import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { getEnv } from "../_shared/env.ts";
import { createSupabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { fetchTwelveDataCandles } from "../_shared/twelveData.ts";
import { sendTelegramMessage } from "../_shared/telegram.ts";
import { runContinuationStrategy } from "../_shared/strategy.ts";
import type { Candle, EngineSignal, EngineTrade } from "../_shared/types.ts";

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

function formatSignalTelegram(s: Record<string, unknown>): string {
  const dir = String(s.direction ?? "");
  return [
    `*EURUSD M15 Signal*`,
    `Direction: *${dir}*`,
    `Trigger: \`${s.trigger_time}\``,
    `Entry: ${s.entry_status === "pending_next_open" ? "*Next candle open (pending)*" : `\`${s.planned_entry_price}\` @ \`${s.planned_entry_time}\``}`,
    `SL: \`${s.stop_loss}\``,
    `TP: \`${s.take_profit}\``,
    `Impulse: \`${s.impulse_pips}\` pips`,
    `Key: \`${s.signal_key}\``,
  ].join("\n");
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

    if (upsertCandlesRes.error) {
      throw upsertCandlesRes.error;
    }

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

    const { data: unsentSignals, error: unsentErr } = await supabase
      .from("strategy_signals")
      .select("*")
      .eq("symbol", env.signalSymbol)
      .eq("timeframe", env.signalTimeframe)
      .is("telegram_notified_at", null)
      .order("trigger_time", { ascending: true })
      .limit(20);
    if (unsentErr) throw unsentErr;

    let notified = 0;
    for (const s of unsentSignals ?? []) {
      await sendTelegramMessage({
        botToken: env.telegramBotToken,
        chatId: env.telegramChatId,
        text: formatSignalTelegram(s as Record<string, unknown>),
      });
      const { error } = await supabase
        .from("strategy_signals")
        .update({ telegram_notified_at: new Date().toISOString(), status: "notified" })
        .eq("signal_key", s.signal_key);
      if (error) throw error;
      notified++;
    }

    return json(200, {
      ok: true,
      symbol: env.signalSymbol,
      timeframe: env.signalTimeframe,
      fetchedCandles: fetched.length,
      computedSignals: engine.signals.length,
      computedTrades: engine.trades.length,
      queuedBrokerRequests: readySignals.length,
      telegramNotified: notified,
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
