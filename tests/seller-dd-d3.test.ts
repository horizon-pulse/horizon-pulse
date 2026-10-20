/** Counsel D3 correction path: receipt log, verify endpoint, re-check reissue with supersede links. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encodePaymentSignatureHeader, decodePaymentRequiredHeader } from "@x402/core/http";
import { USDC_BASE } from "@/lib/config";

const h = vi.hoisted(() => ({ verify: vi.fn(), settle: vi.fn() }));
vi.mock("@/lib/premium/payment", async (orig) => {
  const m: any = await orig();
  return { ...m, verifyPayment: (...a: unknown[]) => h.verify(...a), settlePayment: (...a: unknown[]) => h.settle(...a), nonceUsed: async () => "unused" };
});

import { GET, POST, OPTIONS } from "@/app/api/seller-dd/single/route";
import { reconcileUnconfirmed, setSellerDdBuyerNonceForTests, setSellerDdClockForTests, setSellerDdDepsForTests } from "@/lib/seller-dd/handler";
import { resetSettleFailureLatchForTests } from "@/lib/seller-dd/caps";
import { MemoryPremiumStore, setPremiumStoreForTests } from "@/lib/premium/store";
import { TRANSFER_WITH_AUTHORIZATION_TYPES, USDC_BASE_DOMAIN } from "@/lib/premium/payment";
import { ddKeys } from "@/lib/seller-dd/caps";
import { DD_NOTICE } from "@/lib/seller-dd/config";
import { receiptPublicKeys, verifyReceipt } from "@/lib/receipt-signer";

const APPROVED_PAYTO = "0x5b32c973596078a967562ca652761404f19be0e9"; // full approved string (security/approved-addresses.md)
const NOW = Date.now();
const testerKey = generatePrivateKey();
const TESTER = privateKeyToAccount(testerKey).address;
const buyer = privateKeyToAccount(generatePrivateKey());
const URL_ = "https://horizonpulse.dev/api/seller-dd/single";

async function paymentHeader(o: { to?: string; value?: string } = {}) {
  const auth = { from: buyer.address, to: o.to ?? APPROVED_PAYTO, value: o.value ?? "5000000", validAfter: "0", validBefore: String(Math.floor(NOW / 1000) + 290), nonce: "0x" + Math.random().toString(16).slice(2).padEnd(64, "0").slice(0, 64) };
  const signature = await buyer.signTypedData({ domain: USDC_BASE_DOMAIN, types: TRANSFER_WITH_AUTHORIZATION_TYPES, primaryType: "TransferWithAuthorization", message: { ...auth, from: auth.from, to: auth.to as `0x${string}`, value: BigInt(auth.value), validAfter: 0n, validBefore: BigInt(auth.validBefore), nonce: auth.nonce as `0x${string}` } });
  return encodePaymentSignatureHeader({ x402Version: 2, accepted: { scheme: "exact", network: "eip155:8453", asset: USDC_BASE, amount: o.value ?? "5000000", payTo: o.to ?? APPROVED_PAYTO, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }, payload: { signature, authorization: auth } } as never);
}
const req = (method: string, body?: unknown, pay?: string) => new NextRequest(URL_, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json", ...(pay ? { "payment-signature": pay } : {}) } });

let store: MemoryPremiumStore;
const engineRan = vi.fn();
function setEngine(pass: boolean) {
  setSellerDdDepsForTests({
    net: {
      get402: async () => { engineRan(); return { ok: true, status: 402, headers: { "content-type": "application/json" }, body: JSON.stringify({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", asset: USDC_BASE, amount: "10000", payTo: "0x" + "4e".repeat(20), extra: { name: "USD Coin", version: "2" } }] }), truncated: false, ip: "93.184.216.34", fetched_at: "t" }; },
      getPaid: async () => ({ ok: true, status: 200, headers: { "content-type": "application/json" }, body: "{}", truncated: false, ip: "93.184.216.34", fetched_at: "t" }),
    },
    continuity: { lookup: async () => ({ payTo: "0x" + "4e".repeat(20), source_url: "https://api.cdp.coinbase.com/x", fetched_at: "t" }) },
    history: async () => (pass ? { window_blocks: 1, window_days: 0, unique_payers: 1, repeat_payers: 0, first_seen_block: 1, volume_usdc: "0.01", from_block: 1, to_block: 2, source: "x" } : null),
    landed: async () => ({ state: pass ? "used" : "unused", nodes: ["a", "b"] }),
    authTx: async () => null,
    sleep: async () => undefined,
  });
}

beforeEach(() => {
  vi.stubEnv("HP_PREMIUM_ENABLED", "true");
  vi.stubEnv("HP_SELLER_DD_ENABLED", "true");
  vi.stubEnv("HP_DD_TESTPAY", "on");
  vi.stubEnv("HP_DD_TESTER_KEY", testerKey);
  vi.stubEnv("HP_DD_TESTER_ADDRESS", TESTER);
  vi.stubEnv("HP_DD_DENYLIST", "0x" + "de".repeat(20));
  vi.stubEnv("HP_DD_OWN_ADDRESSES", TESTER);
  vi.stubEnv("HP_RECEIPT_SIGNING_KEY", "22".repeat(32));
  vi.stubEnv("CDP_API_KEY_ID", "test-id");
  vi.stubEnv("CDP_API_KEY_SECRET", "test-secret");
  store = new MemoryPremiumStore();
  setPremiumStoreForTests(store);
  setSellerDdClockForTests(() => NOW);
  h.verify.mockReset().mockResolvedValue({ ok: true, payer: buyer.address });
  h.settle.mockReset().mockResolvedValue({ ok: true, tx: "0x" + "cd".repeat(32), payer: buyer.address, header: "e30=" });
  engineRan.mockReset();
  setEngine(true);
});
import { GET as VERIFY } from "@/app/api/seller-dd/verify/route";
import { POST as RECHECK } from "@/app/api/seller-dd/recheck/route";
import { rcptKeys, verdictSha256 } from "@/lib/seller-dd/receipts";

const SECRET = "s".repeat(32);
const verify = (id: string) => VERIFY(new NextRequest(`https://horizonpulse.dev/api/seller-dd/verify?id=${id}`));
const recheck = (id: string, auth = `Bearer ${SECRET}`) => RECHECK(new NextRequest("https://horizonpulse.dev/api/seller-dd/recheck", { method: "POST", body: JSON.stringify({ id }), headers: { authorization: auth } }));
async function buy(resource = "https://seller.example.com/api") {
  const r = await POST(req("POST", { resource, expected_payTo: "0x" + "4e".repeat(20) }, await paymentHeader()));
  expect(r.status).toBe(200);
  const { status, charged, tx, ...signed } = await r.json();
  return signed as Record<string, any>;
}

describe("seller-dd D3 correction path", () => {
  beforeEach(() => { vi.stubEnv("HP_DD_RECHECK_SECRET", SECRET); vi.stubEnv("CRON_SECRET", "c".repeat(32)); });

  it("flag off -> verify and recheck 404 before any store access", async () => {
    vi.stubEnv("HP_SELLER_DD_ENABLED", "");
    setPremiumStoreForTests(null);
    expect((await verify("dd_" + "a".repeat(24))).status).toBe(404);
    expect((await recheck("dd_" + "a".repeat(24))).status).toBe(404);
  });

  it("delivered verdict is in the receipt log (hash only) and verify says current", async () => {
    const v = await buy();
    const raw = await store.get(rcptKeys.rec(v.id));
    expect(raw).toBeTruthy();
    expect(raw).not.toContain("paid_response_excerpt");
    const r = await verify(v.id);
    const b = await r.json();
    expect(r.status).toBe(200);
    expect(b).toMatchObject({ id: v.id, status: "current", superseded_by: null, supersedes: null, verdict_sha256: verdictSha256(v) });
    // Odin V2: only these fields (+ Counsel's superseded line and the verify how-to)
    expect(Object.keys(b).sort()).toEqual(["check", "id", "issued_at", "kid", "resource_sha256", "status", "superseded_by", "superseded_note", "supersedes", "verdict_sha256"]);
    expect(JSON.stringify(b)).not.toContain("seller.example.com");
    expect(b.pass).toBeUndefined(); expect(b.resource).toBeUndefined(); expect(b.note).toBeUndefined();
  });

  it("receipt-log write fails -> buyer never settled (fail closed)", async () => {
    const orig = store.setNx.bind(store);
    store.setNx = async (k: string, ...a: [string, number]) => { if (k.startsWith("dd:rcpt:")) throw new Error("down"); return orig(k, ...a); };
    const r = await POST(req("POST", { resource: "https://seller.example.com/api" }, await paymentHeader()));
    expect(r.status).toBe(503);
    expect(h.settle).not.toHaveBeenCalled();
  });

  it("recheck: auth required, unknown/invalid ids refused, no store write", async () => {
    expect((await recheck("dd_" + "a".repeat(24), "Bearer wrong")).status).toBe(401);
    expect((await recheck("nope")).status).toBe(400);
    expect((await recheck("dd_" + "a".repeat(24))).status).toBe(404);
  });

  it("recheck reissues with a NEW id, signed supersedes link, old id superseded_by, old record + verdict untouched, buyer not charged", async () => {
    const old = await buy();
    const oldRec = await store.get(rcptKeys.rec(old.id));
    h.settle.mockClear(); h.verify.mockClear();
    const r = await recheck(old.id);
    const b = await r.json();
    expect(r.status).toBe(200);
    expect(b.status).toBe("reissued");
    expect(b.id).not.toBe(old.id);
    expect(b.supersedes).toBe(old.id);
    expect(h.settle).not.toHaveBeenCalled(); // at our cost
    expect(h.verify).not.toHaveBeenCalled();
    const { status, ...signed } = b;
    const { sig, ...body } = signed;
    expect(verifyReceipt("seller-dd", body, sig, receiptPublicKeys()!.keys[0]!.x)).toBe(true); // link is under the signature
    expect(await store.get(rcptKeys.rec(old.id))).toBe(oldRec); // never silently edited
    const o = await (await verify(old.id)).json();
    expect(o).toMatchObject({ status: "superseded", superseded_by: b.id, verdict_sha256: verdictSha256(old) }); // old hash still verifies
    const n = await (await verify(b.id)).json();
    expect(n).toMatchObject({ status: "current", supersedes: old.id, superseded_by: null });
    const log = await store.zrangeByScore(rcptKeys.log(), Number.MAX_SAFE_INTEGER, 50);
    expect(log).toContain(`superseded:${old.id}:by:${b.id}`);
    expect(log).toContain(`issued:${b.id}:supersedes:${old.id}`);
  });

  it("recheck with a failing outcome is still reissued and signed (pass:false)", async () => {
    const old = await buy();
    setEngine(false); // test pay sent but not landed -> fail
    const b = await (await recheck(old.id)).json();
    expect(b.status).toBe("reissued");
    expect(b.pass).toBe(false);
    expect((await (await verify(old.id)).json()).superseded_by).toBe(b.id);
  });

  it("already superseded -> 409 pointing at the newer id; only one supersede ever", async () => {
    const old = await buy();
    const b = await (await recheck(old.id)).json();
    const r2 = await recheck(old.id);
    expect(r2.status).toBe(409);
    expect((await r2.json()).superseded_by).toBe(b.id);
  });

  it("kill switch / caps: no test pay -> nothing reissued, old stays current", async () => {
    const old = await buy();
    vi.stubEnv("HP_DD_TESTPAY", "off");
    expect((await recheck(old.id)).status).toBe(503);
    expect((await (await verify(old.id)).json()).status).toBe("current");
  });
});

import { DD_PASS_NOTE, DD_RETENTION_TERM, DD_SUPERSEDED_NOTE } from "@/lib/seller-dd/config";
import PremiumTermsPage from "@/app/premium-terms/page";
import { renderToStaticMarkup } from "react-dom/server";
describe("seller-dd D3 Counsel copy (verbatim)", () => {
  beforeEach(() => { vi.stubEnv("HP_DD_RECHECK_SECRET", SECRET); vi.stubEnv("CRON_SECRET", "c".repeat(32)); });
  it("verify response carries both Counsel lines exactly", async () => {
    expect(DD_SUPERSEDED_NOTE).toBe("A superseded verdict has been replaced after a re-check; rely on the verdict named in superseded_by.");
    expect(DD_PASS_NOTE).toBe("pass means Horizon Pulse's charge criteria were met; it is not a rating of the seller.");
    const old = await buy();
    await recheck(old.id);
    for (const id of [old.id]) {
      const b = await (await verify(id)).json();
      expect(b.superseded_note).toBe("A superseded verdict has been replaced after a re-check; rely on the verdict named in superseded_by.");
      expect(b.note).toBeUndefined(); // moved to /premium-terms (verify no longer returns pass)
      expect(b.issued_at).toBeTruthy(); // R5: superseded keeps its issue time
    }
  });
  it("/premium-terms states retention exactly when seller-dd is on, and not at all when off", () => {
    vi.stubEnv("HP_PREMIUM_TIERS", "brief");
    expect(DD_RETENTION_TERM).toBe("Verdict receipts (hashes only) are kept for 3 years.");
    const html = renderToStaticMarkup(PremiumTermsPage());
    expect(html).toContain("Verdict receipts (hashes only) are kept for 3 years.");
    expect(html).toContain("pass means Horizon Pulse&#x27;s charge criteria were met; it is not a rating of the seller.");
    vi.stubEnv("HP_SELLER_DD_ENABLED", "");
    expect(renderToStaticMarkup(PremiumTermsPage())).not.toContain("Verdict receipts");
  });
});

import { ddKeys as K } from "@/lib/seller-dd/caps";
describe("seller-dd D3 Odin round 5 + Sentinel D3", () => {
  beforeEach(() => { vi.stubEnv("HP_DD_RECHECK_SECRET", SECRET); vi.stubEnv("CRON_SECRET", "c".repeat(32)); });
  const lossEntries = async () => (await store.zrangeByScore(K.loss(NOW), Number.MAX_SAFE_INTEGER, 100)).map((x) => JSON.parse(x));

  it("V1: HP_DD_RECHECK_SECRET unset -> every request refused; CRON_SECRET never accepted", async () => {
    const old = await buy();
    vi.stubEnv("HP_DD_RECHECK_SECRET", "");
    vi.stubEnv("CRON_SECRET", SECRET);
    expect((await recheck(old.id)).status).toBe(401);
    expect((await recheck(old.id, "")).status).toBe(401);
    vi.stubEnv("HP_DD_RECHECK_SECRET", "t".repeat(32));
    expect((await recheck(old.id, `Bearer ${SECRET}`)).status).toBe(401); // the cron secret is not the recheck secret
    expect((await (await verify(old.id)).json()).status).toBe("current");
  });

  it("verify rate limit: 60/min per IP, 61st -> 429; another IP unaffected", async () => {
    const id = "dd_" + "b".repeat(24);
    const v = (ip: string) => VERIFY(new NextRequest(`https://horizonpulse.dev/api/seller-dd/verify?id=${id}`, { headers: { "x-real-ip": ip } }));
    for (let i = 0; i < 60; i++) expect((await v("1.2.3.4")).status).toBe(404);
    const r = await v("1.2.3.4");
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("60");
    expect((await v("5.6.7.8")).status).toBe(404);
  });

  it("R1 / LOW-1: every re-check test pay is a ledger entry tagged recheck (pass and fail)", async () => {
    const a = await buy(); const b = await buy("https://other-seller.example.org/api"); // distinct hosts: §3 per-host cap
    const before = new Set((await lossEntries()).map((e) => JSON.stringify(e)));
    expect((await recheck(a.id)).status).toBe(200); // pass
    await store.del(K.ip("93.184.216.34", NOW), K.host("example.com", NOW)); // mock engine reuses one IP; §3 per-IP/host caps otherwise refuse (correctly)
    setEngine(false);
    const rb = await recheck(b.id); const jb = await rb.json(); expect([rb.status, jb.reason ?? jb.error]).toEqual([200, undefined]); // fail, still reissued
    const added = (await lossEntries()).filter((e) => !before.has(JSON.stringify(e)));
    expect(added).toHaveLength(2);
    expect(added.every((e) => e.reason === "recheck")).toBe(true);
    expect(new Set(added.map((e) => e.request_id)).size).toBe(2);
  });

  it("LOW-2: paid record saved before 503; retry finishes without a second test pay", async () => {
    const old = await buy();
    engineRan.mockClear();
    const orig = store.setNx.bind(store);
    let failSup = true;
    store.setNx = async (k: string, ...a: [string, number]) => { if (k.startsWith("dd:superseded:") && failSup) { failSup = false; throw new Error("down"); } return orig(k, ...a); };
    const r1 = await recheck(old.id);
    expect(r1.status).toBe(503);
    expect((await r1.json()).retry).toBe("resumes_without_new_test_pay");
    expect(await store.get(rcptKeys.recheckPaid(old.id))).toBeTruthy();
    const runs = engineRan.mock.calls.length;
    const r2 = await recheck(old.id);
    const b2 = await r2.json();
    expect(r2.status).toBe(200);
    expect(engineRan.mock.calls.length).toBe(runs); // no new engine run / test pay
    expect((await (await verify(old.id)).json()).superseded_by).toBe(b2.id);
    expect(await store.get(rcptKeys.recheckPaid(old.id))).toBeNull();
  });

  it("LOW-2: at most 1 re-check test pay per verdict per day", async () => {
    const old = await buy();
    const orig = store.setNx.bind(store);
    store.setNx = async (k: string, ...a: [string, number]) => { if (k.startsWith("dd:rcpt:dd_")) throw new Error("down"); return orig(k, ...a); };
    expect((await recheck(old.id)).status).toBe(503);
    store.setNx = orig;
    await store.del(rcptKeys.recheckPaid(old.id)); // even with no saved record, the day's slot is used
    const r = await recheck(old.id);
    expect(r.status).toBe(429);
    expect((await r.json()).error).toBe("recheck_daily_limit");
  });
});

import { RECHECK_CTX_TTL_S, RECEIPT_TTL_S } from "@/lib/seller-dd/receipts";
describe("seller-dd D3 Odin round 6: 3-year record hashes/ids only, 90-day re-check context", () => {
  beforeEach(() => { vi.stubEnv("HP_DD_RECHECK_SECRET", SECRET); vi.stubEnv("CRON_SECRET", "c".repeat(32)); });
  it("3-year record holds no URL and no 0x address; URL + expected payTo only in the 90-day entry", async () => {
    const ttls: Record<string, number> = {};
    const os = store.set.bind(store), on = store.setNx.bind(store);
    store.set = async (k: string, v: string, t: number) => { ttls[k] = t; return os(k, v, t); };
    store.setNx = async (k: string, v: string, t: number) => { ttls[k] = t / 1000; return on(k, v, t); };
    const v = await buy();
    const raw = (await store.get(rcptKeys.rec(v.id)))!;
    expect(raw).not.toMatch(/https?:|seller\.example|0x[0-9a-fA-F]/);
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(["id", "issued_at", "kid", "origin", "pass", "resource_sha256", "supersedes", "verdict_sha256"]);
    expect(ttls[rcptKeys.rec(v.id)]).toBe(RECEIPT_TTL_S);
    const ctx = JSON.parse((await store.get(rcptKeys.ctx(v.id)))!);
    expect(ctx).toEqual({ resource: "https://seller.example.com/api", expected_payTo: "0x" + "4e".repeat(20) });
    expect(ttls[rcptKeys.ctx(v.id)]).toBe(RECHECK_CTX_TTL_S);
    expect(RECHECK_CTX_TTL_S).toBe(90 * 86_400);
  });
  it("re-check within 90 days works (uses the 90-day entry)", async () => {
    const v = await buy();
    const r = await recheck(v.id);
    expect(r.status).toBe(200);
    expect((await r.json()).resource).toBe("https://seller.example.com/api");
  });
  it("re-check after the 90-day entry expired -> 410 recheck_window_expired, no test pay, old stays current", async () => {
    const v = await buy();
    await store.del(rcptKeys.ctx(v.id)); // expiry
    engineRan.mockClear();
    const r = await recheck(v.id);
    expect(r.status).toBe(410);
    expect((await r.json()).error).toBe("recheck_window_expired");
    expect(engineRan).not.toHaveBeenCalled();
    expect((await (await verify(v.id)).json()).status).toBe("current");
  });
});

describe("seller-dd D3 Sentinel INFO-2", () => {
  it("HP_DD_RECHECK_SECRET equal to CRON_SECRET -> every re-check 401, no test pay", async () => {
    vi.stubEnv("HP_DD_RECHECK_SECRET", SECRET);
    const v = await buy();
    vi.stubEnv("CRON_SECRET", SECRET);
    engineRan.mockClear();
    expect((await recheck(v.id)).status).toBe(401);
    expect(engineRan).not.toHaveBeenCalled();
    vi.stubEnv("CRON_SECRET", "c".repeat(32));
    expect((await recheck(v.id)).status).toBe(200);
  });
});

import { POST as DISPUTE } from "@/app/api/seller-dd/dispute/route";
import { DD_DISPUTE_TERM } from "@/lib/seller-dd/config";
import { openDispute, resolveDispute } from "@/lib/seller-dd/receipts";
describe("seller-dd D3 Counsel retention: 90-day window, real purge, dispute hold", () => {
  beforeEach(() => { vi.stubEnv("HP_DD_RECHECK_SECRET", SECRET); vi.stubEnv("CRON_SECRET", "c".repeat(32)); });
  const DAY = 86_400_000;
  const dispute = (id: string, action: string, auth = `Bearer ${SECRET}`) => DISPUTE(new NextRequest("https://horizonpulse.dev/api/seller-dd/dispute", { method: "POST", body: JSON.stringify({ id, action }), headers: { authorization: auth } }));

  it("/premium-terms carries Counsel's dispute-window sentence verbatim", () => {
    vi.stubEnv("HP_PREMIUM_TIERS", "brief");
    const s = "To handle disputes, the checked URL and payment address are kept in readable form for 90 days after a verdict and then deleted; after that, only hashes are kept, for 3 years. Disputes must be raised within 90 days of the verdict's checked_at time.";
    expect(DD_DISPUTE_TERM).toBe(s);
    expect(renderToStaticMarkup(PremiumTermsPage())).toContain(s.replace("verdict's", "verdict&#x27;s"));
  });

  it("purge actually happens at 90 days (store TTL), while the hashes-only record remains", async () => {
    const v = await buy();
    store.now = () => NOW + 89 * DAY;
    expect(await store.get(rcptKeys.ctx(v.id))).toBeTruthy();
    store.now = () => NOW + 90 * DAY + 1000;
    expect(await store.get(rcptKeys.ctx(v.id))).toBeNull(); // deleted
    expect(await store.get(rcptKeys.rec(v.id))).toBeTruthy(); // 3-year hashes-only record kept
    setSellerDdClockForTests(() => NOW + 90 * DAY + 1000);
    expect((await recheck(v.id)).status).toBe(410);
    expect((await openDispute(store, v.id, NOW + 90 * DAY + 1000))).toMatchObject({ ok: false, status: 410, error: "dispute_window_expired" });
  });

  it("an open dispute holds the entry past 90 days until resolved; resolve after the window deletes it", async () => {
    const v = await buy();
    store.now = () => NOW + 80 * DAY;
    expect(await openDispute(store, v.id, NOW + 80 * DAY)).toMatchObject({ ok: true, state: "open" });
    store.now = () => NOW + 200 * DAY;
    expect(await store.get(rcptKeys.ctx(v.id))).toBeTruthy(); // held
    expect(await resolveDispute(store, v.id, NOW + 200 * DAY)).toMatchObject({ ok: true, state: "resolved", ctx_expires_at: null });
    expect(await store.get(rcptKeys.ctx(v.id))).toBeNull(); // deleted on resolve
    const log = await store.zrangeByScore(rcptKeys.log(), Number.MAX_SAFE_INTEGER, 50);
    expect(log.some((x) => x.startsWith(`dispute_open:${v.id}`))).toBe(true);
    expect(log.some((x) => x.startsWith(`dispute_resolved:${v.id}`))).toBe(true);
  });

  it("resolve inside the window restores the remaining 90-day TTL (not longer)", async () => {
    const v = await buy();
    await openDispute(store, v.id, NOW + 10 * DAY);
    const r = await resolveDispute(store, v.id, NOW + 20 * DAY);
    expect(r).toMatchObject({ ok: true, ctx_expires_at: new Date(NOW + 90 * DAY).toISOString() });
    store.now = () => NOW + 90 * DAY + 2000;
    expect(await store.get(rcptKeys.ctx(v.id))).toBeNull();
  });

  it("Odin H2: dispute-open log write fails -> 503, no hold, readable entry TTL unchanged", async () => {
    const v = await buy();
    const ttls: Record<string, number> = {};
    const os = store.set.bind(store);
    store.set = async (k: string, val: string, t: number) => { ttls[k] = t; return os(k, val, t); };
    const oz = store.zadd.bind(store);
    store.zadd = async (k: string, sc: number, m: string, t: number) => { if (m.startsWith("dispute_open:")) throw new Error("log down"); return oz(k, sc, m, t); };
    const r = await dispute(v.id, "open");
    expect(r.status).toBe(503);
    expect(ttls[rcptKeys.ctx(v.id)]).toBeUndefined(); // TTL not rewritten
    expect(ttls[rcptKeys.dispute(v.id)]).toBeUndefined();
    expect(await store.get(rcptKeys.dispute(v.id))).toBeNull();
    store.now = () => NOW + 90 * DAY + 1000;
    expect(await store.get(rcptKeys.ctx(v.id))).toBeNull(); // still purged at 90 days
    store.zadd = oz; store.set = os;
  });

  it("dispute route: auth rules match recheck (401), flag off 404, bad action 400, open -> 200", async () => {
    const v = await buy();
    expect((await dispute(v.id, "open", "Bearer nope")).status).toBe(401);
    expect((await dispute(v.id, "delete")).status).toBe(400);
    const r = await dispute(v.id, "open");
    expect(r.status).toBe(200);
    expect((await r.json()).state).toBe("open");
    expect((await dispute(v.id, "resolve")).status).toBe(200);
    expect((await dispute(v.id, "resolve")).status).toBe(409);
    vi.stubEnv("CRON_SECRET", SECRET);
    expect((await dispute(v.id, "open")).status).toBe(401);
    vi.stubEnv("HP_SELLER_DD_ENABLED", "");
    expect((await dispute(v.id, "open")).status).toBe(404);
  });
});
