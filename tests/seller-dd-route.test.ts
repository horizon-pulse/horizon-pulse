/** Route-level tests: flag gating, payTo pin, Odin C4 ordering, kill switch, settle-failure fail-closed, notice everywhere. */
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
    history: async () => ({ window_blocks: 1, window_days: 0, unique_payers: 1, repeat_payers: 0, first_seen_block: 1, volume_usdc: "0.01", from_block: 1, to_block: 2, source: "x" }), // outside review #1: history always readable here; "fail" = test pay not landed
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
afterEach(() => { resetSettleFailureLatchForTests(); setSellerDdBuyerNonceForTests(null); vi.unstubAllEnvs(); setPremiumStoreForTests(undefined); setSellerDdDepsForTests(null); setSellerDdClockForTests(null); });

describe("seller-dd route", () => {
  it("flag off -> 404 on every verb (either flag)", async () => {
    vi.stubEnv("HP_SELLER_DD_ENABLED", "");
    for (const f of [GET, POST, OPTIONS]) expect((await f(req("GET"))).status).toBe(404);
    vi.stubEnv("HP_SELLER_DD_ENABLED", "true"); vi.stubEnv("HP_PREMIUM_ENABLED", "false");
    expect((await GET(req("GET"))).status).toBe(404);
  });
  it("unpaid GET -> 402 with payTo == full approved string, $5, Base USDC, description + notice", async () => {
    const r = await GET(req("GET"));
    expect(r.status).toBe(402);
    const b = await r.json();
    expect(b.accepts).toHaveLength(1);
    expect(b.accepts[0].payTo).toBe(APPROVED_PAYTO);
    expect(b.accepts[0].payTo.toLowerCase() === APPROVED_PAYTO).toBe(true);
    expect(b.accepts[0]).toMatchObject({ amount: "5000000", network: "eip155:8453", asset: USDC_BASE });
    expect(b.resource.description.length).toBeLessThan(500);
    expect(b.notice).toBe(DD_NOTICE);
    expect((decodePaymentRequiredHeader(r.headers.get("payment-required")!) as any).accepts[0].payTo).toBe(APPROVED_PAYTO);
    expect(b.accepts[0].payTo.toLowerCase()).not.toBe(TESTER.toLowerCase());
  });
  it("payment to another payTo or amount is refused before verify", async () => {
    const r = await POST(req("POST", { resource: "https://seller.example.com/api" }, await paymentHeader({ to: "0x" + "11".repeat(20) })));
    expect(r.status).toBe(402);
    expect((await r.json()).error).toBe("payto_mismatch");
    const r2 = await POST(req("POST", { resource: "https://seller.example.com/api" }, await paymentHeader({ value: "1000000" })));
    expect((await r2.json()).error).toBe("amount_mismatch");
    expect(h.verify).not.toHaveBeenCalled();
  });
  it("kill switch -> no_charge test_pay_disabled before verify; notice present", async () => {
    vi.stubEnv("HP_DD_TESTPAY", "off");
    const r = await POST(req("POST", { resource: "https://seller.example.com/api" }, await paymentHeader()));
    expect(r.status).toBe(503);
    const b = await r.json();
    expect(b).toMatchObject({ status: "no_charge", charged: false, reason: "test_pay_disabled", notice: DD_NOTICE });
    expect(h.verify).not.toHaveBeenCalled();
    expect(engineRan).not.toHaveBeenCalled();
  });
  it("C4: no test pay before the buyer's verify passes (invalid verify -> engine never runs)", async () => {
    h.verify.mockResolvedValue({ ok: false, kind: "invalid", reason: "insufficient_funds" });
    const r = await POST(req("POST", { resource: "https://seller.example.com/api" }, await paymentHeader()));
    expect(r.status).toBe(402);
    expect(engineRan).not.toHaveBeenCalled();
    expect(h.settle).not.toHaveBeenCalled();
  });
  it("PASS -> buyer settled once, signed verdict verifies with the published key", async () => {
    const r = await POST(req("POST", { resource: "https://seller.example.com/api" }, await paymentHeader()));
    const b = await r.json();
    expect(r.status).toBe(200);
    expect(h.verify.mock.invocationCallOrder[0]).toBeLessThan(h.settle.mock.invocationCallOrder[0]!);
    expect(h.settle).toHaveBeenCalledTimes(1);
    expect(b.notice).toBe(DD_NOTICE);
    const { sig, status, charged, tx, ...verdict } = b;
    const x = receiptPublicKeys()!.keys[0]!.x;
    expect(verifyReceipt("seller-dd", verdict, sig, x)).toBe(true);
  });
  it("no pass -> never settled, no_charge with notice, loss recorded", async () => {
    setEngine(false);
    const r = await POST(req("POST", { resource: "https://seller.example.com/api" }, await paymentHeader()));
    const b = await r.json();
    expect(b).toMatchObject({ status: "no_charge", charged: false, notice: DD_NOTICE });
    expect(h.settle).not.toHaveBeenCalled();
    expect(Number(await store.get(ddKeys.lossUsd(NOW)))).toBeGreaterThan(0);
    expect(JSON.stringify(b)).not.toMatch(/"evidence"|excerpt|"history"|"sig"|"listed"/);
  });
  it("B1: 3 settle timeouts -> settle_unconfirmed each (no loss yet, never re-settled); route closed before verify", async () => {
    h.settle.mockResolvedValue({ ok: false, kind: "timeout", tx: null });
    for (let k = 0; k < 3; k++) {
      const r = await POST(req("POST", { resource: `https://seller${k}-shop.com/api` }, await paymentHeader()));
      expect(r.status).toBe(504);
      const b = await r.json();
      expect(b).toMatchObject({ status: "settle_unconfirmed", reason: "buyer_settle_timeout", notice: DD_NOTICE });
      expect(b.redeem_message).toContain(b.reconcile_id);
    }
    expect(h.settle).toHaveBeenCalledTimes(3);
    expect(await store.get(ddKeys.lossUsd(NOW))).toBeNull(); // no loss until confirmed not landed
    h.verify.mockClear();
    const r = await POST(req("POST", { resource: "https://seller9.example.com/api" }, await paymentHeader()));
    expect((await r.json()).reason).toBe("route_paused_settle_failures");
    expect(h.verify).not.toHaveBeenCalled();
  });
  it("Odin #4: per-seller settle-fail: 2 failures on one seller -> that seller refused no_charge before verify; other sellers still served", async () => {
    h.settle.mockResolvedValue({ ok: false, kind: "timeout", tx: null });
    for (let k = 0; k < 2; k++) expect((await POST(req("POST", { resource: `https://api.bad-seller.com/v${k}` }, await paymentHeader()))).status).toBe(504);
    h.verify.mockClear(); engineRan.mockClear(); h.settle.mockClear();
    // same registrable domain, different subdomain/path -> refused, no verify, no test pay, no settle
    const r = await POST(req("POST", { resource: "https://other.bad-seller.com/x" }, await paymentHeader()));
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ status: "no_charge", charged: false, reason: "seller_paused_settle_failures", seller: "bad-seller.com", notice: DD_NOTICE });
    expect(h.verify).not.toHaveBeenCalled(); expect(engineRan).not.toHaveBeenCalled(); expect(h.settle).not.toHaveBeenCalled();
    expect(Number(await store.get(ddKeys.sellerSettleFail("bad-seller.com", NOW)))).toBe(2);
    expect(Number(await store.get(ddKeys.settleFail(NOW)))).toBe(2); // global counted too
    // a different seller is still served (global 2 < 3)
    h.settle.mockResolvedValue({ ok: true, tx: "0x" + "cd".repeat(32), payer: buyer.address, header: "e30=" });
    const ok = await POST(req("POST", { resource: "https://good-seller.com/api" }, await paymentHeader()));
    expect(ok.status).toBe(200);
  });
  it("Odin #4: unreadable per-seller counter -> refused (fail closed)", async () => {
    const realGet = store.get.bind(store);
    store.get = async (k: string) => { if (k.startsWith("dd:settlefail:seller:")) throw new Error("down"); return realGet(k); };
    const r = await POST(req("POST", { resource: "https://x-seller.com/api" }, await paymentHeader()));
    expect((await r.json()).reason).toBe("seller_paused_settle_failures");
    expect(h.verify).not.toHaveBeenCalled();
  });
  it("Odin #4: per-seller counter write failure latches that seller closed (B2 rule)", async () => {
    h.settle.mockResolvedValue({ ok: false, kind: "ambiguous", tx: null });
    const realAdj = store.spendAdjust.bind(store);
    store.spendAdjust = async (k: string, d: number, t: number) => { if (k.startsWith("dd:settlefail:seller:")) throw new Error("down"); return realAdj(k, d, t); };
    expect((await POST(req("POST", { resource: "https://latch-seller.com/api" }, await paymentHeader()))).status).toBe(502);
    store.spendAdjust = realAdj;
    const r = await POST(req("POST", { resource: "https://latch-seller.com/api" }, await paymentHeader()));
    expect((await r.json()).reason).toBe("seller_paused_settle_failures");
  });
  it("B1: timeout where the settle landed -> redeem with payer proof delivers the cached signed verdict, no re-settle, no new test pay", async () => {
    h.settle.mockResolvedValue({ ok: false, kind: "timeout", tx: null });
    const pay = await paymentHeader();
    const body = { resource: "https://seller.example.com/api" };
    const b1 = await (await POST(req("POST", body, pay))).json();
    expect(b1.status).toBe("settle_unconfirmed");
    // resend without proof: no re-settle, no new authorization asked
    expect((await POST(req("POST", body, pay))).status).toBe(409);
    engineRan.mockClear(); h.settle.mockClear(); h.verify.mockClear();
    setSellerDdBuyerNonceForTests(async () => "used");
    const proof = await buyer.signMessage({ message: b1.redeem_message });
    const r = await POST(new NextRequest(URL_, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "payment-signature": pay, "x-hp-payer-proof": proof } }));
    const b = await r.json();
    expect(r.status).toBe(200);
    expect(b).toMatchObject({ status: "delivered", redeemed: true, notice: DD_NOTICE });
    const { sig, status, charged, redeemed, ...verdict } = b;
    expect(verifyReceipt("seller-dd", verdict, sig, receiptPublicKeys()!.keys[0]!.x)).toBe(true);
    expect(h.settle).not.toHaveBeenCalled();
    expect(h.verify).not.toHaveBeenCalled();
    expect(engineRan).not.toHaveBeenCalled();
    expect(await store.get(ddKeys.lossUsd(NOW))).toBeNull();
    // bad proof refused
    const bad = await POST(new NextRequest(URL_, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "payment-signature": pay, "x-hp-payer-proof": "0x" + "11".repeat(65) } }));
    expect(bad.status).toBeGreaterThanOrEqual(400);
  });
  it("B1: timeout where it did not land -> closed as not charged after validBefore; loss written exactly once (redeem + cron)", async () => {
    h.settle.mockResolvedValue({ ok: false, kind: "ambiguous", tx: null });
    const pay = await paymentHeader();
    const body = { resource: "https://seller.example.com/api" };
    const b1 = await (await POST(req("POST", body, pay))).json();
    expect(b1.status).toBe("settle_unconfirmed");
    setSellerDdBuyerNonceForTests(async () => "unused");
    const proof = await buyer.signMessage({ message: b1.redeem_message });
    const redeem = () => POST(new NextRequest(URL_, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "payment-signature": pay, "x-hp-payer-proof": proof } }));
    expect((await (await redeem()).json()).reason).toBe("authorization_still_open"); // before validBefore: nothing closed
    expect(await store.get(ddKeys.lossUsd(NOW))).toBeNull();
    setSellerDdClockForTests(() => NOW + 400_000);
    const r = await redeem();
    expect(r.status).toBe(410);
    expect((await r.json()).reason).toBe("payment_did_not_land");
    await reconcileUnconfirmed(store, NOW + 400_000);
    expect(Number(await store.get(ddKeys.lossUsd(NOW + 400_000)))).toBeCloseTo(0.01);
    expect(h.settle).toHaveBeenCalledTimes(1);
  });
  it("B1: cron closes an unconfirmed claim not landed (loss once), leaves a landed one for redeem", async () => {
    h.settle.mockResolvedValue({ ok: false, kind: "timeout", tx: null });
    await POST(req("POST", { resource: "https://a.example.com/api" }, await paymentHeader()));
    setSellerDdBuyerNonceForTests(async () => "unused");
    const r1 = await reconcileUnconfirmed(store, NOW + 400_000);
    const r2 = await reconcileUnconfirmed(store, NOW + 400_000);
    expect(r1).toMatchObject({ checked: 1, closed_not_charged: 1 });
    expect(r2).toMatchObject({ checked: 0 });
    expect(Number(await store.get(ddKeys.lossUsd(NOW + 400_000)))).toBeCloseTo(0.01);
  });
  it("LOW-1: buyer auth spent/cancelled after our test pay -> settle fails, buyer NOT charged, our test pay recorded as loss once", async () => {
    h.settle.mockResolvedValue({ ok: false, kind: "ambiguous", tx: null }); // e.g. buyer used the nonce elsewhere / cancelled it
    const pay = await paymentHeader();
    const body = { resource: "https://seller.example.com/api" };
    const r1 = await POST(req("POST", body, pay));
    const b1 = await r1.json();
    expect(r1.status).toBe(502);
    expect(b1).toMatchObject({ status: "settle_unconfirmed", charged: "unknown", notice: DD_NOTICE });
    expect(b1.sig).toBeUndefined(); // verdict not delivered
    setSellerDdBuyerNonceForTests(async () => "unused");
    setSellerDdClockForTests(() => NOW + 400_000);
    const r = await reconcileUnconfirmed(store, NOW + 400_000);
    expect(r).toMatchObject({ closed_not_charged: 1 });
    await reconcileUnconfirmed(store, NOW + 400_000);
    expect(Number(await store.get(ddKeys.lossUsd(NOW + 400_000)))).toBeCloseTo(0.01);
    expect(h.settle).toHaveBeenCalledTimes(1);
  });
  it("B2: settle-failure counter write fails -> route fails closed for the day", async () => {
    h.settle.mockResolvedValue({ ok: false, kind: "timeout", tx: null });
    const orig = store.spendAdjust.bind(store);
    store.spendAdjust = async (k: string, dlt: number, t: number) => { if (k.startsWith("dd:settlefail:")) throw new Error("down"); return orig(k, dlt, t); };
    await POST(req("POST", { resource: "https://a.example.com/api" }, await paymentHeader()));
    h.verify.mockClear();
    const r = await POST(req("POST", { resource: "https://b.example.com/api" }, await paymentHeader()));
    expect((await r.json()).reason).toBe("route_paused_settle_failures");
    expect(h.verify).not.toHaveBeenCalled();
  });
  it("C4: test pay counts against the brief's decline cap ($3 unsettled cap covered in caps tests)", async () => {
    setEngine(false);
    for (let k = 0; k < 5; k++) await POST(req("POST", { resource: `https://s${k}.example.com/api` }, await paymentHeader()));
    const r = await POST(req("POST", { resource: "https://s9.example.com/api" }, await paymentHeader()));
    expect((await r.json()).reason).toBe("too_many_no_charge_requests");
  });
  it("tester address mismatch -> route closed (no_charge), never verifies", async () => {
    vi.stubEnv("HP_DD_TESTER_ADDRESS", "0x" + "12".repeat(20));
    const r = await POST(req("POST", { resource: "https://seller.example.com/api" }, await paymentHeader()));
    expect((await r.json()).reason).toBe("test_pay_unavailable");
    expect(h.verify).not.toHaveBeenCalled();
  });
  it("bad body with payment -> 400 no_charge; http resource refused", async () => {
    const r = await POST(req("POST", { resource: "http://seller.example.com/api" }, await paymentHeader()));
    expect(r.status).toBe(400);
    expect((await r.json()).notice).toBe(DD_NOTICE);
  });
});

