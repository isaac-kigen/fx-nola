import { log, err } from "./logger.js";
import { CTraderApiError } from "./ctraderClient.js";

function nowIso() {
  return new Date().toISOString();
}

function isReadyToExecute(reqRow) {
  if (!reqRow.planned_entry_time) return true;
  return new Date(reqRow.planned_entry_time).getTime() <= Date.now();
}

function floorToStep(value, step) {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return 0;
  return Math.floor(value / step) * step;
}

function estimatePerUnitRiskInAccountCurrency({
  symbol,
  accountCurrency,
  entryPrice,
  stopLoss,
}) {
  const stopDistance = Math.abs(entryPrice - stopLoss);
  if (!(stopDistance > 0)) {
    throw new Error("Invalid stop distance for risk sizing");
  }

  const normalizedSymbol = String(symbol || "").replace("/", "").toUpperCase();

  // Strictly supported conversions for this scaffold.
  if (normalizedSymbol === "EURUSD" && accountCurrency === "USD") {
    return { perUnitRisk: stopDistance, stopDistance };
  }

  if (normalizedSymbol === "EURUSD" && accountCurrency === "EUR") {
    return { perUnitRisk: stopDistance / entryPrice, stopDistance };
  }

  throw new Error(
    `Unsupported risk conversion for symbol=${symbol} accountCurrency=${accountCurrency}. Add FX conversion logic first.`,
  );
}

async function computeSizedVolumeUnits({ req, ctraderClient, config }) {
  const trader = await ctraderClient.getTraderSnapshot();
  const refField = config.risk.riskReference;
  const accountValue = refField === "equity" && trader.equity != null
    ? Number(trader.equity)
    : Number(trader.balance);

  if (!Number.isFinite(accountValue) || accountValue <= 0) {
    throw new Error(`Invalid trader ${refField}: ${accountValue}`);
  }

  const entryPrice = Number(req.planned_entry_price);
  const stopLoss = Number(req.stop_loss);
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    throw new Error("planned_entry_price required for strict risk sizing");
  }

  const { perUnitRisk, stopDistance } = estimatePerUnitRiskInAccountCurrency({
    symbol: req.symbol,
    accountCurrency: config.risk.accountCurrency,
    entryPrice,
    stopLoss,
  });

  const riskBudget = accountValue * (Number(config.risk.riskPercent) / 100);
  const slippageHaircut = Math.max(0, Number(config.risk.marketSlippageBufferPercent)) / 100;
  const effectiveRiskBudget = riskBudget * (1 - slippageHaircut);

  if (!(effectiveRiskBudget > 0)) {
    throw new Error("Effective risk budget is non-positive");
  }

  const rawUnits = effectiveRiskBudget / perUnitRisk;
  let units = floorToStep(rawUnits, Number(config.risk.volumeStepUnits));

  if (Number.isFinite(config.risk.maxVolumeUnits) && config.risk.maxVolumeUnits > 0) {
    units = Math.min(units, Number(config.risk.maxVolumeUnits));
    units = floorToStep(units, Number(config.risk.volumeStepUnits));
  }

  if (units < Number(config.risk.minVolumeUnits)) {
    throw new Error(
      `Risk budget too small for min volume. budget=${effectiveRiskBudget.toFixed(2)} minUnits=${config.risk.minVolumeUnits}`,
    );
  }

  const projectedRisk = units * perUnitRisk;
  if (projectedRisk > riskBudget + 1e-9) {
    throw new Error("Projected risk exceeds configured risk budget after sizing");
  }

  return {
    units,
    accountValue,
    reference: refField,
    riskPercent: Number(config.risk.riskPercent),
    riskBudget,
    effectiveRiskBudget,
    projectedRisk,
    perUnitRisk,
    stopDistance,
    entryPrice,
    traderSnapshot: trader,
  };
}

