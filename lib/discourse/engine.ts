/**
 * /api/discourse/split — "online discourse sample, NOT a poll".
 *
 * Scope memo: to-odin/2026-10-13-crowd-consensus-scope.md (Option B, approved
 * for a branch build only). Sources: Hacker News (hn.algolia.com, public, no
 * key) and Bluesky (AppView app.bsky.feed.searchPosts, public, no key). X and
 * Reddit are deliberately absent (their terms bar paid resale; see memo).
 *
 * Output never contains post text, usernames or handles: only aggregate
 * shares, counts, and source links (HN item URLs; Bluesky post URLs, which
 * carry the account DID because that is how a Bluesky link is addressed).
 *
 * Billing contract (same as every route): any status >= 400 is not settled
 * (REST: x402 wrappers skip settle on >= 400; MCP: isError). Refusals,
 * insufficient samples, source failures and a missing classifier all return
 * >= 400 with charged:false. Only a 200 answer is billed.
 */
import { classifierFromEnv } from "./llm";

export const DISCOURSE_LABEL = "online discourse sample, NOT a poll" as const;

/** Minimum decided (non-neutral) posts for an answer. Below: 422, not charged. */
export const MIN_DECIDED = 30;
/** Per-source fetch cap; also bounds classifier cost (<= 2 x 100 posts per call). */
export const PER_SOURCE_CAP = 100;
/** Each post is truncated before classification (cost bound). */
export const MAX_POST_CHARS = 280;
/** One account counts once; one thread contributes at most this many posts. */
export const PER_THREAD_CAP = 10;
/** Links returned per source. */
export const SAMPLE_LINKS_PER_SOURCE = 5;
export const CACHE_TTL_MS = 60 * 60 * 1000;
export const HN_SEARCH_URL = "https://hn.algolia.com/api/v1/search";
export const HN_ITEM_URL = "https://hacker-news.firebaseio.com/v0/item";
/**
 * Bluesky AppView. public.api.bsky.app answers 403 to searchPosts; api.bsky.app
 * serves it unauthenticated (checked 2026-10-13 with one free GET).
 */
export const BSKY_APPVIEW = "https://api.bsky.app/xrpc";

export const METHOD =
  "Keyword search of public Hacker News comments (Algolia) and Bluesky posts within the window; one post per account, at most 10 per thread; each post (truncated to 280 chars, never returned) is labeled with one side or neutral by a stance classifier; shares are over decided posts with Wilson 95% intervals. Deleted links are removed from the sample, also when a cached answer is served (shares and n are not recomputed)." as const;

export const CAVEATS = [
  "Not a poll: self-selected posters on two tech-leaning, US-heavy networks; not representative of any population.",
  "Keyword search misses posts that use other words and can include off-topic posts.",
  "Bots, coordinated posting and brigading can move the numbers; one-vote-per-account and per-thread caps only reduce this.",
  "Stance labels come from an automated classifier and are sometimes wrong (sarcasm, quotes, negation).",
] as const;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export type SplitInput = { q: string; sides: string[]; windowDays: number };
export type ParseResult = { ok: true; input: SplitInput } | { ok: false; status: number; code: string; error: string };

export function parseSplitInput(raw: { q?: string; sides?: string; window?: string }): ParseResult {
  const q = (raw.q ?? "").trim().replace(/\s+/g, " ");
  if (!q) return { ok: false, status: 400, code: "missing_query", error: "Query param q is required" };
  if (q.length < 3 || q.length > 200) return { ok: false, status: 400, code: "bad_query", error: "q must be 3-200 characters" };
  let sides = ["yes", "no"];
  if (raw.sides != null && raw.sides.trim() !== "") {
    sides = raw.sides.split(",").map((s) => s.trim()).filter(Boolean);
    const uniq = new Set(sides.map((s) => s.toLowerCase()));
    if (sides.length < 2 || sides.length > 4 || uniq.size !== sides.length || sides.some((s) => s.length > 40)) {
      return { ok: false, status: 400, code: "bad_sides", error: "sides must be 2-4 distinct comma-separated labels, each <= 40 chars (default yes,no)" };
    }
  }
  let windowDays = 30;
  if (raw.window != null && raw.window !== "") {
    const m = /^(\d{1,2})d?$/.exec(raw.window.trim());
    const n = m ? Number(m[1]) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 30) {
      return { ok: false, status: 400, code: "bad_window", error: "window must be 1-30 days, e.g. 7d (default 30d)" };
    }
    windowDays = n;
  }
  return { ok: true, input: { q, sides, windowDays } };
}

