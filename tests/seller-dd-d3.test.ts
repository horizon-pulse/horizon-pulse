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
async function buy() {
  const r = await POST(req("POST", { resource: "https://seller.example.com/api", expected_payTo: "0x" + "4e".repeat(20) }, await paymentHeader()));
  expect(r.status).toBe(200);
  const { status, charged, tx, ...signed } = await r.json();
  return signed as Record<string, any>;
}

describe("seller-dd D3 correction path", () => {
  beforeEach(() => vi.stubEnv("CRON_SECRET", SECRET));

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
    expect(b.checks).toBeUndefined();
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
