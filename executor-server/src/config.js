function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

function optionalInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalNumber(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalEnum(name, fallback, allowed) {
  const raw = process.env[name];
  if (!raw) return fallback;
  return allowed.includes(raw) ? raw : fallback;
}

function requiredNumber(name) {
  const raw = required(name);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric env ${name}: ${raw}`);
  }
  return parsed;
}

export function getConfig() {
  const environment = process.env.CTRADER_ENVIRONMENT || "demo";
  const host = environment === "live"
    ? "wss://live.ctraderapi.com:5036"
    : "wss://demo.ctraderapi.com:5036";

  return {
    port: optionalInt("PORT", 8787),
    webhookSecret: process.env.EXECUTOR_WEBHOOK_SECRET || "",
    supabaseUrl: required("SUPABASE_URL"),
    supabaseServiceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN || "",
      chatId: process.env.TELEGRAM_CHAT_ID || "",
    },
    pollIntervalMs: optionalInt("CTRADER_POLL_INTERVAL_MS", 5000),
    risk: {
      positionSizingMode: optionalEnum(
        "CTRADER_POSITION_SIZING_MODE",
        "risk_percent",
        ["risk_percent", "fixed"],
      ),
      riskPercent: optionalNumber("CTRADER_RISK_PERCENT", 1),
      riskReference: optionalEnum(
        "CTRADER_RISK_REFERENCE",
        "balance",
        ["balance", "equity"],
      ),
      accountCurrency: (process.env.CTRADER_ACCOUNT_CURRENCY || "USD").toUpperCase(),
      volumeStepUnits: optionalNumber("CTRADER_VOLUME_STEP_UNITS", 1000),
      minVolumeUnits: optionalNumber("CTRADER_MIN_VOLUME_UNITS", 1000),
      maxVolumeUnits: optionalNumber("CTRADER_MAX_VOLUME_UNITS", 1_000_000),
      marketSlippageBufferPercent: optionalNumber("CTRADER_MARKET_SLIPPAGE_BUFFER_PERCENT", 0.1),
    },
    ctrader: {
      wsUrl: process.env.CTRADER_WS_URL || host,
      clientId: required("CTRADER_APP_CLIENT_ID"),
      clientSecret: required("CTRADER_APP_CLIENT_SECRET"),
      accessToken: required("CTRADER_ACCESS_TOKEN"),
      refreshToken: required("CTRADER_REFRESH_TOKEN"),
      accountId: requiredNumber("CTRADER_ACCOUNT_ID"),
      symbolId: requiredNumber("CTRADER_SYMBOL_ID"),
      volumeUnits: optionalNumber("CTRADER_ORDER_VOLUME_UNITS", 10000),
    },
  };
}
