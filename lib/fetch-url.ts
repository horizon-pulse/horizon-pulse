/**
 * Best-effort URL → clean text/markdown for GET /api/fetch.
 * Caps + SSRF guards so we cannot be DoS'd or used as an open proxy to private nets.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const FETCH_MAX_BYTES = 200_000; // ~200KB raw before trim
export const FETCH_TIMEOUT_MS = 8_000;
export const FETCH_MAX_REDIRECTS = 3;

export const FETCH_METHODOLOGY = {
  purpose: "Fetch a public http(s) URL and return best-effort clean text/markdown",
  caps: {
    maxBytesRaw: FETCH_MAX_BYTES,
    timeoutMs: FETCH_TIMEOUT_MS,
    maxRedirects: FETCH_MAX_REDIRECTS,
  },
  allowedSchemes: ["http:", "https:"],
  preferredContentTypes: [
    "text/html",
    "text/plain",
    "application/json",
    "text/markdown",
  ],
  ssrf:
    "Blocks localhost, private, link-local, and metadata IPs; re-checks each redirect hop",
  cleaning:
    "Best-effort: strip script/style/noscript, common chrome (nav/header/footer/aside), HTML tags; collapse whitespace. Not a full readability engine.",
} as const;

const PREFERRED_TYPES = FETCH_METHODOLOGY.preferredContentTypes;

export type FetchUrlResult = {
  ok: true;
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string | null;
  truncated: boolean;
  bytesRead: number;
  content: string;
  format: "markdown" | "text" | "json";
};

export type FetchUrlError = {
  ok: false;
  error: string;
  code:
    | "missing_url"
    | "bad_url"
    | "scheme_blocked"
    | "host_blocked"
    | "content_type"
    | "timeout"
    | "too_large"
    | "upstream"
    | "redirects";
  status: number;
};

function baseType(ct: string | null): string | null {
  if (!ct) return null;
  return ct.split(";")[0]!.trim().toLowerCase();
}

function isPreferredContentType(ct: string | null): boolean {
  const b = baseType(ct);
  if (!b) return false;
  return PREFERRED_TYPES.some((p) => b === p);
}

/** IPv4 private / special-use ranges we refuse. */
function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((x) => Number(x));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0.0/24
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isBlockedIpv6(ip: string): boolean {
  const n = ip.toLowerCase();
  if (n === "::" || n === "::1") return true;
  // Unique local fc00::/7, link-local fe80::/10, multicast ff00::/8
  if (n.startsWith("fc") || n.startsWith("fd")) return true;
  if (n.startsWith("fe8") || n.startsWith("fe9") || n.startsWith("fea") || n.startsWith("feb")) {
    return true;
  }
  if (n.startsWith("ff")) return true;
  // IPv4-mapped ::ffff:x.x.x.x
  const mapped = n.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]!);
  return false;
}

export function isBlockedIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isBlockedIpv4(ip);
  if (v === 6) return isBlockedIpv6(ip);
  return true;
}

function hostnameLooksLocal(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (h === "metadata.google.internal") return true;
  return false;
}

/**
 * Validate URL shape + resolve DNS; refuse private / local targets.
 */
export async function assertSafePublicUrl(
  raw: string,
): Promise<{ url: URL } | FetchUrlError> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return {
      ok: false,
      error: "url is not a valid absolute URL",
      code: "bad_url",
      status: 400,
    };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      ok: false,
      error: "Only http and https URLs are allowed",
      code: "scheme_blocked",
      status: 400,
    };
  }
  if (url.username || url.password) {
    return {
      ok: false,
      error: "URLs with embedded credentials are not allowed",
      code: "bad_url",
      status: 400,
    };
  }
  const host = url.hostname;
  if (hostnameLooksLocal(host)) {
    return {
      ok: false,
      error: "localhost / local hostnames are blocked",
      code: "host_blocked",
      status: 400,
    };
  }
  const literal = isIP(host);
  if (literal) {
    if (isBlockedIp(host)) {
      return {
        ok: false,
        error: "Private, loopback, or link-local IP targets are blocked",
        code: "host_blocked",
        status: 400,
      };
    }
    return { url };
  }
  try {
    const answers = await lookup(host, { all: true, verbatim: true });
    if (!answers.length) {
      return {
        ok: false,
        error: `DNS lookup returned no addresses for ${host}`,
        code: "host_blocked",
        status: 400,
      };
    }
    for (const a of answers) {
      if (isBlockedIp(a.address)) {
        return {
          ok: false,
          error: `Host ${host} resolves to a blocked address (${a.address})`,
          code: "host_blocked",
          status: 400,
        };
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "DNS lookup failed";
    return {
      ok: false,
      error: `DNS lookup failed for ${host}: ${message}`,
      code: "host_blocked",
      status: 400,
    };
  }
  return { url };
}

/** Strip noisy HTML chrome → plain-ish text (best-effort, no extra deps). */
export function htmlToCleanText(html: string): string {
  let s = html;
  // Remove script/style/noscript blocks
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  // Drop common chrome regions wholesale
  s = s.replace(/<(nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  // Prefer title as a heading if present
  const titleMatch = s.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch
    ? decodeEntities(titleMatch[1]!.replace(/<[^>]+>/g, "").trim())
    : "";
  // Drop head entirely after capturing title
  s = s.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, " ");
  // Block → newlines
  s = s.replace(/<\/(p|div|section|article|h[1-6]|li|tr|br|hr)\s*>/gi, "\n");
  s = s.replace(/<(br|hr)\s*\/?>/gi, "\n");
  s = s.replace(/<\/?(p|div|section|article|li|tr)\b[^>]*>/gi, "\n");
  s = s.replace(/<h([1-6])\b[^>]*>/gi, (_, n) => `\n${"#".repeat(Number(n))} `);
  s = s.replace(/<\/h[1-6]\s*>/gi, "\n");
  // Remaining tags
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/\r/g, "");
  s = s.replace(/[ \t]+\n/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  s = s.replace(/[ \t]{2,}/g, " ");
  s = s.trim();
  if (title && !s.toLowerCase().startsWith(title.toLowerCase())) {
    s = `# ${title}\n\n${s}`;
  }
  return s;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const c = Number.parseInt(h, 16);
      return Number.isFinite(c) ? String.fromCodePoint(c) : "";
    })
    .replace(/&#(\d+);/g, (_, d) => {
      const c = Number.parseInt(d, 10);
      return Number.isFinite(c) ? String.fromCodePoint(c) : "";
    });
}

