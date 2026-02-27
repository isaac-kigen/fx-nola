import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { getEnv } from "../_shared/env.ts";
import { createSupabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { sendTelegramMessage } from "../_shared/telegram.ts";
import {
  backToMenuKeyboard,
  formatAnalysis,
  formatDailyReport,
  formatDataWarning,
  formatDebugSnapshot,
  formatStatus,
  formatUnauthorized,
  formatWeeklyReport,
  menuKeyboard,
} from "../_shared/telegramTemplates.ts";
import type { EngineRuntimeSnapshot } from "../_shared/types.ts";

const STRATEGY_CODE = "eurusd_m15_continuation_v1";

type TelegramUpdate = {
  message?: {
    text?: string;
    chat?: { id?: number | string };
  };
  callback_query?: {
    id?: string;
    data?: string;
    message?: { chat?: { id?: number | string } };
  };
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function extractChatId(update: TelegramUpdate): string | null {
  const fromMessage = update.message?.chat?.id;
  if (fromMessage != null) return String(fromMessage);
  const fromCallback = update.callback_query?.message?.chat?.id;
  if (fromCallback != null) return String(fromCallback);
  return null;
}

function extractCommand(update: TelegramUpdate): string | null {
  const msg = update.message?.text?.trim();
  if (msg?.startsWith("/")) return msg.split(/\s+/)[0].toLowerCase();
  const cb = update.callback_query?.data?.trim();
  if (cb) return cb.toLowerCase();
  return null;
}

async function answerCallback(botToken: string, callbackQueryId: string | undefined) {
  if (!callbackQueryId) return;
  const url = `https://api.telegram.org/bot${botToken}/answerCallbackQuery`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  });
}

function toRuntimeSnapshot(row: Record<string, unknown>): EngineRuntimeSnapshot {
  return {
    strategyCode: String(row.strategy_code),
    symbol: String(row.symbol),
    timeframe: String(row.timeframe),
    bias: String(row.bias) as "BULLISH" | "BEARISH" | "NEUTRAL",
    state: String(row.state) as EngineRuntimeSnapshot["state"],
    lastCandleTs: row.last_candle_ts ? String(row.last_candle_ts) : null,
    lastFSHPrice: row.last_fsh_price == null ? null : Number(row.last_fsh_price),
    lastFSLPrice: row.last_fsl_price == null ? null : Number(row.last_fsl_price),
    anchorLine: row.anchor_line == null ? null : Number(row.anchor_line),
    anchorIndex: row.anchor_index == null ? null : Number(row.anchor_index),
    causalExtreme: row.causal_extreme == null ? null : Number(row.causal_extreme),
    causalExtremeIndex: row.causal_extreme_index == null ? null : Number(row.causal_extreme_index),
    midpointLevel: row.midpoint_level == null ? null : Number(row.midpoint_level),
    impulsePips: row.impulse_pips == null ? null : Number(row.impulse_pips),
    pullbackStartIndex: row.pullback_start_index == null ? null : Number(row.pullback_start_index),
    pullbackConfirmIndex: row.pullback_confirm_index == null ? null : Number(row.pullback_confirm_index),
    pbLow: row.pb_low == null ? null : Number(row.pb_low),
    pbHigh: row.pb_high == null ? null : Number(row.pb_high),
    sLow: row.s_low == null ? null : Number(row.s_low),
    sHigh: row.s_high == null ? null : Number(row.s_high),
    activeTradeKey: row.active_trade_key == null ? null : String(row.active_trade_key),
  };
}

