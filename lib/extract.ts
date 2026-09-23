/**
 * Structured HTML extraction for GET|POST /api/extract.
 *
 * Price: $0.015 USDC (15000 atomic) — between /api/http ($0.01 volume proxy)
 * and /api/fetch ($0.02 clean-text). Same payTo + facilitator stack.
 *
 * Inputs: `url` (fetched SSRF-safe) and/or `html` (size-capped). No cookie jar.
 * Parse is lightweight regex/DOM-ish (no cheerio) — honest best-effort.
 */

import {
  assertSafePublicUrl,
  htmlToCleanText,
  FETCH_MAX_BYTES,
  FETCH_TIMEOUT_MS,
  FETCH_MAX_REDIRECTS,
  type FetchUrlError,
} from "./fetch-url";

/** Same raw body band as /api/fetch. */
export const EXTRACT_MAX_HTML_BYTES = FETCH_MAX_BYTES; // ~200KB
export const EXTRACT_TIMEOUT_MS = FETCH_TIMEOUT_MS; // 8s
export const EXTRACT_MAX_REDIRECTS = FETCH_MAX_REDIRECTS; // 3
export const EXTRACT_MAX_REQUEST_JSON_BYTES = 220_000; // html + envelope
export const EXTRACT_TEXT_SAMPLE_CHARS = 2_000;
export const EXTRACT_MAX_LINKS = 40;
export const EXTRACT_MAX_IMAGES = 30;
export const EXTRACT_MAX_HEADINGS = 40;
export const EXTRACT_MAX_JSONLD = 10;

export const EXTRACT_METHODOLOGY = {
  purpose:
    "Extract structured page fields (title, description, links, images, headings, json-ld, text sample) from a public URL or provided HTML for agents",
  priceChoice:
    "$0.015 USDC (15000 atomic) — between /api/http ($0.01) and /api/fetch ($0.02). Same payTo + Base USDC stack.",
  caps: {
    maxHtmlBytes: EXTRACT_MAX_HTML_BYTES,
    timeoutMs: EXTRACT_TIMEOUT_MS,
    maxRedirects: EXTRACT_MAX_REDIRECTS,
    textSampleChars: EXTRACT_TEXT_SAMPLE_CHARS,
  },
  allowedSchemes: ["http:", "https:"],
  ssrf:
    "When fetching url: blocks localhost, private, link-local, and metadata IPs; re-checks each redirect hop (shared assertSafePublicUrl with /api/fetch)",
  parsing:
    "Lightweight regex extraction (no cheerio). Best-effort; omit empty fields. Not a full browser DOM.",
  cookies: "No cookie jar; outbound fetch never sends Cookie.",
} as const;

export type ExtractLink = { href: string; text: string };
export type ExtractImage = { src: string; alt?: string };
export type ExtractHeading = { level: number; text: string };

export type ExtractSuccess = {
  ok: true;
  url?: string;
  title?: string;
  description?: string;
  canonical?: string;
  language?: string;
  links?: ExtractLink[];
  images?: ExtractImage[];
  jsonLd?: unknown[];
  headings?: ExtractHeading[];
  textSample?: string;
  elapsedMs: number;
  truncated?: boolean;
  bytesRead?: number;
  finalUrl?: string;
};

export type ExtractError = {
  ok: false;
  error: string;
  code:
    | "missing_input"
    | "bad_url"
    | "scheme_blocked"
    | "host_blocked"
    | "content_type"
    | "timeout"
    | "too_large"
    | "upstream"
    | "redirects"
    | "html_too_large"
    | "bad_html";
  status: number;
  elapsedMs: number;
};

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

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function attr(tag: string, name: string): string | null {
  const re = new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  );
  const m = tag.match(re);
  if (!m) return null;
  return decodeEntities((m[1] ?? m[2] ?? m[3] ?? "").trim());
}

function baseType(ct: string | null): string | null {
  if (!ct) return null;
  return ct.split(";")[0]!.trim().toLowerCase();
}

function resolveUrl(href: string, base: string | undefined): string {
  const h = href.trim();
  if (!h || h.startsWith("#") || h.startsWith("javascript:") || h.startsWith("data:")) {
    return h;
  }
  if (!base) return h;
  try {
    return new URL(h, base).toString();
  } catch {
    return h;
  }
}

/**
 * Best-effort structured extract from an HTML string.
 */
