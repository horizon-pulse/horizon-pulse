/**
 * Parallel (parallel.ai) Search + Extract client. DeepSeek dropped (Michael GO 2026-10-19 2:04 PM AST); Parallel only.
 *
 * - Key: process.env.PARALLEL_API_KEY ONLY (Vercel env). Never logged, never returned, never stored. No account
 *   exists yet (Michael creates it himself after a read-only terms review); without the key every premium tier
 *   refuses with an uncharged 503 BEFORE any 402 / verify / settle.
 * - Endpoints: POST https://api.parallel.ai/v1/search and /v1/extract (docs.parallel.ai, read 2026-10-19), mode "fast".
 * - Per-buyer output (Counsel cond. 2): no cache of any kind here; every call goes upstream for that one request.
 * - Output is used inside this one request/job only; archive copies (async tiers) come from our own fetch, never
 *   from Parallel output.
 */
export const PARALLEL_BASE = "https://api.parallel.ai";
/** fetched_at: when WE fetched the page (Counsel E2: carried per page, also for cached index pages). */
export type ParallelResult = { url: string; title: string | null; publish_date: string | null; excerpts: string[]; fetched_at?: string };
export type ParallelDeps = { fetch: typeof fetch };

let depsOverride: ParallelDeps | null = null;
export function setParallelForTests(d: ParallelDeps | null) {
  depsOverride = d;
}

export function parallelKeyPresent(env: Record<string, string | undefined> = process.env): boolean {
  return typeof env.PARALLEL_API_KEY === "string" && env.PARALLEL_API_KEY.trim().length > 0;
}

export class ParallelError extends Error {}

function clean(results: unknown): ParallelResult[] {
  if (!Array.isArray(results)) return [];
  const out: ParallelResult[] = [];
  for (const r of results) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (typeof o.url !== "string" || !/^https?:\/\//i.test(o.url)) continue;
    out.push({
      url: o.url.slice(0, 2048),
      title: typeof o.title === "string" ? o.title.slice(0, 300) : null,
      publish_date: typeof o.publish_date === "string" ? o.publish_date.slice(0, 32) : null,
      // Verified brief: full page text (capped) when requested, so sentences are read in context, not only excerpts.
      excerpts: typeof o.full_content === "string" && o.full_content.length ? [o.full_content.slice(0, FULL_CONTENT_MAX_CHARS)] : Array.isArray(o.excerpts) ? o.excerpts.filter((e): e is string => typeof e === "string").map((e) => e.slice(0, 4000)).slice(0, 10) : [],
    });
  }
  return out;
}

async function post(path: string, body: unknown, deadline: number): Promise<any> {
  const key = process.env.PARALLEL_API_KEY?.trim();
  if (!key) throw new ParallelError("not_configured");
  const budget = deadline - Date.now();
  if (budget <= 0) throw new ParallelError("budget");
  const f = depsOverride?.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(`${PARALLEL_BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(budget),
      cache: "no-store",
    });
  } catch {
    throw new ParallelError("upstream_unreachable");
  }
  if (!res.ok) throw new ParallelError(`upstream_${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new ParallelError("upstream_bad_json");
  }
}

/** POST /v1/search body. v1 rejects unknown top-level fields (additionalProperties:false -> 422): max_results lives under
 * advanced_settings (a top-level max_results was only accepted by v1beta). */
export type SearchOpts = { afterDate?: string; includeDomains?: string[] };
/** afterDate (YYYY-MM-DD) maps to advanced_settings.source_policy.after_date (Parallel v1): content published on/after it. */
export function searchBody(objective: string, queries: string[], maxResults: number, opts: SearchOpts = {}) {
  const advanced_settings: Record<string, unknown> = { max_results: maxResults };
  const sp: Record<string, unknown> = {};
  if (opts.afterDate && /^\d{4}-\d{2}-\d{2}$/.test(opts.afterDate)) sp.after_date = opts.afterDate;
  if (opts.includeDomains?.length) sp.include_domains = opts.includeDomains.slice(0, 20);
  if (Object.keys(sp).length) advanced_settings.source_policy = sp;
  return { objective, search_queries: queries.slice(0, 5), mode: "fast" as const, advanced_settings };
}

export async function parallelSearch(objective: string, queries: string[], maxResults: number, deadline: number, opts: SearchOpts = {}): Promise<ParallelResult[]> {
  const j = await post("/v1/search", searchBody(objective, queries, maxResults, opts), deadline);
  return clean(j?.results);
}

/**
 * Odin ruling A+B (B): live fetch only for this allowlist (pages whose live value is the point: gas tracker, USDC stats).
 * Parallel v1 /v1/extract advanced_settings.fetch_policy (max_age_seconds min 600; cache fallback kept on). No surcharge
 * is listed for live fetch (Extract is $1 / 1,000 URLs); it adds latency, so it is bounded by LIVE_FETCH_TIMEOUT_S.
 */
// Hardened spec §3 step 1b: never read Etherscan / usdc.org HTML; live values come from on-chain reads (onchain.ts).
// The live-fetch mechanism stays, with an EMPTY allowlist.
export const LIVE_FETCH_ALLOWLIST: readonly string[] = [];
export const EXTRACT_NEVER = ["etherscan.io", "basescan.org", "usdc.org"] as const; // Counsel E10: basescan treated like Etherscan
export const extractAllowed = (url: string) => {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return !EXTRACT_NEVER.some((d) => h === d || h.endsWith(`.${d}`));
  } catch {
    return false;
  }
};
export const LIVE_FETCH_TIMEOUT_S = 6;
export const liveFetchAllowed = (url: string) => {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return LIVE_FETCH_ALLOWLIST.some((d) => h === d || h.endsWith(`.${d}`));
  } catch {
    return false;
  }
};
export const FULL_CONTENT_MAX_CHARS = 40_000;
export function extractBody(objective: string, urls: string[], live = false, full = false) {
  const body: Record<string, unknown> = { urls: urls.slice(0, 20), objective };
  const adv: Record<string, unknown> = {};
  if (live) adv.fetch_policy = { max_age_seconds: 600, timeout_seconds: LIVE_FETCH_TIMEOUT_S, disable_cache_fallback: false };
  if (full) adv.full_content = true;
  if (Object.keys(adv).length) body.advanced_settings = adv;
  return body;
}
export async function parallelExtract(objective: string, urls: string[], deadline: number, full = false): Promise<ParallelResult[]> {
  if (urls.length === 0) return [];
  const live = urls.filter(liveFetchAllowed);
  const cached = urls.filter((u) => !liveFetchAllowed(u));
  const [a, b] = await Promise.all([
    cached.length ? post("/v1/extract", extractBody(objective, cached, false, full), deadline) : Promise.resolve({ results: [] }),
    live.length ? post("/v1/extract", extractBody(objective, live, true), deadline).catch(() => post("/v1/extract", extractBody(objective, live), deadline)) : Promise.resolve({ results: [] }),
  ]);
  return clean([...(a?.results ?? []), ...(b?.results ?? [])]);
}
