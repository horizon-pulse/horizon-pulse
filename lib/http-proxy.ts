/**
 * Universal agent HTTP proxy for GET|POST /api/http.
 *
 * Price choice: $0.01 USDC (10000 atomic) — volume-friendly raw proxy.
 * /api/fetch stays at $0.02 (specialized clean-text path). Documented in
 * HTTP_METHODOLOGY + live-catalog CATALOG_NOTE.
 *
 * SSRF: reuses assertSafePublicUrl from fetch-url (private / link-local /
 * metadata blocked; re-check each redirect hop). Only http/https.
 */

import {
  assertSafePublicUrl,
  type FetchUrlError,
} from "./fetch-url";

export const HTTP_MAX_RESPONSE_BYTES = 384_000; // ~384KB (within 256–512KB band)
export const HTTP_MAX_REQUEST_BODY_BYTES = 64_000; // upstream request body cap
export const HTTP_TIMEOUT_MS = 12_000; // ~10–15s band
export const HTTP_MAX_REDIRECTS = 3;
export const HTTP_MAX_HEADER_COUNT = 32;
export const HTTP_MAX_HEADER_VALUE_CHARS = 4_096;

export const HTTP_ALLOWED_METHODS = [
  "GET",
  "POST",
  "HEAD",
  "PUT",
  "PATCH",
  "DELETE",
] as const;

export type HttpAllowedMethod = (typeof HTTP_ALLOWED_METHODS)[number];

export const HTTP_METHODOLOGY = {
  purpose:
    "Universal agent HTTP proxy: call a public http(s) URL with chosen method/headers/body; return status + filtered headers + body (text or base64)",
  priceChoice:
    "$0.01 USDC (10000 atomic) for volume. /api/fetch remains $0.02 for clean-text specialization.",
  caps: {
    maxResponseBytes: HTTP_MAX_RESPONSE_BYTES,
    maxRequestBodyBytes: HTTP_MAX_REQUEST_BODY_BYTES,
    timeoutMs: HTTP_TIMEOUT_MS,
    maxRedirects: HTTP_MAX_REDIRECTS,
  },
  allowedSchemes: ["http:", "https:"],
  allowedMethods: HTTP_ALLOWED_METHODS,
  ssrf:
    "Blocks localhost, private, link-local, and metadata IPs; re-checks each redirect hop (shared with /api/fetch)",
  headers:
    "Request: allowlist only (no Cookie / hop-by-hop / Host). Response: strip Set-Cookie + hop-by-hop.",
} as const;

/** Hop-by-hop + abuse-prone request headers we never forward. */
const BLOCKED_REQUEST_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "cookie",
  "cookie2",
  "set-cookie",
  "set-cookie2",
  // Do not let clients override our identity / encoding negotiation silently
  "accept-encoding",
]);

/** Response headers we strip before returning to the agent. */
const BLOCKED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "set-cookie",
  "set-cookie2",
  "content-encoding", // we decode via fetch; avoid lying to clients
]);

/**
 * Forward allowlist: common agent/API headers. Anything else is dropped
 * (fail-closed vs open proxy header injection).
 */
const ALLOWED_REQUEST_HEADERS = new Set([
  "accept",
  "accept-language",
  "authorization",
  "cache-control",
  "content-type",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "if-unmodified-since",
  "pragma",
  "user-agent",
  "x-api-key",
  "x-request-id",
  "x-correlation-id",
]);

export type HttpProxyInput = {
  url: string;
  method?: string;
  /** Optional outbound headers (allowlisted). */
  headers?: Record<string, string>;
  /** Optional body for POST/PUT/PATCH (string). */
  body?: string;
};

export type HttpProxySuccess = {
  ok: true;
  status: number;
  headers: Record<string, string>;
  body: string;
  bodyEncoding: "text" | "base64";
  contentType: string | null;
  elapsedMs: number;
  requestedUrl: string;
  finalUrl: string;
  method: HttpAllowedMethod;
  truncated: boolean;
  bytesRead: number;
};

export type HttpProxyError = {
  ok: false;
  error: string;
  code:
    | "missing_url"
    | "bad_url"
    | "scheme_blocked"
    | "host_blocked"
    | "method_blocked"
    | "headers_invalid"
    | "body_not_allowed"
    | "body_too_large"
    | "timeout"
    | "too_large"
    | "upstream"
    | "redirects";
  status: number;
  elapsedMs: number;
};

function isAllowedMethod(m: string): m is HttpAllowedMethod {
  return (HTTP_ALLOWED_METHODS as readonly string[]).includes(m);
}

function methodAllowsBody(m: HttpAllowedMethod): boolean {
  return m === "POST" || m === "PUT" || m === "PATCH";
}

/**
 * Filter client-supplied headers through allowlist + blocklist.
 */
