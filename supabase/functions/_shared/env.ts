export type RuntimeEnv = {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  twelveDataApiKey: string;
  telegramBotToken: string;
  telegramChatId: string;
  cronSecret: string;
  signalSymbol: string;
  signalTimeframe: string;
  signalLookbackCandles: number;
  twelveDataOutputsize: number;
  executorBaseUrl: string | null;
  executorWebhookSecret: string | null;
  ctraderOrderVolumeUnits: number;
  telegramAllowedChatIds: string[];
  telegramWebhookSecret: string | null;
};

function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

function optionalInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function getEnv(): RuntimeEnv {
  const allowedRaw = Deno.env.get("TELEGRAM_ALLOWED_CHAT_IDS") ?? (Deno.env.get("TELEGRAM_CHAT_ID") ?? "");
  const telegramAllowedChatIds = allowedRaw.split(",").map((v) => v.trim()).filter((v) => v.length > 0);
  return {
    supabaseUrl: required("SUPABASE_URL"),
    supabaseServiceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
    twelveDataApiKey: required("TWELVE_DATA_API_KEY"),
    telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
    telegramChatId: required("TELEGRAM_CHAT_ID"),
    cronSecret: required("CRON_SECRET"),
    signalSymbol: Deno.env.get("SIGNAL_SYMBOL") ?? "EUR/USD",
    signalTimeframe: Deno.env.get("SIGNAL_TIMEFRAME") ?? "15min",
    signalLookbackCandles: optionalInt("SIGNAL_LOOKBACK_CANDLES", 1500),
    twelveDataOutputsize: optionalInt("TWELVE_DATA_OUTPUTSIZE", 5000),
    executorBaseUrl: Deno.env.get("EXECUTOR_BASE_URL"),
    executorWebhookSecret: Deno.env.get("EXECUTOR_WEBHOOK_SECRET"),
    ctraderOrderVolumeUnits: optionalInt("CTRADER_ORDER_VOLUME_UNITS", 10000),
    telegramAllowedChatIds,
    telegramWebhookSecret: Deno.env.get("TELEGRAM_WEBHOOK_SECRET"),
  };
}
