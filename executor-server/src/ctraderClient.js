import WebSocket from "ws";
import { log } from "./logger.js";

// Selected payload type IDs from cTrader Open API ProtoOAPayloadType enum.
const PT = {
  HEARTBEAT_EVENT: 51,
  ERROR_RES: 2142,
  APPLICATION_AUTH_REQ: 2100,
  APPLICATION_AUTH_RES: 2101,
  ACCOUNT_AUTH_REQ: 2102,
  ACCOUNT_AUTH_RES: 2103,
  NEW_ORDER_REQ: 2106,
  EXECUTION_EVENT: 2126,
  ORDER_ERROR_EVENT: 2132,
  SYMBOLS_LIST_REQ: 2114,
  SYMBOLS_LIST_RES: 2115,
  TRADER_REQ: 2121,
  TRADER_RES: 2122,
};

const ORDER_TYPE = {
  MARKET: 1,
};

const TRADE_SIDE = {
  BUY: 1,
  SELL: 2,
};

const EXEC_TYPE = {
  ORDER_ACCEPTED: 2,
  ORDER_FILLED: 3,
  ORDER_REJECTED: 4,
};

function toProtoVolume(units) {
  // cTrader Open API uses volume in cents of units (0.01 lot/units granularity depending symbol settings)
  return Math.round(units * 100);
}

function toRelativePriceDistance(priceDistance) {
  // cTrader Open API relative SL/TP for market orders is expressed in 1/100000 price units.
  return Math.round(Math.abs(priceDistance) * 100000);
}

export class CTraderApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "CTraderApiError";
    this.code = details.code || null;
    this.payloadType = details.payloadType || null;
    this.raw = details.raw || null;
  }
}

export class CTraderOpenApiClient {
  constructor(config) {
    this.config = config;
    this.ws = null;
    this.connected = false;
    this.authed = false;
    this.messageId = 1;
    this.pending = new Map();
    this.heartbeatTimer = null;
    this.symbolMap = null;
  }

  async ensureReady() {
    if (this.connected && this.authed && this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }
    await this.connectAndAuth();
  }

  async connectAndAuth() {
    await this.close();
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.config.wsUrl);
      this.ws = ws;
      const timeout = setTimeout(() => reject(new Error("cTrader WS connect timeout")), 10000);

      ws.on("open", () => {
        clearTimeout(timeout);
        this.connected = true;
        this.authed = false;
        this.startHeartbeat();
        resolve();
      });

      ws.on("message", (data) => {
        this.onRawMessage(data);
      });

      ws.on("close", () => {
        this.connected = false;
        this.authed = false;
        this.stopHeartbeat();
      });

      ws.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    await this.request(PT.APPLICATION_AUTH_REQ, {
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
    }, { expectPayloadType: PT.APPLICATION_AUTH_RES });

    await this.request(PT.ACCOUNT_AUTH_REQ, {
      ctidTraderAccountId: this.config.accountId,
      accessToken: this.config.accessToken,
    }, { expectPayloadType: PT.ACCOUNT_AUTH_RES });

