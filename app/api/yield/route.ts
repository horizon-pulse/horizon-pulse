import { NextRequest, NextResponse } from "next/server";
import { fetchRankedYields, YIELD_METHODOLOGY } from "@/lib/defillama";
import {
  createX402GetHandler,
  discoveryOptionsResponse,
  yieldRouteConfig,
} from "@/lib/x402-server";
import {
  YIELD_PRICE_ATOMIC,
  YIELD_PRICE_USD,
  getPayTo,
  USDC_BASE,
} from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paymentOpts = {
  maxAmountRequired: YIELD_PRICE_ATOMIC,
  resource: "/api/yield",
  description:
    "Ranked DefiLlama yields (TVL >= $10M, prefer stablecoin/single-asset)",
} as const;

async function yieldHandler(_req: NextRequest): Promise<NextResponse> {
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

/**
 * Unpaid GET → 402 with payment requirements (no CDP / facilitator needed).
 * Paid GET with CDP → withX402 verify+settle (lazy-init).
 * Paid GET without CDP → 503.
 */
export const GET = createX402GetHandler(
  yieldHandler,
  yieldRouteConfig(),
  paymentOpts,
);

export async function OPTIONS() {
  return discoveryOptionsResponse(paymentOpts);
}
