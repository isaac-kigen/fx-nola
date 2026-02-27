import type { EngineRuntimeSnapshot } from "./types.ts";

function toEat(ts: string | null): string {
  if (!ts) return "-";
  try {
    return new Date(ts).toLocaleString("en-GB", {
      timeZone: "Africa/Nairobi",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }) + " (EAT)";
  } catch {
    return ts;
  }
}

function dOk(impulsePips: number): string {
  return impulsePips >= 20 ? "✅ ≥ 20" : "❌ < 20";
}

export function menuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "📊 Status", callback_data: "status" },
        { text: "🧭 Analysis", callback_data: "analysis" },
      ],
      [
        { text: "🚀 Open Trade", callback_data: "trade" },
        { text: "🧾 Last Signal", callback_data: "last_signal" },
      ],
      [
        { text: "📈 Daily Report", callback_data: "daily" },
        { text: "📊 Weekly Report", callback_data: "weekly" },
      ],
      [
        { text: "🧪 Debug", callback_data: "debug" },
        { text: "🔄 Reset Cycle", callback_data: "reset_cycle" },
      ],
    ],
  };
}

export function backToMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "⬅️ Menu", callback_data: "menu" }],
    ],
  };
}

export function formatMenu(symbol: string, timeframe: string) {
  return [
    `🧠 *NOLA-DELTA • CONTROL PANEL*`,
    `Pair: ${symbol} • TF: ${timeframe}`,
    ``,
    `Choose an option👇`,
  ].join("\n");
}

export function formatSignalDetected(input: {
  direction: "LONG" | "SHORT";
  symbol: string;
  timeframe: string;
  triggerTime: string;
  plannedEntryTime: string | null;
  plannedEntryPrice: number | null;
  stopLoss: number;
  takeProfit: number;
  impulsePips: number;
  pbLevel: number;
  signalKey: string;
  riskPercent?: number | null;
}) {
  const directionEmoji = input.direction === "LONG" ? "🟢" : "🔴";
  return [
    `🧠 *NOLA-DELTA • ${input.symbol} • ${input.timeframe}*`,
    `📌 CONTINUATION SIGNAL DETECTED`,
    ``,
    `${directionEmoji} Direction: ${input.direction}`,
    `⏱️ Time: ${toEat(input.triggerTime)}`,
    ``,
    `📊 Structure:`,
    `• Impulse D: ${input.impulsePips.toFixed(1)} pips (${dOk(input.impulsePips)})`,
    `• Pullback Level (Mid): ${input.pbLevel}`,
    ``,
    `💰 Entry (Next Open): ${input.plannedEntryPrice == null ? "pending" : input.plannedEntryPrice}`,
    `🛑 SL: ${input.stopLoss}  (+3p buffer)`,
    `🎯 TP: ${input.takeProfit}`,
    `${input.riskPercent != null ? `📈 Risk: ${input.riskPercent}%` : `📈 Risk: -`}`,
    `🧾 ID: ${input.signalKey}`,
  ].join("\n");
}

export function formatSignalArmed(input: {
  direction: "LONG" | "SHORT";
  symbol: string;
  timeframe: string;
  stopLoss: number;
  takeProfit: number;
  signalKey: string;
}) {
  const directionEmoji = input.direction === "LONG" ? "🟢" : "🔴";
  return [
    `⏳ *NOLA-DELTA • ${input.symbol} • ${input.timeframe}*`,
    `📌 SIGNAL ARMED — Waiting Next Candle Open`,
    ``,
    `${directionEmoji} ${input.direction}`,
    `💰 Entry: next M15 open`,
    `🛑 SL: ${input.stopLoss}`,
    `🎯 TP: ${input.takeProfit}`,
    ``,
    `🧾 ID: ${input.signalKey}`,
  ].join("\n");
}

export function formatTradeExecuted(input: {
  signalKey: string;
  symbol: string;
  timeframe: string;
  direction: "LONG" | "SHORT";
  entryPrice: number | null;
  stopLoss: number;
  takeProfit: number;
  riskPips: number | null;
  rr: number | null;
}) {
  const directionEmoji = input.direction === "LONG" ? "🟢" : "🔴";
  return [
    `🚀 *NOLA-DELTA • ${input.symbol} • ${input.timeframe}*`,
    `📌 TRADE EXECUTED`,
    ``,
    `${directionEmoji} ${input.direction} @ ${input.entryPrice ?? "-"}`,
    `🛑 SL: ${input.stopLoss}`,
    `🎯 TP: ${input.takeProfit}`,
    ``,
    `📏 Risk: ${input.riskPips == null ? "-" : `${input.riskPips.toFixed(1)} pips`}`,
    `📐 R:R: ${input.rr == null ? "-" : `1 : ${input.rr.toFixed(2)}`}`,
    ``,
    `🧾 ID: ${input.signalKey}`,
  ].join("\n");
}

