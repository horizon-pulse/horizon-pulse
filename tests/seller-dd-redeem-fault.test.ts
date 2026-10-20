/**
 * Fault injection (Odin 10/20 6:06 PM ET): the REAL settlePayment/verifyPayment + HTTPFacilitatorClient run against a
 * stubbed facilitator (global fetch). Verify passes; settle is forced to fail (HTTP 500, then a timeout-style abort).
 * Asserts settle_unconfirmed, the 3/day settle-failure counter increments, redeem with payer proof delivers the cached
 * signed verdict, and the buyer is never settled twice (exactly one facilitator /settle call per authorization).
 * No network, no real money: every fetch is stubbed and any unexpected URL fails the test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import { USDC_BASE } from "@/lib/config";
import { POST } from "@/app/api/seller-dd/single/route";
import { setSellerDdBuyerNonceForTests, setSellerDdClockForTests, setSellerDdDepsForTests } from "@/lib/seller-dd/handler";
import { ddKeys, resetSettleFailureLatchForTests } from "@/lib/seller-dd/caps";
import { MemoryPremiumStore, setPremiumStoreForTests } from "@/lib/premium/store";
import { TRANSFER_WITH_AUTHORIZATION_TYPES, USDC_BASE_DOMAIN, resetPremiumFacilitatorForTests, resetPremiumNoncesForTests } from "@/lib/premium/payment";
import { receiptPublicKeys, verifyReceipt } from "@/lib/receipt-signer";
import { generateKeyPairSync } from "node:crypto";

// Throwaway in-test Ed25519 key in the CDP secret format (base64 seed||pub) so the real client builds its auth header offline.
const kp = generateKeyPairSync("ed25519");
const seed = (kp.privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).subarray(-32);
const pub = (kp.publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32);
const FAKE_CDP_SECRET = Buffer.concat([seed, pub]).toString("base64");

const APPROVED_PAYTO = "0x5b32c973596078a967562ca652761404f19be0e9";
const NOW = Date.now();
const testerKey = generatePrivateKey();
const TESTER = privateKeyToAccount(testerKey).address;
const buyer = privateKeyToAccount(generatePrivateKey());
const URL_ = "https://horizonpulse.dev/api/seller-dd/single";
const SELLER_PAYTO = "0x" + "4e".repeat(20);

async function paymentHeader() {
  const auth = { from: buyer.address, to: APPROVED_PAYTO, value: "5000000", validAfter: "0", validBefore: String(Math.floor(NOW / 1000) + 290), nonce: "0x" + [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("") };
  const signature = await buyer.signTypedData({ domain: USDC_BASE_DOMAIN, types: TRANSFER_WITH_AUTHORIZATION_TYPES, primaryType: "TransferWithAuthorization", message: { ...auth, to: auth.to as `0x${string}`, value: BigInt(auth.value), validAfter: 0n, validBefore: BigInt(auth.validBefore), nonce: auth.nonce as `0x${string}` } });
  return encodePaymentSignatureHeader({ x402Version: 2, accepted: { scheme: "exact", network: "eip155:8453", asset: USDC_BASE, amount: "5000000", payTo: APPROVED_PAYTO, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }, payload: { signature, authorization: auth } } as never);
}
const post = (body: unknown, pay: string, proof?: string) =>
  POST(new NextRequest(URL_, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "payment-signature": pay, ...(proof ? { "x-hp-payer-proof": proof } : {}) } }));

let store: MemoryPremiumStore;
let settleMode: "http500" | "abort" = "http500";
const calls = { verify: 0, settle: 0, other: [] as string[] };

beforeEach(() => {
  vi.stubEnv("HP_PREMIUM_ENABLED", "true");
  vi.stubEnv("HP_SELLER_DD_ENABLED", "true");
  vi.stubEnv("HP_DD_TESTPAY", "on");
  vi.stubEnv("HP_DD_TESTER_KEY", testerKey);
  vi.stubEnv("HP_DD_TESTER_ADDRESS", TESTER);
  vi.stubEnv("HP_DD_DENYLIST", "0x" + "de".repeat(20));
  vi.stubEnv("HP_DD_OWN_ADDRESSES", TESTER);
  vi.stubEnv("HP_RECEIPT_SIGNING_KEY", "33".repeat(32));
  vi.stubEnv("CDP_API_KEY_ID", "fault-test-key-id");
  vi.stubEnv("CDP_API_KEY_SECRET", FAKE_CDP_SECRET);
  calls.verify = 0; calls.settle = 0; calls.other = [];
  resetPremiumFacilitatorForTests();
  resetPremiumNoncesForTests();
  // Stubbed facilitator: the real HTTPFacilitatorClient POSTs here; nothing leaves the process.
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (/\/verify$/.test(u)) { calls.verify++; return new Response(JSON.stringify({ isValid: true, payer: buyer.address }), { status: 200, headers: { "content-type": "application/json" } }); }
    if (/\/settle$/.test(u)) {
      calls.settle++;
      if (settleMode === "abort") { const e = new Error("The operation was aborted due to timeout"); e.name = "TimeoutError"; throw e; }
      return new Response(JSON.stringify({ error: "internal" }), { status: 500, headers: { "content-type": "application/json" } });
    }
    // pre-verify used-nonce check (USDC authorizationState): stubbed RPC says unused
    if (typeof init?.body === "string" && init.body.includes("eth_call") && init.body.includes("0xe94a0102")) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + "0".repeat(64) }), { status: 200, headers: { "content-type": "application/json" } });
    }
    calls.other.push(u);
    throw new Error(`unexpected fetch in fault test: ${u}`);
  }));
  store = new MemoryPremiumStore();
  setPremiumStoreForTests(store);
  setSellerDdClockForTests(() => NOW);
  setSellerDdDepsForTests({
    net: {
      get402: async () => ({ ok: true, status: 402, headers: { "content-type": "application/json" }, body: JSON.stringify({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", asset: USDC_BASE, amount: "1000", payTo: SELLER_PAYTO, extra: { name: "USD Coin", version: "2" } }] }), truncated: false, ip: "93.184.216.34", fetched_at: "t" }),
      getPaid: async () => ({ ok: true, status: 200, headers: { "content-type": "application/json" }, body: "{}", truncated: false, ip: "93.184.216.34", fetched_at: "t" }),
    },
    continuity: { lookup: async () => ({ payTo: SELLER_PAYTO, source_url: "https://api.cdp.coinbase.com/x", fetched_at: "t" }) },
    history: async () => ({ window_blocks: 1, window_days: 0, unique_payers: 1, repeat_payers: 0, first_seen_block: 1, volume_usdc: "0.001", from_block: 1, to_block: 2, source: "x" }),
    landed: async () => ({ state: "used", nodes: ["a", "b"] }),
    authTx: async () => null,
    sleep: async () => undefined,
  });
});
afterEach(() => {
  resetSettleFailureLatchForTests(); setSellerDdBuyerNonceForTests(null); vi.unstubAllEnvs(); vi.unstubAllGlobals();
  setPremiumStoreForTests(undefined); setSellerDdDepsForTests(null); setSellerDdClockForTests(null); resetPremiumFacilitatorForTests();
});

describe("seller-dd redeem path under a failing facilitator settle (real payment code)", () => {
  for (const mode of ["http500", "abort"] as const) {
    it(`settle ${mode} -> settle_unconfirmed, counter +1, redeem delivers once, no double charge`, async () => {
      settleMode = mode;
      const pay = await paymentHeader();
      const body = { resource: "https://seller.example.com/api" };
      expect(await store.get(ddKeys.settleFail(NOW))).toBeNull();

      const r1 = await post(body, pay);
      const b1 = await r1.json();
      expect(r1.status).toBe(mode === "abort" ? 504 : 502);
      expect(b1).toMatchObject({ status: "settle_unconfirmed", charged: "unknown", reason: mode === "abort" ? "buyer_settle_timeout" : "buyer_settle_ambiguous" });
      expect(typeof b1.reconcile_id).toBe("string");
      expect(calls.verify).toBe(1);
      expect(calls.settle).toBe(1);
      expect(Number(await store.get(ddKeys.settleFail(NOW)))).toBe(1); // counter incremented exactly once

      // resend without proof: refused, never re-settled
      expect((await post(body, pay)).status).toBe(409);
      expect(calls.settle).toBe(1);

      // the authorization landed on-chain after all -> redeem with payer proof
      setSellerDdBuyerNonceForTests(async () => "used");
      const proof = await buyer.signMessage({ message: b1.redeem_message });
      const r2 = await post(body, pay, proof);
      const b2 = await r2.json();
      expect(r2.status).toBe(200);
      expect(b2).toMatchObject({ status: "delivered", charged: true, redeemed: true });
      const { sig, status, charged, redeemed, ...verdict } = b2;
      expect(verifyReceipt("seller-dd", verdict, sig, receiptPublicKeys()!.keys[0]!.x)).toBe(true);

      // second redeem: nothing left to redeem, still no settle
      const r3 = await post(body, pay, proof);
      expect(r3.status).toBe(409);
      expect(calls.settle).toBe(1); // no double charge: exactly one settle attempt for this authorization, ever
      expect(calls.verify).toBe(1);
      expect(Number(await store.get(ddKeys.settleFail(NOW)))).toBe(1); // redeem does not touch the counter
      expect(await store.get(ddKeys.lossUsd(NOW))).toBeNull();
      expect(calls.other).toEqual([]);
    });
  }
});
