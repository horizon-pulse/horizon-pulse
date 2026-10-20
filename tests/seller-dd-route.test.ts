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
import { setSellerDdClockForTests, setSellerDdDepsForTests } from "@/lib/seller-dd/handler";
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
afterEach(() => { vi.unstubAllEnvs(); setPremiumStoreForTests(undefined); setSellerDdDepsForTests(null); setSellerDdClockForTests(null); });

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
  it("C4: buyer settle fails after test pay -> loss recorded, not charged; 3 failures -> route fails closed before verify", async () => {
    h.settle.mockResolvedValue({ ok: false, kind: "ambiguous", tx: null });
    for (let k = 0; k < 3; k++) {
      const r = await POST(req("POST", { resource: `https://seller${k}.example.com/api` }, await paymentHeader()));
      expect((await r.json()).reason).toBe("buyer_settle_ambiguous");
    }
    expect(Number(await store.get(ddKeys.lossUsd(NOW)))).toBeCloseTo(0.03);
    h.verify.mockClear();
    const r = await POST(req("POST", { resource: "https://seller9.example.com/api" }, await paymentHeader()));
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
