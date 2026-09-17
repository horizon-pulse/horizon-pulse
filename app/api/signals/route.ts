import { NextRequest, NextResponse } from "next/server";
import { fetchOhlcCloses, type AssetSymbol } from "@/lib/coingecko";
import { fetchAllFunding } from "@/lib/okx";
import { bollinger, macd, rsi } from "@/lib/indicators";
import {
  createX402GetHandler,
  discoveryOptionsResponse,
  signalsRouteConfig,
} from "@/lib/x402-server";
import {
  SIGNALS_PRICE_ATOMIC,
  SIGNALS_PRICE_USD,
  getPayTo,
  USDC_BASE,
} from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SYMBOLS: AssetSymbol[] = ["BTC", "ETH", "SOL"];

const paymentOpts = {
  maxAmountRequired: SIGNALS_PRICE_ATOMIC,
  resource: "/api/signals",
  description: "RSI/MACD/Bollinger + OKX funding",
} as const;

async function signalsHandler(_req: NextRequest): Promise<NextResponse> {
  try {
    const [fundingList, ...ohlcCloses] = await Promise.all([
      fetchAllFunding(["BTC", "ETH", "SOL"]),
      ...SYMBOLS.map((s) => fetchOhlcCloses(s, 90)),
    ]);

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
      priced: {
        amountUsd: SIGNALS_PRICE_USD,
        amountAtomic: SIGNALS_PRICE_ATOMIC,
        asset: USDC_BASE,
        network: "base",
        payTo: getPayTo(),
      },
      asOf: new Date().toISOString(),
      assets,
      methodology: {
        prices: "CoinGecko public API OHLC closes (USD)",
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

/**
 * Unpaid GET → 402 with payment requirements (no CDP / facilitator needed).
 * Paid GET with CDP → withX402 verify+settle (lazy-init).
 * Paid GET without CDP → 503.
 */
export const GET = createX402GetHandler(
  signalsHandler,
  signalsRouteConfig(),
  paymentOpts,
);

export async function OPTIONS() {
  return discoveryOptionsResponse(paymentOpts);
}
