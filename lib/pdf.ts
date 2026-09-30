/**
 * /api/pdf — public PDF URL → text per page + metadata.
 *
 * Download: same SSRF guard as /api/fetch on every redirect hop
 * (assertSafePublicUrl), 10MB cap (rejected, never truncated: a cut PDF
 * can't be parsed), 12s download budget. Parse: pdf.js (unpdf) text layer,
 * first 50 pages max, 100K characters total. No OCR.
 *
 * Billing: billed only when text is returned. Not billed: bad input, blocked
 * host, not a PDF, too large, download failure/timeout, encrypted/corrupt
 * PDF, or no text layer (scanned images) → 4xx/5xx, settlement skipped.
 */
import { getDocumentProxy } from "unpdf";
import { assertSafePublicUrl, type FetchUrlError } from "@/lib/fetch-url";

export const PDF_MAX_BYTES = 10 * 1024 * 1024;
export const PDF_TIMEOUT_MS = 12_000;
export const PDF_MAX_REDIRECTS = 3;
export const PDF_MAX_PAGES = 50;
export const PDF_MAX_CHARS = 100_000;
const PARSE_BUDGET_MS = 10_000;

export const PDF_METHODOLOGY = {
  download: `SSRF-safe GET (private/localhost blocked at every redirect hop, ${PDF_MAX_REDIRECTS} redirects), ${PDF_MAX_BYTES / 1024 / 1024}MB cap (larger files are rejected, not truncated), ${PDF_TIMEOUT_MS / 1000}s download budget. The file must start with %PDF-.`,
  parse: `Text layer via pdf.js, pages 1-${PDF_MAX_PAGES} at most (use pages=N to limit), ${PDF_MAX_CHARS / 1000}K characters total. No OCR: scanned image-only PDFs return no_text_layer.`,
  billing:
    "Billed only when text is returned. Not billed: missing/bad URL, blocked host, not a PDF, too large, download failure or timeout, encrypted or corrupt PDF, or no text layer; those return 400/413/415/422/502/504 and settlement is skipped.",
} as const;

export type PdfResult = {
  ok: true;
  requestedUrl: string;
  finalUrl: string;
  bytes: number;
  totalPages: number;
  pagesReturned: number;
  truncated: boolean;
  meta: { title: string | null; author: string | null; subject: string | null; creator: string | null; producer: string | null; creationDate: string | null };
  pages: { page: number; text: string }[];
  methodology: typeof PDF_METHODOLOGY;
};
export type PdfError = { ok: false; error: string; code: string; status: number };

async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) (out.set(c, o), (o += c.byteLength));
  return out;
}

async function download(raw: string): Promise<{ bytes: Uint8Array; finalUrl: string } | PdfError> {
  let current = raw;
  const deadline = Date.now() + PDF_TIMEOUT_MS;
  for (let hop = 0; hop <= PDF_MAX_REDIRECTS; hop++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { ok: false, error: `Download timed out after ${PDF_TIMEOUT_MS}ms`, code: "timeout", status: 504 };
    const checked = await assertSafePublicUrl(current);
    if ("ok" in checked && (checked as FetchUrlError).ok === false) return checked as FetchUrlError;
    const { url } = checked as { url: URL };
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        redirect: "manual",
        signal: AbortSignal.timeout(remaining),
        headers: { Accept: "application/pdf, */*;q=0.1", "User-Agent": "HorizonPulsePdf/1.0 (+https://horizonpulse.dev)" },
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "TimeoutError" || name === "AbortError")
        return { ok: false, error: `Download timed out after ${PDF_TIMEOUT_MS}ms`, code: "timeout", status: 504 };
      return { ok: false, error: err instanceof Error ? err.message : "download failed", code: "upstream", status: 502 };
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      if (!loc) return { ok: false, error: `Redirect ${res.status} without Location`, code: "upstream", status: 502 };
      if (hop === PDF_MAX_REDIRECTS) return { ok: false, error: `Too many redirects (max ${PDF_MAX_REDIRECTS})`, code: "redirects", status: 502 };
      current = new URL(loc, url).toString();
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, error: `Upstream returned HTTP ${res.status}`, code: "upstream", status: 502 };
    }
    const cl = res.headers.get("content-length");
    if (cl && Number(cl) > PDF_MAX_BYTES) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, error: `File is ${cl} bytes; max ${PDF_MAX_BYTES}`, code: "too_large", status: 413 };
    }
    let bytes: Uint8Array | null;
    try {
      bytes = await readCapped(res, PDF_MAX_BYTES);
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "TimeoutError" || name === "AbortError")
        return { ok: false, error: `Download timed out after ${PDF_TIMEOUT_MS}ms`, code: "timeout", status: 504 };
      return { ok: false, error: "Failed reading the file", code: "upstream", status: 502 };
    }
    if (!bytes) return { ok: false, error: `File exceeds ${PDF_MAX_BYTES} bytes`, code: "too_large", status: 413 };
    const head = new TextDecoder().decode(bytes.slice(0, 1024));
    if (!head.includes("%PDF-"))
      return { ok: false, error: `Not a PDF (content-type ${res.headers.get("content-type") ?? "missing"})`, code: "not_pdf", status: 415 };
    return { bytes, finalUrl: url.toString() };
  }
  return { ok: false, error: "Too many redirects", code: "redirects", status: 502 };
}

