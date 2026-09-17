import { NextRequest, NextResponse } from "next/server";
import { fetchGasSnapshot, GAS_METHODOLOGY } from "@/lib/gas";
import {
  createX402GetHandler,
  discoveryOptionsResponse,
  gasRouteConfig,
} from "@/lib/x402-server";
import {
  GAS_PRICE_ATOMIC,
  GAS_PRICE_USD,
  getPayTo,
  USDC_BASE,
} from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paymentOpts = {
  maxAmountRequired: GAS_PRICE_ATOMIC,
  resource: "/api/gas",
  description:
    "Live Base + Ethereum gas (baseFee / priority / suggested maxFee) with timingHint + optional transfer USD cost",
} as const;

async function gasHandler(_req: NextRequest): Promise<NextResponse> {
  try {
    const result = await fetchGasSnapshot();
    const anyOk = result.networks.some((n) => n.ok);
    const status = anyOk ? 200 : 502;

    return NextResponse.json(
      {
        ok: anyOk,
        source: "rpc+coingecko",
        priced: {
          amountUsd: GAS_PRICE_USD,
          amountAtomic: GAS_PRICE_ATOMIC,
          asset: USDC_BASE,
          network: "base",
          payTo: getPayTo(),
        },
        ...result,
      },
      { status },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "gas failed";
    return NextResponse.json(
      {
        ok: false,
        error: message,
        methodology: GAS_METHODOLOGY,
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
  gasHandler,
  gasRouteConfig(),
  paymentOpts,
);

export async function OPTIONS() {
  return discoveryOptionsResponse(paymentOpts);
}
