import { NextRequest, NextResponse } from "next/server";
import { fetchGasSnapshot, GAS_METHODOLOGY } from "@/lib/gas";
import { isMissing, upstreamUnavailable } from "@/lib/upstream-guard";
import {
  GAS_PRICE_ATOMIC,
  GAS_PRICE_USD,
} from "@/lib/config";
import { pricedBlock } from "@/lib/paid-rail";
import { ROUTE_METADATA } from "@/lib/route-metadata";

export const paymentOpts = {
  maxAmountRequired: GAS_PRICE_ATOMIC,
  resource: "/api/gas",
  description: ROUTE_METADATA["/api/gas"].description,
} as const;

export async function gasHandler(_req: NextRequest): Promise<NextResponse> {
  try {
    const result = await fetchGasSnapshot();
    const anyOk = result.networks.some((n) => n.ok);
    const status = anyOk ? 200 : 502;
    if (anyOk && isMissing(result.ethUsd)) {
      return upstreamUnavailable("/api/gas", ["ETH/USD"], {
        warnings: (result as { warnings?: unknown }).warnings,
        methodology: GAS_METHODOLOGY,
      });
    }

    return NextResponse.json(
      {
        ok: anyOk,
        source: result.priceSource ? `rpc+${result.priceSource}` : "rpc",
        priced: pricedBlock(GAS_PRICE_USD, GAS_PRICE_ATOMIC),
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
