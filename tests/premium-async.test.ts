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
import { RECONCILE_RETENTION_S, PRIVACY_PREMIUM_ADDITION, PRIVACY_PREMIUM_REPLACEMENT } from "@/lib/premium/copy";
import { flushReconcileForTests, setReconcileForTests, storedFingerprint, type ReconcileLine } from "@/lib/premium/reconcile";
import { MemoryPremiumStore, premiumPrefix, setPremiumStoreForTests, UpstashPremiumStore, type PremiumStore } from "@/lib/premium/store";
import { setPremiumClockForTests } from "@/lib/premium/handler";
import { AUTH_USED_TOPIC, FIRST_DELIVERABLE_BUDGET_MS, JOB_KEYS, loadJob, runJob, setJobClockForTests, setJobRpcForTests, stopWatch, cronSweep } from "@/lib/premium/jobs";
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
  const auth = { from: FROM, to: PAYTO, value: amount, validAfter: o.validAfter ?? "0", validBefore: o.validBefore ?? "9999999999", nonce: o.nonce ?? nonce() };
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
let parallelCalls: string[];
let reconciles: ReconcileLine[];
let settleBehaviour: () => unknown;
let now: number;
let pages: Record<string, { status: number; body: string; headers?: Record<string, string> }>;

function on(extra: Record<string, string> = {}) {
  vi.stubEnv("HP_PREMIUM_ENABLED", "true");
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
  parallelCalls = [];
  reconciles = [];
  settleBehaviour = () => ({ success: true, transaction: "0x" + "cd".repeat(32), network: "eip155:8453", payer: FROM });
  fac = installFacilitatorMock({ verify: () => ({ isValid: true, payer: FROM }), settle: () => settleBehaviour() });
  const rpcFetch = (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (rpcAnswer === "down") throw new Error("down");
    if (body.method === "eth_blockNumber") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x100" }));
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
    expect(on1).toContain(`${PRIVACY_PREMIUM_REPLACEMENT} ${PRIVACY_PREMIUM_ADDITION}`);
    expect(on1).toBe(ROUTE_LOG_PRIVACY_LINE.replace(NO_IP_SENTENCE, `${PRIVACY_PREMIUM_REPLACEMENT} ${PRIVACY_PREMIUM_ADDITION}`));
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
