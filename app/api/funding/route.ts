import { NextRequest, NextResponse } from "next/server";
import {
  crowdingHintFromFunding,
  fetchAllFunding,
  FUNDING_METHODOLOGY,
} from "@/lib/okx";
import {
  createX402GetHandler,
  discoveryOptionsResponse,
  fundingRouteConfig,
} from "@/lib/x402-server";
import {
  FUNDING_PRICE_ATOMIC,
  FUNDING_PRICE_USD,
  getPayTo,
  USDC_BASE,
} from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paymentOpts = {
  maxAmountRequired: FUNDING_PRICE_ATOMIC,
  resource: "/api/funding",
  description:
    "Live OKX perpetual funding rates for BTC/ETH/SOL + optional crowding hint (rules only)",
} as const;

async function fundingHandler(_req: NextRequest): Promise<NextResponse> {
  try {
    const fundingList = await fetchAllFunding(["BTC", "ETH", "SOL"]);

    const assets = Object.fromEntries(
      fundingList.map((f) => {
        const crowding = crowdingHintFromFunding(f.fundingRate);
        return [
          f.symbol,
          {
            instId: f.instId,
            fundingRate: f.fundingRate,
            nextFundingRate: f.nextFundingRate,
            fundingTime: f.fundingTime,
            venue: "okx" as const,
            crowding,
          },
        ];
      }),
    );

    return NextResponse.json({
      ok: true,
      source: "okx",
      priced: {
        amountUsd: FUNDING_PRICE_USD,
        amountAtomic: FUNDING_PRICE_ATOMIC,
        asset: USDC_BASE,
        network: "base",
        payTo: getPayTo(),
      },
      asOf: new Date().toISOString(),
      assets,
      methodology: FUNDING_METHODOLOGY,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "funding failed";
    return NextResponse.json(
      {
        ok: false,
        error: message,
        methodology: FUNDING_METHODOLOGY,
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
  fundingHandler,
  fundingRouteConfig(),
  paymentOpts,
);

export async function OPTIONS() {
  return discoveryOptionsResponse(paymentOpts);
}
