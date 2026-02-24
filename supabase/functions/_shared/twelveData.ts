import type { Candle } from "./types.ts";

type TwelveDataValue = {
  datetime: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume?: string;
};

type TwelveDataResponse = {
  status?: string;
  code?: number;
  message?: string;
  values?: TwelveDataValue[];
};

function toIsoUtc(datetime: string): string {
  // Twelve Data commonly returns "YYYY-MM-DD HH:mm:ss"
  if (datetime.includes("T")) return new Date(datetime).toISOString();
  return new Date(datetime.replace(" ", "T") + "Z").toISOString();
}

export async function fetchTwelveDataCandles(params: {
  apiKey: string;
  symbol: string;
  interval: string;
  outputsize: number;
}): Promise<Candle[]> {
  const url = new URL("https://api.twelvedata.com/time_series");
  url.searchParams.set("apikey", params.apiKey);
  url.searchParams.set("symbol", params.symbol);
  url.searchParams.set("interval", params.interval);
  url.searchParams.set("outputsize", String(params.outputsize));
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("format", "JSON");

  const res = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
  });

  if (!res.ok) {
    throw new Error(`Twelve Data HTTP ${res.status}`);
  }

  const body = (await res.json()) as TwelveDataResponse;
  if (body.status === "error" || !body.values) {
    throw new Error(`Twelve Data error: ${body.message ?? "unknown error"}`);
  }

  return body.values
    .map((v) => ({
      ts: toIsoUtc(v.datetime),
      open: Number(v.open),
      high: Number(v.high),
      low: Number(v.low),
      close: Number(v.close),
      volume: v.volume != null ? Number(v.volume) : null,
    }))
    .filter((c) =>
      [c.open, c.high, c.low, c.close].every((x) => Number.isFinite(x))
    )
    .sort((a, b) => a.ts.localeCompare(b.ts));
}
