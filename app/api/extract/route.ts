import { NextRequest, NextResponse } from "next/server";
import {
  EXTRACT_METHODOLOGY,
  EXTRACT_MAX_REQUEST_JSON_BYTES,
  extractPage,
} from "@/lib/extract";
import {
  createX402GetHandler,
  discoveryOptionsResponse,
  extractRouteConfig,
} from "@/lib/x402-server";
import {
  EXTRACT_PRICE_ATOMIC,
  EXTRACT_PRICE_USD,
  getPayTo,
  USDC_BASE,
} from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Price: $0.015 USDC (15000 atomic) — between /api/http ($0.01 volume proxy)
 * and /api/fetch ($0.02 clean-text). Same payTo + facilitator stack.
 *
 * GET+POST both paid identically. Discovery extension advertises GET.
 */
const paymentOpts = {
  maxAmountRequired: EXTRACT_PRICE_ATOMIC,
  resource: "/api/extract",
  description:
    "Extract structured page fields from url and/or html → title, description, links, images, headings, json-ld, text sample (SSRF-safe, size/time capped)",
} as const;

async function readJsonBody(
  req: NextRequest,
): Promise<
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string; status: number }
> {
  const cl = req.headers.get("content-length");
  if (cl && Number(cl) > EXTRACT_MAX_REQUEST_JSON_BYTES + 8_192) {
    return {
      ok: false,
      error: "JSON body Content-Length exceeds cap",
      status: 413,
    };
  }
  try {
    const text = await req.text();
    if (!text || !text.trim()) return { ok: true, data: {} };
    if (Buffer.byteLength(text, "utf8") > EXTRACT_MAX_REQUEST_JSON_BYTES + 8_192) {
      return { ok: false, error: "JSON body too large", status: 413 };
    }
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) {
      return { ok: false, error: "JSON body must be an object", status: 400 };
    }
    return { ok: true, data: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, error: "Invalid JSON body", status: 400 };
  }
}

async function extractHandler(req: NextRequest): Promise<NextResponse> {
  const q = req.nextUrl.searchParams;
  const urlQ = q.get("url");

  let bodyJson: Record<string, unknown> = {};
  if (req.method === "POST") {
    const parsed = await readJsonBody(req);
    if (!parsed.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: parsed.error,
          code: "missing_input",
          methodology: EXTRACT_METHODOLOGY,
        },
        { status: parsed.status },
      );
    }
    bodyJson = parsed.data;
  }

  // POST JSON wins over query for overlapping keys; query fills gaps.
  const url =
    (typeof bodyJson.url === "string" ? bodyJson.url : undefined) ??
    urlQ ??
    undefined;
  const html =
    typeof bodyJson.html === "string" ? bodyJson.html : undefined;

  const result = await extractPage({ url, html });

  if (!result.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: result.error,
        code: result.code,
        elapsedMs: result.elapsedMs,
        methodology: EXTRACT_METHODOLOGY,
      },
      { status: result.status },
    );
  }

  // Honest: only echo fields extractPage populated (omit empties).
  const {
    ok: _ok,
    elapsedMs,
    ...fields
  } = result;

  return NextResponse.json({
    ok: true,
    ...fields,
    elapsedMs,
    source: "extract",
    priced: {
      amountUsd: EXTRACT_PRICE_USD,
      amountAtomic: EXTRACT_PRICE_ATOMIC,
      asset: USDC_BASE,
      network: "base",
      payTo: getPayTo(),
    },
    asOf: new Date().toISOString(),
    methodology: EXTRACT_METHODOLOGY,
  });
}

/**
 * Unpaid GET/POST → 402 with payment requirements (no CDP needed).
 * Paid + CDP → withX402 verify+settle (lazy-init).
 * Paid without CDP → 503.
 *
 * Both methods share the same $0.015 price / payTo / facilitator stack.
 * createX402GetHandler is method-agnostic (name is historical).
 */
const paid = createX402GetHandler(
  extractHandler,
  extractRouteConfig(),
  paymentOpts,
);

export const GET = paid;
export const POST = paid;

export async function OPTIONS() {
  const res = discoveryOptionsResponse(paymentOpts);
  // Advertise both paid verbs for CORS / Allow (same price).
  res.headers.set("Allow", "GET, POST, OPTIONS");
  res.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  return res;
}
