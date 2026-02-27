import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { getEnv } from "../_shared/env.ts";
import { createSupabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { fetchTwelveDataCandles } from "../_shared/twelveData.ts";
import { sendTelegramMessage } from "../_shared/telegram.ts";
import {
  formatCycleDiscarded,
  formatSignalDetected,
  formatStructureFlip,
  formatTradeClosedSL,
  formatTradeClosedTP,
} from "../_shared/telegramTemplates.ts";
import { runContinuationStrategy } from "../_shared/strategy.ts";
import type { Candle, EngineEvent, EngineRuntimeSnapshot, EngineSignal, EngineTrade } from "../_shared/types.ts";

const STRATEGY_CODE = "eurusd_m15_continuation_v1";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function asDbCandle(symbol: string, timeframe: string, c: Candle) {
  return {
    symbol,
    timeframe,
    ts: c.ts,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume ?? null,
    source: "twelvedata",
    raw: {},
  };
}

function signalRow(s: EngineSignal) {
  return {
    signal_key: s.signalKey,
    strategy_code: s.strategyCode,
    symbol: s.symbol,
    timeframe: s.timeframe,
    direction: s.direction,
    bos_time: s.bosTime,
    trigger_time: s.triggerTime,
    planned_entry_time: s.plannedEntryTime,
    planned_entry_price: s.plannedEntryPrice,
    entry_status: s.entryStatus,
    stop_loss: s.stopLoss,
    take_profit: s.takeProfit,
    impulse_pips: s.impulsePips,
    anchor_line: s.anchorLine,
    causal_extreme: s.causalExtreme,
    pb_level: s.pbLevel,
    pullback_swing_target: s.pullbackSwingTarget,
    cause_fractal_type: s.causeFractalType,
    cause_fractal_index: s.causeFractalIndex,
    trigger_candle_index: s.triggerCandleIndex,
    bos_to_pb_start_candles: s.metrics.bosToPullbackStartCandles,
    pb_start_to_confirm_candles: s.metrics.pullbackStartToConfirmCandles,
    confirm_to_trigger_candles: s.metrics.confirmToTriggerCandles,
    payload: s.payload,
  };
}

function tradeRow(t: EngineTrade) {
  return {
    trade_key: t.tradeKey,
    signal_key: t.signalKey,
    symbol: t.symbol,
    timeframe: t.timeframe,
    direction: t.direction,
    entry_time: t.entryTime,
    entry_price: t.entryPrice,
    stop_loss: t.stopLoss,
    take_profit: t.takeProfit,
    exit_time: t.exitTime,
    exit_price: t.exitPrice,
    exit_reason: t.exitReason,
    r_multiple: t.rMultiple,
    status: t.status,
    payload: t.payload,
  };
}

function runtimeRow(runtime: EngineRuntimeSnapshot, events: EngineEvent[]) {
  return {
    strategy_code: runtime.strategyCode,
    symbol: runtime.symbol,
    timeframe: runtime.timeframe,
    bias: runtime.bias,
    state: runtime.state,
    last_candle_ts: runtime.lastCandleTs,
    last_fsh_price: runtime.lastFSHPrice,
    last_fsl_price: runtime.lastFSLPrice,
    anchor_line: runtime.anchorLine,
    anchor_index: runtime.anchorIndex,
    causal_extreme: runtime.causalExtreme,
    causal_extreme_index: runtime.causalExtremeIndex,
    midpoint_level: runtime.midpointLevel,
    impulse_pips: runtime.impulsePips,
    pullback_start_index: runtime.pullbackStartIndex,
    pullback_confirm_index: runtime.pullbackConfirmIndex,
    pb_low: runtime.pbLow,
    pb_high: runtime.pbHigh,
    s_low: runtime.sLow,
    s_high: runtime.sHigh,
    active_trade_key: runtime.activeTradeKey,
    payload: {
      events: events.slice(-20),
    },
  };
}

function brokerRequestRow(s: EngineSignal, requestedUnits: number) {
  return {
    request_key: `${s.signalKey}:ctrader:market`,
    signal_key: s.signalKey,
    broker: "ctrader",
    symbol: s.symbol,
    timeframe: s.timeframe,
    direction: s.direction,
    order_type: "MARKET",
    requested_units: requestedUnits,
    planned_entry_time: s.plannedEntryTime,
    planned_entry_price: s.plannedEntryPrice,
    stop_loss: s.stopLoss,
    take_profit: s.takeProfit,
    payload: {
      strategy_code: s.strategyCode,
      trigger_time: s.triggerTime,
      bos_time: s.bosTime,
      entry_status: s.entryStatus,
      impulse_pips: s.impulsePips,
    },
  };
}

async function triggerExecutorWebhook(baseUrl: string, secret: string | null) {
  const url = `${baseUrl.replace(/\/$/, "")}/webhook/queued`;
  const headers: HeadersInit = { "Content-Type": "application/json" };
  if (secret) headers["x-executor-secret"] = secret;
  try {
    await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ source: "m15-signal-engine" }),
    });
  } catch (e) {
    console.error("Executor webhook failed", e);
  }
}

