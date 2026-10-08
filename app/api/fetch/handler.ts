import { NextRequest, NextResponse } from "next/server";
import {
  FETCH_METHODOLOGY,
  fetchPublicUrl,
} from "@/lib/fetch-url";
import {
  FETCH_PRICE_ATOMIC,
  FETCH_PRICE_USD,
} from "@/lib/config";
import { pricedBlock } from "@/lib/paid-rail";
import { ROUTE_METADATA } from "@/lib/route-metadata";

export const paymentOpts = {
  maxAmountRequired: FETCH_PRICE_ATOMIC,
  resource: "/api/fetch",
  description: ROUTE_METADATA["/api/fetch"].description,
} as const;

export async function fetchHandler(req: NextRequest): Promise<NextResponse> {
  const urlParam = req.nextUrl.searchParams.get("url");
  const result = await fetchPublicUrl(urlParam ?? "");

  if (!result.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: result.error,
        code: result.code,
        methodology: FETCH_METHODOLOGY,
      },
      { status: result.status },
    );
  }

  return NextResponse.json({
    ok: true,
    source: "fetch",
    priced: pricedBlock(FETCH_PRICE_USD, FETCH_PRICE_ATOMIC),
    asOf: new Date().toISOString(),
    requestedUrl: result.requestedUrl,
    finalUrl: result.finalUrl,
    upstreamStatus: result.status,
    contentType: result.contentType,
    format: result.format,
    truncated: result.truncated,
    bytesRead: result.bytesRead,
    content: result.content,
    methodology: FETCH_METHODOLOGY,
  });
}
