/**
 * /api/search — web search, then fetch the top N results as clean markdown.
 *
 * Search results (links only) come from a search API provider; every result
 * page is then fetched through our own SSRF-safe fetch pipeline
 * (fetchPublicUrl). Provider is selected by env; the key never leaves the
 * server.
 *
 * Billing: a report with >=1 search result is billed, even if some pages fail
 * to fetch (each page carries its own ok/error). Not billed: missing/bad
 * query, provider not configured, provider error/timeout, zero results.
 */
import { fetchPublicUrl } from "@/lib/fetch-url";

export const SEARCH_MAX_RESULTS = 5;
export const SEARCH_DEFAULT_RESULTS = 3;
export const SEARCH_MAX_QUERY_CHARS = 300;
export const SEARCH_PROVIDER_TIMEOUT_MS = 6_000;
export const SEARCH_PAGE_CHAR_CAP = 12_000;

export const SEARCH_METHODOLOGY = {
  search:
    "The query goes to a third-party web search API (provider named in each response). Only result links, titles and snippets are used from the provider.",
  fetch: `Each of the top n results (1-${SEARCH_MAX_RESULTS}, default ${SEARCH_DEFAULT_RESULTS}) is fetched in parallel through the same SSRF-safe pipeline as /api/fetch (private/local targets blocked at every redirect hop, 200KB / 8s caps per page) and converted to clean markdown/text, trimmed to ${SEARCH_PAGE_CHAR_CAP / 1000}K characters per page.`,
  sources: "Every page is returned with its URL, title, rank, and fetch status, so answers can cite sources.",
  billing:
    "Billed when the search returns at least one result, even if some pages fail to fetch (each page reports its own error). Not billed: missing or too-long query, bad n, search provider unavailable or erroring, or zero results; those return 400/404/503 and settlement is skipped.",
  notAdvice: "Pages are returned as served; content is not verified or ranked by Horizon Pulse.",
} as const;

export type SearchHit = { rank: number; url: string; title: string | null; snippet: string | null };
export type SearchPage = SearchHit & {
  ok: boolean;
  finalUrl?: string;
  status?: number;
  format?: string;
  truncated?: boolean;
  content?: string;
  error?: string;
  code?: string;
};
export type SearchResult = {
  ok: true;
  query: string;
  provider: string;
  n: number;
  resultCount: number;
  fetchedOk: number;
  elapsedMs: number;
  results: SearchPage[];
  methodology: typeof SEARCH_METHODOLOGY;
};
export type SearchError = { ok: false; error: string; code: string; status: number };

type Provider = { name: string; search: (q: string, n: number) => Promise<SearchHit[] | SearchError> };

function serper(key: string): Provider {
  return {
    name: "serper (Google results)",
    async search(q, n) {
      let res: Response;
      try {
        res = await fetch("https://google.serper.dev/search", {
          method: "POST",
          headers: { "X-API-KEY": key, "content-type": "application/json" },
          body: JSON.stringify({ q, num: Math.min(10, n + 3) }),
          signal: AbortSignal.timeout(SEARCH_PROVIDER_TIMEOUT_MS),
        });
      } catch {
        return { ok: false, error: "Search provider timed out or was unreachable", code: "provider_unreachable", status: 503 };
      }
      if (!res.ok) return { ok: false, error: `Search provider returned HTTP ${res.status}`, code: "provider_error", status: 503 };
      const j = (await res.json().catch(() => null)) as { organic?: { link?: string; title?: string; snippet?: string }[] } | null;
      return (j?.organic ?? [])
        .filter((o) => typeof o.link === "string" && /^https?:\/\//i.test(o.link))
        .map((o, i) => ({ rank: i + 1, url: o.link!, title: o.title ?? null, snippet: o.snippet ?? null }));
    },
  };
}

export function getSearchProvider(): Provider | null {
  const k = process.env.SERPER_API_KEY?.trim();
  if (k) return serper(k);
  return null;
}

export async function searchAndFetch(
  input: { q?: string; n?: string },
  provider: Provider | null = getSearchProvider(),
): Promise<SearchResult | SearchError> {
  const started = Date.now();
  const q = (input.q ?? "").trim();
  if (!q) return { ok: false, error: "Query param q is required", code: "missing_query", status: 400 };
  if (q.length > SEARCH_MAX_QUERY_CHARS)
    return { ok: false, error: `q exceeds ${SEARCH_MAX_QUERY_CHARS} characters`, code: "query_too_long", status: 400 };
  let n = SEARCH_DEFAULT_RESULTS;
  if (input.n !== undefined && input.n !== "") {
    const v = Number(input.n);
    if (!Number.isInteger(v) || v < 1 || v > SEARCH_MAX_RESULTS)
      return { ok: false, error: `n must be an integer 1-${SEARCH_MAX_RESULTS}`, code: "bad_n", status: 400 };
    n = v;
  }
  if (!provider) return { ok: false, error: "Search provider not configured", code: "provider_unconfigured", status: 503 };

  const hits = await provider.search(q, n);
  if (!Array.isArray(hits)) return hits;
  // de-dupe by URL, keep provider order
  const seen = new Set<string>();
  const top = hits.filter((h) => (seen.has(h.url) ? false : (seen.add(h.url), true))).slice(0, n);
  if (top.length === 0) return { ok: false, error: "No search results for this query", code: "no_results", status: 404 };

  const results: SearchPage[] = await Promise.all(
    top.map(async (h, i): Promise<SearchPage> => {
      const r = await fetchPublicUrl(h.url);
      const base = { ...h, rank: i + 1 };
      if (!r.ok) return { ...base, ok: false, error: r.error, code: r.code };
      const over = r.content.length > SEARCH_PAGE_CHAR_CAP;
      return {
        ...base,
        ok: true,
        finalUrl: r.finalUrl,
        status: r.status,
        format: r.format,
        truncated: r.truncated || over,
        content: over ? r.content.slice(0, SEARCH_PAGE_CHAR_CAP) : r.content,
      };
    }),
  );
  return {
    ok: true,
    query: q,
    provider: provider.name,
    n,
    resultCount: results.length,
    fetchedOk: results.filter((r) => r.ok).length,
    elapsedMs: Date.now() - started,
    results,
    methodology: SEARCH_METHODOLOGY,
  };
}
