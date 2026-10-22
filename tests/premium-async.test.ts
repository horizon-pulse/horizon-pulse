/**
 * Premium async job path (to-odin/2026-10-19-pulse-premium-async-scope.md §8, Odin Q1–Q6) + Odin Class A C1–C5 +
 * Sentinel premium v3.2 review items 1–6 (SP-RACE-2, MEDIUM-1) + Counsel C1/C2. Every upstream is mocked: facilitator,
 * Base RPC, Parallel, page fetches, store. No network, no real key, no paid call. The signing key is a throwaway
 * generated per run.
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const afters: (() => unknown)[] = [];
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => unknown) => void afters.push(fn) }));

import { NextRequest } from "next/server";
import { encodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { keccak256, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { installFacilitatorMock } from "./helpers/facilitator-mock";
import * as researchTier from "@/app/api/research/report/[tier]/route";
import * as watchTier from "@/app/api/seller-watch/[tier]/route";
import * as jobRoute from "@/app/api/premium/job/[id]/route";
import * as archiveRoute from "@/app/api/research/archive/[sha]/route";
import * as cronRoute from "@/app/api/premium/cron/route";
import { PREMIUM_TIERS, type TierId } from "@/lib/premium/tiers";
import {
  ASYNC_MAX_TIMEOUT_S, PAYER_PROOF_HEADER, PREMIUM_VERIFY_TIMEOUT_MS, reasonCode, redeemMessage, requirementFor, resetPremiumFacilitatorForTests,
  resetPremiumNoncesForTests, setPremiumRpcForTests, TRANSFER_WITH_AUTHORIZATION_TYPES, USDC_BASE_DOMAIN,
} from "@/lib/premium/payment";
import { setParallelForTests } from "@/lib/premium/parallel";
import { BUYER_TERMS, WATCH_TERMS, TECHNICAL_NOTES, RECONCILE_RETENTION_S, PRIVACY_PREMIUM_ADDITION, PRIVACY_PREMIUM_REPLACEMENT, PRIVACY_PREMIUM_REPLACEMENT_WITH_FEEDBACK } from "@/lib/premium/copy";
import { CAP_EXEMPT_OUTCOMES, recordReconcile, RECONCILE_WRITE_CAP_PER_DAY, reconcileWriteStats, flushReconcileForTests, setReconcileForTests, storedFingerprint, type ReconcileLine } from "@/lib/premium/reconcile";
import { MemoryPremiumStore, premiumPrefix, setPremiumStoreForTests, UpstashPremiumStore, type PremiumStore } from "@/lib/premium/store";
import { BRIEF_RUN_COST_USD, setBriefGateForTests, setPremiumClockForTests, UNSETTLED_DAILY_CAP_USD, unsettledKey } from "@/lib/premium/handler";
import { setClassifierForTests, TEST_GENERIC_TYPE } from "@/lib/premium/source-index";
import { settleLanded, SETTLE_BLOCK_REASON, SETTLE_BLOCK_S, AUTH_USED_TOPIC, FIRST_DELIVERABLE_BUDGET_MS, JOB_KEYS, loadJob, runJob, setJobClockForTests, setJobRpcForTests, stopWatch, cronSweep } from "@/lib/premium/jobs";
import { ARCHIVE_CONTEXT_CHARS, ARCHIVE_TEXT_CAP_BYTES, matchSnippet, noArchive, robotsAllows, setArchiveFetchForTests } from "@/lib/premium/archive";
import { DAY_MS, dayWindow, resembles, setWatchDepsForTests, watchRefundAtomic } from "@/lib/premium/watch";
import { alertWriteStats, PREMIUM_ALERT_WRITE_CAP_PER_DAY, ALERT_WRITE_CAP_PER_DAY, persistAlert, setAlertPersistForTests } from "@/lib/alert-persist";
import { NO_IP_SENTENCE, privacyLine, ROUTE_LOG_PRIVACY_LINE } from "@/lib/privacy-copy";

const PAYTO = "0x5b32c973596078a967562ca652761404f19be0e9";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ACCOUNT = privateKeyToAccount(generatePrivateKey());
const FROM = ACCOUNT.address;
const price = (id: TierId) => PREMIUM_TIERS.find((t) => t.id === id)!.amount;
const tier = (id: TierId) => PREMIUM_TIERS.find((t) => t.id === id)!;
const nonce = () => toHex(crypto.getRandomValues(new Uint8Array(32)));
const TARGET = "https://seller.example.com/api/paid";

type PayOpts = { amount?: string; nonce?: string; validAfter?: string; validBefore?: string; badSig?: boolean; maxTimeout?: number };
async function payment(o: PayOpts = {}) {
  const amount = o.amount ?? price("brief");
  const auth = { from: FROM, to: PAYTO, value: amount, validAfter: o.validAfter ?? "0", validBefore: o.validBefore ?? String(Math.floor(now / 1000) + 1800), nonce: o.nonce ?? nonce() };
  const signature = o.badSig
    ? "0x" + "ab".repeat(65)
    : await ACCOUNT.signTypedData({ domain: USDC_BASE_DOMAIN, types: TRANSFER_WITH_AUTHORIZATION_TYPES, primaryType: "TransferWithAuthorization", message: { from: FROM, to: PAYTO, value: BigInt(amount), validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore), nonce: auth.nonce as `0x${string}` } });
  return encodePaymentSignatureHeader({
    x402Version: 2,
    accepted: { scheme: "exact", network: "eip155:8453", amount, asset: USDC, payTo: PAYTO, maxTimeoutSeconds: o.maxTimeout ?? 300, extra: { name: "USD Coin", version: "2" } },
    payload: { signature, authorization: auth },
  } as never);
}
function call(id: TierId, query: string, headers: Record<string, string> = {}) {
  const watch = id === "watch" || id === "watch-report";
  const req = new NextRequest(`https://horizonpulse.dev${watch ? "/api/seller-watch" : "/api/research/report"}/${id}?${query}`, { headers: { accept: "application/json", ...headers } });
  return ((watch ? watchTier : researchTier).GET(req, { params: Promise.resolve({ tier: id }) }) as Promise<Response>);
}
const status = (id: string, token?: string, q = "") =>
  jobRoute.GET(new NextRequest(`https://horizonpulse.dev/api/premium/job/${id}${q}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }), { params: Promise.resolve({ id }) }) as Promise<Response>;
const archive = (sha: string, id: string, token?: string) =>
  archiveRoute.GET(new NextRequest(`https://horizonpulse.dev/api/research/archive/${sha}?job=${id}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }), { params: Promise.resolve({ sha }) }) as Promise<Response>;
const cron = (auth?: string) => cronRoute.GET(new NextRequest("https://horizonpulse.dev/api/premium/cron", { headers: auth ? { authorization: auth } : {} })) as Promise<Response>;

let store: MemoryPremiumStore;
let fac: ReturnType<typeof installFacilitatorMock>;
let rpcAnswer: "used" | "unused" | "down";
let logsAnswer: unknown[];
let logQueries: any[];
let blockDown = false;
let parallelCalls: string[];
let reconciles: ReconcileLine[];
let settleBehaviour: () => unknown;
let now: number;
let pages: Record<string, { status: number; body: string; headers?: Record<string, string> }>;

function on(extra: Record<string, string> = {}) {
  vi.stubEnv("HP_PREMIUM_ENABLED", "true"); vi.stubEnv("HP_PREMIUM_TIERS", "brief,standard,extended,report,monitor,watch,watch-report");
  vi.stubEnv("HP_PREMIUM_ASYNC_ENABLED", "true");
  vi.stubEnv("PARALLEL_API_KEY", "test-parallel-key-not-real");
  vi.stubEnv("CDP_API_KEY_ID", "test-key-id");
  vi.stubEnv("CDP_API_KEY_SECRET", "test-key-secret");
  for (const [k, v] of Object.entries(extra)) vi.stubEnv(k, v);
}
async function drainAfters() {
  while (afters.length) await afters.shift()!();
}
const EXCERPT = "The x402 protocol lets an HTTP server answer 402 Payment Required and settle a stablecoin payment in the same request cycle.";

beforeEach(() => {
  setBriefGateForTests((b) => (b ? "confirmed" : null)); // legacy settle/redeem flow tests: contract gate stubbed to pass
  setClassifierForTests(() => ({ ok: true, type: TEST_GENERIC_TYPE })); // ...and any question accepted (ruling (c) scope tested separately)
  vi.unstubAllEnvs();
  afters.length = 0;
  now = Date.now();
  store = new MemoryPremiumStore();
  store.now = () => now;
  setPremiumStoreForTests(store);
  setPremiumClockForTests(() => now);
  setJobClockForTests(() => now);
  resetPremiumFacilitatorForTests();
  resetPremiumNoncesForTests();
  rpcAnswer = "unused";
  logsAnswer = [];
  logQueries = [];
  blockDown = false;
  parallelCalls = [];
  reconciles = [];
  settleBehaviour = () => ({ success: true, transaction: "0x" + "cd".repeat(32), network: "eip155:8453", payer: FROM });
  fac = installFacilitatorMock({ verify: () => ({ isValid: true, payer: FROM }), settle: () => settleBehaviour() });
  const rpcFetch = (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (rpcAnswer === "down") throw new Error("down");
    if (body.method === "eth_blockNumber" && blockDown) throw new Error("block rpc down");
    if (body.method === "eth_blockNumber") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x100" }));
    if (body.method === "eth_getLogs") logQueries.push(body.params[0]);
    if (body.method === "eth_getLogs") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: logsAnswer }));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + (rpcAnswer === "used" ? "1" : "0").padStart(64, "0") }));
  }) as never;
  setPremiumRpcForTests({ now: () => Date.now(), fetch: rpcFetch });
  setJobRpcForTests({ now: () => Date.now(), fetch: rpcFetch } as never);
  setParallelForTests({
    fetch: (async (u: string) => {
      parallelCalls.push(u);
      return new Response(JSON.stringify({ results: [
        { url: "https://a.example.com/x402", title: "A", publish_date: "2025-05-06", excerpts: [EXCERPT] },
        { url: "https://b.example.org/post", title: "B", publish_date: null, excerpts: [EXCERPT + " As reported."] },
      ] }));
    }) as never,
  });
  pages = {
    "https://a.example.com/robots.txt": { status: 200, body: "User-agent: *\nAllow: /" },
    "https://a.example.com/x402": { status: 200, body: `<html><body><p>Intro text. ${EXCERPT} Closing remarks follow here.</p></body></html>`, headers: { "content-type": "text/html" } },
    "https://b.example.org/robots.txt": { status: 200, body: "User-agent: *\nDisallow: /post" },
  };
  setArchiveFetchForTests((async (u: string) => {
    const p = pages[u];
    if (!p) return { ok: false, code: "http_404" };
    return { ok: true, status: p.status, headers: new Headers(p.headers ?? {}), body: p.body, bytes: p.body.length, truncated: false, finalUrl: u, hops: [] };
  }) as never);
  setWatchDepsForTests({
    get: (async (u: string) => {
      if (u.endsWith("/.well-known/x402")) return { ok: true, status: 200, headers: new Headers(), body: JSON.stringify({ resources: [TARGET] }), bytes: 1, truncated: false, finalUrl: u, hops: [] };
      const hdr = encodePaymentRequiredHeader({ x402Version: 2, resource: { url: TARGET }, accepts: [{ scheme: "exact", network: "eip155:8453", amount: "10000", asset: USDC, payTo: "0x1234567890abcdef1234567890abcdef12345678", maxTimeoutSeconds: 60, extra: {} }] } as never);
      return { ok: true, status: 402, headers: new Headers({ "payment-required": hdr }), body: "{}", bytes: 2, truncated: false, finalUrl: u, hops: [] };
    }) as never,
    tx: { fetch: (async () => { throw new Error("offline"); }) as never, now: () => now } as never,
  });
  setReconcileForTests({ sink: (l) => reconciles.push(l) });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setPremiumStoreForTests(undefined);
  setPremiumClockForTests(null);
  setJobClockForTests(null);
  setJobRpcForTests(null);
  setPremiumRpcForTests(null);
  setParallelForTests(null);
  setArchiveFetchForTests(null);
  setWatchDepsForTests(null);
  setReconcileForTests(null);
  setAlertPersistForTests(null);
});

async function acceptReport(q = "q=what%20is%20x402", n = nonce()) {
  const r = await call("report", q, { "payment-signature": await payment({ amount: price("report"), nonce: n }) });
  return { r, j: (await r.json()) as any, n };
}

/* ======================= §8 async: accept ======================= */
describe("async accept (§8, Q1, Q5)", () => {
  it("$20 report: 202 with job_id + status_url + one-time token; verify at accept, settle NOT called; store keeps only the token hash", async () => {
    on();
    const { r, j } = await acceptReport();
    expect(r.status).toBe(202);
    expect(j.status).toBe("accepted");
    expect(j.charged).toBe(false);
    expect(j.job_id).toMatch(/^job_[0-9a-f]{24}$/);
    expect(j.status_url).toBe(`/api/premium/job/${j.job_id}`);
    expect(j.job_token.length).toBeGreaterThanOrEqual(43);
    expect(fac.map((c) => c.op)).toEqual(["verify"]);
    const dump = [...store.kv.values()].map((e) => e.v).join("\n");
    expect(dump).not.toContain(j.job_token);
    expect(dump).toContain(createHash("sha256").update(j.job_token).digest("hex"));
    expect(parallelCalls.length).toBe(0);
  });
  it("async 402 advertises maxTimeoutSeconds 900 (Q1: settle within the 10-min budget)", () => {
    expect(requirementFor(tier("report")).maxTimeoutSeconds).toBe(ASYNC_MAX_TIMEOUT_S);
    expect(requirementFor(tier("watch")).maxTimeoutSeconds).toBe(900);
    expect(requirementFor(tier("brief")).maxTimeoutSeconds).not.toBe(900);
  });
  it("async authorization with < 11 min remaining -> 402 authorization_window_too_short, nothing called", async () => {
    on();
    const vb = String(Math.floor(now / 1000) + 300);
    const r = await call("report", "q=what%20is%20x402", { "payment-signature": await payment({ amount: price("report"), validBefore: vb }) });
    expect(r.status).toBe(402);
    expect(fac.length).toBe(0);
  });
  it("Q5: 3rd open job for the same payer -> 429 before verify (2 per payer)", async () => {
    on();
    expect((await acceptReport()).r.status).toBe(202);
    expect((await acceptReport()).r.status).toBe(202);
    const third = await acceptReport();
    expect(third.r.status).toBe(429);
    expect(third.j.charged).toBe(false);
    expect(fac.filter((c) => c.op === "verify").length).toBe(2);
  });
  it("Q5: global cap of 10 open jobs", async () => {
    on();
    for (let i = 0; i < 10; i++) await store.zadd(JOB_KEYS.openGlobal, now + 600_000, `job_${String(i).padStart(24, "0")}`, 1200);
    expect((await acceptReport()).r.status).toBe(429);
  });
  it("same authorization while its job is open -> 503 payment_in_progress, no second job, no reconcile", async () => {
    on();
    const n = nonce();
    expect((await acceptReport("q=one%20two", n)).r.status).toBe(202);
    const again = await acceptReport("q=one%20two", n);
    expect(again.r.status).toBe(503);
    expect(again.j.error).toBe("payment_in_progress");
    expect([...store.kv.keys()].filter((k) => k.startsWith("job:")).length).toBe(1);
    expect(reconciles).toHaveLength(0);
  });
  it("$50 monitor / $100 watch-report stay closed (503 before any 402)", async () => {
    on();
    expect((await call("monitor", "q=abc%20def")).status).toBe(503);
    expect((await call("watch-report", `target=${encodeURIComponent(TARGET)}`)).status).toBe(503);
  });
  it("async flag off: 503 tier_not_available, job/archive 404, cron 204 with no store access", async () => {
    on({ HP_PREMIUM_ASYNC_ENABLED: "false" });
    expect((await call("report", "q=abc%20def")).status).toBe(503);
    expect((await status("job_" + "0".repeat(24), "x".repeat(43))).status).toBe(404);
    expect((await archive("a".repeat(64), "job_" + "0".repeat(24), "x".repeat(43))).status).toBe(404);
    const throwing = new Proxy({}, { get: () => () => { throw new Error("store touched"); } }) as PremiumStore;
    setPremiumStoreForTests(throwing);
    expect((await cron("Bearer whatever")).status).toBe(204);
  });
});