serve(async (req) => {
  try {
    const env = getEnv();
    const authHeader = req.headers.get("x-cron-secret");
    if (authHeader !== env.cronSecret) {
      return json(401, { error: "Unauthorized" });
    }

    const supabase = createSupabaseAdmin(env);

    const { data: controlRow, error: controlErr } = await supabase
      .from("strategy_controls")
      .select("*")
      .eq("strategy_code", STRATEGY_CODE)
      .eq("symbol", env.signalSymbol)
      .eq("timeframe", env.signalTimeframe)
      .maybeSingle();
    if (controlErr) throw controlErr;

    let resetApplied = false;
    if (controlRow?.reset_requested === true) {
      resetApplied = true;
      const { error: resetErr } = await supabase
        .from("strategy_controls")
        .upsert({
          strategy_code: STRATEGY_CODE,
          symbol: env.signalSymbol,
          timeframe: env.signalTimeframe,
          reset_requested: false,
        }, { onConflict: "strategy_code,symbol,timeframe" });
      if (resetErr) throw resetErr;

      await supabase
        .from("strategy_runtime_state")
        .delete()
        .eq("strategy_code", STRATEGY_CODE)
        .eq("symbol", env.signalSymbol)
        .eq("timeframe", env.signalTimeframe);
    }

    const fetched = await fetchTwelveDataCandles({
      apiKey: env.twelveDataApiKey,
      symbol: env.signalSymbol,
      interval: env.signalTimeframe,
      outputsize: env.twelveDataOutputsize,
    });

    if (fetched.length === 0) {
      return json(200, { ok: true, message: "No candles returned from Twelve Data" });
    }

    const candleRows = fetched.map((c) => asDbCandle(env.signalSymbol, env.signalTimeframe, c));
    const upsertCandlesRes = await supabase
      .from("market_candles")
      .upsert(candleRows, { onConflict: "symbol,timeframe,ts" });
    if (upsertCandlesRes.error) throw upsertCandlesRes.error;

    const { data: dbCandles, error: dbCandleErr } = await supabase
      .from("market_candles")
      .select("ts,open,high,low,close,volume")
      .eq("symbol", env.signalSymbol)
      .eq("timeframe", env.signalTimeframe)
      .order("ts", { ascending: false })
      .limit(env.signalLookbackCandles);
    if (dbCandleErr) throw dbCandleErr;
    if (!dbCandles || dbCandles.length < 5) {
      return json(200, { ok: true, candlesStored: candleRows.length, message: "Insufficient candles" });
    }

    const candles: Candle[] = [...dbCandles]
      .reverse()
      .map((r) => ({
        ts: new Date(r.ts as string).toISOString(),
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: r.volume == null ? null : Number(r.volume),
      }));

    const engine = runContinuationStrategy({
      symbol: env.signalSymbol,
      timeframe: env.signalTimeframe,
      candles,
    });

    const { error: runtimeErr } = await supabase
      .from("strategy_runtime_state")
      .upsert(runtimeRow(engine.runtime, engine.events), { onConflict: "strategy_code,symbol,timeframe" });
    if (runtimeErr) throw runtimeErr;

    if (engine.signals.length > 0) {
      const { error } = await supabase
        .from("strategy_signals")
        .upsert(engine.signals.map(signalRow), { onConflict: "signal_key" });
      if (error) throw error;
    }

    if (engine.trades.length > 0) {
      const { error } = await supabase
        .from("strategy_trades")
        .upsert(engine.trades.map(tradeRow), { onConflict: "trade_key" });
      if (error) throw error;
    }

    const readySignals = engine.signals.filter((s) => s.entryStatus === "known_next_open");
    if (readySignals.length > 0) {
      const { error } = await supabase
        .from("broker_order_requests")
        .upsert(
          readySignals.map((s) => brokerRequestRow(s, env.ctraderOrderVolumeUnits)),
          { onConflict: "request_key" },
        );
      if (error) throw error;
    }

    if (readySignals.length > 0 && env.executorBaseUrl) {
      await triggerExecutorWebhook(env.executorBaseUrl, env.executorWebhookSecret);
    }

    let eventNotifications = 0;
    for (const event of engine.events) {
      if (event.type === "STRUCTURE_FLIP") {
        await sendTelegramMessage({
          botToken: env.telegramBotToken,
          chatId: env.telegramChatId,
          text: formatStructureFlip(event),
        });
        eventNotifications++;
      }
      if (event.type === "CYCLE_DISCARDED") {
        await sendTelegramMessage({
          botToken: env.telegramBotToken,
          chatId: env.telegramChatId,
          text: formatCycleDiscarded(event),
        });
        eventNotifications++;
      }
    }

    const { data: unsentSignals, error: unsentErr } = await supabase
      .from("strategy_signals")
      .select("*")
      .eq("symbol", env.signalSymbol)
      .eq("timeframe", env.signalTimeframe)
      .is("telegram_notified_at", null)
      .order("trigger_time", { ascending: true })
      .limit(20);
    if (unsentErr) throw unsentErr;

    let signalNotified = 0;
    for (const s of unsentSignals ?? []) {
      await sendTelegramMessage({
        botToken: env.telegramBotToken,
        chatId: env.telegramChatId,
        text: formatSignalDetected({
          direction: String(s.direction) as "LONG" | "SHORT",
          symbol: String(s.symbol),
          timeframe: String(s.timeframe),
          triggerTime: String(s.trigger_time),
          plannedEntryTime: s.planned_entry_time ? String(s.planned_entry_time) : null,
          plannedEntryPrice: s.planned_entry_price == null ? null : Number(s.planned_entry_price),
          stopLoss: Number(s.stop_loss),
          takeProfit: Number(s.take_profit),
          impulsePips: Number(s.impulse_pips),
          pbLevel: Number(s.pb_level),
          signalKey: String(s.signal_key),
        }),
      });
      const { error } = await supabase
        .from("strategy_signals")
        .update({ telegram_notified_at: new Date().toISOString(), status: "notified" })
        .eq("signal_key", s.signal_key);
      if (error) throw error;
      signalNotified++;
    }

    const { data: unclosedNotifiedTrades, error: closedErr } = await supabase
      .from("strategy_trades")
      .select("*")
      .eq("symbol", env.signalSymbol)
      .eq("timeframe", env.signalTimeframe)
      .eq("status", "CLOSED")
      .is("telegram_close_notified_at", null)
      .order("updated_at", { ascending: true })
      .limit(20);
    if (closedErr) throw closedErr;

    let closeNotified = 0;
    for (const t of unclosedNotifiedTrades ?? []) {
      if (t.exit_reason === "TP") {
        await sendTelegramMessage({
          botToken: env.telegramBotToken,
          chatId: env.telegramChatId,
          text: formatTradeClosedTP({
            signalKey: String(t.signal_key),
            exitTime: t.exit_time ? String(t.exit_time) : null,
            exitPrice: t.exit_price == null ? null : Number(t.exit_price),
            rMultiple: t.r_multiple == null ? null : Number(t.r_multiple),
          }),
        });
      } else {
        await sendTelegramMessage({
          botToken: env.telegramBotToken,
          chatId: env.telegramChatId,
          text: formatTradeClosedSL({
            signalKey: String(t.signal_key),
            exitTime: t.exit_time ? String(t.exit_time) : null,
            exitPrice: t.exit_price == null ? null : Number(t.exit_price),
            rMultiple: t.r_multiple == null ? null : Number(t.r_multiple),
          }),
        });
      }
      await supabase
        .from("strategy_trades")
        .update({ telegram_close_notified_at: new Date().toISOString() })
        .eq("trade_key", t.trade_key);
      closeNotified++;
    }

    return json(200, {
      ok: true,
      symbol: env.signalSymbol,
      timeframe: env.signalTimeframe,
      fetchedCandles: fetched.length,
      computedSignals: engine.signals.length,
      computedTrades: engine.trades.length,
      queuedBrokerRequests: readySignals.length,
      signalTelegramNotified: signalNotified,
      eventTelegramNotified: eventNotifications,
      tradeCloseTelegramNotified: closeNotified,
      resetApplied,
      latestCandle: candles[candles.length - 1]?.ts ?? null,
    });
  } catch (error) {
    console.error(error);
    return json(500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
