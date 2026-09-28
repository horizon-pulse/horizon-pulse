import { NextRequest, NextResponse } from "next/server";
import { fetchRankedYields, YIELD_METHODOLOGY } from "@/lib/defillama";
import {
  YIELD_PRICE_ATOMIC,
  YIELD_PRICE_USD,
  getPayTo,
  USDC_BASE,
} from "@/lib/config";

export const paymentOpts = {
  maxAmountRequired: YIELD_PRICE_ATOMIC,
  resource: "/api/yield",
  description:
    "Ranked DefiLlama yields (TVL >= $10M, prefer stablecoin/single-asset)",
} as const;

export async function yieldHandler(_req: NextRequest): Promise<NextResponse> {
  try {
    const result = await fetchRankedYields(25);

    return NextResponse.json({
      ok: true,
      source: "defillama",
      sourceUrl: "https://yields.llama.fi/pools",
      priced: {
        amountUsd: YIELD_PRICE_USD,
        amountAtomic: YIELD_PRICE_ATOMIC,
        asset: USDC_BASE,
        network: "base",
        payTo: getPayTo(),
      },
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