export function filterRequestHeaders(
  raw: Record<string, string> | undefined,
):
  | { ok: true; headers: Record<string, string> }
  | { ok: false; error: string } {
  if (raw == null) return { ok: true, headers: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "headers must be a plain object of string→string" };
  }
  const entries = Object.entries(raw);
  if (entries.length > HTTP_MAX_HEADER_COUNT) {
    return {
      ok: false,
      error: `Too many headers (max ${HTTP_MAX_HEADER_COUNT})`,
    };
  }
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (typeof k !== "string" || typeof v !== "string") {
      return { ok: false, error: "headers values must be strings" };
    }
    const name = k.trim();
    if (!name) continue;
    const lower = name.toLowerCase();
    if (BLOCKED_REQUEST_HEADERS.has(lower)) continue;
    if (!ALLOWED_REQUEST_HEADERS.has(lower) && !lower.startsWith("x-")) {
      // Allow custom x-* except we already blocked cookie-like; still cap x-
      continue;
    }
    // x-forwarded-* / x-real-ip etc. — still under x- allow; strip spoof proxies
    if (
      lower.startsWith("x-forwarded-") ||
      lower === "x-real-ip" ||
      lower === "forwarded"
    ) {
      continue;
    }
    if (v.length > HTTP_MAX_HEADER_VALUE_CHARS) {
      return {
        ok: false,
        error: `Header ${name} value exceeds ${HTTP_MAX_HEADER_VALUE_CHARS} chars`,
      };
    }
    out[name] = v;
  }
  return { ok: true, headers: out };
}

function filterResponseHeaders(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (BLOCKED_RESPONSE_HEADERS.has(lower)) return;
    out[key] = value;
  });
  return out;
}

function looksTextual(ct: string | null, buf: Buffer): boolean {
  const b = (ct ?? "").split(";")[0]!.trim().toLowerCase();
  if (
    b.startsWith("text/") ||
    b === "application/json" ||
    b === "application/xml" ||
    b === "application/javascript" ||
    b === "application/xhtml+xml" ||
    b.endsWith("+json") ||
    b.endsWith("+xml") ||
    b === "application/x-www-form-urlencoded"
  ) {
    return true;
  }
  // Heuristic: no NUL in first 512 bytes → treat as text
  const sample = buf.subarray(0, Math.min(512, buf.length));
  if (sample.includes(0)) return false;
  if (!b || b === "application/octet-stream") {
    // Empty/unknown: prefer text if printable-ish
    let printable = 0;
    for (const byte of sample) {
      if (
        byte === 9 ||
        byte === 10 ||
        byte === 13 ||
        (byte >= 32 && byte <= 126) ||
        byte >= 128
      ) {
        printable += 1;
      }
    }
    return sample.length === 0 || printable / sample.length >= 0.85;
  }
  return false;
}

