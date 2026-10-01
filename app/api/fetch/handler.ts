import { NextRequest, NextResponse } from "next/server";
import {
  FETCH_METHODOLOGY,
  fetchPublicUrl,
} from "@/lib/fetch-url";
import {
  FETCH_PRICE_ATOMIC,
  FETCH_PRICE_USD,
  getPayTo,
  USDC_BASE,
} from "@/lib/config";
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
    priced: {
      amountUsd: FETCH_PRICE_USD,
      amountAtomic: FETCH_PRICE_ATOMIC,
      asset: USDC_BASE,
      network: "base",
      payTo: getPayTo(),
    },
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
