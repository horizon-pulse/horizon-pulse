/**
 * Keyless spot prices with fallback.
 * Primary: Coinbase Exchange public product stats (no key, no account).
 *   priceUsd = last; change24hPct = (last - open) / open * 100, where open is the rolling 24h open.
 * Fallback: CoinGecko public /simple/price (keyless; may 403/429 from shared cloud IPs).
 * Errors from each source are surfaced, never hidden or invented.
 */
import { fetchSpotPrices as fetchCoinGeckoSpot, type AssetSymbol, type SpotPrice } from "./coingecko";

export type SpotSource = "coinbase" | "coingecko";

const COINBASE_PRODUCT: Record<AssetSymbol, string> = {
  BTC: "BTC-USD",
  ETH: "ETH-USD",
  SOL: "SOL-USD",
};
const CG_ID: Record<AssetSymbol, string> = { BTC: "bitcoin", ETH: "ethereum", SOL: "solana" };

const UA = "horizon-pulse/1.0 (+https://github.com/horizon-pulse/horizon-pulse)";

async function coinbaseStats(symbol: AssetSymbol): Promise<SpotPrice> {
  const product = COINBASE_PRODUCT[symbol];
  const res = await fetch(`https://api.exchange.coinbase.com/products/${product}/stats`, {
    headers: { Accept: "application/json", "User-Agent": UA },
    next: { revalidate: 30 },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Coinbase ${res.status} for ${product}: ${text.slice(0, 160)}`);
  }
  const d = (await res.json()) as { open?: string; last?: string };
  const last = Number(d.last);
  const open = Number(d.open);
  if (!Number.isFinite(last) || last <= 0) throw new Error(`Coinbase missing last price for ${product}`);
  const change24hPct = Number.isFinite(open) && open > 0 ? ((last - open) / open) * 100 : null;
  return { symbol, id: CG_ID[symbol], priceUsd: last, change24hPct };
}

export async function fetchSpotPricesWithFallback(
  symbols: AssetSymbol[] = ["BTC", "ETH", "SOL"],
): Promise<{ spots: SpotPrice[]; source: SpotSource; warnings: string[] }> {
  const warnings: string[] = [];
  try {
    const spots = await Promise.all(symbols.map(coinbaseStats));
    return { spots, source: "coinbase", warnings };
  } catch (err) {
    warnings.push(`Coinbase primary failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 160)}`);
  }
  try {
    const spots = await fetchCoinGeckoSpot(symbols);
    return { spots, source: "coingecko", warnings };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`All price sources failed. ${warnings.join(" | ")} | CoinGecko fallback failed: ${msg.slice(0, 160)}`);
  }
}

/** USD marks for portfolio tokens (CoinGecko ids). Coinbase public exchange-rates first, CoinGecko for anything left. */
const COINBASE_RATE_SYMBOL: Record<string, string> = {
  ethereum: "ETH",
  "usd-coin": "USDC",
  "wrapped-bitcoin": "WBTC",
  // WETH is 1:1 redeemable for ETH via the WETH9 contract; marked at the Coinbase ETH/USD rate (method stated in portfolio methodology).
  weth: "ETH",
  dai: "DAI",
};

export async function fetchCoinbaseUsdMarks(
  ids: string[],
): Promise<{ prices: Record<string, number>; error?: string }> {
  const prices: Record<string, number> = {};
  const wanted = ids.filter((id) => COINBASE_RATE_SYMBOL[id]);
  if (wanted.length === 0) return { prices };
  try {
    const res = await fetch("https://api.coinbase.com/v2/exchange-rates?currency=USD", {
      headers: { Accept: "application/json", "User-Agent": UA },
      next: { revalidate: 30 },
    });
    if (!res.ok) return { prices, error: `Coinbase rates ${res.status}` };
    const data = (await res.json()) as { data?: { rates?: Record<string, string> } };
    const rates = data.data?.rates ?? {};
    for (const id of wanted) {
      const r = Number(rates[COINBASE_RATE_SYMBOL[id]]);
      if (Number.isFinite(r) && r > 0) prices[id] = Number((1 / r).toPrecision(10));
    }
    return { prices };
  } catch (err) {
    return { prices, error: `Coinbase rates failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Closes for indicators. CoinGecko /ohlc first (days>30 yields ~4-day candles).
 * Fallback: Coinbase Exchange daily candles over the same window, sampled every 4th day
 * back from the latest close so the indicator timescale stays comparable. Oldest first.
 */
export async function fetchClosesWithFallback(
  symbol: AssetSymbol,
  days: number = 90,
): Promise<{ closes: number[]; source: SpotSource; note?: string }> {
  let cgErr = "";
  try {
    const { fetchOhlcCloses } = await import("./coingecko");
    return { closes: await fetchOhlcCloses(symbol, days), source: "coingecko" };
  } catch (err) {
    cgErr = (err instanceof Error ? err.message : String(err)).slice(0, 160);
  }
  const product = COINBASE_PRODUCT[symbol];
  const res = await fetch(`https://api.exchange.coinbase.com/products/${product}/candles?granularity=86400`, {
    headers: { Accept: "application/json", "User-Agent": UA },
    next: { revalidate: 300 },
  });
  if (!res.ok) {
    throw new Error(`All OHLC sources failed for ${symbol}. CoinGecko: ${cgErr} | Coinbase ${res.status}`);
  }
  // Coinbase candle: [time, low, high, open, close, volume], newest first
  const rows = (await res.json()) as number[][];
  const daily = rows.slice(0, days).map((c) => c[4]).filter((x) => typeof x === "number" && Number.isFinite(x));
  if (daily.length === 0) throw new Error(`Empty Coinbase candles for ${symbol}; CoinGecko: ${cgErr}`);
  const sampled = daily.filter((_, i) => i % 4 === 0).reverse();
  return { closes: sampled, source: "coinbase", note: "Coinbase daily closes sampled every 4 days (CoinGecko unavailable)" };
}
