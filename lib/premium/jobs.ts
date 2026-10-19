/**
 * Async job path ($20 report, $75 watch) — async scope with Odin's answers Q1–Q6.
 *   Q1 verify at accept, settle after the first deliverable; nothing readable before settle succeeds.
 *   Q2 archive = text <= 256 KB/page + sha256 of raw bytes (archive.ts); no Blob.
 *   Q3 Vercel Hobby: ONE daily cron (/api/premium/cron, CRON_SECRET) + a recovery path inside Hobby limits: every
 *      status-link poll by the token holder runs the job's next bounded step via after(), under a 55 s lease, so a
 *      killed invocation is resumed by the buyer's next poll (or the daily cron). Steps are checkpointed.
 *   Q4 a settle_unconfirmed job is released only when the settle is confirmed on-chain (AuthorizationUsed log for
 *      from+nonce AND authorizationState = used), and only to the job-token holder.
 *   Q5 at most 2 open unsettled jobs per payer and 10 globally (429 before verify).
 *   Q6 the $75 test passes at day 0 + 3 daily records; the watch keeps running, pro rata applies.
 * Storage keys are all job-scoped and carry a TTL (store.ts). Parallel output lives only inside its job's keys.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { BASE_CAIP2, DEFAULT_PAY_TO, USDC_BASE } from "@/lib/config";
import { defaultRpcDeps, rpcCall, type RpcDeps } from "@/lib/chain-rpc";
import { archivePages, matchSnippet, type ArchivedPage } from "./archive";
import { CLAIM_TTL_MS, moveClaim, releaseClaim, type Held } from "./claim";
import { legalBlock } from "./copy";
import { markNonceSettled, nonceUsed, settlePayment, type Decoded } from "./payment";
import { parallelExtract, type ParallelResult } from "./parallel";
import { newReconcileId, recordReconcile } from "./reconcile";
import { compile, researchSearches } from "./research";
import type { PremiumStore } from "./store";
import { tierFor, type Tier } from "./tiers";
import { dayWindow, DAY_MS, diffEvents, watchCheck, watchRefundAtomic, WATCH_DAYS, type CheckRecord } from "./watch";

export const FIRST_DELIVERABLE_BUDGET_MS = 10 * 60_000;
export const OPEN_PER_PAYER = 2;
export const OPEN_GLOBAL = 10;
export const LEASE_MS = 55_000;
export const STEP_RESERVE_MS = 12_000;
export const RETENTION_MS = 30 * DAY_MS;
const S = (ms: number) => Math.ceil(ms / 1000);
const INDEX_TTL_S = S(62 * DAY_MS);

export type JobStatus = "accepted" | "running" | "built" | "settling" | "delivered" | "failed_uncharged" | "settle_unconfirmed" | "watching" | "completed" | "stopped";
export type Job = {
  id: string;
  tier: Tier["id"];
  route: string;
  amount: string;
  payer: string;
  nonce: string;
  valid_before: number;
  rq: string;
  token_sha256: string;
  input: string;
  status: JobStatus;
  created_at: number;
  updated_at: number;
  block_at_accept: number | null;
  claim: { key: string; raw: string };
  steps: { search?: boolean; read?: boolean; archive?: boolean };
  archive_shas?: string[];
  charged: boolean;
  settle_tx: string | null;
  http_equivalent: 502 | 504 | null;
  reconcile_id: string | null;
  failure: string | null;
  purge_at: number;
  watch?: { t0: number; missed: number; recorded: number; stop: null | "ours" | "abuse"; refund_owed: string | null; known_payTos: string[] };
};

const K = {
  job: (id: string) => `job:${id}`,
  auth: (id: string) => `auth:${id}`,
  work: (id: string, s: string) => `work:${id}:${s}`,
  result: (id: string) => `result:${id}`,
  day: (id: string, n: number) => `day:${id}:${n}`,
  arch: (id: string, sha: string) => `arch:${id}:${sha}`,
  snip: (id: string, sha: string) => `snip:${id}:${sha}`,
  gone: (id: string) => `gone:${id}`,
  lease: (id: string) => `lease:${id}`,
  active: "jobs:active",
  purge: "jobs:purge",
  openGlobal: "open:global",
  openPayer: (p: string) => `open:payer:${p.toLowerCase()}`,
  settleFail: (p: string) => `settlefail:${p.toLowerCase()}`,
  settleBlock: (p: string) => `settleblock:${p.toLowerCase()}`,
  settleFailGlobal: "settlefail:global",
};
export const JOB_KEYS = K;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export const JOB_ID_RE = /^job_[0-9a-f]{24}$/;

let clock: () => number = () => Date.now();
/** The job clock (Date.now outside tests); routes derive their deadlines from it. */
export const jobNow = () => clock();
export function setJobClockForTests(f: (() => number) | null) {
  clock = f ?? (() => Date.now());
}
let rpcDeps: RpcDeps | null = null;
export function setJobRpcForTests(d: RpcDeps | null) {
  rpcDeps = d;
}

