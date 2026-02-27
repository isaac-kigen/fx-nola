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
    }) + " EAT";
  } catch {
    return ts;
  }
}

function dirEmoji(direction: string): string {
  return direction === "LONG" ? "🟢" : "🔴";
}

export function menuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "Status", callback_data: "status" },
        { text: "Analysis", callback_data: "analysis" },
      ],
      [
        { text: "Trade", callback_data: "trade" },
        { text: "Last Signal", callback_data: "last_signal" },
      ],
      [
        { text: "Daily", callback_data: "daily" },
        { text: "Weekly", callback_data: "weekly" },
      ],
      [
        { text: "Debug", callback_data: "debug" },
        { text: "Reset Cycle", callback_data: "reset_cycle" },
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
}) {
  const dOk = input.impulsePips >= 20 ? ">=20 ✅" : "<20 ❌";
  return [
    `${dirEmoji(input.direction)} *Signal Detected*`,
    `Pair: *${input.symbol}* (${input.timeframe})`,
    `Direction: *${input.direction}*`,
    `Trigger (EAT): \`${toEat(input.triggerTime)}\``,
    `Entry Next Open: ${input.plannedEntryPrice == null ? "*pending*" : `\`${input.plannedEntryPrice}\` @ \`${toEat(input.plannedEntryTime)}\``}`,
    `SL: \`${input.stopLoss}\``,
    `TP: \`${input.takeProfit}\``,
    `D: \`${input.impulsePips}\` pips (${dOk})`,
    `Midpoint: \`${input.pbLevel}\``,
    `Signal ID: \`${input.signalKey}\``,
  ].join("\n");
}

export function formatSignalArmed(signalKey: string, plannedEntryTime: string | null) {
  return [
    `🧭 *Signal Armed*`,
    `Signal ID: \`${signalKey}\``,
    `Planned Entry (EAT): \`${toEat(plannedEntryTime)}\``,
  ].join("\n");
}

export function formatTradeExecuted(input: {
  signalKey: string;
  direction: string;
  entryPrice: number | null;
  stopLoss: number;
  takeProfit: number;
  orderId: string | null;
  positionId: string | null;
}) {
  return [
    `🚀 *Trade Executed*`,
    `Direction: *${input.direction}*`,
    `Entry: \`${input.entryPrice ?? "-"}\``,
    `SL: \`${input.stopLoss}\``,
    `TP: \`${input.takeProfit}\``,
    `Order ID: \`${input.orderId ?? "-"}\``,
    `Position ID: \`${input.positionId ?? "-"}\``,
    `Signal ID: \`${input.signalKey}\``,
  ].join("\n");
}

export function formatTradeClosedTP(input: {
  signalKey: string;
  exitTime: string | null;
  exitPrice: number | null;
  rMultiple: number | null;
}) {
  return [
    `🎯 *Trade Closed (TP)*`,
    `Exit (EAT): \`${toEat(input.exitTime)}\``,
    `Exit Price: \`${input.exitPrice ?? "-"}\``,
    `R: \`${input.rMultiple ?? "-"}\``,
    `Signal ID: \`${input.signalKey}\``,
  ].join("\n");
}

export function formatTradeClosedSL(input: {
  signalKey: string;
  exitTime: string | null;
  exitPrice: number | null;
  rMultiple: number | null;
}) {
  return [
    `🛑 *Trade Closed (SL)*`,
    `Exit (EAT): \`${toEat(input.exitTime)}\``,
    `Exit Price: \`${input.exitPrice ?? "-"}\``,
    `R: \`${input.rMultiple ?? "-"}\``,
    `Signal ID: \`${input.signalKey}\``,
  ].join("\n");
}

export function formatStructureFlip(input: {
  at: string;
  from: string;
  to: string;
  reason: string;
}) {
  return [
    `🔁 *Structure Flip*`,
    `At (EAT): \`${toEat(input.at)}\``,
    `From: *${input.from}*`,
    `To: *${input.to}*`,
    `Reason: ${input.reason}`,
  ].join("\n");
}