/* ======================= §8 async: status link + run ======================= */
describe("status link (token, 404, result hidden) + first deliverable + settle (Q1, Q4)", () => {
  it("wrong / missing / query token -> 404 (no existence oracle); right token -> status, result hidden before delivery", async () => {
    on();
    const { j } = await acceptReport();
    afters.length = 0;
    expect((await status(j.job_id)).status).toBe(404);
    expect((await status(j.job_id, "y".repeat(43))).status).toBe(404);
    expect((await status(j.job_id, undefined, `?token=${j.job_token}`)).status).toBe(404);
    expect((await status("job_" + "f".repeat(24), j.job_token)).status).toBe(404);
    const ok = await status(j.job_id, j.job_token);
    expect(ok.status).toBe(200);
    const v = (await ok.json()) as any;
    expect(v.status).toBe("accepted");
    expect(v.result).toBeUndefined();
    expect(v.charged).toBe(false);
  });
  it("run: search -> read -> archive -> settle after the first deliverable -> delivered; result + sources fields + archive links", async () => {
    on();
    const { j } = await acceptReport();
    await drainAfters();
    expect(fac.map((c) => c.op)).toEqual(["verify", "settle"]);
    const v = (await (await status(j.job_id, j.job_token)).json()) as any;
    expect(v.status).toBe("delivered");
    expect(v.charged).toBe(true);
    expect(v.tx).toMatch(/^0x/);
    const src = v.result.sources;
    expect(src[0]).toMatchObject({ archive_status: "archived" });
    expect(src[0].fetched_at).toBeTruthy();
    expect(typeof src[0].source_quality_heuristic).toBe("number");
    expect(src.find((s: any) => s.url.startsWith("https://b."))?.archive_status).toBe("not_archived"); // robots disallow
    expect(Array.isArray(v.result.claims_json)).toBe(true);
    expect(typeof v.result.sections_md).toBe("string");
    for (const s of v.result.snippets) expect(s.source_kind ?? "search_provider_excerpt").toBe("search_provider_excerpt");
    const matched = v.result.snippets.find((s: any) => s.archive?.status === "matched");
    expect(matched).toBeTruthy();
    const a = await archive(matched.archive.sha256, j.job_id, j.job_token);
    expect(a.status).toBe(200);
    const av = (await a.json()) as any;
    for (const s of av.snippets) {
      expect((s.context_before ?? "").length).toBeLessThanOrEqual(ARCHIVE_CONTEXT_CHARS);
      expect((s.context_after ?? "").length).toBeLessThanOrEqual(ARCHIVE_CONTEXT_CHARS);
    }
    expect(JSON.stringify(av)).not.toContain("Closing remarks follow here. Intro"); // never the full copy
    expect(av.text).toBeUndefined();
    expect((await archive(matched.archive.sha256, j.job_id, "z".repeat(43))).status).toBe(404);
    // claim is settled now: the same authorization -> 409, zero work
    const before = parallelCalls.length;
    const replay = await call("report", "q=what%20is%20x402", { "payment-signature": await payment({ amount: price("report"), nonce: (await loadJob(store, j.job_id))!.nonce }) });
    expect(replay.status).toBe(409);
    expect(parallelCalls.length).toBe(before);
  });
  it("work fails -> failed_uncharged, settle never called, authorization deleted, payer slot freed", async () => {
    on();
    setParallelForTests({ fetch: (async () => new Response("x", { status: 500 })) as never });
    const { j } = await acceptReport();
    await drainAfters();
    const v = (await (await status(j.job_id, j.job_token)).json()) as any;
    expect(v.status).toBe("failed_uncharged");
    expect(v.charged).toBe(false);
    expect(v.result).toBeUndefined();
    expect(fac.map((c) => c.op)).toEqual(["verify"]);
    expect(await store.get(JOB_KEYS.auth(j.job_id))).toBeNull();
    expect(await store.zcardAfterPrune(JOB_KEYS.openPayer(FROM), now)).toBe(0);
  });
  it("first-deliverable budget (10 min) exceeded -> failed_uncharged, no settle", async () => {
    on();
    const { j } = await acceptReport();
    afters.length = 0;
    now += FIRST_DELIVERABLE_BUDGET_MS + 1000;
    await runJob(store, j.job_id, now + 50_000);
    const job = await loadJob(store, j.job_id);
    expect(job!.status).toBe("failed_uncharged");
    expect(job!.failure).toBe("first_deliverable_budget_exceeded");
    expect(fac.some((c) => c.op === "settle")).toBe(false);
  });
  it("settle timeout -> settle_unconfirmed (504-equivalent), result hidden, reconcile; Q4 resolution on AuthorizationUsed log -> delivered", async () => {
    on();
    settleBehaviour = () => new Promise((_r, rej) => rej(Object.assign(new Error("timed out"), { name: "TimeoutError" })));
    const { j } = await acceptReport();
    await drainAfters();
    let job = (await loadJob(store, j.job_id))!;
    if (job.status !== "settle_unconfirmed") throw new Error(`status ${job.status}`);
    let v = (await (await status(j.job_id, j.job_token)).json()) as any;
    expect(v.result).toBeUndefined();
    expect([502, 504]).toContain(v.http_equivalent);
    expect(reconciles.map((l) => l.outcome)[0]).toMatch(/^settle_(timeout|ambiguous)$/);
    afters.length = 0;
    // used on-chain but no log (cancelAuthorization) -> not landed, still hidden
    rpcAnswer = "used";
    logsAnswer = [];
    await runJob(store, j.job_id, now + 50_000);
    expect((await loadJob(store, j.job_id))!.status).toBe("settle_unconfirmed");
    logsAnswer = [{ topics: [AUTH_USED_TOPIC] }];
    await runJob(store, j.job_id, now + 50_000);
    job = (await loadJob(store, j.job_id))!;
    expect(job.status).toBe("delivered");
    v = (await (await status(j.job_id, j.job_token)).json()) as any;
    expect(v.result).toBeTruthy();
  });
  it("settle never lands and validBefore passed -> failed_uncharged", async () => {
    on();
    settleBehaviour = () => ({ success: false, errorReason: "unexpected" });
    const r0 = await call("report", "q=abc%20def", { "payment-signature": await payment({ amount: price("report"), validBefore: String(Math.floor(now / 1000) + 3600) }) });
    const j = (await r0.json()) as any;
    await drainAfters();
    const job = (await loadJob(store, j.job_id))!;
    expect(job.status).toBe("settle_unconfirmed");
    rpcAnswer = "unused";
    now = (job.valid_before + 10) * 1000;
    await runJob(store, j.job_id, now + 50_000);
    expect((await loadJob(store, j.job_id))!.status).toBe("failed_uncharged");
  });
  it("AuthorizationUsed topic = keccak256(AuthorizationUsed(address,bytes32))", () => {
    expect(AUTH_USED_TOPIC).toBe(keccak256(toHex("AuthorizationUsed(address,bytes32)")));
  });
  it("every store write carries a TTL (no immortal keys)", async () => {
    on();
    const { j } = await acceptReport();
    await drainAfters();
    await status(j.job_id, j.job_token);
    expect(store.writes.length).toBeGreaterThan(5);
    for (const w of store.writes) expect(w.ttlMs, `${w.op} ${w.key}`).toBeGreaterThan(0);
  });
  it("purge: after 30 days the job is gone; the token holder gets 410 on the archive link, others 404", async () => {
    on();
    const { j } = await acceptReport();
    await drainAfters();
    const sha = (await loadJob(store, j.job_id))!.archive_shas![0];
    now += 31 * DAY_MS;
    await cronSweep(store, now + 50_000);
    expect(await loadJob(store, j.job_id)).toBeNull();
    expect((await archive(sha, j.job_id, j.job_token)).status).toBe(410);
    expect((await archive(sha, j.job_id, "q".repeat(43))).status).toBe(404);
  });
});

