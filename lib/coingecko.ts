const COINGECKO_BASE = "https://api.coingecko.com/api/v3";

const ID_MAP = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
} as const;

export type AssetSymbol = keyof typeof ID_MAP;

export type SpotPrice = {
  symbol: AssetSymbol;
  id: string;
  priceUsd: number;
  change24hPct: number | null;
};

async function cgFetch<T>(path: string): Promise<T> {
  const url = `${COINGECKO_BASE}${path}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "horizon-pulse/1.0 (+https://github.com/horizon-pulse/horizon-pulse)",
    },
    // Cache briefly on the edge of Next's fetch cache; market data should stay fresh
    next: { revalidate: 30 },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`CoinGecko ${res.status} for ${path}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchSpotPrices(
  symbols: AssetSymbol[] = ["BTC", "ETH", "SOL"],
): Promise<SpotPrice[]> {
  const ids = symbols.map((s) => ID_MAP[s]).join(",");
  type PriceResp = Record<
    string,
    { usd?: number; usd_24h_change?: number }
  >;
  const data = await cgFetch<PriceResp>(
    `/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`,
  );

  return symbols.map((symbol) => {
    const id = ID_MAP[symbol];
    const row = data[id];
    if (!row || typeof row.usd !== "number") {
      throw new Error(`Missing CoinGecko price for ${symbol} (${id})`);
    }
    return {
      symbol,
      id,
      priceUsd: row.usd,
      change24hPct:
        typeof row.usd_24h_change === "number" ? row.usd_24h_change : null,
    };
  });
}

/** Daily OHLC candles; CoinGecko returns [timestamp, open, high, low, close] */
export async function fetchOhlcCloses(
  symbol: AssetSymbol,
  days: number = 14,
): Promise<number[]> {
  const id = ID_MAP[symbol];
  const data = await cgFetch<number[][]>(
    `/coins/${id}/ohlc?vs_currency=usd&days=${days}`,
  );
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`Empty OHLC for ${symbol}`);
  }
  return data.map((candle) => {
    const close = candle[4];
    if (typeof close !== "number") {
      throw new Error(`Malformed OHLC candle for ${symbol}`);
    }
    return close;
  });
}

export { ID_MAP };
