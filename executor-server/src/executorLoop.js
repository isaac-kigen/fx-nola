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

export class BrokerExecutor {
  constructor({ supabase, ctraderClient, config }) {
    this.supabase = supabase;
    this.ctraderClient = ctraderClient;
    this.config = config;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((e) => err("executor tick failed", e));
    }, this.config.pollIntervalMs);
    this.tick().catch((e) => err("executor startup tick failed", e));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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
          last_attempt_at: nowIso(),
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
