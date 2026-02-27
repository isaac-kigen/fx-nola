export type Direction = "LONG" | "SHORT";

export type Candle = {
  ts: string; // ISO timestamp UTC
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number | null;
};

export type FractalType = "FSH" | "FSL";

export type Fractal = {
  type: FractalType;
  index: number; // candle index of fractal pivot
  price: number;
  confirmedAtIndex: number; // confirmation occurs when index+1 candle closes
};

export type EngineSignal = {
  signalKey: string;
  strategyCode: string;
  symbol: string;
  timeframe: string;
  direction: Direction;
  bosTime: string;
  triggerTime: string;
  plannedEntryTime: string | null;
  plannedEntryPrice: number | null;
  entryStatus: "pending_next_open" | "known_next_open";
  stopLoss: number;
  takeProfit: number;
  impulsePips: number;
  anchorLine: number; // B_line for shorts, A_line for longs
  causalExtreme: number; // H for shorts, L for longs
  pbLevel: number;
  pullbackSwingTarget: number; // S_low or S_high
  causeFractalType: FractalType;
  causeFractalIndex: number;
  triggerCandleIndex: number;
  metrics: {
    bosToPullbackStartCandles: number;
    pullbackStartToConfirmCandles: number;
    confirmToTriggerCandles: number;
  };
  payload: Record<string, unknown>;
};

export type EngineTrade = {
  tradeKey: string;
  signalKey: string;
  symbol: string;
  timeframe: string;
  direction: Direction;
  entryTime: string;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  exitTime: string | null;
  exitPrice: number | null;
  exitReason: "TP" | "SL" | null;
  rMultiple: number | null;
  status: "OPEN" | "CLOSED";
  payload: Record<string, unknown>;
};

export type EngineRunResult = {
  signals: EngineSignal[];
  trades: EngineTrade[];
  runtime: EngineRuntimeSnapshot;
  events: EngineEvent[];
};

export type EngineRuntimeSnapshot = {
  strategyCode: string;
  symbol: string;
  timeframe: string;
  bias: "BULLISH" | "BEARISH" | "NEUTRAL";
  state:
    | "WAIT_SWING_BOS"
    | "BEAR_WAIT_PULLBACK_START"
    | "BEAR_TRACK_PULLBACK"
    | "BEAR_WAIT_CONTINUATION_TRIGGER"
    | "BULL_WAIT_PULLBACK_START"
    | "BULL_TRACK_PULLBACK"
    | "BULL_WAIT_CONTINUATION_TRIGGER"
    | "IN_TRADE";
  lastCandleTs: string | null;
  lastFSHPrice: number | null;
  lastFSLPrice: number | null;
  anchorLine: number | null;
  anchorIndex: number | null;
  causalExtreme: number | null;
  causalExtremeIndex: number | null;
  midpointLevel: number | null;
  impulsePips: number | null;
  pullbackStartIndex: number | null;
  pullbackConfirmIndex: number | null;
  pbLow: number | null;
  pbHigh: number | null;
  sLow: number | null;
  sHigh: number | null;
  activeTradeKey: string | null;
};

export type EngineEvent =
  | {
    type: "STRUCTURE_FLIP";
    at: string;
    from: "BEARISH" | "BULLISH";
    to: "BEARISH" | "BULLISH";
    reason: string;
  }
  | {
    type: "CYCLE_DISCARDED";
    at: string;
    direction: "LONG" | "SHORT";
    impulsePips: number;
    minImpulsePips: number;
  };