// ---------------------------------------------------------------------------
// Refusals (conservative keyword rules; refused calls are not charged)
// ---------------------------------------------------------------------------

export type Refusal = { code: "refused_election" | "refused_person" | "refused_health"; reason: string };

const ELECTION_RE =
  /\b(elections?|electoral|ballots?|vote|votes|voting|voters?|candidates?|campaigns?|primar(y|ies) (election|race|vote)s?|caucus(es)?|midterms?|referendum|polls? (show|say|numbers)|presiden(t|tial|cy)|senators?|senate race|governors?|congress(man|woman|ional)?|mayor(al)?|prime minister|parliament(ary)?|democrats?|republicans?|gop|labour party|tory|tories|trump|biden|harris|vance|newsom|desantis|obama)\b/i;

const HEALTH_RE =
  /\b(cures?|vaccines?|vaccinat\w*|cancer|tumou?r|treatments?|therap(y|ies)|dos(e|es|age)|medications?|medicines?|drugs?|prescri\w+|diseases?|disorders?|diagnos\w*|symptoms?|supplements?|ivermectin|covid|autism|diabet\w*|chemo\w*|pregnan\w*|abortion pills?|side effects?|safe to (take|eat|drink)|healthy|unhealthy|health)\b/i;

const ACCUSATION_RE =
  /\b(guilty|innocent|fraud\w*|scam\w*|liars?|lying|criminal|crimes?|cheat\w*|steal\w*|stole|thie(f|ves)|harass\w*|abus\w*|assault\w*|rap(e|ist)|murder\w*|kill(ed|er)?|corrupt\w*|racist|predator|pedo\w*|affair|drunk|addict\w*|bankrupt|fired|arrested|convicted|did (he|she|they) do it|is (he|she) (a|an|bad|evil|good))\b/i;

/** Two or more consecutive capitalized words not at sentence start, e.g. "Jane Smith". */
const PERSON_NAME_RE = /(?:^|[^.?!]\s)([A-Z][a-z'’-]+(?:\s+[A-Z][a-z'’-]+)+)/;

export function refusalFor(q: string): Refusal | null {
  if (ELECTION_RE.test(q)) {
    return { code: "refused_election", reason: "Questions about elections, voting, candidates or politicians are refused: this output looks like polling and must not be cited as one." };
  }
  if (HEALTH_RE.test(q)) {
    return { code: "refused_health", reason: "Health and medical questions are refused: online opinion is not medical evidence." };
  }
  const named = PERSON_NAME_RE.exec(q) ?? (/^[A-Z][a-z'’-]+\s+[A-Z][a-z'’-]+/.exec(q) ? [q, q] : null);
  if (named && ACCUSATION_RE.test(q)) {
    return { code: "refused_person", reason: "Questions about a named person's conduct or character are refused (defamation risk; we cannot tell public figures from private people)." };
  }
  if (/\b(@[a-z0-9_.-]{2,}|my (boss|neighbou?r|ex|coworker|co-worker|landlord|teacher))\b/i.test(q) && ACCUSATION_RE.test(q)) {
    return { code: "refused_person", reason: "Questions about a specific private person's conduct or character are refused." };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

const round = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d;

/** Wilson score 95% interval for k successes out of n (z = 1.959964). */
export function wilson95(k: number, n: number): [number, number] {
  if (n <= 0) return [0, 1];
  const z = 1.959964;
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [round(Math.max(0, center - half)), round(Math.min(1, center + half))];
}

// ---------------------------------------------------------------------------
// Sources (fetch is injected for tests)
// ---------------------------------------------------------------------------

export type Post = {
  source: "hn" | "bsky";
  /** Public link (never contains a handle or username). */
  url: string;
  /** Used for classification only; never returned or cached. */
  text: string;
  /** Internal dedup keys only; never returned or cached. */
  account: string;
  thread: string;
};

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/\s+/g, " ").trim();
}