export function formatTradeClosedTP(input: {
  signalKey: string;
  symbol?: string;
  timeframe?: string;
  direction?: string;
  exitTime: string | null;
  exitPrice: number | null;
  rMultiple: number | null;
}) {
  const header = input.symbol && input.timeframe
    ? `🎯 *NOLA-DELTA • ${input.symbol} • ${input.timeframe}*`
    : `🎯 *NOLA-DELTA • TAKE PROFIT HIT*`;
  return [
    header,
    `📌 TAKE PROFIT HIT`,
    ``,
    `${input.direction ? `${input.direction} ` : ""}Closed @ ${input.exitPrice ?? "-"}`,
    `📈 Result: ${input.rMultiple == null ? "-" : `+${input.rMultiple.toFixed(2)}R`}`,
    `⏱️ Time: ${toEat(input.exitTime)}`,
    ``,
    `🧾 ID: ${input.signalKey}`,
  ].join("\n");
}

export function formatTradeClosedSL(input: {
  signalKey: string;
  symbol?: string;
  timeframe?: string;
  direction?: string;
  exitTime: string | null;
  exitPrice: number | null;
  rMultiple: number | null;
}) {
  const header = input.symbol && input.timeframe
    ? `🛑 *NOLA-DELTA • ${input.symbol} • ${input.timeframe}*`
    : `🛑 *NOLA-DELTA • STOP LOSS HIT*`;
  return [
    header,
    `📌 STOP LOSS HIT`,
    ``,
    `${input.direction ? `${input.direction} ` : ""}Closed @ ${input.exitPrice ?? "-"}`,
    `📉 Result: ${input.rMultiple == null ? "-" : `${input.rMultiple.toFixed(2)}R`}`,
    `⏱️ Time: ${toEat(input.exitTime)}`,
    ``,
    `🧾 ID: ${input.signalKey}`,
  ].join("\n");
}

export function formatStructureFlip(input: {
  from: "BEARISH" | "BULLISH";
  to: "BEARISH" | "BULLISH";
  reason?: string;
}) {
  const invalidationLine = input.from === "BEARISH"
    ? "⚠️ Bearish continuation invalidated."
    : "⚠️ Bullish continuation invalidated.";
  const bosLine = input.to === "BULLISH"
    ? "📈 BOS UP confirmed."
    : "📉 BOS DOWN confirmed.";
  const nextLine = input.to === "BULLISH"
    ? "Next: wait pullback to go LONG."
    : "Next: wait pullback to go SHORT.";
  return [
    `🔁 *NOLA-DELTA • EURUSD • M15*`,
    `📌 STRUCTURE SHIFT DETECTED`,
    ``,
    invalidationLine,
    bosLine,
    ``,
    `🔄 New Bias: ${input.to}`,
    nextLine,
    ``,
    `🧾 Cycle reset complete`,
  ].join("\n");
}

export function formatCycleDiscarded(input: {
  impulsePips: number;
  minImpulsePips: number;
}) {
  return [
    `🚫 *NOLA-DELTA • EURUSD • M15*`,
    `📌 CYCLE DISCARDED`,
    ``,
    `Impulse D: ${input.impulsePips.toFixed(1)} pips`,
    `Minimum Required: ${input.minImpulsePips.toFixed(1)} pips`,
    ``,
    `Reason: insufficient displacement (noise risk).`,
    `Waiting for new Swing BOS.`,
  ].join("\n");
}

export function formatStatus(input: {
  runtime: EngineRuntimeSnapshot;
  lastCandle: { ts: string | null; open: number | null; high: number | null; low: number | null; close: number | null };
  lastSignalKey: string | null;
  hasOpenTrade: boolean;
}) {
  const lc = input.lastCandle;
  return [
    `📊 *NOLA-DELTA • STATUS*`,
    `EURUSD • M15 • ${toEat(lc.ts)}`,
    ``,
    `🧭 Bias: ${input.runtime.bias}`,
    `🧩 State: ${input.runtime.state}`,
    ``,
    `🕯️ Last Candle:`,
    `• Time: ${toEat(lc.ts)}`,
    `• O/H/L/C: ${lc.open ?? "-"} / ${lc.high ?? "-"} / ${lc.low ?? "-"} / ${lc.close ?? "-"}`,
    ``,
    `🚦 Pullback:`,
    `• Enabled: ${input.runtime.pullbackStartIndex != null ? "✅" : "❌"}`,
    `• Confirmed: ${input.runtime.pullbackConfirmIndex != null ? "✅" : "❌"}`,
    ``,
    `🚀 Open Trade: ${input.hasOpenTrade ? "✅" : "❌ None"}`,
    `🧾 Last Signal ID: ${input.lastSignalKey ?? "-"}`,
  ].join("\n");
}