serve(async (req) => {
  try {
    const env = getEnv();
    const webhookSecret = req.headers.get("x-telegram-secret") ??
      req.headers.get("x-telegram-bot-api-secret-token");
    if (env.telegramWebhookSecret && webhookSecret !== env.telegramWebhookSecret) {
      return json(401, { error: "Unauthorized" });
    }

    const update = (await req.json()) as TelegramUpdate;
    const chatId = extractChatId(update);
    if (!chatId) return json(200, { ok: true, ignored: "no chat id" });

    if (!env.telegramAllowedChatIds.includes(chatId)) {
      await sendTelegramMessage({
        botToken: env.telegramBotToken,
        chatId,
        text: formatUnauthorized(),
      });
      return json(200, { ok: true, unauthorized: true });
    }

    const command = extractCommand(update) ?? "/menu";
    const supabase = createSupabaseAdmin(env);

    const send = async (text: string, withMenu = false) => {
      await sendTelegramMessage({
        botToken: env.telegramBotToken,
        chatId,
        text,
        replyMarkup: withMenu ? menuKeyboard() : backToMenuKeyboard(),
      });
    };

    const sendStatus = async () => {
      const { data, error } = await supabase
        .from("strategy_runtime_state")
        .select("*")
        .eq("strategy_code", STRATEGY_CODE)
        .eq("symbol", env.signalSymbol)
        .eq("timeframe", env.signalTimeframe)
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        await send(formatDataWarning("No runtime state available yet."));
        return;
      }
      await send(formatStatus(toRuntimeSnapshot(data as Record<string, unknown>)));
    };

    const sendAnalysis = async () => {
      const { data, error } = await supabase
        .from("strategy_runtime_state")
        .select("*")
        .eq("strategy_code", STRATEGY_CODE)
        .eq("symbol", env.signalSymbol)
        .eq("timeframe", env.signalTimeframe)
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        await send(formatDataWarning("No runtime state available yet."));
        return;
      }
      await send(formatAnalysis(toRuntimeSnapshot(data as Record<string, unknown>)));
    };

    const sendLastSignal = async () => {
      const { data, error } = await supabase
        .from("strategy_signals")
        .select("*")
        .eq("symbol", env.signalSymbol)
        .eq("timeframe", env.signalTimeframe)
        .order("trigger_time", { ascending: false })
        .limit(1);
      if (error) throw error;
      if (!data || data.length === 0) {
        await send(formatDataWarning("No signal found."));
        return;
      }
      const s = data[0];
      await send([
        `🧾 *Last Signal*`,
        `Direction: *${s.direction}*`,
        `Trigger: \`${s.trigger_time}\``,
        `Entry: \`${s.planned_entry_price ?? "-"}\` @ \`${s.planned_entry_time ?? "-"}\``,
        `SL/TP: \`${s.stop_loss}\` / \`${s.take_profit}\``,
        `Status: \`${s.status}\``,
        `ID: \`${s.signal_key}\``,
      ].join("\n"));
    };

    const sendTrade = async () => {
      const { data, error } = await supabase
        .from("broker_order_requests")
        .select("*")
        .eq("symbol", env.signalSymbol)
        .eq("timeframe", env.signalTimeframe)
        .order("updated_at", { ascending: false })
        .limit(1);
      if (error) throw error;
      if (!data || data.length === 0) {
        await send(formatDataWarning("No broker request found."));
        return;
      }
      const t = data[0];
      await send([
        `📌 *Trade/Broker Status*`,
        `Request: \`${t.request_key}\``,
        `Direction: *${t.direction}*`,
        `Status: \`${t.status}\``,
        `Order/Position: \`${t.broker_order_id ?? "-"}\` / \`${t.broker_position_id ?? "-"}\``,
        `Last Error: \`${t.broker_error_message ?? "-"}\``,
        `Updated: \`${t.updated_at}\``,
      ].join("\n"));
    };

    const sendDaily = async () => {
      const now = new Date();
      const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();

      const signalsRes = await supabase
        .from("strategy_signals")
        .select("id", { count: "exact", head: true })
        .eq("symbol", env.signalSymbol)
        .eq("timeframe", env.signalTimeframe)
        .gte("trigger_time", dayStart);
      const executedRes = await supabase
        .from("broker_order_requests")
        .select("id", { count: "exact", head: true })
        .in("status", ["accepted", "submitted"])
        .eq("symbol", env.signalSymbol)
        .eq("timeframe", env.signalTimeframe)
        .gte("created_at", dayStart);
      const tpRes = await supabase
        .from("strategy_trades")
        .select("id", { count: "exact", head: true })
        .eq("status", "CLOSED")
        .eq("exit_reason", "TP")
        .eq("symbol", env.signalSymbol)
        .eq("timeframe", env.signalTimeframe)
        .gte("updated_at", dayStart);
      const slRes = await supabase
        .from("strategy_trades")
        .select("id", { count: "exact", head: true })
        .eq("status", "CLOSED")
        .eq("exit_reason", "SL")
        .eq("symbol", env.signalSymbol)
        .eq("timeframe", env.signalTimeframe)
        .gte("updated_at", dayStart);

      await send(formatDailyReport({
        date: dayStart.slice(0, 10),
        signals: signalsRes.count ?? 0,
        executed: executedRes.count ?? 0,
        tp: tpRes.count ?? 0,
        sl: slRes.count ?? 0,
      }));
    };

    const sendWeekly = async () => {
      const now = new Date();
      const day = now.getUTCDay();
      const diffToMonday = (day + 6) % 7;
      const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - diffToMonday));
      const weekStart = monday.toISOString();

      const signalsRes = await supabase
        .from("strategy_signals")
        .select("id", { count: "exact", head: true })
        .eq("symbol", env.signalSymbol)
        .eq("timeframe", env.signalTimeframe)
        .gte("trigger_time", weekStart);
      const executedRes = await supabase
        .from("broker_order_requests")
        .select("id", { count: "exact", head: true })
        .in("status", ["accepted", "submitted"])
        .eq("symbol", env.signalSymbol)
        .eq("timeframe", env.signalTimeframe)
        .gte("created_at", weekStart);
      const tpRes = await supabase
        .from("strategy_trades")
        .select("id", { count: "exact", head: true })
        .eq("status", "CLOSED")
        .eq("exit_reason", "TP")
        .eq("symbol", env.signalSymbol)
        .eq("timeframe", env.signalTimeframe)
        .gte("updated_at", weekStart);
      const slRes = await supabase
        .from("strategy_trades")
        .select("id", { count: "exact", head: true })
        .eq("status", "CLOSED")
        .eq("exit_reason", "SL")
        .eq("symbol", env.signalSymbol)
        .eq("timeframe", env.signalTimeframe)
        .gte("updated_at", weekStart);

      await send(formatWeeklyReport({
        weekStart: weekStart.slice(0, 10),
        signals: signalsRes.count ?? 0,
        executed: executedRes.count ?? 0,
        tp: tpRes.count ?? 0,
        sl: slRes.count ?? 0,
      }));
    };

    const sendDebug = async () => {
      const runtime = await supabase
        .from("strategy_runtime_state")
        .select("updated_at")
        .eq("strategy_code", STRATEGY_CODE)
        .eq("symbol", env.signalSymbol)
        .eq("timeframe", env.signalTimeframe)
        .maybeSingle();
      const signal = await supabase
        .from("strategy_signals")
        .select("signal_key")
        .eq("symbol", env.signalSymbol)
        .eq("timeframe", env.signalTimeframe)
        .order("trigger_time", { ascending: false })
        .limit(1);
      const reqStatus = await supabase
        .from("broker_order_requests")
        .select("status")
        .eq("symbol", env.signalSymbol)
        .eq("timeframe", env.signalTimeframe)
        .order("updated_at", { ascending: false })
        .limit(1);

      await send(formatDebugSnapshot({
        runtimeUpdatedAt: runtime.data?.updated_at ? String(runtime.data.updated_at) : null,
        lastSignalKey: signal.data?.[0]?.signal_key ? String(signal.data[0].signal_key) : null,
        lastOrderRequestStatus: reqStatus.data?.[0]?.status ? String(reqStatus.data[0].status) : null,
      }));
    };

    const setReset = async () => {
      const { error } = await supabase
        .from("strategy_controls")
        .upsert({
          strategy_code: STRATEGY_CODE,
          symbol: env.signalSymbol,
          timeframe: env.signalTimeframe,
          reset_requested: true,
        }, { onConflict: "strategy_code,symbol,timeframe" });
      if (error) throw error;
      await send("✅ Reset cycle requested. Engine will apply on next run.");
    };

    switch (command) {
      case "/menu":
      case "menu":
        await sendTelegramMessage({
          botToken: env.telegramBotToken,
          chatId,
          text: `*Menu*\nChoose an action.`,
          replyMarkup: menuKeyboard(),
        });
        break;
      case "/status":
      case "status":
        await sendStatus();
        break;
      case "/analysis":
      case "analysis":
        await sendAnalysis();
        break;
      case "/trade":
      case "trade":
        await sendTrade();
        break;
      case "/last_signal":
      case "last_signal":
        await sendLastSignal();
        break;
      case "/daily":
      case "daily":
        await sendDaily();
        break;
      case "/weekly":
      case "weekly":
        await sendWeekly();
        break;
      case "/debug":
      case "debug":
        await sendDebug();
        break;
      case "/reset_cycle":
      case "reset_cycle":
        await setReset();
        break;
      default:
        await sendTelegramMessage({
          botToken: env.telegramBotToken,
          chatId,
          text: `Unknown command: \`${command}\``,
          replyMarkup: menuKeyboard(),
        });
        break;
    }

    await answerCallback(env.telegramBotToken, update.callback_query?.id);
    return json(200, { ok: true });
  } catch (error) {
    console.error(error);
    return json(500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