/* ======================= archive unit (Q2) ======================= */
describe("archive (Q2: 256 KB text + raw hash, robots, noarchive, context)", () => {
  it("robots: disallow honoured for * and our agent; allow otherwise", () => {
    expect(robotsAllows("User-agent: *\nDisallow: /p", "/post")).toBe(false);
    expect(robotsAllows("User-agent: horizonpulsecheck\nDisallow: /", "/x")).toBe(false);
    expect(robotsAllows("User-agent: other\nDisallow: /", "/x")).toBe(true);
  });
  it("noarchive header or meta -> not archived", () => {
    expect(noArchive(new Headers({ "x-robots-tag": "noarchive" }), "")).toBe(true);
    expect(noArchive(new Headers(), '<meta name="robots" content="noarchive">')).toBe(true);
    expect(noArchive(new Headers(), "<p>ok</p>")).toBe(false);
  });
  it("matchSnippet: context at most 150 chars each side; absent quote -> not_found_in_source", () => {
    const text = "x".repeat(1000) + " " + EXCERPT + " " + "y".repeat(1000);
    const m = matchSnippet("s1", EXCERPT, text);
    expect(m.status).toBe("matched");
    expect(m.context_before!.length).toBeLessThanOrEqual(150);
    expect(m.context_after!.length).toBeLessThanOrEqual(150);
    expect(matchSnippet("s2", "words that never appear anywhere at all", text).status).toBe("not_found_in_source");
  });
  it("text cap is 256 KB", () => expect(ARCHIVE_TEXT_CAP_BYTES).toBe(262_144));
});

/* ======================= $75 watch (Q3, Q6) ======================= */
describe("$75 watch (Q6: day 0 + daily records, pro rata, no backfill)", () => {
  it("accept -> day-0 check -> settle -> watching; 3 daily records via cron; no back-fill; refund pro rata", async () => {
    on({ CRON_SECRET: "s".repeat(32) });
    const r = await call("watch", `target=${encodeURIComponent(TARGET)}`, { "payment-signature": await payment({ amount: price("watch") }) });
    expect(r.status).toBe(202);
    const j = (await r.json()) as any;
    await drainAfters();
    let job = (await loadJob(store, j.job_id))!;
    expect(job.status).toBe("watching");
    expect(fac.map((c) => c.op)).toEqual(["verify", "settle"]);
    const v0 = (await (await status(j.job_id, j.job_token)).json()) as any;
    expect(v0.result.day0.accepts[0].payTo).toMatch(/^0x/);
    afters.length = 0;
    for (let d = 1; d <= 3; d++) {
      now = job.watch!.t0 + d * DAY_MS + 3600_000;
      expect((await cron(`Bearer ${"s".repeat(32)}`)).status).toBe(200);
    }
    job = (await loadJob(store, j.job_id))!;
    expect(job.watch!.recorded).toBe(3);
    expect(job.watch!.missed).toBe(0);
    // skip day 4 entirely (window closes), run on day 5: day 4 = missed, never back-filled
    now = job.watch!.t0 + 5 * DAY_MS + 3600_000;
    await cronSweep(store, now + 50_000);
    job = (await loadJob(store, j.job_id))!;
    expect(JSON.parse((await store.get(JOB_KEYS.day(j.job_id, 4)))!).status).toBe("missed");
    expect(job.watch!.recorded).toBe(4);
    // our early stop -> refund for undelivered days (missed + not run)
    await stopWatch(store, j.job_id, "ours");
    job = (await loadJob(store, j.job_id))!;
    expect(job.status).toBe("stopped");
    expect(job.watch!.refund_owed).toBe(watchRefundAtomic(price("watch"), job.watch!.missed, 30 - job.watch!.missed - job.watch!.recorded, "ours"));
    expect(reconciles.some((l) => l.outcome === "refund_owed")).toBe(true);
  });
  it("pro rata table: $75 × 4/30 = 10.00 USDC; < 3 missed and no stop -> 0; abuse -> 0", () => {
    expect(watchRefundAtomic("75000000", 4, 0, null)).toBe("10000000");
    expect(watchRefundAtomic("75000000", 2, 0, null)).toBe("0");
    expect(watchRefundAtomic("75000000", 0, 30, "abuse")).toBe("0");
    expect(watchRefundAtomic("75000000", 0, 30, "ours")).toBe("75000000");
  });
  it("day windows: pending / due / closed", () => {
    expect(dayWindow(0, 1, DAY_MS - 1)).toBe("pending");
    expect(dayWindow(0, 1, DAY_MS)).toBe("due");
    expect(dayWindow(0, 1, 2 * DAY_MS)).toBe("closed");
  });
  it("lookalike rule: same first 4 + last 4 = resembles", () => {
    expect(resembles("0xabcd1111111111111111111111111111111189ef", "0xabcd2222222222222222222222222222222289ef")).toBe(true);
    expect(resembles("0xabcd1111111111111111111111111111111189ef", "0xabcd1111111111111111111111111111111189ef")).toBe(false);
  });
});

/* ======================= cron (Q3) ======================= */
describe("cron (Q3: daily, secret-protected)", () => {
  it("missing / wrong / short secret -> 401, no store access", async () => {
    on({ CRON_SECRET: "c".repeat(32) });
    const throwing = new Proxy({}, { get: () => () => { throw new Error("store touched"); } }) as PremiumStore;
    setPremiumStoreForTests(throwing);
    expect((await cron()).status).toBe(401);
    expect((await cron(`Bearer ${"d".repeat(32)}`)).status).toBe(401);
    vi.stubEnv("CRON_SECRET", "short");
    expect((await cron("Bearer short")).status).toBe(401);
  });
  it("right secret -> 200 sweep", async () => {
    on({ CRON_SECRET: "c".repeat(32) });
    expect((await cron(`Bearer ${"c".repeat(32)}`)).status).toBe(200);
  });
});

