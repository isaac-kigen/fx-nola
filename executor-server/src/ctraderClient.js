import WebSocket from "ws";
import { log } from "./logger.js";

// Selected payload type IDs from cTrader Open API ProtoOAPayloadType enum.
const PT = {
  HEARTBEAT_EVENT: 51,
  ERROR_RES: 2142,
  APPLICATION_AUTH_REQ: 2104,
  APPLICATION_AUTH_RES: 2105,
  ACCOUNT_AUTH_REQ: 2107,
  ACCOUNT_AUTH_RES: 2108,
  NEW_ORDER_REQ: 2106,
  EXECUTION_EVENT: 2126,
  ORDER_ERROR_EVENT: 2132,
  SYMBOLS_LIST_REQ: 2114,
  SYMBOLS_LIST_RES: 2115,
  TRADER_REQ: 2118,
  TRADER_RES: 2119,
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
      if (msg.payloadType === PT.ERROR_RES || msg.payloadType === PT.ORDER_ERROR_EVENT) {
        pending.reject(new Error(msg.description || msg.errorCode || "cTrader error"));
        return;
      }
      if (pending.expectPayloadType && msg.payloadType !== pending.expectPayloadType && msg.payloadType !== PT.EXECUTION_EVENT) {
        pending.reject(
          new Error(`Unexpected payloadType ${msg.payloadType}, expected ${pending.expectPayloadType}`),
        );
        return;
      }
      pending.resolve(msg);
      return;
    }
  }

  request(payloadType, payload, options = {}) {
    const clientMsgId = this.nextClientMsgId();
    const frame = { payloadType, clientMsgId, ...payload };
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

  async placeMarketOrder({ requestKey, direction, stopLoss, takeProfit, symbolId, volumeUnits }) {
    await this.ensureReady();

    const side = direction === "LONG" ? TRADE_SIDE.BUY : TRADE_SIDE.SELL;
    const volume = toProtoVolume(volumeUnits);

    const res = await this.request(
      PT.NEW_ORDER_REQ,
      {
        ctidTraderAccountId: this.config.accountId,
        symbolId,
        orderType: ORDER_TYPE.MARKET,
        tradeSide: side,
        volume,
        stopLoss,
        takeProfit,
        label: `sig:${requestKey}`.slice(0, 45),
        comment: `supabase:${requestKey}`.slice(0, 100),
      },
      { expectPayloadType: PT.EXECUTION_EVENT, timeoutMs: 20000 },
    );

    return {
      accepted: [EXEC_TYPE.ORDER_ACCEPTED, EXEC_TYPE.ORDER_FILLED].includes(Number(res.executionType)),
      executionType: res.executionType ?? null,
      orderId: res.order?.orderId ?? res.orderId ?? null,
      positionId: res.position?.positionId ?? res.positionId ?? null,
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

    const trader = res.trader ?? res;
    return {
      balance: trader.balance != null ? Number(trader.balance) : null,
      equity: trader.equity != null ? Number(trader.equity) : null,
      depositAssetId: trader.depositAssetId != null ? Number(trader.depositAssetId) : null,
      raw: res,
    };
  }
}