export function formatAnalysis(runtime: EngineRuntimeSnapshot) {
  return [
    `🧭 *NOLA-DELTA • ANALYSIS*`,
    `EURUSD • M15 • ${toEat(runtime.lastCandleTs)}`,
    ``,
    `📊 Structure:`,
    `• Anchor Line: ${runtime.anchorLine ?? "-"}`,
    `• Causal Extreme: ${runtime.causalExtreme ?? "-"}`,
    `• Impulse D: ${runtime.impulsePips ?? "-"} pips ${runtime.impulsePips == null ? "" : `(${dOk(runtime.impulsePips)})`}`,
    ``,
    `🎯 Pullback (Midpoint Rule):`,
    `• Midpoint Level: ${runtime.midpointLevel ?? "-"}`,
    `• Pullback Start: ${runtime.pullbackStartIndex != null ? "✅" : "❌"}`,
    `• Pullback Confirm: ${runtime.pullbackConfirmIndex != null ? "✅" : "❌"}`,
    ``,
    `📍 Pullback Swing:`,
    `• PB_low: ${runtime.pbLow ?? "-"}`,
    `• PB_high: ${runtime.pbHigh ?? "-"}`,
    ``,
    `🧱 Fractals:`,
    `• lastFSH: ${runtime.lastFSHPrice ?? "-"}`,
    `• lastFSL: ${runtime.lastFSLPrice ?? "-"}`,
    ``,
    `🧾 Active Trade: ${runtime.activeTradeKey ?? "-"}`,
  ].join("\n");
}

export function formatDailyReport(summary: {
  date: string;
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  netR: number;
}) {
  return [
    `📊 *NOLA-DELTA • DAILY REPORT*`,
    `Date: ${summary.date}`,
    ``,
    `Trades: ${summary.trades}`,
    `Wins: ${summary.wins} • Losses: ${summary.losses}`,
    `Win Rate: ${summary.winRatePct.toFixed(1)}%`,
    ``,
    `Net Result: ${summary.netR.toFixed(2)}R`,
  ].join("\n");
}

export function formatWeeklyReport(summary: {
  weekStart: string;
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  netR: number;
}) {
  return [
    `📈 *NOLA-DELTA • WEEKLY REPORT*`,
    `Week Start: ${summary.weekStart}`,
    ``,
    `Trades: ${summary.trades}`,
    `Wins: ${summary.wins} • Losses: ${summary.losses}`,
    `Win Rate: ${summary.winRatePct.toFixed(1)}%`,
    ``,
    `Net R: ${summary.netR.toFixed(2)}R`,
  ].join("\n");
}

export function formatDebugSnapshot(input: {
  runtime: EngineRuntimeSnapshot | null;
}) {
  const r = input.runtime;
  if (!r) {
    return [
      `🧪 *NOLA-DELTA • DEBUG*`,
      `No runtime snapshot yet.`,
    ].join("\n");
  }
  return [
    `🧪 *NOLA-DELTA • DEBUG*`,
    `EURUSD • M15 • ${toEat(r.lastCandleTs)}`,
    ``,
    `State: ${r.state}`,
    `Anchor: ${r.anchorLine ?? "-"}`,
    `Causal Extreme: ${r.causalExtreme ?? "-"}`,
    `D: ${r.impulsePips ?? "-"}p ${r.impulsePips == null ? "" : `(${dOk(r.impulsePips)})`}`,
    ``,
    `Mid: ${r.midpointLevel ?? "-"}`,
    `pullbackEnabled: ${r.pullbackStartIndex != null ? "✅" : "❌"}`,
    `pullbackConfirmed: ${r.pullbackConfirmIndex != null ? "✅" : "❌"}`,
    `PB_low: ${r.pbLow ?? "-"}`,
    `PB_high: ${r.pbHigh ?? "-"}`,
    ``,
    `lastFSH: ${r.lastFSHPrice ?? "-"}`,
    `lastFSL: ${r.lastFSLPrice ?? "-"}`,
  ].join("\n");
}

export function formatResetCycleAck() {
  return [
    `✅ *NOLA-DELTA*`,
    `Cycle reset complete.`,
    `State: WAIT_SWING_BOS`,
  ].join("\n");
}

export function formatUnauthorized() {
  return [
    `🔒 *NOLA-DELTA*`,
    `Unauthorized request detected.`,
    ``,
    `This bot is private.`,
  ].join("\n");
}

export function formatDataWarning(message: string) {
  return [
    `⚠️ *NOLA-DELTA • DATA WARNING*`,
    ``,
    message,
  ].join("\n");
}
