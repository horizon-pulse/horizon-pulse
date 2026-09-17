import { NextRequest, NextResponse } from "next/server";
import {
  buildPortfolio,
  parseEvmAddress,
  PORTFOLIO_METHODOLOGY,
} from "@/lib/portfolio";
import {
  createX402GetHandler,
  discoveryOptionsResponse,
  portfolioRouteConfig,
} from "@/lib/x402-server";
import {
  PORTFOLIO_PRICE_ATOMIC,
  PORTFOLIO_PRICE_USD,
  getPayTo,
  USDC_BASE,
} from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paymentOpts = {
  maxAmountRequired: PORTFOLIO_PRICE_ATOMIC,
  resource: "/api/portfolio",
  description:
    "On-chain portfolio (?address=0x...) Base+Ethereum: balances, risk score, rebalance suggestions",
} as const;

async function portfolioHandler(req: NextRequest): Promise<NextResponse> {
  const address = parseEvmAddress(req.nextUrl.searchParams.get("address"));
  if (!address) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Query param address is required and must be a 0x-prefixed 40-hex EVM address (e.g. ?address=0xabc...)",
        methodology: PORTFOLIO_METHODOLOGY,
      },
      { status: 400 },
    );
  }

  try {
    const result = await buildPortfolio(address);
    const anyNetworkOk = result.networks.some((n) => n.ok);
    const status = anyNetworkOk ? 200 : 502;

    return NextResponse.json(
      {
        ok: anyNetworkOk,
        source: "rpc+coingecko",
        priced: {
          amountUsd: PORTFOLIO_PRICE_USD,
          amountAtomic: PORTFOLIO_PRICE_ATOMIC,
          asset: USDC_BASE,
          network: "base",
          payTo: getPayTo(),
        },
        ...result,
      },
      { status },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "portfolio failed";
    return NextResponse.json(
      {
        ok: false,
        error: message,
        methodology: PORTFOLIO_METHODOLOGY,
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
  portfolioHandler,
  portfolioRouteConfig(),
  paymentOpts,
);

export async function OPTIONS() {
  return discoveryOptionsResponse(paymentOpts);
}