export function extractFromHtml(
  html: string,
  opts?: { baseUrl?: string },
): Omit<ExtractSuccess, "ok" | "elapsedMs" | "truncated" | "bytesRead" | "finalUrl"> {
  const base = opts?.baseUrl;
  const out: Omit<
    ExtractSuccess,
    "ok" | "elapsedMs" | "truncated" | "bytesRead" | "finalUrl"
  > = {};

  if (base) out.url = base;

  const titleM = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleM ? stripTags(titleM[1]!) : "";
  if (title) out.title = title;

  // meta description / og:description
  let description = "";
  const metaRe = /<meta\b[^>]*>/gi;
  let metaTag: RegExpExecArray | null;
  while ((metaTag = metaRe.exec(html)) !== null) {
    const tag = metaTag[0]!;
    const name = (attr(tag, "name") || attr(tag, "property") || "").toLowerCase();
    if (
      name === "description" ||
      name === "og:description" ||
      name === "twitter:description"
    ) {
      const content = attr(tag, "content");
      if (content) {
        description = content;
        if (name === "description") break; // prefer plain description
      }
    }
  }
  if (description) out.description = description;

  // canonical
  const linkRe = /<link\b[^>]*>/gi;
  let linkTag: RegExpExecArray | null;
  while ((linkTag = linkRe.exec(html)) !== null) {
    const tag = linkTag[0]!;
    const rel = (attr(tag, "rel") || "").toLowerCase();
    if (rel.split(/\s+/).includes("canonical")) {
      const href = attr(tag, "href");
      if (href) {
        out.canonical = resolveUrl(href, base);
        break;
      }
    }
  }

  // language
  const htmlLang = html.match(/<html\b[^>]*>/i);
  if (htmlLang) {
    const lang = attr(htmlLang[0]!, "lang");
    if (lang) out.language = lang;
  }

  // links
  const links: ExtractLink[] = [];
  const aRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let aM: RegExpExecArray | null;
  while ((aM = aRe.exec(html)) !== null && links.length < EXTRACT_MAX_LINKS) {
    const href = attr(`<a ${aM[1]!}>`, "href");
    if (!href || href.startsWith("javascript:") || href.startsWith("data:")) continue;
    const text = stripTags(aM[2]!).slice(0, 200);
    links.push({ href: resolveUrl(href, base), text });
  }
  if (links.length) out.links = links;

  // images
  const images: ExtractImage[] = [];
  const imgRe = /<img\b[^>]*>/gi;
  let imgM: RegExpExecArray | null;
  while ((imgM = imgRe.exec(html)) !== null && images.length < EXTRACT_MAX_IMAGES) {
    const tag = imgM[0]!;
    const src = attr(tag, "src") || attr(tag, "data-src");
    if (!src || src.startsWith("data:")) continue;
    const alt = attr(tag, "alt") || undefined;
    const item: ExtractImage = { src: resolveUrl(src, base) };
    if (alt) item.alt = alt.slice(0, 200);
    images.push(item);
  }
  if (images.length) out.images = images;

  // json-ld
  const jsonLd: unknown[] = [];
  const ldRe =
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let ldM: RegExpExecArray | null;
  while ((ldM = ldRe.exec(html)) !== null && jsonLd.length < EXTRACT_MAX_JSONLD) {
    const raw = ldM[1]!.trim();
    if (!raw) continue;
    try {
      jsonLd.push(JSON.parse(raw));
    } catch {
      // skip invalid JSON-LD blocks honestly
    }
  }
  if (jsonLd.length) out.jsonLd = jsonLd;

  // headings
  const headings: ExtractHeading[] = [];
  const hRe = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let hM: RegExpExecArray | null;
  while ((hM = hRe.exec(html)) !== null && headings.length < EXTRACT_MAX_HEADINGS) {
    const level = Number(hM[1]);
    const text = stripTags(hM[2]!).slice(0, 300);
    if (!text) continue;
    headings.push({ level, text });
  }
  if (headings.length) out.headings = headings;

  // text sample (reuse fetch cleaner)
  const cleaned = htmlToCleanText(html);
  if (cleaned) {
    const truncated =
      cleaned.length > EXTRACT_TEXT_SAMPLE_CHARS
        ? `${cleaned.slice(0, EXTRACT_TEXT_SAMPLE_CHARS)}…`
        : cleaned;
    out.textSample = truncated;
  }

  return out;
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

function mapFetchUrlError(err: FetchUrlError, elapsedMs: number): ExtractError {
  return {
    ok: false,
    error: err.error,
    code: err.code as ExtractError["code"],
    status: err.status,
    elapsedMs,
  };
}

/**
 * Fetch public URL → raw HTML with SSRF + size/time caps (no cookies).
 */
export async function fetchHtmlForExtract(
  rawUrl: string,
): Promise<
  | {
      ok: true;
      html: string;
      requestedUrl: string;
      finalUrl: string;
      truncated: boolean;
      bytesRead: number;
    }
  | ExtractError
> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;

  if (!rawUrl || !rawUrl.trim()) {
    return {
      ok: false,
      error: "url is required when html is not provided",
      code: "missing_input",
      status: 400,
      elapsedMs: elapsed(),
    };
  }

  let current = rawUrl.trim();
  let redirects = 0;
  const requestedUrl = current;
  const deadline = Date.now() + EXTRACT_TIMEOUT_MS;

  while (redirects <= EXTRACT_MAX_REDIRECTS) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return {
        ok: false,
        error: `Upstream fetch timed out after ${EXTRACT_TIMEOUT_MS}ms`,
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

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept: "text/html, application/xhtml+xml;q=0.9, */*;q=0.1",
          "User-Agent": "HorizonPulseExtract/1.0 (+https://horizonpulse.dev)",
        },
        // No cookie jar — fetch default has no credentials store here
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        return {
          ok: false,
          error: `Upstream fetch timed out after ${EXTRACT_TIMEOUT_MS}ms`,
          code: "timeout",
          status: 504,
          elapsedMs: elapsed(),
        };
      }
      const message = err instanceof Error ? err.message : "upstream fetch failed";
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
      if (redirects > EXTRACT_MAX_REDIRECTS) {
        return {
          ok: false,
          error: `Too many redirects (max ${EXTRACT_MAX_REDIRECTS})`,
          code: "redirects",
          status: 502,
          elapsedMs: elapsed(),
        };
      }
      current = new URL(loc, url).toString();
      continue;
    }

    const ct = res.headers.get("content-type");
    const b = baseType(ct);
    if (
      b &&
      b !== "text/html" &&
      b !== "application/xhtml+xml" &&
      !b.endsWith("+html")
    ) {
      return {
        ok: false,
        error: `Unsupported Content-Type ${ct ?? "(missing)"}; extract expects HTML`,
        code: "content_type",
        status: 415,
        elapsedMs: elapsed(),
      };
    }

    const cl = res.headers.get("content-length");
    if (cl && Number(cl) > EXTRACT_MAX_HTML_BYTES) {
      return {
        ok: false,
        error: `Content-Length ${cl} exceeds max ${EXTRACT_MAX_HTML_BYTES} bytes`,
        code: "too_large",
        status: 413,
        elapsedMs: elapsed(),
      };
    }

    let body: { buf: Buffer; truncated: boolean };
    try {
      body = await readBodyCapped(res, EXTRACT_MAX_HTML_BYTES);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return {
          ok: false,
          error: `Upstream fetch timed out after ${EXTRACT_TIMEOUT_MS}ms`,
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

    if (!res.ok) {
      return {
        ok: false,
        error: `Upstream returned HTTP ${res.status}`,
        code: "upstream",
        status: 502,
        elapsedMs: elapsed(),
      };
    }

    return {
      ok: true,
      html: body.buf.toString("utf8"),
      requestedUrl,
      finalUrl: url.toString(),
      truncated: body.truncated,
      bytesRead: body.buf.length,
    };
  }

  return {
    ok: false,
    error: `Too many redirects (max ${EXTRACT_MAX_REDIRECTS})`,
    code: "redirects",
    status: 502,
    elapsedMs: elapsed(),
  };
}

