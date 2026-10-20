/**
 * §1a source archive with hashes ($20 report), Odin Q2: text-extracted copy capped at 256 KB per page in Upstash,
 * plus sha256 of the RAW response bytes; no Blob.
 *  - Copies come from OUR OWN fetch (guardedGet: SSRF guard on every hop, web-checks opt-out, identifying
 *    User-Agent CHECK_USER_AGENT), never from Parallel output.
 *  - robots.txt disallow (for * or HorizonPulseCheck) or noarchive (X-Robots-Tag / meta robots) -> not archived;
 *    the snippet is still cited, marked not_archived.
 *  - Each provider excerpt is checked against our own fetched text (Odin C3): matched -> quote offsets + <= 150 chars
 *    of context each side (<= ~300 total); unmatched -> `not_found_in_source` (kept, labelled).
 *  - Full archived text is stored for integrity/disputes only and never served; the archive URL serves the snippet record.
 */
import { createHash } from "node:crypto";
import { guardedGet, type GuardedGetErr, type GuardedGetOk } from "@/lib/guarded-get";

export const ARCHIVE_TEXT_CAP_BYTES = 256 * 1024;
export const ARCHIVE_RAW_MAX_BYTES = 2 * 1024 * 1024;
export const ARCHIVE_CONTEXT_CHARS = 150;
export const ARCHIVE_FETCH_TIMEOUT_MS = 8_000;
export const ARCHIVE_PARALLEL = 5;
export const ROBOTS_AGENT = "horizonpulsecheck";

type Get = (url: string, opts: { maxBytes: number; timeoutMs: number }) => Promise<GuardedGetOk | GuardedGetErr>;
let getOverride: Get | null = null;
export function setArchiveFetchForTests(g: Get | null) {
  getOverride = g;
}
const get: Get = (u, o) => (getOverride ?? ((x, oo) => guardedGet(x, oo)))(u, o);

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function capUtf8(s: string, maxBytes: number): string {
  const b = Buffer.from(s, "utf8");
  return b.length <= maxBytes ? s : b.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/, "");
}

/** Minimal robots.txt reader: groups for `*` or our agent token; longest-prefix Disallow vs Allow. */
export function robotsAllows(robots: string, path: string): boolean {
  const lines = robots.split(/\r?\n/).map((l) => l.replace(/#.*/, "").trim());
  let applies = false;
  let inGroupAgents = false;
  const rules: { allow: boolean; p: string }[] = [];
  for (const l of lines) {
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(l);
    if (!m) continue;
    const k = m[1].toLowerCase();
    const v = m[2].trim();
    if (k === "user-agent") {
      if (!inGroupAgents) applies = false;
      inGroupAgents = true;
      if (v === "*" || v.toLowerCase().includes(ROBOTS_AGENT)) applies = true;
      continue;
    }
    inGroupAgents = false;
    if (!applies) continue;
    if ((k === "disallow" || k === "allow") && v) rules.push({ allow: k === "allow", p: v });
  }
  let best: { allow: boolean; p: string } | null = null;
  for (const r of rules) if (path.startsWith(r.p) && (!best || r.p.length > best.p.length)) best = r;
  return best ? best.allow : true;
}

export function noArchive(headers: Headers, body: string): boolean {
  if (/noarchive|\bnone\b/i.test(headers.get("x-robots-tag") ?? "")) return true;
  return /<meta[^>]+name=["']?(robots|horizonpulsecheck)["']?[^>]+content=["'][^"']*(noarchive|none)/i.test(body);
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

export type SnippetMatch = { id: string; status: "matched" | "not_found_in_source" | "not_archived"; quote?: string; context_before?: string; context_after?: string; start?: number; end?: number };

/** Find the excerpt (ellipsis stripped, first <= 12 words) in our own text; exact-normalized match only. */
export function matchSnippet(id: string, excerpt: string, text: string): SnippetMatch {
  const words = excerpt.replace(/\s*…$/, "").split(/\s+/).filter(Boolean);
  const probe = norm(words.slice(0, Math.min(12, words.length)).join(" "));
  if (probe.length < 15) return { id, status: "not_found_in_source" };
  const hay = norm(text);
  const at = hay.indexOf(probe);
  if (at < 0) return { id, status: "not_found_in_source" };
  const full = norm(words.join(" "));
  const end = hay.startsWith(full, at) ? at + full.length : at + probe.length;
  return {
    id,
    status: "matched",
    quote: hay.slice(at, end),
    context_before: hay.slice(Math.max(0, at - ARCHIVE_CONTEXT_CHARS), at),
    context_after: hay.slice(end, end + ARCHIVE_CONTEXT_CHARS),
    start: at,
    end,
  };
}

export type ArchivedPage = {
  url: string;
  status: "archived" | "not_archived" | "fetch_failed";
  reason?: string;
  final_url?: string;
  http_status?: number;
  fetched_at: string;
  sha256?: string;
  raw_bytes?: number;
  raw_truncated?: boolean;
  text?: string;
};

export async function archivePage(url: string, robotsCache: Map<string, string | null>): Promise<ArchivedPage> {
  const fetched_at = new Date().toISOString();
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { url, status: "fetch_failed", reason: "bad_url", fetched_at };
  }
  if (!robotsCache.has(u.origin)) {
    const r = await get(`${u.origin}/robots.txt`, { maxBytes: 128 * 1024, timeoutMs: 4_000 });
    robotsCache.set(u.origin, r.ok && r.status === 200 ? r.body : null);
  }
  const robots = robotsCache.get(u.origin);
  if (robots && !robotsAllows(robots, u.pathname + u.search)) return { url, status: "not_archived", reason: "robots_disallow", fetched_at };
  const r = await get(url, { maxBytes: ARCHIVE_RAW_MAX_BYTES, timeoutMs: ARCHIVE_FETCH_TIMEOUT_MS });
  if (!r.ok) return { url, status: "fetch_failed", reason: r.code, fetched_at };
  if (noArchive(r.headers, r.body)) return { url, status: "not_archived", reason: "noarchive", fetched_at, final_url: r.finalUrl, http_status: r.status };
  const raw = Buffer.from(r.body, "utf8");
  const ct = r.headers.get("content-type") ?? "";
  const text = capUtf8(/html|xml/i.test(ct) || /<html|<body/i.test(r.body.slice(0, 2000)) ? htmlToText(r.body) : r.body.replace(/\s+/g, " "), ARCHIVE_TEXT_CAP_BYTES);
  return {
    url,
    status: "archived",
    final_url: r.finalUrl,
    http_status: r.status,
    fetched_at,
    sha256: createHash("sha256").update(raw).digest("hex"),
    raw_bytes: raw.length,
    raw_truncated: r.truncated,
    text,
  };
}

/** Archive up to `urls` with bounded parallelism, stopping new fetches at the deadline. */
export async function archivePages(urls: string[], deadline: number): Promise<ArchivedPage[]> {
  const robots = new Map<string, string | null>();
  const out: ArchivedPage[] = [];
  for (let i = 0; i < urls.length; i += ARCHIVE_PARALLEL) {
    if (Date.now() + ARCHIVE_FETCH_TIMEOUT_MS > deadline) {
      for (const u of urls.slice(i)) out.push({ url: u, status: "fetch_failed", reason: "time_budget", fetched_at: new Date().toISOString() });
      break;
    }
    out.push(...(await Promise.all(urls.slice(i, i + ARCHIVE_PARALLEL).map((u) => archivePage(u, robots)))));
  }
  return out;
}