async function sendTelegram(config, text) {
  if (!config.telegram?.botToken || !config.telegram?.chatId) return false;
  const url = `https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: config.telegram.chatId,
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    }),
  });
  return res.ok;
}

function extractEventField(payload, path) {
  let cur = payload;
  for (const k of path) {
    if (!cur || typeof cur !== "object") return null;
    cur = cur[k];
  }
  return cur ?? null;
}

function eventTimestamp(payload) {
  const tsRaw = extractEventField(payload, ["utcLastUpdateTimestamp"]) ??
    extractEventField(payload, ["deal", "utcTimestamp"]) ??
    extractEventField(payload, ["executionTimestamp"]);
  if (tsRaw == null) return nowIso();
  const n = Number(tsRaw);
  if (Number.isFinite(n) && n > 0) {
    // cTrader often uses ms unix timestamp
    return new Date(n).toISOString();
  }
  const s = String(tsRaw);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? nowIso() : d.toISOString();
}

function detectCloseReason(payload) {
  const raw = JSON.stringify(payload).toUpperCase();
  if (raw.includes("TAKE_PROFIT")) return "TP";
  if (raw.includes("STOP_LOSS")) return "SL";
  return null;
}

function eventSignature(event) {
  const p = event.payload ?? event;
  const positionId = extractEventField(p, ["position", "positionId"]) ??
    extractEventField(p, ["closedPosition", "positionId"]) ??
    extractEventField(p, ["positionId"]) ??
    "";
  const orderId = extractEventField(p, ["order", "orderId"]) ??
    extractEventField(p, ["orderId"]) ??
    "";
  const executionType = extractEventField(p, ["executionType"]) ?? "";
  const uts = extractEventField(p, ["utcLastUpdateTimestamp"]) ??
    extractEventField(p, ["deal", "utcTimestamp"]) ?? "";
  return `${event.payloadType}:${executionType}:${positionId}:${orderId}:${uts}`;
}

export class BrokerExecutor {
  constructor({ supabase, ctraderClient, config }) {
    this.supabase = supabase;
    this.ctraderClient = ctraderClient;
    this.config = config;
    this.timer = null;
    this.running = false;
    this.unsubscribeExecution = null;
  }

  start() {
    if (this.timer) return;
    if (!this.unsubscribeExecution) {
      this.unsubscribeExecution = this.ctraderClient.onExecutionEvent((event) => {
        this.handleExecutionEvent(event).catch((e) => err("execution event handler failed", e));
      });
    }
    this.timer = setInterval(() => {
      this.tick().catch((e) => err("executor tick failed", e));
    }, this.config.pollIntervalMs);
    this.tick().catch((e) => err("executor startup tick failed", e));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.unsubscribeExecution) {
      this.unsubscribeExecution();
      this.unsubscribeExecution = null;
    }
  }

  async handleExecutionEvent(event) {
    const payload = event.payload ?? event;
    const signature = eventSignature(event);
    const receivedAt = nowIso();
    const closeReason = detectCloseReason(payload);
    const positionId = extractEventField(payload, ["position", "positionId"]) ??
      extractEventField(payload, ["closedPosition", "positionId"]) ??
      extractEventField(payload, ["positionId"]);
    const orderId = extractEventField(payload, ["order", "orderId"]) ??
      extractEventField(payload, ["orderId"]);
    const executionType = extractEventField(payload, ["executionType"]);
    const eventTs = eventTimestamp(payload);

    const eventInsert = await this.supabase
      .from("broker_execution_events")
      .upsert({
        event_signature: signature,
        payload_type: Number(event.payloadType ?? 0),
        execution_type: executionType == null ? null : String(executionType),
        broker_position_id: positionId == null ? null : String(positionId),
        broker_order_id: orderId == null ? null : String(orderId),
        close_reason: closeReason,
        event_time: eventTs,
        received_at: receivedAt,
        payload,
      }, { onConflict: "event_signature" })
      .select("id")
      .limit(1);
    if (eventInsert.error) throw eventInsert.error;

    if (closeReason == null) return;

    let reqQuery = this.supabase
      .from("broker_order_requests")
      .select("*")
      .eq("broker", "ctrader")
      .in("status", ["accepted", "submitted", "processing", "failed", "queued"])
      .order("updated_at", { ascending: false })
      .limit(1);
    if (positionId != null) reqQuery = reqQuery.eq("broker_position_id", String(positionId));
    else if (orderId != null) reqQuery = reqQuery.eq("broker_order_id", String(orderId));
    else return;

    const reqRes = await reqQuery;
    if (reqRes.error) throw reqRes.error;
    const req = reqRes.data?.[0];
    if (!req) return;

    const exitPrice = extractEventField(payload, ["deal", "executionPrice"]) ??
      extractEventField(payload, ["executionPrice"]) ??
      extractEventField(payload, ["closePrice"]);
    const exitPxNum = exitPrice == null ? null : Number(exitPrice);

    const tradeUpdate = await this.supabase
      .from("strategy_trades")
      .update({
        status: "CLOSED",
        exit_reason: closeReason,
        exit_time: eventTs,
        exit_price: Number.isFinite(exitPxNum) ? exitPxNum : null,
      })
      .eq("signal_key", req.signal_key)
      .eq("status", "OPEN");
    if (tradeUpdate.error) throw tradeUpdate.error;

    const text = closeReason === "TP"
      ? [
        `🎯 *NOLA-DELTA • ${req.symbol} • ${req.timeframe}*`,
        `📌 TAKE PROFIT HIT`,
        ``,
        `${req.direction === "LONG" ? "🟢" : "🔴"} ${req.direction} Closed @ ${Number.isFinite(exitPxNum) ? exitPxNum : "-"}`,
        `⏱️ Time: ${eventTs}`,
        ``,
        `🧾 ID: ${req.signal_key}`,
      ].join("\n")
      : [
        `🛑 *NOLA-DELTA • ${req.symbol} • ${req.timeframe}*`,
        `📌 STOP LOSS HIT`,
        ``,
        `${req.direction === "LONG" ? "🟢" : "🔴"} ${req.direction} Closed @ ${Number.isFinite(exitPxNum) ? exitPxNum : "-"}`,
        `⏱️ Time: ${eventTs}`,
        ``,
        `🧾 ID: ${req.signal_key}`,
      ].join("\n");

    const closeTgSent = await sendTelegram(this.config, text);
    if (closeTgSent) {
      await this.supabase
        .from("strategy_trades")
        .update({ telegram_close_notified_at: nowIso() })
        .eq("signal_key", req.signal_key)
        .eq("status", "CLOSED");
    }
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const { data, error } = await this.supabase
        .from("broker_order_requests")
        .select("*")
        .in("status", ["queued", "failed"])
        .order("created_at", { ascending: true })
        .limit(25);
      if (error) throw error;
      for (const req of data ?? []) {
        if (req.next_attempt_after && new Date(req.next_attempt_after).getTime() > Date.now()) continue;
        if (!isReadyToExecute(req)) continue;
        await this.processRequest(req);
      }
    } finally {
      this.running = false;
    }
  }

  async processRequest(req) {
    log("processing broker request", req.request_key, req.status);
    await this.markProcessing(req.id, req.attempts);
    try {
      let volumeUnits = Number(req.requested_units);
      if (!Number.isFinite(volumeUnits) || volumeUnits <= 0) {
        volumeUnits = Number(this.config.ctrader.volumeUnits);
      }
      let riskSizing = null;

      if (this.config.risk.positionSizingMode === "risk_percent") {
        riskSizing = await computeSizedVolumeUnits({
          req,
          ctraderClient: this.ctraderClient,
          config: this.config,
        });
        volumeUnits = Number(riskSizing.units);
      }

      log("submitting order", {
        requestKey: req.request_key,
        accountId: this.config.ctrader.accountId,
        environment: this.config.ctrader.wsUrl.includes("demo") ? "demo" : "live",
        symbol: req.symbol,
        symbolId: this.config.ctrader.symbolId,
        direction: req.direction,
        plannedEntryTime: req.planned_entry_time,
        plannedEntryPrice: req.planned_entry_price,
        stopLoss: req.stop_loss,
        takeProfit: req.take_profit,
        volumeUnits,
        riskSizing: riskSizing
          ? {
            reference: riskSizing.reference,
            riskPercent: riskSizing.riskPercent,
            accountValue: Number(riskSizing.accountValue.toFixed(2)),
            riskBudget: Number(riskSizing.riskBudget.toFixed(2)),
            effectiveRiskBudget: Number(riskSizing.effectiveRiskBudget.toFixed(2)),
            projectedRisk: Number(riskSizing.projectedRisk.toFixed(2)),
            stopDistance: Number(riskSizing.stopDistance.toFixed(8)),
          }
          : null,
      });

      const outcome = await this.ctraderClient.placeMarketOrder({
        requestKey: req.request_key,
        direction: req.direction,
        entryPrice: Number(req.planned_entry_price),
        stopLoss: Number(req.stop_loss),
        takeProfit: Number(req.take_profit),
        symbolId: Number(this.config.ctrader.symbolId),
        volumeUnits,
      });

      const status = outcome.accepted ? "accepted" : "submitted";
      const executedAt = nowIso();
      const { error } = await this.supabase
        .from("broker_order_requests")
        .update({
          status,
          requested_units: volumeUnits,
          broker_order_id: outcome.orderId ? String(outcome.orderId) : null,
          broker_position_id: outcome.positionId ? String(outcome.positionId) : null,
          execution_event: outcome.raw,
          payload: {
            ...(req.payload || {}),
            execution: {
              sizingMode: this.config.risk.positionSizingMode,
              sizedUnits: volumeUnits,
              ...(riskSizing
                ? {
                  riskReference: riskSizing.reference,
                  riskPercent: riskSizing.riskPercent,
                  accountValue: Number(riskSizing.accountValue.toFixed(2)),
                  riskBudget: Number(riskSizing.riskBudget.toFixed(2)),
                  effectiveRiskBudget: Number(riskSizing.effectiveRiskBudget.toFixed(2)),
                  projectedRisk: Number(riskSizing.projectedRisk.toFixed(2)),
                  perUnitRisk: Number(riskSizing.perUnitRisk.toFixed(8)),
                  stopDistance: Number(riskSizing.stopDistance.toFixed(8)),
                  entryPriceForSizing: Number(riskSizing.entryPrice.toFixed(8)),
                }
                : {}),
              ctraderProtection: {
                relativeStopLoss: outcome.relativeStopLoss ?? null,
                relativeTakeProfit: outcome.relativeTakeProfit ?? null,
              },
            },
          },
          last_attempt_at: executedAt,
          telegram_executed_notified_at: null,
          broker_error_code: null,
          broker_error_message: null,
        })
        .eq("id", req.id);
      if (error) throw error;

      await this.supabase
        .from("strategy_signals")
        .update({
          status: outcome.accepted ? "broker_accepted" : "broker_submitted",
        })
        .eq("signal_key", req.signal_key);

      log("broker request sent", {
        requestKey: req.request_key,
        status,
        orderId: outcome.orderId,
        positionId: outcome.positionId,
        relativeStopLoss: outcome.relativeStopLoss ?? null,
        relativeTakeProfit: outcome.relativeTakeProfit ?? null,
      });

      const plannedEntry = Number(req.planned_entry_price);
      const stopLoss = Number(req.stop_loss);
      const takeProfit = Number(req.take_profit);
      const riskAbs = Number.isFinite(plannedEntry) ? Math.abs(plannedEntry - stopLoss) : NaN;
      const rewardAbs = Number.isFinite(plannedEntry) ? Math.abs(takeProfit - plannedEntry) : NaN;
      const rr = riskAbs > 0 ? (rewardAbs / riskAbs) : NaN;

      const tgSent = await sendTelegram(this.config, [
        `🚀 *NOLA-DELTA • ${req.symbol} • ${req.timeframe}*`,
        `📌 TRADE EXECUTED`,
        ``,
        `${req.direction === "LONG" ? "🟢" : "🔴"} ${req.direction} @ ${req.planned_entry_price ?? "-"}`,
        `🛑 SL: ${req.stop_loss}`,
        `🎯 TP: ${req.take_profit}`,
        ``,
        `📏 Risk: ${Number.isFinite(riskAbs) ? riskAbs.toFixed(5) : "-"}`,
        `📐 R:R: ${Number.isFinite(rr) ? `1 : ${rr.toFixed(2)}` : "-"}`,
        ``,
        `🧾 ID: ${req.signal_key}`,
      ].join("\n"));
      if (tgSent) {
        await this.supabase
          .from("broker_order_requests")
          .update({ telegram_executed_notified_at: nowIso() })
          .eq("id", req.id);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isCTraderError = e instanceof CTraderApiError;
      const brokerErrorCode = isCTraderError ? (e.code ?? null) : null;
      const errorPayloadType = isCTraderError ? (e.payloadType ?? null) : null;
      const rawError = isCTraderError ? (e.raw ?? null) : null;

      err("broker request failed", {
        requestKey: req.request_key,
        accountId: this.config.ctrader.accountId,
        symbolId: this.config.ctrader.symbolId,
        message: msg,
        brokerErrorCode,
        payloadType: errorPayloadType,
        rawError,
      });

      const backoffMins = Math.min(30, Math.max(1, (req.attempts || 0) + 1));
      const next = new Date(Date.now() + backoffMins * 60_000).toISOString();
      const { error } = await this.supabase
        .from("broker_order_requests")
        .update({
          status: "failed",
          last_attempt_at: nowIso(),
          next_attempt_after: next,
          broker_error_code: brokerErrorCode,
          broker_error_message: msg,
          execution_event: rawError,
          payload: {
            ...(req.payload || {}),
            lastFailure: {
              message: msg,
              brokerErrorCode,
              payloadType: errorPayloadType,
              accountId: this.config.ctrader.accountId,
              symbolId: this.config.ctrader.symbolId,
              at: nowIso(),
            },
          },
        })
        .eq("id", req.id);
      if (error) throw error;
    }
  }

  async markProcessing(id, attempts) {
    const { error } = await this.supabase
      .from("broker_order_requests")
      .update({
        status: "processing",
        attempts: (attempts || 0) + 1,
        last_attempt_at: nowIso(),
      })
      .eq("id", id)
      .in("status", ["queued", "failed"]);
    if (error) throw error;
  }
}