/* ======================= Sentinel items + Odin Class A (sync) ======================= */
describe("Sentinel SP-RACE-2 / MEDIUM-1 / LOW-1 / item 4, Odin C1 / C4", () => {
  it("SP-RACE-2: two instances, same authorization, concurrent -> exactly one 200, the other 503 payment_in_progress; one verify, one settle", async () => {
    on();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    fac = installFacilitatorMock({ verify: async () => (await gate, { isValid: true, payer: FROM }), settle: () => settleBehaviour() });
    const h = await payment();
    const a = call("brief", "q=race%20one", { "payment-signature": h });
    resetPremiumNoncesForTests(); // "instance B": no local memory, shared store only
    const b = call("brief", "q=race%20one", { "payment-signature": h });
    await new Promise((r) => setTimeout(r, 20));
    release();
    const st = (await Promise.all([a, b])).map((r) => r.status).sort();
    expect(st).toEqual([200, 503]);
    expect(fac.filter((c) => c.op === "verify").length).toBe(1);
    expect(fac.filter((c) => c.op === "settle").length).toBe(1);
  });
  it("MEDIUM-1: 25 spoofed replays of a public (from, nonce) with a bad signature -> 402 invalid_signature, zero reconcile / alert / store write / RPC", async () => {
    on();
    const n = nonce();
    rpcAnswer = "used";
    for (let i = 0; i < 25; i++) {
      const r = await call("brief", "q=spam%20test", { "payment-signature": await payment({ nonce: n, badSig: true }) });
      expect(r.status).toBe(402);
      expect(((await r.json()) as any).error).toBe("invalid_signature");
    }
    expect(reconciles).toHaveLength(0);
    expect(store.writes).toHaveLength(0);
    expect(fac.length).toBe(0);
  });
  it("MEDIUM-1: a validly signed authorization already used on-chain, replayed 25 times -> one reconcile line, 25 × 409", async () => {
    on();
    rpcAnswer = "used";
    const h = await payment();
    for (let i = 0; i < 25; i++) expect((await call("brief", "q=spam%20test", { "payment-signature": h })).status).toBe(409);
    expect(reconciles).toHaveLength(1);
    expect(fac.length).toBe(0);
  });
  it("LOW-1: validBefore past / too soon and validAfter in the future -> 402 before any call", async () => {
    on();
    const nowS = Math.floor(now / 1000);
    for (const o of [{ validBefore: String(nowS - 1) }, { validBefore: String(nowS + 60) }, { validAfter: String(nowS + 600) }]) {
      const r = await call("brief", "q=window%20test", { "payment-signature": await payment(o) });
      expect(r.status).toBe(402);
    }
    expect(fac.length + store.writes.length).toBe(0);
  });
  it("Odin C1: clock anchored at request start; slow nonce RPC + slow verify push past 55 s -> uncharged 503 before settle, claim released", async () => {
    on();
    fac = installFacilitatorMock({ verify: () => ((now += 8_000), { isValid: true, payer: FROM }), settle: () => settleBehaviour() });
    setPremiumRpcForTests({ now: () => Date.now(), fetch: (async () => ((now += 4_000), new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + "0".repeat(64) })))) as never });
    const q = "q=" + encodeURIComponent("a1 one?b2 two?c3 three?");
    const h = await payment({ amount: price("extended") });
    const r = await call("extended", q, { "payment-signature": h });
    if (r.status === 200) throw new Error("expected the budget guard to refuse");
    expect(r.status).toBe(503);
    expect(((await r.json()) as any).charged).toBe(false);
    expect(fac.some((c) => c.op === "settle")).toBe(false);
    expect([...store.kv.keys()].filter((k) => k.startsWith("claim:")).length).toBe(0);
    expect(PREMIUM_VERIFY_TIMEOUT_MS).toBe(8_000);
  });
  it("Odin C4: 402 carries a reason code, never facilitator free text", async () => {
    expect(reasonCode("insufficient_funds")).toBe("insufficient_funds");
    expect(reasonCode("Insufficient funds: balance 0 < 1000000 at 0xabc")).toBe("invalid_payment");
    on();
    fac = installFacilitatorMock({ verify: () => ({ isValid: false, invalidReason: "Error: upstream said <html>" }) });
    const r = await call("brief", "q=reason%20code", { "payment-signature": await payment() });
    expect(r.status).toBe(402);
    expect(JSON.stringify(await r.json())).not.toContain("upstream said");
  });
  it("item 4: after a 504 the same request may redeem once with a payer proof; a different request or no proof -> 409", async () => {
    on();
    settleBehaviour = () => new Promise((_r, rej) => rej(Object.assign(new Error("timed out"), { name: "TimeoutError" })));
    const h = await payment();
    const first = await call("brief", "q=redeem%20me", { "payment-signature": h });
    expect([502, 504]).toContain(first.status);
    const fj = (await first.json()) as any;
    const rc = fj.reconcile_id;
    expect(fj.redeem_header).toBe(PAYER_PROOF_HEADER);
    expect((await call("brief", "q=redeem%20me", { "payment-signature": h })).status).toBe(409); // no proof
    expect((await call("brief", "q=other%20request", { "payment-signature": h })).status).toBe(409); // other fingerprint
    const claim = JSON.parse([...store.kv.entries()].find(([k]) => k.startsWith("claim:"))![1].v);
    expect(fj.redeem_message).toBe(redeemMessage(rc, claim.rq, PAYTO, price("brief")));
    const proof = await ACCOUNT.signMessage({ message: fj.redeem_message });
    rpcAnswer = "unused";
    expect((await call("brief", "q=redeem%20me", { "payment-signature": h, [PAYER_PROOF_HEADER]: proof })).status).toBe(503); // not landed yet
    rpcAnswer = "used";
    logsAnswer = [{ topics: [AUTH_USED_TOPIC] }];
    const ok = await call("brief", "q=redeem%20me", { "payment-signature": h, [PAYER_PROOF_HEADER]: proof });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).redeemed.reconcile_id).toBe(rc);
    expect((await call("brief", "q=redeem%20me", { "payment-signature": h, [PAYER_PROOF_HEADER]: proof })).status).toBe(409); // once only
  });
  describe("redeem window (Odin 10/19)", () => {
    async function failedFirst(q: string) {
      // Charge-on-pass: brief work runs BEFORE settle, so a post-settle work failure can no longer happen on the sync
      // brief; the redeemable claim is seeded by a settle timeout (unconfirmed) that later proves landed on-chain.
      settleBehaviour = () => new Promise((_r, rej) => rej(Object.assign(new Error("timed out"), { name: "TimeoutError" })));
      const h = await payment();
      const first = (await (await call("brief", q, { "payment-signature": h })).json()) as any;
      expect(first.reconcile_id).toBeTruthy();
      rpcAnswer = "used";
      logsAnswer = [{ topics: [AUTH_USED_TOPIC] }];
      return { h, first };
    }
    it("(1) expired window + valid payer proof on a redeemable (unconfirmed, landed) claim -> redeem succeeds (200)", async () => {
      on();
      const { h, first } = await failedFirst("q=late%20redeem");
      now += 2 * 3600_000; // auth validBefore (now+1800 s) long gone
      const proof = await ACCOUNT.signMessage({ message: first.redeem_message });
      const ok = await call("brief", "q=late%20redeem", { "payment-signature": h, [PAYER_PROOF_HEADER]: proof });
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as any).redeemed.reconcile_id).toBe(first.reconcile_id);
    });
    it("(1b) expired window + proof on an unconfirmed (settle timeout) claim reaches redeem (landing checked)", async () => {
      on();
      settleBehaviour = () => new Promise((_r, rej) => rej(Object.assign(new Error("timed out"), { name: "TimeoutError" })));
      const h = await payment();
      const first = (await (await call("brief", "q=late%20timeout", { "payment-signature": h })).json()) as any;
      now += 2 * 3600_000;
      const proof = await ACCOUNT.signMessage({ message: first.redeem_message });
      rpcAnswer = "used";
      logsAnswer = [{ topics: [AUTH_USED_TOPIC] }];
      expect((await call("brief", "q=late%20timeout", { "payment-signature": h, [PAYER_PROOF_HEADER]: proof })).status).toBe(200);
    });
    it("(2) expired window, no proof -> 402 authorization_window_too_short", async () => {
      on();
      const { h } = await failedFirst("q=late%20noproof");
      now += 2 * 3600_000;
      const r = await call("brief", "q=late%20noproof", { "payment-signature": h });
      expect(r.status).toBe(402);
      expect(JSON.stringify(await r.json())).toContain("authorization_window_too_short");
    });
    it("(3) proof present but no redeemable claim (fresh nonce, or claim already redeemed) -> normal window check 402", async () => {
      on();
      const exp = await payment({ validBefore: String(Math.floor(now / 1000) + 30) });
      const r = await call("brief", "q=fresh", { "payment-signature": exp, [PAYER_PROOF_HEADER]: "0x" + "11".repeat(65) });
      expect(r.status).toBe(402);
      expect(JSON.stringify(await r.json())).toContain("authorization_window_too_short");
      const { h, first } = await failedFirst("q=late%20twice");
      const proof = await ACCOUNT.signMessage({ message: first.redeem_message });
      now += 2 * 3600_000;
      expect((await call("brief", "q=late%20twice", { "payment-signature": h, [PAYER_PROOF_HEADER]: proof })).status).toBe(200);
      const again = await call("brief", "q=late%20twice", { "payment-signature": h, [PAYER_PROOF_HEADER]: proof });
      expect(again.status).toBe(402); // claim is "redeemed" now -> window check applies
      expect(JSON.stringify(await again.json())).toContain("authorization_window_too_short");
    });
  });
  it("INFO-3: reconcile console line carries a truncated payer", async () => {
    on();
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
    rpcAnswer = "used";
    await call("brief", "q=log%20test", { "payment-signature": await payment() });
    const rl = lines.find((l) => l.includes("[RECONCILE]"))!;
    expect(rl).toBeTruthy();
    expect(rl.toLowerCase()).not.toContain(FROM.toLowerCase());
  });
});

