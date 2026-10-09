import { NextRequest, NextResponse } from "next/server";
import { fetchSpotPricesWithFallback } from "@/lib/spot-prices";
import {
  aggregatePulse,
  momentumFromChange,
} from "@/lib/indicators";
import {
  PULSE_PRICE_ATOMIC,
  PULSE_PRICE_USD,
} from "@/lib/config";
import { pricedBlock } from "@/lib/paid-rail";
import { ROUTE_METADATA } from "@/lib/route-metadata";

export const paymentOpts = {
  maxAmountRequired: PULSE_PRICE_ATOMIC,
  resource: "/api/pulse",
  description: ROUTE_METADATA["/api/pulse"].description,
} as const;

export async function pulseHandler(_req: NextRequest): Promise<NextResponse> {
  try {
    const { spots, source, warnings } = await fetchSpotPricesWithFallback(["BTC", "ETH", "SOL"]);
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
      source,
      ...(warnings.length ? { priceWarnings: warnings } : {}),
      priced: pricedBlock(PULSE_PRICE_USD, PULSE_PRICE_ATOMIC),
      asOf: new Date().toISOString(),
      assets,
      overall: {
        momentum: overall.momentum,
        sentiment: overall.sentiment,
        direction: overall.direction,
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
