import http from "node:http";
import { getConfig } from "./config.js";
import { createSupabaseAdmin } from "./supabase.js";
import { CTraderOpenApiClient } from "./ctraderClient.js";
import { BrokerExecutor } from "./executorLoop.js";
import { log, err } from "./logger.js";

const config = getConfig();
const supabase = createSupabaseAdmin(config);
const ctraderClient = new CTraderOpenApiClient(config.ctrader);
const executor = new BrokerExecutor({ supabase, ctraderClient, config });

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body, null, 2));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      return sendJson(res, 200, { ok: true, service: "ctrader-executor", time: new Date().toISOString() });
    }

    if (req.method === "POST" && req.url === "/tick") {
      if (config.webhookSecret) {
        const secret = req.headers["x-executor-secret"];
        if (secret !== config.webhookSecret) {
          return sendJson(res, 401, { ok: false, error: "Unauthorized" });
        }
      }
      await executor.tick();
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && req.url === "/reload-ctrader") {
      if (config.webhookSecret) {
        const secret = req.headers["x-executor-secret"];
        if (secret !== config.webhookSecret) {
          return sendJson(res, 401, { ok: false, error: "Unauthorized" });
        }
      }
      await ctraderClient.close();
      await ctraderClient.ensureReady();
      return sendJson(res, 200, { ok: true, reconnected: true });
    }

    if (req.method === "POST" && req.url === "/webhook/queued") {
      if (config.webhookSecret) {
        const secret = req.headers["x-executor-secret"];
        if (secret !== config.webhookSecret) {
          return sendJson(res, 401, { ok: false, error: "Unauthorized" });
        }
      }
      await readBody(req);
      executor.tick().catch((e) => err("webhook-triggered tick failed", e));
      return sendJson(res, 202, { ok: true });
    }

    return sendJson(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    err("server error", error);
    return sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(config.port, () => {
  log("ctrader executor server listening", { port: config.port });
  executor.start();
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    log("shutdown signal", sig);
    executor.stop();
    await ctraderClient.close();
    server.close(() => process.exit(0));
  });
}