export type ExtractInput = {
  url?: string;
  html?: string;
};

/**
 * Extract structured fields from url and/or html.
 * If html is provided, parse it (optional url echoed). Else fetch url.
 */
export async function extractPage(
  input: ExtractInput,
): Promise<ExtractSuccess | ExtractError> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;

  const urlIn = typeof input.url === "string" ? input.url.trim() : "";
  const htmlIn = typeof input.html === "string" ? input.html : "";

  if (!htmlIn && !urlIn) {
    return {
      ok: false,
      error: "Provide url and/or html (at least one required)",
      code: "missing_input",
      status: 400,
      elapsedMs: elapsed(),
    };
  }

  let html = htmlIn;
  let truncated: boolean | undefined;
  let bytesRead: number | undefined;
  let finalUrl: string | undefined;
  let baseUrl: string | undefined = urlIn || undefined;

  if (htmlIn) {
    const bytes = Buffer.byteLength(htmlIn, "utf8");
    if (bytes > EXTRACT_MAX_HTML_BYTES) {
      return {
        ok: false,
        error: `html ${bytes} bytes exceeds max ${EXTRACT_MAX_HTML_BYTES}`,
        code: "html_too_large",
        status: 413,
        elapsedMs: elapsed(),
      };
    }
    bytesRead = bytes;
  } else {
    const fetched = await fetchHtmlForExtract(urlIn);
    if (!fetched.ok) return fetched;
    html = fetched.html;
    truncated = fetched.truncated;
    bytesRead = fetched.bytesRead;
    finalUrl = fetched.finalUrl;
    baseUrl = fetched.finalUrl;
  }

  if (!html || !html.trim()) {
    return {
      ok: false,
      error: "HTML is empty",
      code: "bad_html",
      status: 400,
      elapsedMs: elapsed(),
    };
  }

  const fields = extractFromHtml(html, { baseUrl });

  const result: ExtractSuccess = {
    ok: true,
    ...fields,
    elapsedMs: elapsed(),
  };
  if (truncated) result.truncated = true;
  if (bytesRead != null) result.bytesRead = bytesRead;
  if (finalUrl) result.finalUrl = finalUrl;
  // Prefer finalUrl as url when we fetched
  if (finalUrl) result.url = finalUrl;
  else if (urlIn && !result.url) result.url = urlIn;

  return result;
}