/* ======================= Odin C5 / Counsel C1 / C2 ======================= */
describe("Odin C5 premium alert cap, Counsel C2 EXPIRE NX + keyed hash, Counsel C1 privacy", () => {
  const prodEnv = { VERCEL_ENV: "production", KV_REST_API_URL: "https://kv.test", KV_REST_API_TOKEN: "t", UPSTASH_REDIS_REST_URL: "https://kv.test", UPSTASH_REDIS_REST_TOKEN: "t" };
  it("C5: premium alerts have their own daily cap; they never consume the XRPL/Solana budget", async () => {
    const posts: string[] = [];
    setAlertPersistForTests({ fetch: (async (_u: string, i: RequestInit) => (posts.push(String(i.body)), new Response("[]"))) as never, env: prodEnv });
    for (let i = 0; i < PREMIUM_ALERT_WRITE_CAP_PER_DAY + 10; i++) persistAlert("premium", { kind: "premium_x", severity: "high" });
    persistAlert("xrpl", { kind: "x", severity: "high" });
    const st = alertWriteStats() as any;
    expect(st.premiumWritten).toBe(PREMIUM_ALERT_WRITE_CAP_PER_DAY);
    expect(st.overCap.premium).toBe(10);
    expect(st.written).toBe(1);
    expect(ALERT_WRITE_CAP_PER_DAY).toBe(50);
  });
  it("Counsel C2: reconcile retention EXPIRE is set on first write only (NX), 12 months", async () => {
    const bodies: any[] = [];
    setReconcileForTests({ sink: () => {}, fetch: (async (_u: string, i: RequestInit) => (bodies.push(JSON.parse(String(i.body))), new Response("[]"))) as never, env: prodEnv });
    on();
    rpcAnswer = "used";
    await call("brief", "q=expire%20nx", { "payment-signature": await payment() });
    await flushReconcileForTests();
    const cmds = bodies.flat();
    const exp = cmds.find((c: any[]) => c[0] === "EXPIRE");
    expect(exp).toEqual(["EXPIRE", expect.stringMatching(/^hp:premium:reconcile:/), RECONCILE_RETENTION_S, "NX"]);
    expect(RECONCILE_RETENTION_S).toBeLessThanOrEqual(366 * 86_400);
  });
  it("Counsel C2 (optional): keyed request hash when HP_FREE_IP_HMAC_KEY is present", () => {
    const rq = "a".repeat(64);
    expect(storedFingerprint(rq, {})).toBe(rq);
    const k = storedFingerprint(rq, { HP_FREE_IP_HMAC_KEY: "k".repeat(43) });
    expect(k).toMatch(/^k1:[0-9a-f]{64}$/);
    expect(k).not.toContain(rq);
  });
  it("Counsel C1: premium off -> privacy line byte-identical; on -> exact replacement + addition", () => {
    expect(privacyLine({})).toBe(ROUTE_LOG_PRIVACY_LINE);
    const on1 = privacyLine({ HP_PREMIUM_ENABLED: "true" });
    expect(on1).not.toContain(NO_IP_SENTENCE);
    // Counsel E1 (10/22): /privacy uses the "...premium jobs and free feedback..." sentence.
    expect(on1).toContain(`${PRIVACY_PREMIUM_REPLACEMENT_WITH_FEEDBACK} ${PRIVACY_PREMIUM_ADDITION}`);
    expect(on1).toBe(ROUTE_LOG_PRIVACY_LINE.replace(NO_IP_SENTENCE, `${PRIVACY_PREMIUM_REPLACEMENT_WITH_FEEDBACK} ${PRIVACY_PREMIUM_ADDITION}`));
    expect(PRIVACY_PREMIUM_REPLACEMENT_WITH_FEEDBACK).toBe(PRIVACY_PREMIUM_REPLACEMENT.replace("premium jobs,", "premium jobs and free feedback,"));
  });
});

/* ======================= store ======================= */
describe("Upstash premium store", () => {
  it("prefix: hp:premium: in production, hp:premium:pv: elsewhere; claim = SET NX PX; CAS via EVAL", async () => {
    expect(premiumPrefix({ VERCEL_ENV: "production" })).toBe("hp:premium:");
    expect(premiumPrefix({ VERCEL_ENV: "preview" })).toBe("hp:premium:pv:");
    expect(premiumPrefix({})).toBe("hp:premium:pv:");
    const sent: any[] = [];
    const s = new UpstashPremiumStore("https://kv.test", "t", "hp:premium:pv:", (async (_u: string, i: RequestInit) => {
      const b = JSON.parse(String(i.body));
      sent.push(b);
      return new Response(JSON.stringify((Array.isArray(b[0]) ? b : [b]).map(() => ({ result: "OK" }))));
    }) as never);
    await s.setNx("claim:a:b", "v", 120_000);
    await s.cas("claim:a:b", "v", "w", 1000);
    const flat = JSON.stringify(sent);
    expect(flat).toContain('"SET","hp:premium:pv:claim:a:b","v","NX","PX",120000');
    expect(flat).toContain("EVAL");
  });
});

/* ======================= delta 2: Odin rulings 10/19 ======================= */
describe("delta 2: per-payer failed-settle cap (Sentinel MEDIUM-2 async) + EOA-only", () => {
  it("2 failed settles -> payer blocked 24 h: 429 payer_settle_failures before verify, TTL 24 h; other payers unaffected; expires after 24 h", async () => {
    on();
    settleBehaviour = () => ({ success: false, errorReason: "unexpected" });
    for (let i = 0; i < 2; i++) {
      const { r } = await acceptReport(`q=fail%20${i}%20x`);
      expect(r.status).toBe(202);
      await drainAfters();
    }
    expect(fac.filter((c) => c.op === "settle").length).toBe(2);
    const block = store.writes.find((w) => w.key.startsWith("settleblock:"));
    expect(block?.ttlMs).toBe(SETTLE_BLOCK_S * 1000);
    const verifies = fac.filter((c) => c.op === "verify").length;
    const third = await acceptReport("q=third%20try");
    expect(third.r.status).toBe(429);
    expect(third.j.error).toBe(SETTLE_BLOCK_REASON);
    expect(third.j.charged).toBe(false);
    expect(third.j.message).toBe("Two payments from this address failed to settle in the last 24 hours. New report and watch jobs from it are paused for 24 hours; nothing was charged for this request. Retry after the Retry-After time, or use the $1, $5 or $10 tiers. See /premium-terms. If an earlier payment was charged but not delivered, see the refund terms at /premium-terms.");
    expect(fac.filter((c) => c.op === "verify").length).toBe(verifies);
    now += SETTLE_BLOCK_S * 1000 + 1000;
    // open slots have expired too; block gone
    expect((await acceptReport("q=after%20block")).r.status).toBe(202);
  });
  it("1 failed settle does not block", async () => {
    on();
    settleBehaviour = () => ({ success: false, errorReason: "unexpected" });
    await acceptReport("q=one%20fail");
    await drainAfters();
    settleBehaviour = () => ({ success: true, transaction: "0x" + "cd".repeat(32), network: "eip155:8453", payer: FROM });
    expect((await acceptReport("q=second%20ok")).r.status).toBe(202);
  });
  it("smart-wallet signature -> 402 smart_wallet_unsupported + plain line, before any call or write", async () => {
    on();
    const h = await payment();
    const obj = JSON.parse(Buffer.from(h, "base64").toString());
    obj.payload.signature = "0x" + "ab".repeat(200);
    const r = await call("brief", "q=smart%20wallet", { "payment-signature": Buffer.from(JSON.stringify(obj)).toString("base64") });
    expect(r.status).toBe(402);
    const j = (await r.json()) as any;
    expect(j.error).toBe("smart_wallet_unsupported");
    expect(j.message).toBe("Premium accepts payments signed by a regular wallet key (EOA) only at launch. Smart-wallet signatures (ERC-1271 / ERC-6492) are not supported yet; nothing was charged for this request. See /premium-terms.");
    expect(fac.length + store.writes.length).toBe(0);
  });
  it("/premium-terms copy states EOA-only and the failed-settle pause", () => {
    expect(TECHNICAL_NOTES.join(" ")).toMatch(/EOA/);
    expect(TECHNICAL_NOTES.join(" ")).toMatch(/fail to settle within 24 hours/);
    expect(TECHNICAL_NOTES[0]).toContain("depending on the signature, the error is smart_wallet_unsupported or invalid_signature.");
    expect(TECHNICAL_NOTES[1]).toBe("If two payments from one address fail to settle within 24 hours, new report and watch jobs from that address are refused for 24 hours; nothing is charged for a refused request. If several payments fail to settle across the service within 24 hours, report and watch purchases may temporarily be settled when the payment is verified, before the job runs; the 202 response says when this applies. If a charged job then fails, or an earlier payment was charged but not delivered, the refund terms above apply.");
    expect(TECHNICAL_NOTES.join(" ")).toContain("Exception: while settlement is temporarily moved to payment verification (the 202 response says so), you are charged before the job runs; if it then fails, it ends as failed_charged and the refund terms apply.");
    expect(WATCH_TERMS).toContain("if it cannot be built, you are not charged, or, if settlement was temporarily moved to payment verification, you are refunded in full.");
    expect(BUYER_TERMS.join(" ")).toContain("report and watch purchases (HTTP 202) are settled after the first deliverable is built, except while settlement is temporarily moved to payment verification, as the 202 response will say");
  });
});

