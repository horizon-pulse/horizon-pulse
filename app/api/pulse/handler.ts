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
import { parseSymbolParam, unsupportedSymbolResponse } from "@/lib/market-symbols";

export const paymentOpts = {
  maxAmountRequired: PULSE_PRICE_ATOMIC,
  resource: "/api/pulse",
  description: ROUTE_METADATA["/api/pulse"].description,
} as const;

export async function pulseHandler(req: NextRequest): Promise<NextResponse> {
  // route.ts gates ?symbol= before payment; re-checked here so the handler never runs on a bad one.
  const sym = parseSymbolParam(req.url);
  if (!sym.ok) return unsupportedSymbolResponse("/api/pulse", sym.error);
  try {
    const { spots, source, warnings } = await fetchSpotPricesWithFallback(sym.symbols ?? ["BTC", "ETH", "SOL"]);
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
