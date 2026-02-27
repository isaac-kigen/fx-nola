import type {
  Candle,
  EngineEvent,
  EngineRunResult,
  EngineRuntimeSnapshot,
  EngineSignal,
  EngineTrade,
  Fractal,
  FractalType,
} from "./types.ts";

const PIP = 0.0001;
const SL_BUFFER = 3 * PIP;
const D_MIN = 20 * PIP;
const STRATEGY_CODE = "eurusd_m15_continuation_v1";

type State =
  | "WAIT_SWING_BOS"
  | "BEAR_WAIT_PULLBACK_START"
  | "BEAR_TRACK_PULLBACK"
  | "BEAR_WAIT_CONTINUATION_TRIGGER"
  | "BULL_WAIT_PULLBACK_START"
  | "BULL_TRACK_PULLBACK"
  | "BULL_WAIT_CONTINUATION_TRIGGER"
  | "IN_TRADE";

type OpenTradeRuntime = {
  trade: EngineTrade;
  signal: EngineSignal;
  entryIndex: number;
};

function roundPx(n: number): number {
  return Number(n.toFixed(6));
}

function roundPips(n: number): number {
  return Number(n.toFixed(2));
}

function confirmFractalAt(candles: Candle[], pivotIndex: number): Fractal | null {
  if (pivotIndex - 1 < 0 || pivotIndex + 1 >= candles.length) return null;
  const prev = candles[pivotIndex - 1];
  const cur = candles[pivotIndex];
  const next = candles[pivotIndex + 1];

  if (cur.high > prev.high && cur.high > next.high) {
    return {
      type: "FSH",
      index: pivotIndex,
      price: cur.high,
      confirmedAtIndex: pivotIndex + 1,
    };
  }
  if (cur.low < prev.low && cur.low < next.low) {
    return {
      type: "FSL",
      index: pivotIndex,
      price: cur.low,
      confirmedAtIndex: pivotIndex + 1,
    };
  }
  return null;
}

function lastConfirmedOfType(
  confirmedFractals: Fractal[],
  type: FractalType,
  currentCandleIndex: number,
  pivotStrictlyBeforeCurrent = false,
): Fractal | null {
  for (let i = confirmedFractals.length - 1; i >= 0; i--) {
    const f = confirmedFractals[i];
    if (f.type !== type) continue;
    if (f.confirmedAtIndex > currentCandleIndex) continue;
    if (pivotStrictlyBeforeCurrent && f.index >= currentCandleIndex) continue;
    return f;
  }
  return null;
}

function buildSignalKey(symbol: string, timeframe: string, direction: string, triggerTime: string): string {
  return `${STRATEGY_CODE}:${symbol}:${timeframe}:${direction}:${triggerTime}`;
}

function buildTradeKey(signalKey: string): string {
  return `${signalKey}:trade`;
}

function computeBias(state: State): "BULLISH" | "BEARISH" | "NEUTRAL" {
  if (state.startsWith("BEAR")) return "BEARISH";
  if (state.startsWith("BULL")) return "BULLISH";
  return "NEUTRAL";
}