/** Job key outlives purge_at by 2 days so the DAILY cron always sees it and writes the 410 tombstone. */
function ttlS(job: Job) {
  return Math.max(60, S(job.purge_at - clock() + 2 * DAY_MS));
}
async function saveJob(store: PremiumStore, job: Job) {
  job.updated_at = clock();
  await store.set(K.job(job.id), JSON.stringify(job), ttlS(job));
  await store.zadd(K.purge, job.purge_at, job.id, INDEX_TTL_S);
}
export async function loadJob(store: PremiumStore, id: string): Promise<Job | null> {
  if (!JOB_ID_RE.test(id)) return null;
  const raw = await store.get(K.job(id));
  try {
    return raw ? (JSON.parse(raw) as Job) : null;
  } catch {
    return null;
  }
}

export function tokenMatches(job: { token_sha256: string }, token: string | null): boolean {
  if (!token || token.length < 32 || token.length > 128) return false;
  const a = Buffer.from(sha(token), "hex");
  const b = Buffer.from(job.token_sha256, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Odin ruling 10/19 (closes Sentinel MEDIUM-2 on async): 2 failed settles in 24 h -> payer blocked 24 h, refused before verify. */
export const SETTLE_FAIL_LIMIT = 2;
export const SETTLE_BLOCK_S = 86_400;
export const SETTLE_BLOCK_REASON = "payer_settle_failures";
export async function settleBlocked(store: PremiumStore, payer: string): Promise<boolean> {
  return (await store.get(K.settleBlock(payer))) !== null;
}
/** Odin P2 global breaker: >= 3 failed settles (any payer) in 24 h -> every async accept 503 until they age out. */
export const GLOBAL_SETTLE_FAIL_LIMIT = 3;
export const ASYNC_BREAKER_REASON = "async_settle_breaker_open";
export async function asyncBreakerOpen(store: PremiumStore): Promise<boolean> {
  return (await store.zcardAfterPrune(K.settleFailGlobal, clock())) >= GLOBAL_SETTLE_FAIL_LIMIT;
}
/** Counts settle_timeout / settle_ambiguous / settle_never_landed (one entry per job). */
async function noteSettleFailure(store: PremiumStore, job: Job) {
  const now = clock();
  const exp = now + SETTLE_BLOCK_S * 1000;
  await store.zadd(K.settleFail(job.payer), exp, job.id, SETTLE_BLOCK_S);
  await store.zadd(K.settleFailGlobal, exp, job.id, SETTLE_BLOCK_S);
  if ((await store.zcardAfterPrune(K.settleFail(job.payer), now)) >= SETTLE_FAIL_LIMIT) await store.set(K.settleBlock(job.payer), String(now), SETTLE_BLOCK_S);
}

export const newJobId = () => `job_${randomBytes(12).toString("hex")}`;
/** Odin P5: atomic Q5 reservation (2 per payer, 10 global) in one Lua call; released if the accept does not complete. */
export async function reserveOpen(store: PremiumStore, payer: string, id: string): Promise<boolean> {
  const now = clock();
  return store.reserve([K.openPayer(payer), K.openGlobal], [OPEN_PER_PAYER, OPEN_GLOBAL], id, now + CLAIM_TTL_MS.job, now, S(CLAIM_TTL_MS.job));
}
export async function releaseOpen(store: PremiumStore, payer: string, id: string) {
  await store.zrem(K.openPayer(payer), id);
  await store.zrem(K.openGlobal, id);
}
/** Odin P1: current Base block (null if unknown), recorded before settle so a later log search is bounded. */
export async function currentBlock(): Promise<number | null> {
  try {
    const deps = rpcDeps ?? defaultRpcDeps();
    const b = await rpcCall(deps, "base", "eth_blockNumber", [], deps.now() + 2_000);
    return typeof b === "string" ? Number(BigInt(b)) : null;
  } catch {
    return null;
  }
}

/** Q5: open unsettled jobs (pruned by their 20-min expiry). */
export async function openCounts(store: PremiumStore, payer: string) {
  const now = clock();
  return { payer: await store.zcardAfterPrune(K.openPayer(payer), now), global: await store.zcardAfterPrune(K.openGlobal, now) };
}
async function closeOpen(store: PremiumStore, job: Job) {
  await store.zrem(K.openPayer(job.payer), job.id);
  await store.zrem(K.openGlobal, job.id);
}

/** Accept: called only after Base gate, binding, window, signature, rate limit, claim (state job), nonce and verify. */
export async function createJob(store: PremiumStore, x: Tier, d: Decoded, rq: string, input: string, held: Held, id: string = newJobId()): Promise<{ job: Job; token: string }> {
  const now = clock();
  const token = randomBytes(32).toString("base64url");
  const block = await currentBlock();
  const job: Job = {
    id,
    tier: x.id,
    route: x.route,
    amount: x.amount,
    payer: d.from!,
    nonce: d.nonce!,
    valid_before: Number(d.validBefore),
    rq,
    token_sha256: sha(token),
    input,
    status: "accepted",
    created_at: now,
    updated_at: now,
    block_at_accept: block,
    claim: { key: held.key, raw: held.raw },
    steps: {},
    charged: false,
    settle_tx: null,
    http_equivalent: null,
    reconcile_id: null,
    failure: null,
    purge_at: now + 2 * DAY_MS,
  };
  await store.set(K.auth(id), JSON.stringify(d.raw), S(CLAIM_TTL_MS.job));
  await saveJob(store, job);
  await store.zadd(K.active, now, id, INDEX_TTL_S); // open:payer / open:global already reserved atomically (reserveOpen)
  return { job, token };
}

function heldOf(job: Job): Held {
  return { key: job.claim.key, raw: job.claim.raw, claim: JSON.parse(job.claim.raw) };
}

async function failUncharged(store: PremiumStore, job: Job, why: string) {
  job.status = "failed_uncharged";
  job.failure = why;
  job.charged = false;
  job.purge_at = clock() + RETENTION_MS;
  await store.del(K.auth(job.id));
  await releaseClaim(store, heldOf(job));
  await closeOpen(store, job);
  await store.zrem(K.active, job.id);
  await saveJob(store, job);
}

const AUTHORIZATION_USED_TOPIC = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
/** keccak256("AuthorizationUsed(address,bytes32)"), checked in tests against viem. */
export const AUTH_USED_TOPIC = AUTHORIZATION_USED_TOPIC;

/** Q4: settle confirmed on-chain = AuthorizationUsed(from, nonce) log on Base USDC AND authorizationState used. */
export async function settleLanded(job: Job): Promise<"landed" | "not_landed" | "unknown"> {
  const state = await nonceUsed(job.payer, job.nonce);
  if (state === "unknown") return "unknown";
  if (state === "unused") return "not_landed";
  try {
    const deps = rpcDeps ?? defaultRpcDeps();
    // Odin P1: never a full-chain scan; without a recorded block the answer is "unknown" (refund via reconcile_id)
    if (job.block_at_accept === null || job.block_at_accept === undefined) return "unknown";
    const from = `0x${Math.max(0, job.block_at_accept - 10).toString(16)}`;
    const logs = await rpcCall(deps, "base", "eth_getLogs", [{ address: USDC_BASE, fromBlock: from, toBlock: "latest", topics: [AUTHORIZATION_USED_TOPIC, `0x${job.payer.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`, job.nonce.toLowerCase()] }], deps.now() + 5_000);
    if (!Array.isArray(logs)) return "unknown";
    // used but no AuthorizationUsed log = cancelAuthorization (never charged)
    return logs.length > 0 ? "landed" : "not_landed";
  } catch {
    return "unknown";
  }
}

async function deliver(store: PremiumStore, job: Job, tx: string | null) {
  const now = clock();
  job.charged = true;
  job.settle_tx = tx;
  markNonceSettled(job.payer, job.nonce);
  await moveClaim(store, heldOf(job), { s: "settled", job: job.id }).catch(() => null);
  await store.del(K.auth(job.id));
  await closeOpen(store, job);
  if (job.tier === "watch") {
    job.status = "watching";
    job.watch = { ...(job.watch as Job["watch"] & object), t0: now, missed: 0, recorded: 0, stop: null, refund_owed: null, known_payTos: job.watch?.known_payTos ?? [] };
    job.purge_at = now + (WATCH_DAYS + 1) * DAY_MS + RETENTION_MS;
    await store.zadd(K.active, now + DAY_MS, job.id, INDEX_TTL_S);
  } else {
    job.status = "delivered";
    job.purge_at = now + RETENTION_MS;
    await store.zrem(K.active, job.id);
  }
  await saveJob(store, job);
  // re-arm result + archive TTLs to the delivery-based purge time
  const r = await store.get(K.result(job.id));
  if (r) await store.set(K.result(job.id), r, ttlS(job));
}

/* ---------- first deliverable ---------- */
async function stepReport(store: PremiumStore, job: Job, x: Tier, deadline: number): Promise<boolean> {
  const wttl = S(DAY_MS);
  if (!job.steps.search) {
    const found = await researchSearches(x, job.input, deadline);
    await store.set(K.work(job.id, "search"), JSON.stringify(found), wttl);
    job.steps.search = true;
    await saveJob(store, job);
    if (clock() + STEP_RESERVE_MS > deadline) return false;
  }
  const found = JSON.parse((await store.get(K.work(job.id, "search"))) ?? "[]") as ParallelResult[];
  if (!job.steps.read) {
    const urls = [...new Set(found.map((r) => r.url))].slice(0, x.reads);
    const read = await parallelExtract(job.input, urls, deadline);
    await store.set(K.work(job.id, "read"), JSON.stringify(read), wttl);
    job.steps.read = true;
    await saveJob(store, job);
    if (clock() + STEP_RESERVE_MS > deadline) return false;
  }
  const read = JSON.parse((await store.get(K.work(job.id, "read"))) ?? "[]") as ParallelResult[];
  const out = compile(x, job.input, [...found, ...read]) as any;
  if (!job.steps.archive) {
    const pages: ArchivedPage[] = await archivePages(out.sources.map((s: any) => s.url), deadline);
    await store.set(K.work(job.id, "archive"), JSON.stringify(pages), wttl);
    job.steps.archive = true;
    await saveJob(store, job);
    if (clock() + STEP_RESERVE_MS > deadline) return false;
  }
  const pages = JSON.parse((await store.get(K.work(job.id, "archive"))) ?? "[]") as ArchivedPage[];
  const byUrl = new Map(pages.map((p) => [p.url, p]));
  const claimsJson: Record<string, unknown>[] = [];
  const snipsBySha = new Map<string, unknown[]>();
  out.snippets = out.snippets.map((sn: any) => {
    const src = out.sources[sn.source - 1];
    const p = byUrl.get(src.url);
    if (!p || p.status !== "archived" || !p.text || !p.sha256) return { ...sn, archive: { status: p?.status === "not_archived" ? "not_archived" : "not_archived", reason: p?.reason ?? "fetch_failed" } };
    const m = matchSnippet(sn.id, sn.text, p.text);
    const rec = { ...m, url: src.url, final_url: p.final_url, http_status: p.http_status, fetched_at: p.fetched_at, sha256: p.sha256 };
    if (m.status === "matched") snipsBySha.set(p.sha256, [...(snipsBySha.get(p.sha256) ?? []), rec]);
    return { ...sn, archive: { status: m.status, sha256: p.sha256, fetched_at: p.fetched_at, start: m.start, end: m.end, url: `/api/research/archive/${p.sha256}?job=${job.id}` } };
  });
  for (const c of out.claims) claimsJson.push({ claim: c.claim, snippets: c.snippets.map((id: string) => { const s = out.snippets.find((z: any) => z.id === id); return { id, ...s?.archive }; }) });
  for (const p of pages) if (p.status === "archived" && p.sha256 && p.text) await store.set(K.arch(job.id, p.sha256), JSON.stringify({ url: p.url, final_url: p.final_url, fetched_at: p.fetched_at, sha256: p.sha256, raw_bytes: p.raw_bytes, text: p.text }), S(RETENTION_MS + 2 * DAY_MS));
  for (const [h, recs] of snipsBySha) await store.set(K.snip(job.id, h), JSON.stringify(recs), S(RETENTION_MS + 2 * DAY_MS));
  job.archive_shas = pages.filter((p) => p.status === "archived" && p.sha256).map((p) => p.sha256!);
  out.sources = out.sources.map((s: any) => {
    const p = byUrl.get(s.url);
    const score = (s.publish_date ? 1 : 0) + (s.label === "primary_heuristic" ? 1 : 0) + (p?.status === "archived" ? 1 : 0);
    return { ...s, fetched_at: p?.fetched_at ?? null, archive_status: p?.status ?? "fetch_failed", sha256: p?.sha256 ?? null, source_quality_heuristic: score };
  });
  out.claims_json = claimsJson;
  out.sections_md = [
    `# Report: ${job.input}`,
    "## Sources",
    ...out.sources.map((s: any) => `- [${s.n}] ${s.url} (publish date: ${s.publish_date ?? "n/a"}; fetched: ${s.fetched_at ?? "not fetched"})`),
    "## Claims found on two or more domains",
    ...out.found_on_two_or_more_domains.map((c: any) => `- "${c.claim}" (${c.domains.join(", ")})`),
    "## Could not confirm",
    ...out.could_not_confirm.map((c: string) => `- "${c}"`),
  ].join("\n");
  await store.set(K.result(job.id), JSON.stringify(out), ttlS(job));
  return true;
}

async function stepWatchDay0(store: PremiumStore, job: Job): Promise<boolean> {
  const rec = await watchCheck(job.input);
  job.watch = { t0: 0, missed: 0, recorded: 0, stop: null, refund_owed: null, known_payTos: rec.accepts.map((a) => a.payTo) };
  await store.set(K.result(job.id), JSON.stringify({ day0: rec }), ttlS(job));
  return true;
}

async function settleJob(store: PremiumStore, job: Job, x: Tier) {
  const raw = await store.get(K.auth(job.id));
  if (!raw) return failUncharged(store, job, "authorization_missing");
  if (clock() / 1000 > job.valid_before - 30) return failUncharged(store, job, "authorization_expired_before_settle");
  job.status = "settling";
  await saveJob(store, job);
  const payload = JSON.parse(raw);
  const d = { raw: payload, from: job.payer, nonce: job.nonce } as Decoded;
  const s = await settlePayment(d, x);
  if (s.ok) return deliver(store, job, s.tx);
  await noteSettleFailure(store, job).catch(() => undefined);
  const outcome = s.kind === "timeout" ? "settle_timeout" : "settle_ambiguous";
  const line = recordReconcile({ reconcile_id: newReconcileId(), route: `${x.route === "research" ? "/api/research/report" : "/api/seller-watch"}/${x.id}`, tier: x.id, payer: job.payer, nonce: job.nonce, amount: job.amount, payTo: DEFAULT_PAY_TO, tx: s.tx, fingerprint: job.rq, outcome, job_id: job.id });
  job.status = "settle_unconfirmed";
  job.http_equivalent = s.kind === "timeout" ? 504 : 502;
  job.reconcile_id = line.reconcile_id;
  job.purge_at = clock() + RETENTION_MS;
  const h = await moveClaim(store, heldOf(job), { s: "unconfirmed", rc: line.reconcile_id, job: job.id }).catch(() => null);
  if (h) job.claim = { key: h.key, raw: h.raw };
  await store.zadd(K.active, clock() + 60 * 60_000, job.id, INDEX_TTL_S);
  await saveJob(store, job);
}

/* ---------- watch days ---------- */
async function stepWatchDays(store: PremiumStore, job: Job, deadline: number, pause: boolean) {
  const w = job.watch!;
  const now = clock();
  const base = JSON.parse((await store.get(K.result(job.id))) ?? "{}").day0 as CheckRecord | undefined;
  let missed = 0;
  let recorded = 0;
  for (let n = 1; n <= WATCH_DAYS; n++) {
    const st = dayWindow(w.t0, n, now);
    if (st === "pending") break;
    const existing = await store.get(K.day(job.id, n));
    if (existing) {
      JSON.parse(existing).status === "missed" ? missed++ : recorded++;
      continue;
    }
    if (st === "closed" || w.stop) {
      // never back-filled: a closed window with no record is a missed day (our failure)
      if (await store.setNx(K.day(job.id, n), JSON.stringify({ day: n, status: "missed", reason: w.stop ? "stopped" : "window_closed_without_check" }), job.purge_at - now + DAY_MS)) missed++;
      continue;
    }
    if (pause || clock() + STEP_RESERVE_MS > deadline) continue;
    try {
      const rec = await watchCheck(job.input, w.known_payTos);
      const events = base ? diffEvents(base, rec) : [];
      if (await store.setNx(K.day(job.id, n), JSON.stringify({ day: n, status: "recorded", record: rec, events }), job.purge_at - now + DAY_MS)) recorded++;
    } catch {
      /* retried within the same window by the next cron / poll */
    }
  }
  w.missed = missed;
  w.recorded = recorded;
  const lastClosed = now >= w.t0 + (WATCH_DAYS + 1) * DAY_MS;
  if (lastClosed || w.stop || missed + recorded >= WATCH_DAYS) {
    const notRun = Math.max(0, WATCH_DAYS - missed - recorded);
    w.refund_owed = watchRefundAtomic(job.amount, missed, notRun, w.stop);
    job.status = w.stop ? "stopped" : "completed";
    await store.zrem(K.active, job.id);
    if (w.refund_owed !== "0")
      recordReconcile({ reconcile_id: newReconcileId(), route: "/api/seller-watch/watch", tier: job.tier, payer: job.payer, nonce: job.nonce, amount: job.amount, payTo: DEFAULT_PAY_TO, tx: job.settle_tx, fingerprint: job.rq, outcome: "refund_owed", job_id: job.id, refund_owed: w.refund_owed });
  } else {
    await store.zadd(K.active, Math.min(...Array.from({ length: WATCH_DAYS }, (_, i) => w.t0 + (i + 1) * DAY_MS).filter((t) => t > now), now + DAY_MS), job.id, INDEX_TTL_S);
  }
  await saveJob(store, job);
}

/** Our early stop (admin action, no route): "ours" refunds undelivered days, "abuse" refunds nothing. */
export async function stopWatch(store: PremiumStore, id: string, reason: "ours" | "abuse") {
  const job = await loadJob(store, id);
  if (!job?.watch || job.status !== "watching") return null;
  job.watch.stop = reason;
  await stepWatchDays(store, job, clock(), true);
  return job;
}

/** Run the job's next bounded step(s) under a lease. Never throws. */
export async function runJob(store: PremiumStore, id: string, deadline: number, opts: { watchPause?: boolean } = {}): Promise<Job | null> {
  const lease = randomBytes(8).toString("hex");
  try {
    if (!(await store.setNx(K.lease(id), lease, LEASE_MS))) return loadJob(store, id);
  } catch {
    return null;
  }
  try {
    const job = await loadJob(store, id);
    if (!job) return null;
    const x = tierFor(job.route as never, job.tier)!;
    if (["accepted", "running", "built"].includes(job.status)) {
      if (clock() > job.created_at + FIRST_DELIVERABLE_BUDGET_MS) {
        await failUncharged(store, job, "first_deliverable_budget_exceeded");
        return job;
      }
      if (job.status !== "built") {
        job.status = "running";
        await saveJob(store, job);
        let done = false;
        try {
          done = job.tier === "report" ? await stepReport(store, job, x, deadline) : await stepWatchDay0(store, job);
        } catch (e) {
          await failUncharged(store, job, "work_failed");
          return job;
        }
        if (!done) return job;
        job.status = "built";
        await saveJob(store, job);
      }
      if (clock() + 11_000 > deadline) return job; // settle needs its 10 s reserve; next poll / cron settles
      await settleJob(store, job, x);
      return job;
    }
    if (job.status === "settle_unconfirmed") {
      const landed = await settleLanded(job);
      if (landed === "landed") {
        job.claim = { key: job.claim.key, raw: job.claim.raw };
        await deliver(store, job, job.settle_tx);
      } else if (landed === "not_landed" && clock() / 1000 > job.valid_before) {
        job.status = "failed_uncharged";
        job.failure = "settle_never_landed";
        await noteSettleFailure(store, job).catch(() => undefined);
        job.charged = false;
        await store.del(K.auth(job.id));
        await closeOpen(store, job);
        await store.zrem(K.active, job.id);
        await saveJob(store, job);
      }
      return job;
    }
    if (job.status === "watching") await stepWatchDays(store, job, deadline, Boolean(opts.watchPause));
    return job;
  } finally {
    await store.casDel(K.lease(id), lease).catch(() => false);
  }
}

/** Status-link view: only what the token holder may see. Result hidden until delivered / watching. */
export async function statusView(store: PremiumStore, job: Job) {
  const released = ["delivered", "watching", "completed", "stopped"].includes(job.status);
  const base: Record<string, unknown> = {
    job_id: job.id,
    tier: job.tier,
    status: job.status,
    charged: job.charged,
    ...(job.status === "settle_unconfirmed" ? { http_equivalent: job.http_equivalent, reconcile_id: job.reconcile_id } : {}),
    ...(job.status === "failed_uncharged" ? { failure: job.failure } : {}),
    ...(job.settle_tx ? { tx: job.settle_tx, network: BASE_CAIP2 } : {}),
  };
  if (released) {
    const r = await store.get(K.result(job.id));
    base.result = r ? JSON.parse(r) : null;
  }
  if (job.watch && released) {
    const days: unknown[] = [];
    for (let n = 1; n <= WATCH_DAYS; n++) {
      const d = await store.get(K.day(job.id, n));
      if (d) days.push(JSON.parse(d));
    }
    base.days = days;
    base.days_completed = job.watch.recorded;
    base.days_missed = job.watch.missed;
    base.refund_owed = job.watch.refund_owed;
    base.watch_started_at = new Date(job.watch.t0).toISOString();
  }
  return { ...base, ...legalBlock() };
}

export async function archiveView(store: PremiumStore, job: Job, sha256: string) {
  if (!/^[0-9a-f]{64}$/.test(sha256)) return null;
  const s = await store.get(K.snip(job.id, sha256));
  return s ? { sha256, snippets: JSON.parse(s), note: "Quote plus surrounding context from our own fetch. The full archived copy is kept for integrity checks and is not served.", ...legalBlock() } : null;
}

/** Daily cron: purge expired, then run every due active job (bounded by the deadline). */
export async function cronSweep(store: PremiumStore, deadline: number, opts: { watchPause?: boolean } = {}) {
  const now = clock();
  let purged = 0;
  for (const id of await store.zrangeByScore(K.purge, now, 200)) {
    const job = await loadJob(store, id);
    if (job && job.purge_at > now) continue;
    const keys = [K.job(id), K.auth(id), K.result(id), K.work(id, "search"), K.work(id, "read"), K.work(id, "archive"), ...Array.from({ length: WATCH_DAYS }, (_, i) => K.day(id, i + 1)), ...(job?.archive_shas ?? []).flatMap((h) => [K.arch(id, h), K.snip(id, h)])];
    await store.del(...keys);
    if (job) await store.set(K.gone(id), job.token_sha256, S(RETENTION_MS));
    await store.zrem(K.purge, id);
    await store.zrem(K.active, id);
    purged++;
  }
  let ran = 0;
  for (const id of await store.zrangeByScore(K.active, now, 50)) {
    if (clock() + STEP_RESERVE_MS > deadline) break;
    await runJob(store, id, deadline, opts);
    ran++;
  }
  return { purged, ran };
}
