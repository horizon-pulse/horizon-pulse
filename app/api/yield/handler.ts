import { NextRequest, NextResponse } from "next/server";
import { fetchRankedYields, YIELD_METHODOLOGY } from "@/lib/defillama";
import {
  YIELD_PRICE_ATOMIC,
  YIELD_PRICE_USD,
} from "@/lib/config";
import { pricedBlock } from "@/lib/paid-rail";
import { ROUTE_METADATA } from "@/lib/route-metadata";

export const paymentOpts = {
  maxAmountRequired: YIELD_PRICE_ATOMIC,
  resource: "/api/yield",
  description: ROUTE_METADATA["/api/yield"].description,
} as const;

export async function yieldHandler(_req: NextRequest): Promise<NextResponse> {
  try {
    const result = await fetchRankedYields(25);

    return NextResponse.json({
      ok: true,
      source: "defillama",
      sourceUrl: "https://yields.llama.fi/pools",
      priced: pricedBlock(YIELD_PRICE_USD, YIELD_PRICE_ATOMIC),
      asOf: new Date().toISOString(),
      meta: {
        scanned: result.scanned,
        afterTvlFilter: result.afterTvlFilter,
        afterPreferenceFilter: result.afterPreferenceFilter,
        returned: result.pools.length,
      },
      pools: result.pools,
      methodology: result.methodology,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "yield failed";
    return NextResponse.json(
      {
        ok: false,
        error: message,
        methodology: YIELD_METHODOLOGY,
      },
      { status: 502 },
    );
  }
}