/* ---- Outside review #1 (Option B, Counsel PASS 10/21): required checks, "incomplete" = 422 and NO settlement ---- */
describe("seller-dd completeness (required checks)", () => {
  const getPaid = vi.fn();
  function engineWith(o: { history?: unknown; paidOk?: boolean; sellerPayTo?: string; listing?: boolean }) {
    getPaid.mockReset().mockImplementation(async () => (o.paidOk === false ? { ok: false, code: "timeout" } : { ok: true, status: 200, headers: { "content-type": "application/json" }, body: "{}", truncated: false, ip: "93.184.216.34", fetched_at: "t" }));
    setSellerDdDepsForTests({
      net: {
        get402: async () => ({ ok: true, status: 402, headers: { "content-type": "application/json" }, body: JSON.stringify({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", asset: USDC_BASE, amount: "10000", payTo: o.sellerPayTo ?? "0x" + "4e".repeat(20), extra: { name: "USD Coin", version: "2" } }] }), truncated: false, ip: "93.184.216.34", fetched_at: "t" }),
        getPaid,
      },
      continuity: { lookup: async () => (o.listing === false ? null : { payTo: o.sellerPayTo ?? "0x" + "4e".repeat(20), source_url: "https://api.cdp.coinbase.com/x", fetched_at: "t" }) },
      history: async () => (o.history === undefined ? { window_blocks: 1, window_days: 0, unique_payers: 1, repeat_payers: 0, first_seen_block: 1, volume_usdc: "0.01", from_block: 1, to_block: 2, source: "x" } : o.history),
      landed: async () => ({ state: "used", nodes: ["a", "b"] }),
      authTx: async () => ({ tx: null, attempts: [{ source: "base-rpc.publicnode.com", reason: "http_429;retry:http_429" }] }),
      sleep: async () => undefined,
    } as never);
  }
  const allFailed = { ok: false, attempts: [{ source: "base.blockscout.com", reason: "http_403" }, { source: "base-rpc.publicnode.com", reason: "head:timeout;retry:timeout" }] };

  it("history read fails on every source -> 422 incomplete, charged false, NO settle, NO test pay, Counsel note verbatim", async () => {
    engineWith({ history: allFailed });
    const r = await POST(req("POST", { resource: "https://seller.example.com/api" }, await paymentHeader()));
    expect(r.status).toBe(422);
    const b = await r.json();
    expect(b).toMatchObject({ status: "incomplete", charged: false, completeness: "incomplete", notice: DD_NOTICE });
    expect(b.message).toBe("Incomplete: one or more checks could not be evidenced (see missing_checks), so no verdict was issued and you were not charged. You may retry later with a new payment authorization.");
    expect(b.missing_checks).toEqual(expect.arrayContaining(["history_and_lookalike", "test_pay"]));
    expect(b.summary_flags).toEqual(expect.arrayContaining(["INCOMPLETE_history_and_lookalike", "INCOMPLETE_test_pay"]));
    // Counsel condition: no settlement attempted on the incomplete 422
    expect(h.settle).not.toHaveBeenCalled();
    expect(getPaid).not.toHaveBeenCalled(); // no test payment spent when the required history check cannot run
    expect(JSON.stringify(b)).not.toMatch(/"sig"|"evidence"|excerpt/);
  });
  it("test pay landed but paid response not captured -> schema_match not_run -> 422 incomplete, NO settle, loss recorded", async () => {
    engineWith({ paidOk: false });
    const r = await POST(req("POST", { resource: "https://seller.example.com/api" }, await paymentHeader()));
    expect(r.status).toBe(422);
    const b = await r.json();
    expect(b).toMatchObject({ status: "incomplete", charged: false });
    expect(b.missing_checks).toContain("schema_match");
    expect(b.summary_flags).toContain("INCOMPLETE_schema_match");
    expect(h.settle).not.toHaveBeenCalled();
    expect(getPaid).toHaveBeenCalledTimes(1);
    expect(Number(await store.get(ddKeys.lossUsd(NOW)))).toBeGreaterThan(0);
  });
  it("full pass: every required check ran -> 200 delivered, completeness complete, settled once; tx lookup failure recorded, not silent", async () => {
    engineWith({});
    const r = await POST(req("POST", { resource: "https://seller.example.com/api" }, await paymentHeader()));
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b).toMatchObject({ status: "delivered", charged: true, completeness: "complete", missing_checks: [], checks_not_run: [] });
    expect(b.checks_run).toEqual(["402_parse", "test_pay", "schema_match", "payTo_continuity", "history_and_lookalike"]);
    expect(b.checks.every((c: any) => c.state === "pass" || c.state === "fail")).toBe(true);
    expect(b.summary_flags.some((f: string) => f.startsWith("INCOMPLETE_"))).toBe(false);
    expect(b.checks.find((c: any) => c.name === "test_pay").evidence.tx_hash_lookup_failed).toEqual([{ source: "base-rpc.publicnode.com", reason: "http_429;retry:http_429" }]);
    expect(h.settle).toHaveBeenCalledTimes(1);
    expect(b.sig).toBeTruthy();
  });
  it("history failure reasons per source are carried in the (unsigned, internal) check evidence", async () => {
    const { runSellerDd } = await import("@/lib/seller-dd/engine");
    engineWith({ history: allFailed });
    const { screenLists } = await import("@/lib/seller-dd/screen");
    const out = await runSellerDd({ resource: "https://seller.example.com/api", request_id: "ab".repeat(12), deadline: Date.now() + 30_000 }, { net: { get402: async () => ({ ok: true, status: 402, headers: {}, body: JSON.stringify({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", asset: USDC_BASE, amount: "10000", payTo: "0x" + "4e".repeat(20), extra: { name: "USD Coin", version: "2" } }] }), truncated: false, ip: "93.184.216.34", fetched_at: "t" }), getPaid: getPaid as never }, continuity: { lookup: async () => null }, store, lists: screenLists(), env: process.env, now: () => NOW, history: async () => allFailed as never } as never);
    const c = (out.verdict.checks as any[]).find((x) => x.name === "history_and_lookalike");
    expect(c.state).toBe("not_run");
    expect(c.evidence.failed_sources).toEqual(allFailed.attempts);
    expect(c.note).toContain("base.blockscout.com http_403");
    expect(out.pass).toBe(false);
    expect(out.verdict.completeness).toBe("incomplete");
  });
  const DENY = "0x" + "de".repeat(20);
  for (const [label, o, body, reason] of [
    ["denylisted payTo", { sellerPayTo: DENY }, { resource: "https://seller.example.com/api" }, "payto_on_denylist"],
    ["own payTo (tester)", { sellerPayTo: TESTER }, { resource: "https://seller.example.com/api" }, "payto_is_own_address"],
    ["payTo mismatch vs expected_payTo", {}, { resource: "https://seller.example.com/api", expected_payTo: "0x" + "77".repeat(20) }, "payto_mismatch_expected"],
    ["no CDP listing", { listing: false }, { resource: "https://seller.example.com/api" }, "payto_not_pinned"],
  ] as const) {
    it(`policy refusal (${label}) -> no_charge + "${reason}", NO incomplete note, NO settle, no test pay`, async () => {
      engineWith(o as never);
      const r = await POST(req("POST", body, await paymentHeader()));
      expect(r.status).toBe(422);
      const b = await r.json();
      expect(b).toMatchObject({ status: "no_charge", charged: false, reason, notice: DD_NOTICE });
      expect(b.message).toBeUndefined();
      expect(JSON.stringify(b)).not.toContain("could not be evidenced");
      expect(h.settle).not.toHaveBeenCalled();
      expect(getPaid).not.toHaveBeenCalled();
    });
  }
  it("read failure (402 fetch timeout) -> 422 incomplete WITH the note, NO settle", async () => {
    setSellerDdDepsForTests({ net: { get402: async () => ({ ok: false, code: "timeout" }), getPaid }, continuity: { lookup: async () => null }, history: async () => null, landed: async () => ({ state: "used", nodes: ["a", "b"] }), authTx: async () => null, sleep: async () => undefined } as never);
    getPaid.mockReset();
    const r = await POST(req("POST", { resource: "https://seller.example.com/api" }, await paymentHeader()));
    expect(r.status).toBe(422);
    const b = await r.json();
    expect(b).toMatchObject({ status: "incomplete", charged: false, reason: "incomplete", cause: "fetch_timeout" });
    expect(b.message).toBe("Incomplete: one or more checks could not be evidenced (see missing_checks), so no verdict was issued and you were not charged. You may retry later with a new payment authorization.");
    expect(h.settle).not.toHaveBeenCalled();
    expect(getPaid).not.toHaveBeenCalled();
  });
});