export async function fetchHn(q: string, windowDays: number, now: number, f: Fetcher): Promise<Post[]> {
  const since = Math.floor(now / 1000) - windowDays * 86400;
  const u = new URL(HN_SEARCH_URL);
  u.searchParams.set("query", q);
  u.searchParams.set("tags", "comment");
  u.searchParams.set("numericFilters", `created_at_i>${since}`);
  u.searchParams.set("hitsPerPage", String(PER_SOURCE_CAP));
  const res = await f(u.toString(), { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`hn ${res.status}`);
  const body = (await res.json()) as { hits?: Array<Record<string, unknown>> };
  const out: Post[] = [];
  for (const h of body.hits ?? []) {
    const text = typeof h.comment_text === "string" ? stripHtml(h.comment_text) : "";
    const id = String(h.objectID ?? "");
    // Deleted / dead comments come back without text (or as a marker): dropped.
    if (!text || !/^\d+$/.test(id) || /^\[(deleted|dead|flagged)\]$/i.test(text) || !h.author) continue;
    out.push({ source: "hn", url: `https://news.ycombinator.com/item?id=${id}`, text, account: `hn:${String(h.author)}`, thread: `hn:${String(h.story_id ?? id)}` });
  }
  return out;
}

export async function fetchBsky(q: string, windowDays: number, now: number, f: Fetcher): Promise<Post[]> {
  const u = new URL(`${BSKY_APPVIEW}/app.bsky.feed.searchPosts`);
  u.searchParams.set("q", q);
  u.searchParams.set("limit", String(PER_SOURCE_CAP));
  u.searchParams.set("sort", "latest");
  u.searchParams.set("since", new Date(now - windowDays * 86400_000).toISOString());
  const res = await f(u.toString(), { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`bsky ${res.status}`);
  const body = (await res.json()) as { posts?: Array<{ uri?: string; author?: { did?: string }; record?: { text?: string; reply?: { root?: { uri?: string } } } }> };
  const out: Post[] = [];
  for (const p of body.posts ?? []) {
    const m = /^at:\/\/(did:[a-z]+:[A-Za-z0-9._:%-]+)\/app\.bsky\.feed\.post\/([A-Za-z0-9]+)$/.exec(p.uri ?? "");
    const text = (p.record?.text ?? "").trim();
    if (!m || !text) continue;
    out.push({ source: "bsky", url: `https://bsky.app/profile/${m[1]}/post/${m[2]}`, text, account: `bsky:${m[1]}`, thread: `bsky:${p.record?.reply?.root?.uri ?? p.uri}` });
  }
  return out;
}

/** One post per account, at most PER_THREAD_CAP per thread (anti-brigading). */
export function dedupe(posts: Post[]): Post[] {
  const seen = new Set<string>();
  const perThread = new Map<string, number>();
  const out: Post[] = [];
  for (const p of posts) {
    if (seen.has(p.account)) continue;
    const t = perThread.get(p.thread) ?? 0;
    if (t >= PER_THREAD_CAP) continue;
    seen.add(p.account);
    perThread.set(p.thread, t + 1);
    out.push(p);
  }
  return out;
}

/** Links still live: Bluesky via app.bsky.feed.getPosts (missing = deleted), HN via the item API (deleted/dead). */
export async function liveLinks(urls: string[], f: Fetcher): Promise<string[]> {
  const bsky = urls.filter((u) => u.startsWith("https://bsky.app/"));
  const hn = urls.filter((u) => u.startsWith("https://news.ycombinator.com/"));
  const alive = new Set<string>();
  if (bsky.length) {
    const toUri = (u: string) => u.replace(/^https:\/\/bsky\.app\/profile\/([^/]+)\/post\/(.+)$/, "at://$1/app.bsky.feed.post/$2");
    const g = new URL(`${BSKY_APPVIEW}/app.bsky.feed.getPosts`);
    for (const u of bsky) g.searchParams.append("uris", toUri(u));
    const res = await f(g.toString(), { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`bsky getPosts ${res.status}`);
    const present = new Set(((await res.json()) as { posts?: { uri?: string }[] }).posts?.map((p) => p.uri) ?? []);
    for (const u of bsky) if (present.has(toUri(u))) alive.add(u);
  }
  await Promise.all(
    hn.map(async (u) => {
      const id = u.split("id=")[1];
      const res = await f(`${HN_ITEM_URL}/${id}.json`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`hn item ${res.status}`);
      const item = (await res.json()) as { deleted?: boolean; dead?: boolean } | null;
      if (item && !item.deleted && !item.dead) alive.add(u);
    }),
  );
  return urls.filter((u) => alive.has(u));
}

// ---------------------------------------------------------------------------
// Classifier (pluggable)
// ---------------------------------------------------------------------------

/** -1 = neutral / off-topic; otherwise index into sides. */
export type StanceLabel = number;
export type ClassifierUsage = { model: string; inputTokens: number; outputTokens: number; calls: number };
export type Classifier = {
  name: string;
  classify(question: string, sides: string[], texts: string[]): Promise<{ labels: StanceLabel[]; usage: ClassifierUsage }>;
};

let classifierOverride: Classifier | null | undefined;

/** Tests (and a future approved provider) plug in here. */
export function setClassifierForTests(c: Classifier | null | undefined): void {
  classifierOverride = c;
}

/**
 * Production classifier (plan v2, Odin PASS): OpenAI gpt-6-luna via
 * DISCOURSE_LLM_API_KEY with an atomic Redis spend reservation
 * ($1/day, $15/month). Missing key or spend store -> null -> 503
 * classifier_unavailable (not charged). Tests never reach the env path.
 */
export function getClassifier(): Classifier | null {
  if (classifierOverride !== undefined) return classifierOverride;
  if (process.env.VITEST) return null;
  return classifierFromEnv(process.env);
}

/**
 * Deterministic stub for tests and the canned demo: a post supports side i if
 * it contains side i's label (or, for default yes/no, a simple agree/disagree
 * cue) and no other side's; otherwise neutral. Not used for paid answers.
 */
export const keywordStubClassifier: Classifier = {
  name: "keyword-stub",
  async classify(_q, sides, texts) {
    const cues: RegExp[] = sides.map((s) => {
      const lower = s.toLowerCase();
      if (lower === "yes") return /\b(yes|agree|definitely|absolutely)\b/i;
      if (lower === "no") return /\b(no|disagree|never|nope)\b/i;
      return new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    });
    const labels = texts.map((t) => {
      const hits = cues.map((re, i) => (re.test(t) ? i : -1)).filter((i) => i >= 0);
      return hits.length === 1 ? hits[0] : -1;
    });
    return { labels, usage: { model: "keyword-stub", inputTokens: 0, outputTokens: 0, calls: 0 } };
  },
};

/**
 * Design-time cost bound for an LLM classifier (ESTIMATE, not measured):
 * posts x (chars/4 tokens + 8 tokens framing) + 300 prompt tokens per batch of 50,
 * output ~4 tokens per post + 20 per batch.
 */
export function estimateCostUsd(posts: number, avgChars: number, inPerM: number, outPerM: number): number {
  const batches = Math.ceil(posts / 50);
  const input = posts * (Math.min(avgChars, MAX_POST_CHARS) / 4 + 8) + batches * 300;
  const output = posts * 4 + batches * 20;
  return (input * inPerM + output * outPerM) / 1e6;
}

// ---------------------------------------------------------------------------
// Engine + 1h cache
// ---------------------------------------------------------------------------

export type SideOut = { label: string; share: number; ci95: [number, number]; n: number };
export type SplitAnswer = {
  ok: true;
  label: typeof DISCOURSE_LABEL;
  question: string;
  sides: SideOut[];
  n_classified: number;
  n_neutral: number;
  n_fetched: number;
  sources: { hn: number; bsky: number };
  sample: string[];
  window: { days: number; from: string; to: string };
  classifier: string;
  method: typeof METHOD;
  caveats: readonly string[];
  cached: boolean;
};
export type SplitError = { ok: false; status: number; code: string; error: string; label: typeof DISCOURSE_LABEL; n_classified?: number; n_fetched?: number };
export type SplitResult = SplitAnswer | SplitError;

type CacheEntry = { at: number; result: SplitResult };
const cache = new Map<string, CacheEntry>();
const CACHE_MAX = 500;

export function resetDiscourseCacheForTests(): void {
  cache.clear();
}

export function cacheKey(input: SplitInput): string {
  return JSON.stringify([input.q.toLowerCase(), input.sides.map((s) => s.toLowerCase()), input.windowDays]);
}

const err = (status: number, code: string, error: string, extra: Partial<SplitError> = {}): SplitError => ({ ok: false, status, code, error, label: DISCOURSE_LABEL, ...extra });

export type Deps = { fetch: Fetcher; now: () => number };
export const defaultDeps = (): Deps => ({ fetch: (u, i) => fetch(u, { ...i, headers: { "user-agent": "HorizonPulse/1.0 (+https://horizonpulse.dev)" } }), now: () => Date.now() });

export async function discourseSplit(input: SplitInput, deps: Deps): Promise<SplitResult> {
  const refusal = refusalFor(input.q);
  if (refusal) return err(422, refusal.code, refusal.reason);

  const key = cacheKey(input);
  const hit = cache.get(key);
  if (hit && deps.now() - hit.at < CACHE_TTL_MS) {
    if (!hit.result.ok) return hit.result;
    // Honor deletes: re-check the sample links before serving a cached answer.
    try {
      const sample = await liveLinks(hit.result.sample, deps.fetch);
      return { ...hit.result, sample, cached: true };
    } catch {
      return { ...hit.result, sample: [], cached: true };
    }
  }

  const classifier = getClassifier();
  if (!classifier) {
    return err(503, "classifier_unavailable", "Stance classifier is not configured on this server yet. Not charged. Free sample: /api/demo/discourse/split");
  }

  const now = deps.now();
  const settled = await Promise.allSettled([fetchHn(input.q, input.windowDays, now, deps.fetch), fetchBsky(input.q, input.windowDays, now, deps.fetch)]);
  if (settled.every((s) => s.status === "rejected")) return err(502, "sources_unavailable", "Hacker News and Bluesky search both failed. Not charged.");
  const raw = settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
  const posts = dedupe(raw);

  const store = (r: SplitResult) => {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
    cache.set(key, { at: now, result: r });
    return r;
  };

  if (posts.length < MIN_DECIDED) {
    return store(err(422, "insufficient_data", `Only ${posts.length} usable posts found (need ${MIN_DECIDED} decided). Not charged.`, { n_fetched: posts.length, n_classified: 0 }));
  }

  let labels: StanceLabel[];
  try {
    ({ labels } = await classifier.classify(input.q, input.sides, posts.map((p) => p.text.slice(0, MAX_POST_CHARS))));
  } catch {
    // Classifier/provider failure (timeout, 5xx, cap reached): 503, never settled, never cached.
    return err(503, "classifier_unavailable", "Stance classifier failed for this request. Not charged. Free sample: /api/demo/discourse/split");
  }
  const counts = input.sides.map(() => 0);
  let neutral = 0;
  labels.forEach((l) => (l >= 0 && l < counts.length ? counts[l]++ : neutral++));
  const decided = counts.reduce((a, b) => a + b, 0);
  if (decided < MIN_DECIDED) {
    return store(err(422, "insufficient_data", `Only ${decided} posts took a side (need ${MIN_DECIDED}). Not charged.`, { n_fetched: posts.length, n_classified: decided }));
  }

  const decidedPosts = posts.filter((_, i) => labels[i] >= 0 && labels[i] < counts.length);
  const sample = [
    ...decidedPosts.filter((p) => p.source === "hn").slice(0, SAMPLE_LINKS_PER_SOURCE),
    ...decidedPosts.filter((p) => p.source === "bsky").slice(0, SAMPLE_LINKS_PER_SOURCE),
  ].map((p) => p.url);

  return store({
    ok: true,
    label: DISCOURSE_LABEL,
    question: input.q,
    sides: input.sides.map((label, i) => ({ label, share: round(counts[i] / decided), ci95: wilson95(counts[i], decided), n: counts[i] })),
    n_classified: decided,
    n_neutral: neutral,
    n_fetched: posts.length,
    sources: { hn: decidedPosts.filter((p) => p.source === "hn").length, bsky: decidedPosts.filter((p) => p.source === "bsky").length },
    sample,
    window: { days: input.windowDays, from: new Date(now - input.windowDays * 86400_000).toISOString(), to: new Date(now).toISOString() },
    classifier: classifier.name,
    method: METHOD,
    caveats: CAVEATS,
    cached: false,
  });
}