/* ======================= delta 2: Odin Class A on 99d52bf (P1–P5) ======================= */
describe("delta 2: Odin P1–P5", () => {
  const prodEnv = { VERCEL_ENV: "production", KV_REST_API_URL: "https://kv.test", KV_REST_API_TOKEN: "t", UPSTASH_REDIS_REST_URL: "https://kv.test", UPSTASH_REDIS_REST_TOKEN: "t" };
  it("P1: sync records the block before settle; the redeem log search starts there (never 'earliest')", async () => {
    on();
    settleBehaviour = () => new Promise((_r, rej) => rej(Object.assign(new Error("timed out"), { name: "TimeoutError" })));
    const h = await payment();
    const first = (await (await call("brief", "q=p1%20redeem", { "payment-signature": h })).json()) as any;
    const claim = JSON.parse([...store.kv.entries()].find(([k]) => k.startsWith("claim:"))![1].v);
    expect(claim.blk).toBe(0x100);
    rpcAnswer = "used";
    logsAnswer = [{ topics: [AUTH_USED_TOPIC] }];
    const proof = await ACCOUNT.signMessage({ message: first.redeem_message });
    expect((await call("brief", "q=p1%20redeem", { "payment-signature": h, [PAYER_PROOF_HEADER]: proof })).status).toBe(200);
    expect(logQueries.length).toBe(1);
    expect(logQueries[0].fromBlock).toBe(`0x${(0x100 - 10).toString(16)}`);
    expect(logQueries.some((q) => q.fromBlock === "earliest")).toBe(false);
  });
  it("P1: no recorded block -> 'unknown' (no full-chain scan, no getLogs call)", async () => {
    rpcAnswer = "used";
    expect(await settleLanded({ payer: FROM, nonce: nonce(), block_at_accept: null } as never)).toBe("unknown");
    expect(logQueries).toHaveLength(0);
  });
  it("Odin ruling e2caa71: global breaker (3 failed settles / 24 h) -> no 503; async settles right after verify, before work, + HIGH alert; per-payer 429 unchanged", async () => {
    on();
    const errs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errs.push(a.map(String).join(" ")));
    for (let i = 0; i < 3; i++) await store.zadd("settlefail:global", now + DAY_MS, `job_${String(i).padStart(24, "0")}`, 86_400);
    const order: string[] = [];
    fac = installFacilitatorMock({ verify: () => (order.push("verify"), { isValid: true, payer: FROM }), settle: () => (order.push("settle"), settleBehaviour()) });
    const pc0 = parallelCalls.length;
    const { r, j } = await acceptReport("q=breaker%20test");
    expect(r.status).toBe(202);
    expect(j.charged).toBe(true);
    expect(j.message).toContain("settled when verified, before the job runs");
    expect(order).toEqual(["verify", "settle"]);
    expect(parallelCalls.length).toBe(pc0); // settle happened before any work
    expect(errs.some((l) => l.includes("[ALERT][HIGH]") && l.includes("premium_async_settle_first"))).toBe(true);
    await drainAfters();
    const v = (await (await status(j.job_id, j.job_token)).json()) as any;
    expect(v.status).toBe("delivered");
    expect(order).toEqual(["verify", "settle"]); // no second settle
    // sync tiers unaffected
    expect((await call("brief", "q=sync%20still%20ok", { "payment-signature": await payment() })).status).toBe(200);
    // breaker ages out -> back to settle-after-first-deliverable
    now += DAY_MS + 1000;
    const after = await acceptReport("q=after%20breaker");
    expect(after.r.status).toBe(202);
    expect(after.j.charged).toBe(false);
  });
  it("settle-first job whose work then fails -> failed_charged + charged_not_delivered reconcile (refund path), never failed_uncharged", async () => {
    on();
    for (let i = 0; i < 3; i++) await store.zadd("settlefail:global", now + DAY_MS, `job_${String(i).padStart(24, "0")}`, 86_400);
    setParallelForTests({ fetch: (async () => new Response("x", { status: 500 })) as never });
    const { j } = await acceptReport("q=prepaid%20fails");
    await drainAfters();
    const v = (await (await status(j.job_id, j.job_token)).json()) as any;
    expect(v.status).toBe("failed_charged");
    expect(v.charged).toBe(true);
    expect(v.reconcile_id).toMatch(/^rc_/);
    expect(reconciles.map((l) => l.outcome)).toContain("failed_charged");
  });
  it("failed_charged is written to the reconcile queue and alerted even past the 50/day and premium alert caps", async () => {
    const prodEnv = { VERCEL_ENV: "production", KV_REST_API_URL: "https://kv.test", KV_REST_API_TOKEN: "t", UPSTASH_REDIS_REST_URL: "https://kv.test", UPSTASH_REDIS_REST_TOKEN: "t" };
    const bodies: string[] = [];
    const f = (async (_u: string, i: RequestInit) => (bodies.push(String(i.body)), new Response("[]"))) as never;
    setReconcileForTests({ sink: (l) => reconciles.push(l), fetch: f, env: prodEnv });
    setAlertPersistForTests({ fetch: f, env: prodEnv });
    const base = { route: "/api/research/report/report", tier: "report", payer: FROM, nonce: nonce(), amount: "20000000", payTo: PAYTO, tx: null, fingerprint: "a".repeat(64) } as const;
    for (let i = 0; i < Math.max(RECONCILE_WRITE_CAP_PER_DAY, PREMIUM_ALERT_WRITE_CAP_PER_DAY) + 3; i++) recordReconcile({ ...base, reconcile_id: `rc_fill_${i}`, outcome: "settle_timeout" });
    expect(CAP_EXEMPT_OUTCOMES.has("failed_charged" as never)).toBe(true);
    on();
    for (let i = 0; i < 3; i++) await store.zadd("settlefail:global", now + DAY_MS, `job_${String(i).padStart(24, "0")}`, 86_400);
    setParallelForTests({ fetch: (async () => new Response("x", { status: 500 })) as never });
    const premiumBefore = (alertWriteStats() as any).premiumWritten;
    const droppedBefore = reconcileWriteStats().dropped;
    const { j } = await acceptReport("q=prepaid%20capped");
    await drainAfters();
    await flushReconcileForTests();
    const line = reconciles.find((l) => l.outcome === "failed_charged" && l.job_id === j.job_id)!;
    expect(line).toBeTruthy();
    expect(bodies.some((b) => b.includes(line.reconcile_id) && b.includes("RPUSH"))).toBe(true);
    expect(reconcileWriteStats().dropped).toBe(droppedBefore);
    expect((alertWriteStats() as any).premiumWritten).toBeGreaterThan(premiumBefore);
  });
  it("per-payer 429 still applies while the breaker is tripped", async () => {
    on();
    for (let i = 0; i < 3; i++) await store.zadd("settlefail:global", now + DAY_MS, `job_${String(i).padStart(24, "0")}`, 86_400);
    await store.set(`settleblock:${FROM.toLowerCase()}`, "1", 86_400);
    const v0 = fac.length;
    expect((await acceptReport("q=blocked%20payer")).r.status).toBe(429);
    expect(fac.length).toBe(v0);
  });
  it("P2: settle_never_landed counts as a failed settle (feeds the payer cap and the breaker)", async () => {
    on();
    settleBehaviour = () => ({ success: false, errorReason: "unexpected" });
    const r0 = await call("report", "q=never%20lands", { "payment-signature": await payment({ amount: price("report"), validBefore: String(Math.floor(now / 1000) + 3600) }) });
    const j = (await r0.json()) as any;
    await drainAfters();
    expect(await store.zcardAfterPrune("settlefail:global", now)).toBe(1);
    now += 3700_000;
    rpcAnswer = "unused";
    await runJob(store, j.job_id, now + 50_000);
    expect((await loadJob(store, j.job_id))!.failure).toBe("settle_never_landed");
    expect(await store.zcardAfterPrune("settlefail:global", now)).toBe(1); // same job counted once
  });
  it("P3: charged_not_delivered / refund_owed are never dropped by the 50/day reconcile cap or the premium alert cap", async () => {
    const bodies: string[] = [];
    const f = (async (_u: string, i: RequestInit) => (bodies.push(String(i.body)), new Response("[]"))) as never;
    setReconcileForTests({ sink: () => {}, fetch: f, env: prodEnv });
    setAlertPersistForTests({ fetch: f, env: prodEnv });
    const base = { route: "/api/research/report/brief", tier: "brief", payer: FROM, nonce: nonce(), amount: "1000000", payTo: PAYTO, tx: null, fingerprint: "a".repeat(64) } as const;
    for (let i = 0; i < RECONCILE_WRITE_CAP_PER_DAY + 5; i++) recordReconcile({ ...base, reconcile_id: `rc_${i}`, outcome: "settle_timeout" });
    expect(reconcileWriteStats().dropped).toBe(5);
    const premiumBefore = (alertWriteStats() as any).premiumWritten;
    for (const o of CAP_EXEMPT_OUTCOMES) recordReconcile({ ...base, reconcile_id: `rc_${o}`, outcome: o as never });
    expect(reconcileWriteStats().dropped).toBe(5);
    expect((alertWriteStats() as any).premiumWritten).toBe(premiumBefore + CAP_EXEMPT_OUTCOMES.size);
    await flushReconcileForTests();
    expect(bodies.filter((b) => b.includes("rc_charged_not_delivered")).length).toBeGreaterThanOrEqual(1);
    expect(bodies.filter((b) => b.includes("rc_refund_owed")).length).toBeGreaterThanOrEqual(1);
  });
  it("P4: copy says $1, $5 and $10 (never $3)", () => {
    const all = TECHNICAL_NOTES.join(" ");
    expect(all).toContain("For the $1 verified brief, the $5 seller due-diligence check and the $5 and $10 research tiers"); // Counsel T4 10/21
    expect(all).not.toContain("$3");
  });
  it("P5: concurrent accepts from one payer cannot exceed 2 open jobs (atomic reserve)", async () => {
    on();
    const rs = await Promise.all([0, 1, 2, 3].map((i) => acceptReport(`q=concurrent%20${i}`)));
    const st = rs.map((x) => x.r.status).sort();
    expect(st.filter((x) => x === 202)).toHaveLength(2);
    expect(st.filter((x) => x === 429)).toHaveLength(2);
    expect(await store.zcardAfterPrune(JOB_KEYS.openPayer(FROM), now)).toBe(2);
  });
  it("P5: a refused accept (verify invalid) releases its reservation", async () => {
    on();
    fac = installFacilitatorMock({ verify: () => ({ isValid: false, invalidReason: "insufficient_funds" }) });
    expect((await acceptReport("q=refused%20one")).r.status).toBe(402);
    expect(await store.zcardAfterPrune(JOB_KEYS.openPayer(FROM), now)).toBe(0);
  });
  it("P5: Upstash reserve is one EVAL over both keys", async () => {
    const sent: string[] = [];
    const s = new UpstashPremiumStore("https://kv.test", "t", "hp:premium:pv:", (async (_u: string, i: RequestInit) => (sent.push(String(i.body)), new Response(JSON.stringify([{ result: 1 }])))) as never);
    expect(await s.reserve(["open:payer:x", "open:global"], [2, 10], "job_1", 5, 1, 1200)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('"EVAL"');
    expect(sent[0]).toContain('"hp:premium:pv:open:payer:x","hp:premium:pv:open:global"');
  });
});

