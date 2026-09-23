import { NextRequest, NextResponse } from "next/server";
import {
  FETCH_METHODOLOGY,
  fetchPublicUrl,
} from "@/lib/fetch-url";
import {
  createX402GetHandler,
  discoveryOptionsResponse,
  fetchRouteConfig,
} from "@/lib/x402-server";
import {
  FETCH_PRICE_ATOMIC,
  FETCH_PRICE_USD,
  getPayTo,
  USDC_BASE,
} from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paymentOpts = {
  maxAmountRequired: FETCH_PRICE_ATOMIC,
  resource: "/api/fetch",
  description:
    "Fetch a public http(s) URL (?url=...) → clean text/markdown (SSRF-safe, size/time capped)",
} as const;

async function fetchHandler(req: NextRequest): Promise<NextResponse> {
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

/**
 * Unpaid GET → 402 with payment requirements (no CDP / facilitator needed).
 * Paid GET with CDP → withX402 verify+settle (lazy-init).
 * Paid GET without CDP → 503.
 */
export const GET = createX402GetHandler(
  fetchHandler,
  fetchRouteConfig(),
  paymentOpts,
);

export async function OPTIONS() {
  return discoveryOptionsResponse(paymentOpts);
}