function cleanByContentType(raw: string, ct: string | null): {
  content: string;
  format: "markdown" | "text" | "json";
} {
  const b = baseType(ct);
  if (b === "text/html") {
    return { content: htmlToCleanText(raw), format: "markdown" };
  }
  if (b === "application/json") {
    try {
      const parsed = JSON.parse(raw);
      return {
        content: JSON.stringify(parsed, null, 2),
        format: "json",
      };
    } catch {
      return { content: raw.trim(), format: "json" };
    }
  }
  if (b === "text/markdown") {
    return { content: raw.trim(), format: "markdown" };
  }
  return { content: raw.trim(), format: "text" };
}

async function readBodyCapped(
  res: Response,
  maxBytes: number,
): Promise<{ buf: Buffer; truncated: boolean }> {
  if (!res.body) {
    const text = await res.text();
    const buf = Buffer.from(text, "utf8");
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

/**
 * Fetch a public URL with SSRF + size/time caps; return cleaned text.
 */
export async function fetchPublicUrl(
  rawUrl: string,
): Promise<FetchUrlResult | FetchUrlError> {
  if (!rawUrl || !rawUrl.trim()) {
    return {
      ok: false,
      error: "Query param url is required (absolute http/https URL)",
      code: "missing_url",
      status: 400,
    };
  }

  let current = rawUrl.trim();
  let redirects = 0;
  const requestedUrl = current;
  const deadline = Date.now() + FETCH_TIMEOUT_MS;

  while (redirects <= FETCH_MAX_REDIRECTS) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return {
        ok: false,
        error: `Upstream fetch timed out after ${FETCH_TIMEOUT_MS}ms`,
        code: "timeout",
        status: 504,
      };
    }

    const checked = await assertSafePublicUrl(current);
    if ("ok" in checked && checked.ok === false) return checked;
    const { url } = checked as { url: URL };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept: "text/html, text/plain, application/json, text/markdown;q=0.9, */*;q=0.1",
          "User-Agent": "HorizonPulseFetch/1.0 (+https://horizonpulse.dev)",
        },
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        return {
          ok: false,
          error: `Upstream fetch timed out after ${FETCH_TIMEOUT_MS}ms`,
          code: "timeout",
          status: 504,
        };
      }
      const message = err instanceof Error ? err.message : "upstream fetch failed";
      return {
        ok: false,
        error: message,
        code: "upstream",
        status: 502,
      };
    } finally {
      clearTimeout(timer);
    }

    // Redirects
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) {
        return {
          ok: false,
          error: `Redirect ${res.status} without Location header`,
          code: "upstream",
          status: 502,
        };
      }
      redirects += 1;
      if (redirects > FETCH_MAX_REDIRECTS) {
        return {
          ok: false,
          error: `Too many redirects (max ${FETCH_MAX_REDIRECTS})`,
          code: "redirects",
          status: 502,
        };
      }
      current = new URL(loc, url).toString();
      continue;
    }

    const ct = res.headers.get("content-type");
    if (!isPreferredContentType(ct)) {
      return {
        ok: false,
        error: `Unsupported Content-Type ${ct ?? "(missing)"}; preferred: ${PREFERRED_TYPES.join(", ")}`,
        code: "content_type",
        status: 415,
      };
    }

    const cl = res.headers.get("content-length");
    if (cl && Number(cl) > FETCH_MAX_BYTES) {
      return {
        ok: false,
        error: `Content-Length ${cl} exceeds max ${FETCH_MAX_BYTES} bytes`,
        code: "too_large",
        status: 413,
      };
    }

    let body: { buf: Buffer; truncated: boolean };
    try {
      body = await readBodyCapped(res, FETCH_MAX_BYTES);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return {
          ok: false,
          error: `Upstream fetch timed out after ${FETCH_TIMEOUT_MS}ms`,
          code: "timeout",
          status: 504,
        };
      }
      const message = err instanceof Error ? err.message : "failed reading body";
      return { ok: false, error: message, code: "upstream", status: 502 };
    }

    if (!res.ok) {
      return {
        ok: false,
        error: `Upstream returned HTTP ${res.status}`,
        code: "upstream",
        status: 502,
      };
    }

    const rawText = body.buf.toString("utf8");
    const cleaned = cleanByContentType(rawText, ct);

    return {
      ok: true,
      requestedUrl,
      finalUrl: url.toString(),
      status: res.status,
      contentType: ct,
      truncated: body.truncated,
      bytesRead: body.buf.length,
      content: cleaned.content,
      format: cleaned.format,
    };
  }

  return {
    ok: false,
    error: `Too many redirects (max ${FETCH_MAX_REDIRECTS})`,
    code: "redirects",
    status: 502,
  };
}