export function runContinuationStrategy(params: {
  symbol: string;
  timeframe: string;
  candles: Candle[];
}): EngineRunResult {
  const { symbol, timeframe, candles } = params;
  const signals: EngineSignal[] = [];
  const trades: EngineTrade[] = [];
  const events: EngineEvent[] = [];

  let state: State = "WAIT_SWING_BOS";
  let tradeRuntime: OpenTradeRuntime | null = null;

  const confirmedFractals: Fractal[] = [];
  let lastFSH: Fractal | null = null;
  let lastFSL: Fractal | null = null;

  // Cycle runtime
  let tBos = -1;
  let anchorLine = 0;
  let anchorIndex = -1;
  let causalExtreme = 0;
  let causalExtremeIndex = -1;
  let pbLevel = 0;
  let impulsePips = 0;
  let pullbackStartIndex = -1;
  let pullbackConfirmIndex = -1;
  let pbLow = Number.POSITIVE_INFINITY;
  let pbHigh = Number.NEGATIVE_INFINITY;
  let sLow = Number.NaN;
  let sHigh = Number.NaN;

  function resetCycle() {
    state = "WAIT_SWING_BOS";
    tBos = -1;
    anchorLine = 0;
    anchorIndex = -1;
    causalExtreme = 0;
    causalExtremeIndex = -1;
    pbLevel = 0;
    impulsePips = 0;
    pullbackStartIndex = -1;
    pullbackConfirmIndex = -1;
    pbLow = Number.POSITIVE_INFINITY;
    pbHigh = Number.NEGATIVE_INFINITY;
    sLow = Number.NaN;
    sHigh = Number.NaN;
  }

  function startBearCycleFromBosDown(t: number, bLine: number, bIndex: number): boolean {
    tBos = t;
    anchorLine = bLine;
    anchorIndex = bIndex;
    let h = -Infinity;
    let hIndex = bIndex;
    for (let k = bIndex; k <= t; k++) {
      if (candles[k].high > h) {
        h = candles[k].high;
        hIndex = k;
      }
    }
    causalExtreme = h;
    causalExtremeIndex = hIndex;
    const d = h - bLine;
    if (d < D_MIN) {
      events.push({
        type: "CYCLE_DISCARDED",
        at: candles[t].ts,
        direction: "SHORT",
        impulsePips: roundPips(d / PIP),
        minImpulsePips: roundPips(D_MIN / PIP),
      });
      resetCycle();
      return false;
    }
    impulsePips = roundPips(d / PIP);
    pbLevel = (bLine + h) / 2;
    pbLow = Number.POSITIVE_INFINITY;
    sLow = Number.NaN;
    state = "BEAR_WAIT_PULLBACK_START";
    return true;
  }

  function startBullCycleFromBosUp(t: number, aLine: number, aIndex: number): boolean {
    tBos = t;
    anchorLine = aLine;
    anchorIndex = aIndex;
    let l = Infinity;
    let lIndex = aIndex;
    for (let k = aIndex; k <= t; k++) {
      if (candles[k].low < l) {
        l = candles[k].low;
        lIndex = k;
      }
    }
    causalExtreme = l;
    causalExtremeIndex = lIndex;
    const d = aLine - l;
    if (d < D_MIN) {
      events.push({
        type: "CYCLE_DISCARDED",
        at: candles[t].ts,
        direction: "LONG",
        impulsePips: roundPips(d / PIP),
        minImpulsePips: roundPips(D_MIN / PIP),
      });
      resetCycle();
      return false;
    }
    impulsePips = roundPips(d / PIP);
    pbLevel = (aLine + l) / 2;
    pbHigh = Number.NEGATIVE_INFINITY;
    sHigh = Number.NaN;
    state = "BULL_WAIT_PULLBACK_START";
    return true;
  }

  function simulateOpenTradeAtCandle(t: number): void {
    if (!tradeRuntime) return;
    const c = candles[t];
    const tr = tradeRuntime.trade;

    if (t < tradeRuntime.entryIndex) return;
    if (tr.status !== "OPEN") return;

    if (tr.direction === "LONG") {
      const hitsSl = c.low <= tr.stopLoss;
      const hitsTp = c.high >= tr.takeProfit;
      if (!hitsSl && !hitsTp) return;
      const slFirst = hitsSl && hitsTp ? true : hitsSl;
      tr.exitTime = c.ts;
      tr.exitPrice = slFirst ? tr.stopLoss : tr.takeProfit;
      tr.exitReason = slFirst ? "SL" : "TP";
      const risk = tr.entryPrice - tr.stopLoss;
      const reward = tr.exitPrice - tr.entryPrice;
      tr.rMultiple = risk > 0 ? roundPips(reward / risk) : null;
      tr.status = "CLOSED";
      tradeRuntime = null;
      resetCycle();
      return;
    }

    const hitsSl = c.high >= tr.stopLoss;
    const hitsTp = c.low <= tr.takeProfit;
    if (!hitsSl && !hitsTp) return;
    const slFirst = hitsSl && hitsTp ? true : hitsSl;
    tr.exitTime = c.ts;
    tr.exitPrice = slFirst ? tr.stopLoss : tr.takeProfit;
    tr.exitReason = slFirst ? "SL" : "TP";
    const risk = tr.stopLoss - tr.entryPrice;
    const reward = tr.entryPrice - (tr.exitPrice ?? tr.entryPrice);
    tr.rMultiple = risk > 0 ? roundPips(reward / risk) : null;
    tr.status = "CLOSED";
    tradeRuntime = null;
    resetCycle();
  }

  for (let t = 0; t < candles.length; t++) {
    const fractal = confirmFractalAt(candles, t - 1);
    if (fractal && fractal.confirmedAtIndex === t) {
      confirmedFractals.push(fractal);
      if (fractal.type === "FSH") lastFSH = fractal;
      if (fractal.type === "FSL") lastFSL = fractal;
    }

    if (state === "IN_TRADE") {
      simulateOpenTradeAtCandle(t);
      if (state === "IN_TRADE") continue;
    }

    const c = candles[t];

    switch (state) {
      case "WAIT_SWING_BOS": {
        if (lastFSL && c.close < lastFSL.price) {
          startBearCycleFromBosDown(t, lastFSL.price, lastFSL.index);
          break;
        }
        if (lastFSH && c.close > lastFSH.price) {
          startBullCycleFromBosUp(t, lastFSH.price, lastFSH.index);
        }
        break;
      }

      case "BEAR_WAIT_PULLBACK_START": {
        if (lastFSH && c.close > lastFSH.price) {
          pullbackStartIndex = t;
          pbLow = c.low;
          state = "BEAR_TRACK_PULLBACK";
        }
        break;
      }

      case "BEAR_TRACK_PULLBACK": {
        pbLow = Math.min(pbLow, c.low);
        if (c.close > pbLevel) {
          sLow = pbLow;
          pullbackConfirmIndex = t;
          state = "BEAR_WAIT_CONTINUATION_TRIGGER";
        }
        break;
      }

      case "BEAR_WAIT_CONTINUATION_TRIGGER": {
        if (c.close > causalExtreme && causalExtremeIndex >= 0) {
          events.push({
            type: "STRUCTURE_FLIP",
            at: c.ts,
            from: "BEARISH",
            to: "BULLISH",
            reason: "Close above bearish causal extreme (H)",
          });
          startBullCycleFromBosUp(t, causalExtreme, causalExtremeIndex);
          break;
        }
        if (!lastFSL || c.close >= lastFSL.price) break;

        const causeFSH = lastConfirmedOfType(confirmedFractals, "FSH", t, true);
        if (!causeFSH || !Number.isFinite(sLow)) {
          resetCycle();
          break;
        }

        const signalKey = buildSignalKey(symbol, timeframe, "SHORT", c.ts);
        const plannedEntryTime = candles[t + 1]?.ts ?? null;
        const plannedEntryPrice = candles[t + 1] ? roundPx(candles[t + 1].open) : null;
        const stopLoss = roundPx(causeFSH.price + SL_BUFFER);
        const takeProfit = roundPx(sLow);

        const signal: EngineSignal = {
          signalKey,
          strategyCode: STRATEGY_CODE,
          symbol,
          timeframe,
          direction: "SHORT",
          bosTime: candles[tBos].ts,
          triggerTime: c.ts,
          plannedEntryTime,
          plannedEntryPrice,
          entryStatus: plannedEntryPrice == null ? "pending_next_open" : "known_next_open",
          stopLoss,
          takeProfit,
          impulsePips,
          anchorLine: roundPx(anchorLine),
          causalExtreme: roundPx(causalExtreme),
          pbLevel: roundPx(pbLevel),
          pullbackSwingTarget: roundPx(sLow),
          causeFractalType: "FSH",
          causeFractalIndex: causeFSH.index,
          triggerCandleIndex: t,
          metrics: {
            bosToPullbackStartCandles: pullbackStartIndex - tBos,
            pullbackStartToConfirmCandles: pullbackConfirmIndex - pullbackStartIndex,
            confirmToTriggerCandles: t - pullbackConfirmIndex,
          },
          payload: { stateMachine: "BEAR" },
        };
        signals.push(signal);

        if (candles[t + 1]) {
          const trade: EngineTrade = {
            tradeKey: buildTradeKey(signalKey),
            signalKey,
            symbol,
            timeframe,
            direction: "SHORT",
            entryTime: candles[t + 1].ts,
            entryPrice: roundPx(candles[t + 1].open),
            stopLoss,
            takeProfit,
            exitTime: null,
            exitPrice: null,
            exitReason: null,
            rMultiple: null,
            status: "OPEN",
            payload: { entryIndex: t + 1, triggerIndex: t },
          };
          trades.push(trade);
          tradeRuntime = { trade, signal, entryIndex: t + 1 };
          state = "IN_TRADE";
        } else {
          resetCycle();
        }
        break;
      }

      case "BULL_WAIT_PULLBACK_START": {
        if (lastFSL && c.close < lastFSL.price) {
          pullbackStartIndex = t;
          pbHigh = c.high;
          state = "BULL_TRACK_PULLBACK";
        }
        break;
      }

      case "BULL_TRACK_PULLBACK": {
        pbHigh = Math.max(pbHigh, c.high);
        if (c.close < pbLevel) {
          sHigh = pbHigh;
          pullbackConfirmIndex = t;
          state = "BULL_WAIT_CONTINUATION_TRIGGER";
        }
        break;
      }

      case "BULL_WAIT_CONTINUATION_TRIGGER": {
        if (c.close < causalExtreme && causalExtremeIndex >= 0) {
          events.push({
            type: "STRUCTURE_FLIP",
            at: c.ts,
            from: "BULLISH",
            to: "BEARISH",
            reason: "Close below bullish causal extreme (L)",
          });
          startBearCycleFromBosDown(t, causalExtreme, causalExtremeIndex);
          break;
        }
        if (!lastFSH || c.close <= lastFSH.price) break;

        const causeFSL = lastConfirmedOfType(confirmedFractals, "FSL", t, true);
        if (!causeFSL || !Number.isFinite(sHigh)) {
          resetCycle();
          break;
        }

        const signalKey = buildSignalKey(symbol, timeframe, "LONG", c.ts);
        const plannedEntryTime = candles[t + 1]?.ts ?? null;
        const plannedEntryPrice = candles[t + 1] ? roundPx(candles[t + 1].open) : null;
        const stopLoss = roundPx(causeFSL.price - SL_BUFFER);
        const takeProfit = roundPx(sHigh);

        const signal: EngineSignal = {
          signalKey,
          strategyCode: STRATEGY_CODE,
          symbol,
          timeframe,
          direction: "LONG",
          bosTime: candles[tBos].ts,
          triggerTime: c.ts,
          plannedEntryTime,
          plannedEntryPrice,
          entryStatus: plannedEntryPrice == null ? "pending_next_open" : "known_next_open",
          stopLoss,
          takeProfit,
          impulsePips,
          anchorLine: roundPx(anchorLine),
          causalExtreme: roundPx(causalExtreme),
          pbLevel: roundPx(pbLevel),
          pullbackSwingTarget: roundPx(sHigh),
          causeFractalType: "FSL",
          causeFractalIndex: causeFSL.index,
          triggerCandleIndex: t,
          metrics: {
            bosToPullbackStartCandles: pullbackStartIndex - tBos,
            pullbackStartToConfirmCandles: pullbackConfirmIndex - pullbackStartIndex,
            confirmToTriggerCandles: t - pullbackConfirmIndex,
          },
          payload: { stateMachine: "BULL" },
        };
        signals.push(signal);

        if (candles[t + 1]) {
          const trade: EngineTrade = {
            tradeKey: buildTradeKey(signalKey),
            signalKey,
            symbol,
            timeframe,
            direction: "LONG",
            entryTime: candles[t + 1].ts,
            entryPrice: roundPx(candles[t + 1].open),
            stopLoss,
            takeProfit,
            exitTime: null,
            exitPrice: null,
            exitReason: null,
            rMultiple: null,
            status: "OPEN",
            payload: { entryIndex: t + 1, triggerIndex: t },
          };
          trades.push(trade);
          tradeRuntime = { trade, signal, entryIndex: t + 1 };
          state = "IN_TRADE";
        } else {
          resetCycle();
        }
        break;
      }

      case "IN_TRADE":
        break;
    }
  }

  const lastCandleTs = candles.length > 0 ? candles[candles.length - 1].ts : null;
  const runtime: EngineRuntimeSnapshot = {
    strategyCode: STRATEGY_CODE,
    symbol,
    timeframe,
    bias: state === "IN_TRADE"
      ? (tradeRuntime?.signal.direction === "LONG" ? "BULLISH" : "BEARISH")
      : computeBias(state),
    state,
    lastCandleTs,
    lastFSHPrice: lastFSH ? roundPx(lastFSH.price) : null,
    lastFSLPrice: lastFSL ? roundPx(lastFSL.price) : null,
    anchorLine: anchorIndex >= 0 ? roundPx(anchorLine) : null,
    anchorIndex: anchorIndex >= 0 ? anchorIndex : null,
    causalExtreme: causalExtremeIndex >= 0 ? roundPx(causalExtreme) : null,
    causalExtremeIndex: causalExtremeIndex >= 0 ? causalExtremeIndex : null,
    midpointLevel: anchorIndex >= 0 ? roundPx(pbLevel) : null,
    impulsePips: anchorIndex >= 0 ? impulsePips : null,
    pullbackStartIndex: pullbackStartIndex >= 0 ? pullbackStartIndex : null,
    pullbackConfirmIndex: pullbackConfirmIndex >= 0 ? pullbackConfirmIndex : null,
    pbLow: Number.isFinite(pbLow) ? roundPx(pbLow) : null,
    pbHigh: Number.isFinite(pbHigh) ? roundPx(pbHigh) : null,
    sLow: Number.isFinite(sLow) ? roundPx(sLow) : null,
    sHigh: Number.isFinite(sHigh) ? roundPx(sHigh) : null,
    activeTradeKey: tradeRuntime?.trade.tradeKey ?? null,
  };

  return { signals, trades, runtime, events };
}