export function formatCycleDiscarded(input: {
  at: string;
  direction: string;
  impulsePips: number;
  minImpulsePips: number;
}) {
  return [
    `⚠️ *Cycle Discarded*`,
    `At (EAT): \`${toEat(input.at)}\``,
    `Direction: *${input.direction}*`,
    `Impulse: \`${input.impulsePips}\` pips`,
    `Required: \`${input.minImpulsePips}\` pips`,
  ].join("\n");
}

export function formatStatus(runtime: EngineRuntimeSnapshot) {
  return [
    `📊 *Status*`,
    `State: *${runtime.state}*`,
    `Bias: *${runtime.bias}*`,
    `Last Candle (EAT): \`${toEat(runtime.lastCandleTs)}\``,
    `Last FSH: \`${runtime.lastFSHPrice ?? "-"}\``,
    `Last FSL: \`${runtime.lastFSLPrice ?? "-"}\``,
    `Midpoint: \`${runtime.midpointLevel ?? "-"}\``,
    `Impulse: \`${runtime.impulsePips ?? "-"}\``,
  ].join("\n");
}

export function formatAnalysis(runtime: EngineRuntimeSnapshot) {
  return [
    `🧠 *Analysis*`,
    `State: *${runtime.state}*`,
    `Bias: *${runtime.bias}*`,
    `Anchor line/index: \`${runtime.anchorLine ?? "-"}\` / \`${runtime.anchorIndex ?? "-"}\``,
    `Causal extreme/index: \`${runtime.causalExtreme ?? "-"}\` / \`${runtime.causalExtremeIndex ?? "-"}\``,
    `PB level: \`${runtime.midpointLevel ?? "-"}\``,
    `PB low/high: \`${runtime.pbLow ?? "-"}\` / \`${runtime.pbHigh ?? "-"}\``,
    `S low/high: \`${runtime.sLow ?? "-"}\` / \`${runtime.sHigh ?? "-"}\``,
    `PB start/confirm idx: \`${runtime.pullbackStartIndex ?? "-"}\` / \`${runtime.pullbackConfirmIndex ?? "-"}\``,
    `Active trade: \`${runtime.activeTradeKey ?? "-"}\``,
  ].join("\n");
}

export function formatDailyReport(summary: {
  date: string;
  signals: number;
  executed: number;
  tp: number;
  sl: number;
}) {
  return [
    `📅 *Daily Report* (${summary.date})`,
    `Signals: \`${summary.signals}\``,
    `Executed: \`${summary.executed}\``,
    `TP: \`${summary.tp}\``,
    `SL: \`${summary.sl}\``,
  ].join("\n");
}

export function formatWeeklyReport(summary: {
  weekStart: string;
  signals: number;
  executed: number;
  tp: number;
  sl: number;
}) {
  return [
    `🗓️ *Weekly Report* (from ${summary.weekStart})`,
    `Signals: \`${summary.signals}\``,
    `Executed: \`${summary.executed}\``,
    `TP: \`${summary.tp}\``,
    `SL: \`${summary.sl}\``,
  ].join("\n");
}

export function formatDebugSnapshot(input: {
  runtimeUpdatedAt: string | null;
  lastSignalKey: string | null;
  lastOrderRequestStatus: string | null;
}) {
  return [
    `🛠️ *Debug Snapshot*`,
    `Runtime updated: \`${toEat(input.runtimeUpdatedAt)}\``,
    `Last signal: \`${input.lastSignalKey ?? "-"}\``,
    `Last order request status: \`${input.lastOrderRequestStatus ?? "-"}\``,
  ].join("\n");
}

export function formatUnauthorized() {
  return `⛔ Unauthorized chat`;
}

export function formatDataWarning(message: string) {
  return `⚠️ ${message}`;
}