const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 300) : null);

export async function pdfToText(input: { url?: string; pages?: string }): Promise<PdfResult | PdfError> {
  const raw = (input.url ?? "").trim();
  if (!raw) return { ok: false, error: "Query param url is required (absolute http/https URL of a PDF)", code: "missing_url", status: 400 };
  let maxPages = PDF_MAX_PAGES;
  if (input.pages !== undefined && input.pages !== "") {
    const v = Number(input.pages);
    if (!Number.isInteger(v) || v < 1 || v > PDF_MAX_PAGES)
      return { ok: false, error: `pages must be an integer 1-${PDF_MAX_PAGES}`, code: "bad_pages", status: 400 };
    maxPages = v;
  }
  const dl = await download(raw);
  if ("ok" in dl) return dl;

  let doc: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    doc = await getDocumentProxy(new Uint8Array(dl.bytes), { isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 } as never);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (/password/i.test(msg)) return { ok: false, error: "PDF is encrypted / password-protected", code: "encrypted", status: 422 };
    return { ok: false, error: "PDF could not be parsed (corrupt or unsupported)", code: "parse_failed", status: 422 };
  }
  try {
    const started = Date.now();
    const total = doc.numPages;
    const n = Math.min(total, maxPages);
    const pages: { page: number; text: string }[] = [];
    let chars = 0;
    let truncated = n < total;
    for (let i = 1; i <= n; i++) {
      if (Date.now() - started > PARSE_BUDGET_MS) { truncated = true; break; }
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      let text = "";
      for (const it of tc.items as { str?: string; hasEOL?: boolean }[]) {
        if (typeof it.str === "string") text += it.str + (it.hasEOL ? "\n" : "");
      }
      text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      if (chars + text.length > PDF_MAX_CHARS) {
        text = text.slice(0, PDF_MAX_CHARS - chars);
        truncated = true;
      }
      chars += text.length;
      pages.push({ page: i, text });
      if (chars >= PDF_MAX_CHARS) { truncated = true; break; }
    }
    if (chars === 0)
      return { ok: false, error: "No text layer found (scanned/image-only PDF; OCR not supported)", code: "no_text_layer", status: 422 };
    let info: Record<string, unknown> = {};
    try { info = ((await doc.getMetadata()).info ?? {}) as Record<string, unknown>; } catch {}
    return {
      ok: true,
      requestedUrl: raw,
      finalUrl: dl.finalUrl,
      bytes: dl.bytes.byteLength,
      totalPages: total,
      pagesReturned: pages.length,
      truncated,
      meta: { title: s(info.Title), author: s(info.Author), subject: s(info.Subject), creator: s(info.Creator), producer: s(info.Producer), creationDate: s(info.CreationDate) },
      pages,
      methodology: PDF_METHODOLOGY,
    };
  } finally {
    const d = doc as unknown as { destroy?: () => Promise<void>; cleanup?: () => Promise<void>; loadingTask?: { destroy?: () => Promise<void> } };
    await (d.loadingTask?.destroy?.() ?? d.destroy?.() ?? d.cleanup?.())?.catch?.(() => {});
  }
}
