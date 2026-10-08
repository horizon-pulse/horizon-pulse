import { NextRequest, NextResponse } from "next/server";
import {
  EXTRACT_METHODOLOGY,
  EXTRACT_MAX_REQUEST_JSON_BYTES,
  extractPage,
} from "@/lib/extract";
import { parseFieldSpecs } from "@/lib/extract-fields";
import {
  EXTRACT_PRICE_ATOMIC,
  EXTRACT_PRICE_USD,
} from "@/lib/config";
import { pricedBlock } from "@/lib/paid-rail";
import { ROUTE_METADATA } from "@/lib/route-metadata";

/**
 * Price: $0.015 USDC (15000 atomic) — between /api/http ($0.01 volume proxy)
 * and /api/fetch ($0.02 clean-text). Same payTo + facilitator stack.
 *
 * GET+POST both paid identically. Discovery extension advertises GET.
 */
export const paymentOpts = {
  maxAmountRequired: EXTRACT_PRICE_ATOMIC,
  resource: "/api/extract",
  description: ROUTE_METADATA["/api/extract"].description,
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

export async function extractHandler(req: NextRequest): Promise<NextResponse> {
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

  const parsedFields = parseFieldSpecs(bodyJson.fields !== undefined ? bodyJson.fields : q.get("fields"));
  if (!parsedFields.ok) {
    return NextResponse.json(
      { ok: false, error: parsedFields.error, code: "bad_fields", methodology: EXTRACT_METHODOLOGY },
      { status: 400 },
    );
  }

  const result = await extractPage({ url, html, fields: parsedFields.specs });

  if (!result.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: result.error,
        code: result.code,
        elapsedMs: result.elapsedMs,
        ...(result.fieldErrors ? { fieldErrors: result.fieldErrors, charged: false } : {}),
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
    priced: pricedBlock(EXTRACT_PRICE_USD, EXTRACT_PRICE_ATOMIC),
    asOf: new Date().toISOString(),
    methodology: EXTRACT_METHODOLOGY,
  });
}