async function readBodyCapped(
  res: Response,
  maxBytes: number,
): Promise<{ buf: Buffer; truncated: boolean }> {
  if (!res.body) {
    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);
    if (buf.length > maxBytes) {
      return { buf: buf.subarray(0, maxBytes), truncated: true };
    }
    return { buf, truncated: false };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (total + value.length > maxBytes) {
      const remain = maxBytes - total;
      if (remain > 0) chunks.push(value.subarray(0, remain));
      total = maxBytes;
      truncated = true;
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  return { buf: Buffer.concat(chunks.map((c) => Buffer.from(c))), truncated };
}

function mapFetchUrlError(err: FetchUrlError, elapsedMs: number): HttpProxyError {
  return {
    ok: false,
    error: err.error,
    code: err.code as HttpProxyError["code"],
    status: err.status,
    elapsedMs,
  };
}

/**
 * Proxy a public URL with SSRF + size/time caps.
 * Returns upstream status honestly (including 4xx/5xx) when the hop succeeded.
 */
export async function proxyPublicHttp(
  input: HttpProxyInput,
): Promise<HttpProxySuccess | HttpProxyError> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;

  const rawUrl = (input.url ?? "").trim();
  if (!rawUrl) {
    return {
      ok: false,
      error: "url is required (absolute http/https URL)",
      code: "missing_url",
      status: 400,
      elapsedMs: elapsed(),
    };
  }

  const methodRaw = (input.method ?? "GET").trim().toUpperCase();
  if (!isAllowedMethod(methodRaw)) {
    return {
      ok: false,
      error: `method must be one of ${HTTP_ALLOWED_METHODS.join(", ")}`,
      code: "method_blocked",
      status: 400,
      elapsedMs: elapsed(),
    };
  }
  const method: HttpAllowedMethod = methodRaw;

  const filtered = filterRequestHeaders(input.headers);
  if (!filtered.ok) {
    return {
      ok: false,
      error: filtered.error,
      code: "headers_invalid",
      status: 400,
      elapsedMs: elapsed(),
    };
  }

  let bodyStr: string | undefined;
  if (input.body != null && input.body !== "") {
    if (!methodAllowsBody(method)) {
      return {
        ok: false,
        error: `body is not allowed for method ${method}`,
        code: "body_not_allowed",
        status: 400,
        elapsedMs: elapsed(),
      };
    }
    if (typeof input.body !== "string") {
      return {
        ok: false,
        error: "body must be a string (send JSON as a stringified payload)",
        code: "headers_invalid",
        status: 400,
        elapsedMs: elapsed(),
      };
    }
    const bodyBytes = Buffer.byteLength(input.body, "utf8");
    if (bodyBytes > HTTP_MAX_REQUEST_BODY_BYTES) {
      return {
        ok: false,
        error: `Request body ${bodyBytes} bytes exceeds max ${HTTP_MAX_REQUEST_BODY_BYTES}`,
        code: "body_too_large",
        status: 413,
        elapsedMs: elapsed(),
      };
    }
    bodyStr = input.body;
  }

  let current = rawUrl;
  let redirects = 0;
  const requestedUrl = current;
  let currentMethod: HttpAllowedMethod = method;
  let currentBody: string | undefined = bodyStr;
  const deadline = Date.now() + HTTP_TIMEOUT_MS;

  while (redirects <= HTTP_MAX_REDIRECTS) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return {
        ok: false,
        error: `Upstream request timed out after ${HTTP_TIMEOUT_MS}ms`,
        code: "timeout",
        status: 504,
        elapsedMs: elapsed(),
      };
    }

    const checked = await assertSafePublicUrl(current);
    if ("ok" in checked && checked.ok === false) {
      return mapFetchUrlError(checked, elapsed());
    }
    const { url } = checked as { url: URL };

    const outbound: Record<string, string> = {
      ...filtered.headers,
      "User-Agent":
        filtered.headers["User-Agent"] ??
        filtered.headers["user-agent"] ??
        "HorizonPulseHttp/1.0 (+https://horizonpulse.dev)",
      Accept: filtered.headers["Accept"] ?? filtered.headers["accept"] ?? "*/*",
    };
    // Normalize: drop lowercase dupes if we set canonical keys
    delete outbound["user-agent"];
    delete outbound["accept"];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method: currentMethod,
        redirect: "manual",
        signal: controller.signal,
        headers: outbound,
        body:
          currentBody != null && methodAllowsBody(currentMethod)
            ? currentBody
            : undefined,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        return {
          ok: false,
          error: `Upstream request timed out after ${HTTP_TIMEOUT_MS}ms`,
          code: "timeout",
          status: 504,
          elapsedMs: elapsed(),
        };
      }
      const message = err instanceof Error ? err.message : "upstream request failed";
      return {
        ok: false,
        error: message,
        code: "upstream",
        status: 502,
        elapsedMs: elapsed(),
      };
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) {
        return {
          ok: false,
          error: `Redirect ${res.status} without Location header`,
          code: "upstream",
          status: 502,
          elapsedMs: elapsed(),
        };
      }
      redirects += 1;
      if (redirects > HTTP_MAX_REDIRECTS) {
        return {
          ok: false,
          error: `Too many redirects (max ${HTTP_MAX_REDIRECTS})`,
          code: "redirects",
          status: 502,
          elapsedMs: elapsed(),
        };
      }
      current = new URL(loc, url).toString();
      // 301/302/303 → GET without body (common client behavior); 307/308 keep method/body
      if (res.status === 303 || res.status === 301 || res.status === 302) {
        currentMethod = "GET";
        currentBody = undefined;
      }
      continue;
    }

    const cl = res.headers.get("content-length");
    if (cl && Number(cl) > HTTP_MAX_RESPONSE_BYTES) {
      return {
        ok: false,
        error: `Content-Length ${cl} exceeds max ${HTTP_MAX_RESPONSE_BYTES} bytes`,
        code: "too_large",
        status: 413,
        elapsedMs: elapsed(),
      };
    }

    let body: { buf: Buffer; truncated: boolean };
    try {
      if (currentMethod === "HEAD") {
        body = { buf: Buffer.alloc(0), truncated: false };
      } else {
        body = await readBodyCapped(res, HTTP_MAX_RESPONSE_BYTES);
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return {
          ok: false,
          error: `Upstream request timed out after ${HTTP_TIMEOUT_MS}ms`,
          code: "timeout",
          status: 504,
          elapsedMs: elapsed(),
        };
      }
      const message = err instanceof Error ? err.message : "failed reading body";
      return {
        ok: false,
        error: message,
        code: "upstream",
        status: 502,
        elapsedMs: elapsed(),
      };
    }

    const ct = res.headers.get("content-type");
    const textual = looksTextual(ct, body.buf);
    const bodyEncoding: "text" | "base64" = textual ? "text" : "base64";
    const bodyOut = textual
      ? body.buf.toString("utf8")
      : body.buf.toString("base64");

    return {
      ok: true,
      status: res.status,
      headers: filterResponseHeaders(res),
      body: bodyOut,
      bodyEncoding,
      contentType: ct,
      elapsedMs: elapsed(),
      requestedUrl,
      finalUrl: url.toString(),
      method,
      truncated: body.truncated,
      bytesRead: body.buf.length,
    };
  }

  return {
    ok: false,
    error: `Too many redirects (max ${HTTP_MAX_REDIRECTS})`,
    code: "redirects",
    status: 502,
    elapsedMs: elapsed(),
  };
}
