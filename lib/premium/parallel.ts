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
export type ParallelResult = { url: string; title: string | null; publish_date: string | null; excerpts: string[] };
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
      excerpts: Array.isArray(o.excerpts) ? o.excerpts.filter((e): e is string => typeof e === "string").map((e) => e.slice(0, 4000)).slice(0, 10) : [],
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
export function searchBody(objective: string, queries: string[], maxResults: number) {
  return { objective, search_queries: queries.slice(0, 5), mode: "fast" as const, advanced_settings: { max_results: maxResults } };
}

export async function parallelSearch(objective: string, queries: string[], maxResults: number, deadline: number): Promise<ParallelResult[]> {
  const j = await post("/v1/search", searchBody(objective, queries, maxResults), deadline);
  return clean(j?.results);
}

export async function parallelExtract(objective: string, urls: string[], deadline: number): Promise<ParallelResult[]> {
  if (urls.length === 0) return [];
  const j = await post("/v1/extract", { urls: urls.slice(0, 20), objective }, deadline);
  return clean(j?.results);
}
