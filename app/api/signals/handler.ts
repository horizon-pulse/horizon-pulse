import { NextRequest, NextResponse } from "next/server";
import { type AssetSymbol } from "@/lib/coingecko";
import { fetchClosesWithFallback } from "@/lib/spot-prices";
import { fetchAllFunding } from "@/lib/okx";
import { bollinger, macd, rsi } from "@/lib/indicators";
import {
  SIGNALS_PRICE_ATOMIC,
  SIGNALS_PRICE_USD,
} from "@/lib/config";
import { pricedBlock } from "@/lib/paid-rail";
import { isMissing, upstreamUnavailable } from "@/lib/upstream-guard";
import { ROUTE_METADATA } from "@/lib/route-metadata";

const SYMBOLS: AssetSymbol[] = ["BTC", "ETH", "SOL"];

export const paymentOpts = {
  maxAmountRequired: SIGNALS_PRICE_ATOMIC,
  resource: "/api/signals",
  description: ROUTE_METADATA["/api/signals"].description,
} as const;

export async function signalsHandler(_req: NextRequest): Promise<NextResponse> {
  try {
    const [fundingList, ...ohlcResults] = await Promise.all([
      fetchAllFunding(["BTC", "ETH", "SOL"]),
      ...SYMBOLS.map((s) => fetchClosesWithFallback(s, 90)),
    ]);
    const ohlcCloses = ohlcResults.map((r) => r.closes);
    const priceSources = [...new Set(ohlcResults.map((r) => r.source))];
    const missingCloses = SYMBOLS.filter(
      (_, i) => isMissing(ohlcCloses[i]?.[ohlcCloses[i]!.length - 1]),
    );
    if (missingCloses.length > 0) {
      return upstreamUnavailable(
        "/api/signals",
        missingCloses.map((s) => `${s}/USD closes`),
      );
    }

    const fundingBySymbol = Object.fromEntries(
      fundingList.map((f) => [f.symbol, f]),
    );

    const assets = Object.fromEntries(
      SYMBOLS.map((symbol, idx) => {
        const closes = ohlcCloses[idx]!;
        const funding = fundingBySymbol[symbol];
        const rsi14 = rsi(closes, 14);
        const macdVal = macd(closes, 12, 26, 9);
        // CoinGecko OHLC at days=14 may yield ~14–28 points; use available period for BB
        const bbPeriod = Math.min(20, closes.length);
        const bb = bollinger(closes, bbPeriod, 2);

        return [
          symbol,
          {
            closesUsed: closes.length,
            rsi14,
            macd: macdVal,
            bollinger: bb
              ? {
                  upper: bb.upper,
                  middle: bb.middle,
                  lower: bb.lower,
                  period: bbPeriod,
                }
              : null,
            funding: funding
              ? {
                  instId: funding.instId,
                  fundingRate: funding.fundingRate,
                  nextFundingRate: funding.nextFundingRate,
                  fundingTime: funding.fundingTime,
                  venue: "okx",
                }
              : null,
            lastClose: closes[closes.length - 1] ?? null,
          },
        ];
      }),
    );

    return NextResponse.json({
      ok: true,
      priced: pricedBlock(SIGNALS_PRICE_USD, SIGNALS_PRICE_ATOMIC),
      asOf: new Date().toISOString(),
      assets,
      methodology: {
        prices: priceSources.length === 1 && priceSources[0] === "coingecko"
          ? "CoinGecko public API OHLC closes (USD)"
          : `OHLC closes (USD) from ${priceSources.join("+")}; Coinbase = Exchange daily closes sampled every 4 days (CoinGecko fallback)`,
        indicators: "RSI(14) Wilder, MACD(12,26,9), Bollinger(period≤20, 2σ)",
        funding: "OKX public perpetual funding-rate endpoint (not Binance/Bybit)",
        note: "Indicators are derived from real OHLC; null means insufficient candles for that window.",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "signals failed";
    return NextResponse.json(
      { ok: false, error: message },
      { status: 502 },
    );
  }
}