/* ======================= delta 3: Sentinel async review LOW-A..D ======================= */
describe("delta 3: Sentinel LOW-A..D", () => {
  const timeout = () => new Promise((_r, rej) => rej(Object.assign(new Error("timed out"), { name: "TimeoutError" })));
  async function unconfirmed(q: string) {
    on();
    settleBehaviour = timeout;
    const h = await payment();
    const first = (await (await call("brief", q, { "payment-signature": h })).json()) as any;
    return { h, first };
  }
  it("LOW-A: a redeem whose work fails rotates the reconcile_id; the old proof no longer works, a new proof over the new message does", async () => {
    const { h, first } = await unconfirmed("q=low%20a%20test");
    rpcAnswer = "used";
    logsAnswer = [{ topics: [AUTH_USED_TOPIC] }];
    const proof1 = await ACCOUNT.signMessage({ message: first.redeem_message });
    // Odin ruling (4): a brief redeem never re-runs; with its cached passing brief gone, the redeem "work" fails.
    const pk = [...store.kv.keys()].find((k) => k.includes("brief:passed:"))!;
    const saved = store.kv.get(pk)!;
    store.kv.delete(pk);
    const r1 = await call("brief", "q=low%20a%20test", { "payment-signature": h, [PAYER_PROOF_HEADER]: proof1 });
    expect(r1.status).toBe(502);
    store.kv.set(pk, saved);
    const j1 = (await r1.json()) as any;
    expect(j1.reconcile_id).not.toBe(first.reconcile_id);
    expect(j1.redeem_message).not.toBe(first.redeem_message);
    setParallelForTests({ fetch: (async () => new Response(JSON.stringify({ results: [{ url: "https://a.example.com/x402", title: "A", publish_date: null, excerpts: [EXCERPT] }] }))) as never });
    expect((await call("brief", "q=low%20a%20test", { "payment-signature": h, [PAYER_PROOF_HEADER]: proof1 })).status).toBe(409); // replayed proof
    const proof2 = await ACCOUNT.signMessage({ message: j1.redeem_message });
    expect((await call("brief", "q=low%20a%20test", { "payment-signature": h, [PAYER_PROOF_HEADER]: proof2 })).status).toBe(200);
  });
  it("LOW-B: mismatched redeems -> 409 without reconcile_id; one deduped redeem_mismatch reconcile + HIGH per claim", async () => {
    const { h, first } = await unconfirmed("q=low%20b%20test");
    const before = reconciles.length;
    const pc = parallelCalls.length; // charge-on-pass: the first call's research ran before its (timed-out) settle
    const other = privateKeyToAccount(generatePrivateKey());
    const attempts = [
      call("brief", "q=other%20request", { "payment-signature": h }),
      call("brief", "q=low%20b%20test", { "payment-signature": h }),
      call("brief", "q=low%20b%20test", { "payment-signature": h, [PAYER_PROOF_HEADER]: await other.signMessage({ message: first.redeem_message }) }),
    ];
    for (const r of await Promise.all(attempts)) {
      expect(r.status).toBe(409);
      const j = (await r.json()) as any;
      expect(j.reconcile_id).toBeUndefined();
      expect(JSON.stringify(j)).not.toContain(first.reconcile_id);
    }
    const mm = reconciles.slice(before).filter((l) => l.outcome === "redeem_mismatch");
    expect(mm).toHaveLength(1);
    expect(parallelCalls.length).toBe(pc);
  });
  it("LOW-C: a settle timeout is not a strike until confirmed failed; a timeout that lands later leaves no strike", async () => {
    on();
    settleBehaviour = timeout;
    const { j } = await acceptReport("q=low%20c%20lands");
    await drainAfters();
    expect((await loadJob(store, j.job_id))!.status).toBe("settle_unconfirmed");
    expect(await store.zcardAfterPrune(JOB_KEYS.settleFail(FROM), now)).toBe(0);
    rpcAnswer = "used";
    logsAnswer = [{ topics: [AUTH_USED_TOPIC] }];
    await runJob(store, j.job_id, now + 50_000);
    expect((await loadJob(store, j.job_id))!.status).toBe("delivered");
    expect(await store.zcardAfterPrune(JOB_KEYS.settleFail(FROM), now)).toBe(0);
  });
  it("LOW-C: a landed payment clears an earlier strike for that job and lifts the payer block", async () => {
    on();
    settleBehaviour = () => ({ success: false, errorReason: "unexpected" });
    const a = await acceptReport("q=low%20c%20one");
    const b = await acceptReport("q=low%20c%20two");
    await drainAfters();
    expect(await store.get(JOB_KEYS.settleBlock(FROM))).not.toBeNull();
    rpcAnswer = "used";
    logsAnswer = [{ topics: [AUTH_USED_TOPIC] }];
    await runJob(store, a.j.job_id, now + 50_000);
    expect(await store.zcardAfterPrune(JOB_KEYS.settleFail(FROM), now)).toBe(1);
    expect(await store.get(JOB_KEYS.settleBlock(FROM))).toBeNull();
    expect(b.r.status).toBe(202);
  });
  it("LOW-D: block-number read fails -> sync 503 chain_unavailable before settle, claim released", async () => {
    on();
    blockDown = true;
    const r = await call("brief", "q=low%20d%20sync", { "payment-signature": await payment() });
    expect(r.status).toBe(503);
    expect(((await r.json()) as any).error).toBe("chain_unavailable");
    expect(fac.some((c) => c.op === "settle")).toBe(false);
    expect([...store.kv.keys()].filter((k) => k.startsWith("claim:"))).toHaveLength(0);
  });
  it("LOW-D: block-number read fails -> async 503 before any job / settle, slot released", async () => {
    on();
    blockDown = true;
    const { r, j } = await acceptReport("q=low%20d%20async");
    expect(r.status).toBe(503);
    expect(j.error).toBe("chain_unavailable");
    expect([...store.kv.keys()].filter((k) => k.startsWith("job:"))).toHaveLength(0);
    expect(await store.zcardAfterPrune(JOB_KEYS.openPayer(FROM), now)).toBe(0);
    expect(fac.some((c) => c.op === "settle")).toBe(false);
  });
});

/* ======================= delta 4: Sentinel delta-3 LOW-1 / LOW-2 ======================= */
describe("delta 4: Sentinel delta-3 LOW-1 / LOW-2", () => {
  it("LOW-1: validBefore beyond now + 1 h -> 402 authorization_window_too_long before verify (sync and async); exactly 1 h is accepted", async () => {
    on();
    const nowS = Math.floor(now / 1000);
    const r1 = await call("brief", "q=too%20long", { "payment-signature": await payment({ validBefore: String(nowS + 3601) }) });
    expect(r1.status).toBe(402);
    expect(((await r1.json()) as any).error).toBe("authorization_window_too_long");
    const r2 = await call("report", "q=too%20long", { "payment-signature": await payment({ amount: price("report"), validBefore: String(nowS + 7200) }) });
    expect(r2.status).toBe(402);
    expect(((await r2.json()) as any).error).toBe("authorization_window_too_long");
    expect(fac.length + store.writes.length).toBe(0);
    expect((await call("brief", "q=exactly%20one%20hour", { "payment-signature": await payment({ validBefore: String(nowS + 3600) }) })).status).toBe(200);
  });
  it("LOW-2: a throw inside settle-at-verify -> 202 settle_unconfirmed with a reconcile_id + reconcile line; the cron resolves it on-chain and the job is delivered", async () => {
    on({ CRON_SECRET: "c".repeat(32) });
    for (let i = 0; i < 3; i++) await store.zadd("settlefail:global", now + DAY_MS, `job_${String(i).padStart(24, "0")}`, 86_400);
    const realSet = store.set.bind(store);
    let thrown = 0;
    store.set = async (k: string, v: string, ttl: number) => {
      if (k.startsWith("job:") && v.includes('"status":"settling"') && thrown === 0) {
        thrown++;
        throw new Error("store down mid-settle");
      }
      return realSet(k, v, ttl);
    };
    const { r, j } = await acceptReport("q=low%202%20throw");
    expect(thrown).toBe(1);
    expect(r.status).toBe(202);
    expect(j.status).toBe("settle_unconfirmed");
    expect(j.reconcile_id).toMatch(/^rc_/);
    expect(reconciles.some((l) => l.reconcile_id === j.reconcile_id && l.job_id === j.job_id)).toBe(true);
    afters.length = 0;
    // payment actually landed: cron resolves -> prepaid -> next cron delivers
    rpcAnswer = "used";
    logsAnswer = [{ topics: [AUTH_USED_TOPIC] }];
    expect((await cron(`Bearer ${"c".repeat(32)}`)).status).toBe(200);
    expect((await loadJob(store, j.job_id))!.prepaid).toBe(true);
    expect((await cron(`Bearer ${"c".repeat(32)}`)).status).toBe(200);
    const v = (await (await status(j.job_id, j.job_token)).json()) as any;
    expect(v.status).toBe("delivered");
    expect(fac.filter((c) => c.op === "settle").length).toBe(0); // the throw happened before the facilitator call; landed on-chain resolution, no second settle
  });
});

/* ======================= delta 5: Odin PASS on bfd52f1 ======================= */
describe("delta 5: Odin bfd52f1 follow-ups", () => {
  it("settle-at-verify throw moves the claim to unconfirmed; resubmitting the same authorization after the 20-min job-claim TTL cannot deliver twice", async () => {
    on({ CRON_SECRET: "c".repeat(32) });
    for (let i = 0; i < 3; i++) await store.zadd("settlefail:global", now + DAY_MS, `job_${String(i).padStart(24, "0")}`, 86_400);
    const realSet = store.set.bind(store);
    let thrown = 0;
    store.set = async (k: string, v: string, ttl: number) => {
      if (k.startsWith("job:") && v.includes('"status":"settling"') && thrown++ === 0) throw new Error("store down mid-settle");
      return realSet(k, v, ttl);
    };
    const n = nonce();
    const header = await payment({ amount: price("report"), nonce: n, validBefore: String(Math.floor(now / 1000) + 3600) });
    const first = await call("report", "q=double%20delivery", { "payment-signature": header });
    const j = (await first.json()) as any;
    expect(j.status).toBe("settle_unconfirmed");
    afters.length = 0;
    const claimEntry = [...store.kv.entries()].find(([k]) => k.startsWith("claim:"))!;
    expect(JSON.parse(claimEntry[1].v).s).toBe("unconfirmed");
    expect(claimEntry[1].exp - now).toBeGreaterThan(20 * 60_000);
    // payment landed; cron delivers the job once
    rpcAnswer = "used";
    logsAnswer = [{ topics: [AUTH_USED_TOPIC] }];
    await cron(`Bearer ${"c".repeat(32)}`);
    await cron(`Bearer ${"c".repeat(32)}`);
    expect((await loadJob(store, j.job_id))!.status).toBe("delivered");
    // 25 min later (past the 20-min job claim TTL, authorization still valid): resubmit -> 409, no new job, no work
    now += 25 * 60_000;
    resetPremiumNoncesForTests();
    const pc = parallelCalls.length;
    const jobsBefore = [...store.kv.keys()].filter((k) => k.startsWith("job:")).length;
    const again = await call("report", "q=double%20delivery", { "payment-signature": header });
    expect(again.status).toBe(409);
    expect([...store.kv.keys()].filter((k) => k.startsWith("job:")).length).toBe(jobsBefore);
    expect(parallelCalls.length).toBe(pc);
  });
  it("/premium-terms EOA paragraph: exact text", () => {
    expect(TECHNICAL_NOTES[0]).toBe("Wallets: at launch, premium accepts payments signed by a regular wallet key (an EOA) only. Smart-wallet signatures (ERC-1271 or ERC-6492) are not supported and are refused before anything is charged; depending on the signature, the error is smart_wallet_unsupported or invalid_signature.");
  });
});

