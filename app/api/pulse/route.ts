import { NextRequest, NextResponse } from "next/server";
import { withX402 } from "@x402/next";
import { fetchSpotPrices } from "@/lib/coingecko";
import {
  aggregatePulse,
  momentumFromChange,
} from "@/lib/indicators";
import {
  getResourceServer,
  pulseRouteConfig,
  shouldSyncFacilitator,
  buildPaymentRequirements,
} from "@/lib/x402-server";
import {
  PULSE_PRICE_ATOMIC,
  PULSE_PRICE_USD,
  getPayTo,
  USDC_BASE,
} from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function pulseHandler(_req: NextRequest): Promise<NextResponse> {
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

/**
 * x402-protected pulse endpoint.
 * Settles only after a successful (<400) response when CDP keys are configured.
 */
export const GET = withX402(
  pulseHandler,
  pulseRouteConfig(),
  getResourceServer(),
  undefined,
  undefined,
  shouldSyncFacilitator(),
);

/** Free OPTIONS / discovery hint — some agents probe without payment first via GET 402 */
export async function OPTIONS() {
  return NextResponse.json(
    buildPaymentRequirements({
      maxAmountRequired: PULSE_PRICE_ATOMIC,
      resource: "/api/pulse",
      description: "BTC/ETH/SOL pulse with momentum",
    }),
    {
      status: 200,
      headers: {
        Allow: "GET, OPTIONS",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers":
          "PAYMENT-SIGNATURE, X-PAYMENT, Content-Type, Accept",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
      },
    },
  );
}
