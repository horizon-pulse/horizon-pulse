import { NextRequest, NextResponse } from "next/server";
import { fetchGasSnapshot, GAS_METHODOLOGY } from "@/lib/gas";
import {
  GAS_PRICE_ATOMIC,
  GAS_PRICE_USD,
  getPayTo,
  USDC_BASE,
} from "@/lib/config";

export const paymentOpts = {
  maxAmountRequired: GAS_PRICE_ATOMIC,
  resource: "/api/gas",
  description:
    "Live Base + Ethereum gas (baseFee / priority / suggested maxFee) with timingHint + optional transfer USD cost",
} as const;

export async function gasHandler(_req: NextRequest): Promise<NextResponse> {
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