/* ======================= delta 6: Sentinel INFO (claim hold failure alerts) ======================= */
describe("delta 6: settle-at-verify claim-hold failure", () => {
  it("if moving the claim to unconfirmed also fails, a HIGH premium_claim_hold_failed alert fires (not swallowed)", async () => {
    on();
    const errs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errs.push(a.map(String).join(" ")));
    for (let i = 0; i < 3; i++) await store.zadd("settlefail:global", now + DAY_MS, `job_${String(i).padStart(24, "0")}`, 86_400);
    const realSet = store.set.bind(store);
    let thrown = 0;
    store.set = async (k: string, v: string, ttl: number) => {
      if (k.startsWith("job:") && v.includes('"status":"settling"') && thrown++ === 0) throw new Error("store down mid-settle");
      return realSet(k, v, ttl);
    };
    const realCas = store.cas.bind(store);
    store.cas = async (k: string, e: string, n: string, t: number) => {
      if (k.startsWith("claim:") && n.includes('"s":"unconfirmed"')) throw new Error("store down");
      return realCas(k, e, n, t);
    };
    const { j } = await acceptReport("q=hold%20fails");
    expect(j.status).toBe("settle_unconfirmed");
    const hi = errs.filter((l) => l.includes("[ALERT][HIGH]") && l.includes("premium_claim_hold_failed"));
    expect(hi).toHaveLength(1);
    expect(hi[0]).toContain(j.job_id);
    expect(hi[0]).toContain('"reason":"store_error"');
    expect(hi[0].toLowerCase()).not.toContain(FROM.toLowerCase());
  });
  it("no alert when the claim hold succeeds", async () => {
    on();
    const errs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errs.push(a.map(String).join(" ")));
    for (let i = 0; i < 3; i++) await store.zadd("settlefail:global", now + DAY_MS, `job_${String(i).padStart(24, "0")}`, 86_400);
    const realSet = store.set.bind(store);
    let thrown = 0;
    store.set = async (k: string, v: string, ttl: number) => {
      if (k.startsWith("job:") && v.includes('"status":"settling"') && thrown++ === 0) throw new Error("x");
      return realSet(k, v, ttl);
    };
    await acceptReport("q=hold%20ok");
    expect(errs.some((l) => l.includes("premium_claim_hold_failed"))).toBe(false);
  });
});


/** Sentinel 1b4e357 MEDIUM 1-4 + LOW 5-7 (Odin rulings 10/20), one test per fix. */
describe("delta 7: Sentinel hardened-brief findings", () => {
  const timeoutSettle = () => new Promise((_r, rej) => rej(Object.assign(new Error("timed out"), { name: "TimeoutError" })));
  const declines = () => Number([...store.kv.entries()].find(([k]) => k.includes("brief:declines:"))?.[1].v ?? 0);
  it("M1: a declined brief returns reason codes only (no claims, quotes, URLs, answer)", async () => {
    on();
    setBriefGateForTests(null); // real contract gate: the generic brief fails
    const r = await call("brief", "q=leak%20test", { "payment-signature": await payment() });
    expect(r.status).toBe(422);
    const j = (await r.json()) as any;
    expect(j.brief).toBeUndefined();
    expect(Object.keys(j).sort()).toEqual(["charged", "contract", "error", "message", "reason"]); // Sentinel INFO-1: exact key list
    const s = JSON.stringify(j);
    expect(s).not.toContain("example.com");
    expect(s).not.toContain(EXCERPT.slice(0, 30));
    expect(j.reason).toMatch(/^[a-z0-9_:,]+$/);
  });
  it("M2: global unsettled cap ($3/day): at the cap, 503 + reason code BEFORE any 402, no verify, no research", async () => {
    on();
    await store.set(unsettledKey(Date.now()), String(UNSETTLED_DAILY_CAP_USD - BRIEF_RUN_COST_USD / 2), 86_400);
    const bare = await call("brief", "q=cap%20test");
    expect(bare.status).toBe(503);
    expect(bare.headers.get("payment-required")).toBeNull();
    const j = (await bare.json()) as any;
    expect(j).toMatchObject({ error: "daily_research_budget_exhausted", reason: "global_unsettled_cap", charged: false });
    expect((await call("brief", "q=cap%20test", { "payment-signature": await payment() })).status).toBe(503);
    expect(fac.length).toBe(0);
    expect(parallelCalls.length).toBe(0);
  });
  it("M2: a run reserves against the global cap; a pass that settles releases it; a decline keeps it counted", async () => {
    on();
    const k = () => Number(store.kv.get([...store.kv.keys()].find((x) => x.includes("brief:unsettled:"))!)?.v ?? 0);
    expect((await call("brief", "q=pass%20one", { "payment-signature": await payment() })).status).toBe(200);
    expect(k()).toBeCloseTo(0);
    setBriefGateForTests(() => null);
    expect((await call("brief", "q=decline%20one", { "payment-signature": await payment() })).status).toBe(422);
    expect(k()).toBeCloseTo(BRIEF_RUN_COST_USD);
  });
  it("M3: the decline slot is refunded only after settle succeeds; pass-then-failed settle (cancelled authorization) counts as a decline", async () => {
    on();
    expect((await call("brief", "q=pass%20settles", { "payment-signature": await payment() })).status).toBe(200);
    expect(declines()).toBe(0);
    settleBehaviour = () => ({ success: false, errorReason: "authorization_cancelled" });
    expect((await call("brief", "q=pass%20cancelled", { "payment-signature": await payment() })).status).toBe(502);
    expect(declines()).toBe(1);
  });
  it("M4: a brief redeem serves the cached passing brief for that payment: no re-run of research or the model", async () => {
    on();
    settleBehaviour = timeoutSettle;
    const h = await payment();
    const first = (await (await call("brief", "q=redeem%20cache", { "payment-signature": h })).json()) as any;
    const proof = await ACCOUNT.signMessage({ message: first.redeem_message });
    rpcAnswer = "used";
    logsAnswer = [{ topics: [AUTH_USED_TOPIC] }];
    const pc = parallelCalls.length;
    const ok = await call("brief", "q=redeem%20cache", { "payment-signature": h, [PAYER_PROOF_HEADER]: proof });
    expect(ok.status).toBe(200);
    const j = (await ok.json()) as any;
    expect(j.verification).toMatchObject({ charged_on_pass: true });
    expect(j.redeemed.reconcile_id).toBe(first.reconcile_id);
    expect(parallelCalls.length).toBe(pc);
  });
  it("M4: a cached brief that does not pass the gate (or is bound to another payer) is never delivered on redeem", async () => {
    on();
    settleBehaviour = timeoutSettle;
    const h = await payment();
    const first = (await (await call("brief", "q=redeem%20gate", { "payment-signature": h })).json()) as any;
    const proof = await ACCOUNT.signMessage({ message: first.redeem_message });
    rpcAnswer = "used";
    logsAnswer = [{ topics: [AUTH_USED_TOPIC] }];
    setBriefGateForTests(() => null);
    const pc = parallelCalls.length;
    const r = await call("brief", "q=redeem%20gate", { "payment-signature": h, [PAYER_PROOF_HEADER]: proof });
    expect(r.status).toBe(502);
    expect(((await r.json()) as any).claims).toBeUndefined();
    expect(parallelCalls.length).toBe(pc);
  });
  it("delta LOW-1: passing-brief cache write fails -> 503 BEFORE settle, nothing charged, authorization reusable, slot returned", async () => {
    on();
    const realSet = store.set.bind(store);
    store.set = (async (k: string, v: string, t: number) => { if (k.includes("brief:passed:")) throw new Error("kv down"); return realSet(k, v, t); }) as never;
    const h = await payment();
    const r = await call("brief", "q=cache%20fail", { "payment-signature": h });
    expect(r.status).toBe(503);
    expect(((await r.json()) as any)).toMatchObject({ error: "store_unavailable", reason: "brief_cache_unavailable", charged: false, message: "Nothing was charged for this request." });
    expect(fac.some((c) => c.op === "settle")).toBe(false);
    expect(declines()).toBe(0);
    store.set = realSet as never;
    expect((await call("brief", "q=cache%20fail", { "payment-signature": h })).status).toBe(200);
  });
  it("INFO-2: decline-cap store error -> 503 store_unavailable / decline_cap_unavailable, unsettled reservation returned, no research", async () => {
    on();
    const real = store.spendReserve.bind(store);
    store.spendReserve = (async (k: string, a: number, c: number, t: number) => { if (k.includes("brief:declines:")) throw new Error("kv down"); return real(k, a, c, t); }) as never;
    const r = await call("brief", "q=decline%20store", { "payment-signature": await payment() });
    expect(r.status).toBe(503);
    expect(((await r.json()) as any)).toMatchObject({ error: "store_unavailable", reason: "decline_cap_unavailable", charged: false });
    expect(Number(store.kv.get([...store.kv.keys()].find((x) => x.includes("brief:unsettled:"))!)?.v ?? 0)).toBeCloseTo(0);
    expect(parallelCalls.length).toBe(0);
  });
  it("delta LOW-2: the $3/day cap trip raises one WARN alert per UTC day (level via HP_BRIEF_CAP_ALERT_LEVEL)", async () => {
    on();
    await store.set(unsettledKey(Date.now()), String(UNSETTLED_DAILY_CAP_USD), 86_400);
    const err = vi.mocked(console.error);
    err.mockClear();
    expect((await call("brief", "q=cap%20alert")).status).toBe(503);
    expect((await call("brief", "q=cap%20alert")).status).toBe(503);
    const alerts = err.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("premium_brief_unsettled_cap_tripped"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("[premium][ALERT][WARN]");
    expect(alerts[0]).toContain('"severity":"warn"');
    const lines = err.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[premium] brief_cap_tripped "));
    expect(lines).toEqual(["[premium] brief_cap_tripped level=warn where=pre_402 cap_usd=3"]);
  });
  it("LOW-7: our outage (Parallel down) -> 503 before settle; authorization reusable and decline slot not consumed", async () => {
    on();
    setParallelForTests({ fetch: (async () => new Response("x", { status: 500 })) as never });
    const h = await payment();
    const r = await call("brief", "q=outage%20test", { "payment-signature": h });
    expect(r.status).toBe(503);
    expect(((await r.json()) as any)).toMatchObject({ error: "research_provider_unavailable", charged: false });
    expect(declines()).toBe(0);
    expect(fac.some((c) => c.op === "settle")).toBe(false);
    setParallelForTests(null);
    setParallelForTests({ fetch: (async () => new Response(JSON.stringify({ results: [{ url: "https://a.example.com/x402", title: "A", publish_date: null, excerpts: [EXCERPT] }] }))) as never });
    expect((await call("brief", "q=outage%20test", { "payment-signature": h })).status).toBe(200); // same authorization reused
  });
  it("LOW-7: RPC (block) down is checked BEFORE research: 503, no Parallel call, no slot used", async () => {
    on();
    blockDown = true;
    const r = await call("brief", "q=block%20down", { "payment-signature": await payment() });
    expect(r.status).toBe(503);
    expect(((await r.json()) as any).message).toBe("Nothing was charged for this request.");
    expect(parallelCalls.length).toBe(0);
    expect(declines()).toBe(0);
  });
});
