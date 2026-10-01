import { NextRequest, NextResponse } from "next/server";
import {
  HTTP_METHODOLOGY,
  HTTP_MAX_REQUEST_BODY_BYTES,
  proxyPublicHttp,
  type HttpProxyInput,
} from "@/lib/http-proxy";
import {
  HTTP_PRICE_ATOMIC,
  HTTP_PRICE_USD,
  getPayTo,
  USDC_BASE,
} from "@/lib/config";
import { ROUTE_METADATA } from "@/lib/route-metadata";

/**
 * Price: $0.01 USDC (10000 atomic) — volume-friendly universal proxy.
 * /api/fetch stays $0.02 for clean-text. Same payTo + facilitator stack.
 */
export const paymentOpts = {
  maxAmountRequired: HTTP_PRICE_ATOMIC,
  resource: "/api/http",
  description: ROUTE_METADATA["/api/http"].description,
} as const;

function parseHeadersParam(
  raw: string | null,
): Record<string, string> | undefined | { error: string } {
  if (raw == null || raw === "") return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed == null ||
      Array.isArray(parsed)
    ) {
      return { error: "headers must be a JSON object" };
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v !== "string") {
        return { error: "headers values must be strings" };
      }
      out[k] = v;
    }
    return out;
  } catch {
    return { error: "headers must be valid JSON" };
  }
}

async function readJsonBody(
  req: NextRequest,
): Promise<
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string; status: number }
> {
  const cl = req.headers.get("content-length");
  if (cl && Number(cl) > HTTP_MAX_REQUEST_BODY_BYTES + 8_192) {
    return {
      ok: false,
      error: `JSON body Content-Length exceeds cap`,
      status: 413,
    };
  }
  try {
    const text = await req.text();
    if (!text || !text.trim()) return { ok: true, data: {} };
    if (Buffer.byteLength(text, "utf8") > HTTP_MAX_REQUEST_BODY_BYTES + 8_192) {
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

function buildInputFromParts(parts: {
  url?: unknown;
  method?: unknown;
  headers?: unknown;
  body?: unknown;
}): HttpProxyInput | { error: string; status: number } {
  const url = typeof parts.url === "string" ? parts.url : "";
  const method =
    typeof parts.method === "string" ? parts.method : undefined;

  let headers: Record<string, string> | undefined;
  if (parts.headers != null) {
    if (
      typeof parts.headers !== "object" ||
      Array.isArray(parts.headers) ||
      parts.headers == null
    ) {
      return { error: "headers must be an object", status: 400 };
    }
    headers = {};
    for (const [k, v] of Object.entries(
      parts.headers as Record<string, unknown>,
    )) {
      if (typeof v !== "string") {
        return { error: "headers values must be strings", status: 400 };
      }
      headers[k] = v;
    }
  }

  let body: string | undefined;
  if (parts.body != null) {
    if (typeof parts.body === "string") {
      body = parts.body;
    } else {
      // Allow object/array → stringify for upstream convenience
      try {
        body = JSON.stringify(parts.body);
      } catch {
        return { error: "body could not be serialized", status: 400 };
      }
    }
  }

  return { url, method, headers, body };
}

export async function httpHandler(req: NextRequest): Promise<NextResponse> {
  const q = req.nextUrl.searchParams;
  const urlQ = q.get("url");
  const methodQ = q.get("method");
  const headersQ = parseHeadersParam(q.get("headers"));
  if (headersQ && "error" in headersQ) {
    return NextResponse.json(
      {
        ok: false,
        error: headersQ.error,
        code: "headers_invalid",
        methodology: HTTP_METHODOLOGY,
      },
      { status: 400 },
    );
  }

  let bodyJson: Record<string, unknown> = {};
  if (req.method === "POST") {
    const parsed = await readJsonBody(req);
    if (!parsed.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: parsed.error,
          code: "bad_url",
          methodology: HTTP_METHODOLOGY,
        },
        { status: parsed.status },
      );
    }
    bodyJson = parsed.data;
  }

  // POST JSON wins over query for overlapping keys; query fills gaps.
  const merged = buildInputFromParts({
    url: bodyJson.url ?? urlQ ?? "",
    method: bodyJson.method ?? methodQ ?? "GET",
    headers: bodyJson.headers ?? headersQ,
    body: bodyJson.body,
  });
  if ("error" in merged) {
    return NextResponse.json(
      {
        ok: false,
        error: merged.error,
        code: "headers_invalid",
        methodology: HTTP_METHODOLOGY,
      },
      { status: merged.status },
    );
  }

  const result = await proxyPublicHttp(merged);

  if (!result.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: result.error,
        code: result.code,
        elapsedMs: result.elapsedMs,
        methodology: HTTP_METHODOLOGY,
      },
      { status: result.status },
    );
  }

  return NextResponse.json({
    ok: true,
    status: result.status,
    headers: result.headers,
    body: result.body,
    bodyEncoding: result.bodyEncoding,
    contentType: result.contentType,
    elapsedMs: result.elapsedMs,
    source: "http",
    priced: {
      amountUsd: HTTP_PRICE_USD,
      amountAtomic: HTTP_PRICE_ATOMIC,
      asset: USDC_BASE,
      network: "base",
      payTo: getPayTo(),
    },
    asOf: new Date().toISOString(),
    requestedUrl: result.requestedUrl,
    finalUrl: result.finalUrl,
    method: result.method,
    truncated: result.truncated,
    bytesRead: result.bytesRead,
    methodology: HTTP_METHODOLOGY,
  });
}
