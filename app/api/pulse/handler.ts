import { NextRequest, NextResponse } from "next/server";
import { fetchSpotPrices } from "@/lib/coingecko";
import {
  aggregatePulse,
  momentumFromChange,
} from "@/lib/indicators";
import {
  PULSE_PRICE_ATOMIC,
  PULSE_PRICE_USD,
  getPayTo,
  USDC_BASE,
} from "@/lib/config";

export const paymentOpts = {
  maxAmountRequired: PULSE_PRICE_ATOMIC,
  resource: "/api/pulse",
  description: "BTC/ETH/SOL pulse with momentum",
} as const;

export async function pulseHandler(_req: NextRequest): Promise<NextResponse> {
  try {
    const spots = await fetchSpotPrices(["BTC", "ETH", "SOL"]);
    const assets = Object.fromEntries(
      spots.map((s) => [
        s.symbol,
        {
          id: s.id,
          priceUsd: s.priceUsd,
          change24hPct: s.change24hPct,
          momentum: momentumFromChange(s.change24hPct),
        },
      ]),
    );

    const overall = aggregatePulse(spots.map((s) => s.change24hPct));

    return NextResponse.json({
      ok: true,
      source: "coingecko",
      priced: {
        amountUsd: PULSE_PRICE_USD,
        amountAtomic: PULSE_PRICE_ATOMIC,
        asset: USDC_BASE,
        network: "base",
        payTo: getPayTo(),
      },
      asOf: new Date().toISOString(),
      assets,
      overall: {
        momentum: overall.momentum,
        sentiment: overall.sentiment,
        signal: overall.signal,
        avgChange24hPct: overall.avgChange24hPct,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "pulse failed";
    return NextResponse.json(
      { ok: false, error: message },
      { status: 502 },
    );
  }
}
