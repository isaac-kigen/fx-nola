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
};