    this.authed = true;
    log("cTrader websocket authenticated", { accountId: this.config.accountId, wsUrl: this.config.wsUrl });
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.sendFrame({ payloadType: PT.HEARTBEAT_EVENT, clientMsgId: `hb-${Date.now()}` });
    }, 15000);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  async close() {
    this.stopHeartbeat();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // noop
      }
    }
    this.ws = null;
    this.connected = false;
    this.authed = false;
    for (const [, pending] of this.pending) {
      pending.reject(new Error("Connection closed"));
    }
    this.pending.clear();
  }

  nextClientMsgId() {
    const id = String(this.messageId++);
    return id;
  }

  sendFrame(frame) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("cTrader WS not connected");
    }
    this.ws.send(JSON.stringify(frame));
  }

  onRawMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.payloadType === PT.HEARTBEAT_EVENT) {
      return;
    }

    const key = msg.clientMsgId ? String(msg.clientMsgId) : null;
    if (key && this.pending.has(key)) {
      const pending = this.pending.get(key);
      this.pending.delete(key);
      const payload = msg.payload ?? msg;
      if (msg.payloadType === PT.ERROR_RES || msg.payloadType === PT.ORDER_ERROR_EVENT) {
        pending.reject(new CTraderApiError(
          payload.description || payload.errorCode || "cTrader error",
          {
            code: payload.errorCode || payload.code || null,
            payloadType: msg.payloadType,
            raw: msg,
          },
        ));
        return;
      }
      if (pending.expectPayloadType && msg.payloadType !== pending.expectPayloadType && msg.payloadType !== PT.EXECUTION_EVENT) {
        pending.reject(new CTraderApiError(
          `Unexpected payloadType ${msg.payloadType}, expected ${pending.expectPayloadType}`,
          {
            payloadType: msg.payloadType,
            raw: msg,
          },
        ));
        return;
      }
      pending.resolve(msg);
      return;
    }
  }

  request(payloadType, payload, options = {}) {
    const clientMsgId = this.nextClientMsgId();
    const frame = {
      payloadType,
      clientMsgId,
      ...(payload && Object.keys(payload).length > 0 ? { payload } : {}),
    };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(clientMsgId);
        reject(new Error(`Timeout waiting for payloadType ${payloadType}`));
      }, options.timeoutMs || 15000);
      this.pending.set(clientMsgId, {
        expectPayloadType: options.expectPayloadType,
        resolve: (msg) => {
          clearTimeout(timeout);
          resolve(msg);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });
      this.sendFrame(frame);
    });
  }

  async placeMarketOrder({ requestKey, direction, entryPrice, stopLoss, takeProfit, symbolId, volumeUnits }) {
    await this.ensureReady();

    const side = direction === "LONG" ? TRADE_SIDE.BUY : TRADE_SIDE.SELL;
    const volume = toProtoVolume(volumeUnits);
    // For market orders cTrader expects relative SL/TP distances, not absolute prices.
    // Distances are derived from the planned strategy entry (provided by caller).
    // Caller passes absolute stop/take; we convert to relative before submit.
    // Actual fill may differ due to slippage, but this is accepted by cTrader and keeps protection attached.
    if (!Number.isFinite(entryPrice)) {
      throw new CTraderApiError("Market order requires entryPrice to compute relative SL/TP", {
        code: "MISSING_ENTRY_PRICE",
      });
    }
    const relativeStopLoss = toRelativePriceDistance(Number(entryPrice) - Number(stopLoss));
    const relativeTakeProfit = toRelativePriceDistance(Number(takeProfit) - Number(entryPrice));

    const res = await this.request(
      PT.NEW_ORDER_REQ,
      {
        ctidTraderAccountId: this.config.accountId,
        symbolId,
        orderType: ORDER_TYPE.MARKET,
        tradeSide: side,
        volume,
        relativeStopLoss,
        relativeTakeProfit,
        label: `sig:${requestKey}`.slice(0, 45),
        comment: `supabase:${requestKey}`.slice(0, 100),
      },
      { expectPayloadType: PT.EXECUTION_EVENT, timeoutMs: 20000 },
    );
    const body = res.payload ?? res;

    return {
      accepted: [EXEC_TYPE.ORDER_ACCEPTED, EXEC_TYPE.ORDER_FILLED].includes(Number(body.executionType)),
      executionType: body.executionType ?? null,
      orderId: body.order?.orderId ?? body.orderId ?? null,
      positionId: body.position?.positionId ?? body.positionId ?? null,
      relativeStopLoss,
      relativeTakeProfit,
      raw: res,
    };
  }

  async getTraderSnapshot() {
    await this.ensureReady();
    const res = await this.request(
      PT.TRADER_REQ,
      { ctidTraderAccountId: this.config.accountId },
      { expectPayloadType: PT.TRADER_RES, timeoutMs: 15000 },
    );

    const body = res.payload ?? res;
    const trader = body.trader ?? body;
    return {
      balance: trader.balance != null ? Number(trader.balance) : null,
      equity: trader.equity != null ? Number(trader.equity) : null,
      depositAssetId: trader.depositAssetId != null ? Number(trader.depositAssetId) : null,
      raw: res,
    };
  }

  async listSymbols() {
    await this.ensureReady();
    const res = await this.request(
      PT.SYMBOLS_LIST_REQ,
      { ctidTraderAccountId: this.config.accountId },
      { expectPayloadType: PT.SYMBOLS_LIST_RES, timeoutMs: 20000 },
    );

    const body = res.payload ?? res;
    const symbols = Array.isArray(body.symbol) ? body.symbol : (Array.isArray(body.symbols) ? body.symbols : []);
    return {
      count: symbols.length,
      symbols,
      raw: res,
    };
  }
}
