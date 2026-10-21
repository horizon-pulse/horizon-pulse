import { NextRequest, NextResponse } from "next/server";
import {
  crowdingHintFromFunding,
  fetchAllFunding,
  FUNDING_METHODOLOGY,
  fundingMethodologyFor,
} from "@/lib/okx";
import { parseSymbolParam, unsupportedSymbolResponse } from "@/lib/market-symbols";
import {
  FUNDING_PRICE_ATOMIC,
  FUNDING_PRICE_USD,
} from "@/lib/config";
import { pricedBlock } from "@/lib/paid-rail";
import { ROUTE_METADATA } from "@/lib/route-metadata";

export const paymentOpts = {
  maxAmountRequired: FUNDING_PRICE_ATOMIC,
  resource: "/api/funding",
  description: ROUTE_METADATA["/api/funding"].description,
} as const;

export async function fundingHandler(req: NextRequest): Promise<NextResponse> {
  const sym = parseSymbolParam(req.url);
  if (!sym.ok) return unsupportedSymbolResponse("/api/funding", sym.error);
  const methodology = fundingMethodologyFor(sym.symbols);
  try {
    const fundingList = await fetchAllFunding(sym.symbols ?? ["BTC", "ETH", "SOL"]);

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
      priced: pricedBlock(FUNDING_PRICE_USD, FUNDING_PRICE_ATOMIC),
      asOf: new Date().toISOString(),
      assets,
      methodology,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "funding failed";
    return NextResponse.json(
      {
        ok: false,
        error: message,
        methodology,
      },
      { status: 502 },
    );
  }
}
