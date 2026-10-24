/**
 * EURC on Base for the $1 verified brief and Seller DD ($5), feat/eurc-premium-dd.
 * Offer gating (flag + Base mainnet + fresh rate), parsed-asset routing of price binding / verify / settle,
 * per-token used-payment check, EIP-712 domain per token, unconfirmed-settle recovery per token, DD cache + cron.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { DEFAULT_PAY_TO, USDC_BASE } from "@/lib/config";
import { EURC_BASE, eurcAtomicFromUsdAtomic } from "@/lib/eurc-config";
import { PREMIUM_TIERS } from "@/lib/premium/tiers";
import {
  EURC_BASE_DOMAIN, USDC_BASE_DOMAIN, acceptsFor, assetContractFor, decodePayment, nonceUsed, paidRail, paymentRequired,
  premiumEurcOn, priceBindingError, requirementFor, requirementForPaid, setPremiumRpcForTests, settlePayment, signatureValid, verifyPayment,
} from "@/lib/premium/payment";
import { settleLanded, setJobRpcForTests } from "@/lib/premium/jobs";
import { DD_TIER } from "@/lib/seller-dd/config";
import { buyerNonceState, ddPaymentRequired, ddRequirement, reconcileUnconfirmed, setSellerDdBuyerNonceForTests } from "@/lib/seller-dd/handler";
import { ddKeys } from "@/lib/seller-dd/caps";
import { MemoryPremiumStore } from "@/lib/premium/store";
import { buildPaidSettleRecord } from "@/lib/route-log";

const brief = PREMIUM_TIERS.find((t) => t.id === "brief")!;
const others = PREMIUM_TIERS.filter((t) => t.id !== "brief");
const FRESH = new Date("2026-10-24T14:00:00Z");
const TYPES = { TransferWithAuthorization: [
  { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] } as const;

async function signed(req: { asset: string; amount: string; payTo: string } & Record<string, unknown>, domain: object, value = req.amount) {
  const acct = privateKeyToAccount(generatePrivateKey());
  const nonce = `0x${"ab".repeat(32)}` as `0x${string}`;
  const msg = { from: acct.address, to: req.payTo as `0x${string}`, value: BigInt(value), validAfter: 0n, validBefore: 9_999_999_999n, nonce };
  const signature = await acct.signTypedData({ domain: domain as never, types: TYPES, primaryType: "TransferWithAuthorization", message: msg });
  const h = encodePaymentSignatureHeader({ x402Version: 2, accepted: req, payload: { signature, authorization: { ...msg, value: String(value), validAfter: "0", validBefore: "9999999999" } } } as never);
  return decodePayment(h)!;
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(FRESH); vi.stubEnv("HP_EURC_ENABLED", "true"); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); setPremiumRpcForTests(null); setJobRpcForTests(null); setSellerDdBuyerNonceForTests(null); });

describe("offer gating", () => {
  it("flag on + fresh rate: brief and DD get [USDC unchanged, EURC]; other tiers USDC only", () => {
    const b = paymentRequired(brief, "x").accepts;
    expect(b).toHaveLength(2);
    expect(b[0]).toEqual(requirementFor(brief));
    expect(b[1]).toMatchObject({ scheme: "exact", network: "eip155:8453", asset: EURC_BASE, payTo: DEFAULT_PAY_TO, amount: eurcAtomicFromUsdAtomic("1000000"), maxTimeoutSeconds: 300 });
    expect(b[1].extra).toMatchObject({ name: "EURC", version: "2" });
    const dd = ddPaymentRequired().accepts;
    expect(dd[0]).toEqual(ddRequirement());
    expect(dd[1]).toMatchObject({ asset: EURC_BASE, payTo: DEFAULT_PAY_TO, amount: eurcAtomicFromUsdAtomic("5000000") });
    for (const t of others) expect(paymentRequired(t, "x").accepts, t.id).toEqual([requirementFor(t)]);
  });
  for (const [name, setup] of [
    ["flag unset", () => vi.stubEnv("HP_EURC_ENABLED", "")],
    ["flag look-alike TRUE", () => vi.stubEnv("HP_EURC_ENABLED", "TRUE")],
    ["rate stale (>14 days)", () => vi.setSystemTime(new Date("2026-11-08T12:00:00Z"))],
    ["rate in the future", () => vi.setSystemTime(new Date("2026-10-20T12:00:00Z"))],
  ] as const) {
    it(`${name}: brief and DD are USDC-only, byte-identical`, () => {
      setup();
      expect(premiumEurcOn(brief)).toBe(false);
      expect(JSON.stringify(paymentRequired(brief, "x").accepts)).toBe(JSON.stringify([requirementFor(brief)]));
      expect(JSON.stringify(ddPaymentRequired().accepts)).toBe(JSON.stringify([ddRequirement()]));
      expect(acceptsFor(DD_TIER)).toHaveLength(1);
    });
  }
});

describe("rail classification + price binding + signing domain", () => {
  it("EURC payment: rail eurc on brief/DD, null on other tiers and with the flag off", async () => {
    const d = await signed(acceptsFor(brief)[1] as never, EURC_BASE_DOMAIN);
    expect(paidRail(d, brief)).toBe("eurc");
    expect(paidRail(d, DD_TIER)).toBe("eurc");
    for (const t of others) expect(paidRail(d, t)).toBeNull();
    vi.stubEnv("HP_EURC_ENABLED", "false");
    expect(paidRail(d, brief)).toBeNull();
  });
  it("amount bound to the PAID asset's requirement", async () => {
    const e = acceptsFor(brief)[1] as { amount: string };
    expect(priceBindingError(await signed(e as never, EURC_BASE_DOMAIN), brief)).toBeNull();
    // EURC asset paying the USDC atomic amount is refused
    expect(priceBindingError(await signed({ ...(e as object), amount: "1000000" } as never, EURC_BASE_DOMAIN), brief)).toBe("amount_mismatch");
    // USDC unchanged
    expect(priceBindingError(await signed(requirementFor(brief) as never, USDC_BASE_DOMAIN), brief)).toBeNull();
  });
  it("signature recovers only under the paid token's EIP-712 domain", async () => {
    const e = acceptsFor(DD_TIER)[1] as never;
    expect(EURC_BASE_DOMAIN).toMatchObject({ name: "EURC", version: "2", chainId: 8453, verifyingContract: EURC_BASE });
    expect(await signatureValid(await signed(e, EURC_BASE_DOMAIN))).toBe(true);
    expect(await signatureValid(await signed(e, USDC_BASE_DOMAIN))).toBe(false);
    expect(await signatureValid(await signed(requirementFor(brief) as never, EURC_BASE_DOMAIN))).toBe(false);
  });
});

describe("verify + settle use the paid asset", () => {
  it("EURC -> EURC requirement to the facilitator and EURC amount in the settle record; USDC unchanged", async () => {
    const seen: { op: string; req: { asset: string; amount: string } }[] = [];
    vi.spyOn(HTTPFacilitatorClient.prototype, "verify").mockImplementation(async (_p: unknown, r: unknown) => { seen.push({ op: "verify", req: r as never }); return { isValid: true, payer: "0x1" } as never; });
    vi.spyOn(HTTPFacilitatorClient.prototype, "settle").mockImplementation(async (_p: unknown, r: unknown) => { seen.push({ op: "settle", req: r as never }); return { success: true, transaction: "0x" + "12".repeat(32), network: "eip155:8453", payer: "0x1" } as never; });
    const e = await signed(acceptsFor(brief)[1] as never, EURC_BASE_DOMAIN);
    expect((await verifyPayment(e, brief)).ok).toBe(true);
    expect((await settlePayment(e, brief)).ok).toBe(true);
    const u = await signed(requirementFor(brief) as never, USDC_BASE_DOMAIN);
    await verifyPayment(u, brief); await settlePayment(u, brief);
    expect(seen.map((s) => [s.op, s.req.asset, s.req.amount])).toEqual([
      ["verify", EURC_BASE, eurcAtomicFromUsdAtomic("1000000")], ["settle", EURC_BASE, eurcAtomicFromUsdAtomic("1000000")],
      ["verify", USDC_BASE, "1000000"], ["settle", USDC_BASE, "1000000"]]);
    expect(requirementForPaid(e, brief)).toEqual(acceptsFor(brief)[1]);
  });
  it("route-log record: asset only for EURC, USDC record unchanged", () => {
    const base = { route: "/x", method: "POST", rail: "eip155:8453", amountAtomic: "1", tx: null, payer: null, now: FRESH };
    expect(buildPaidSettleRecord(base)).not.toHaveProperty("asset");
    expect(buildPaidSettleRecord({ ...base, asset: EURC_BASE }).asset).toBe(EURC_BASE);
  });
});

describe("used-payment check per token", () => {
  const rpcCapture = () => {
    const calls: { method: string; to?: string; address?: string }[] = [];
    const fetch = (async (_u: string, init: { body: string }) => {
      const b = JSON.parse(init.body); const p = b.params?.[0] ?? {};
      calls.push({ method: b.method, to: p.to, address: p.address });
      const result = b.method === "eth_call" ? "0x" + "0".repeat(63) + "1" : b.method === "eth_getLogs" ? [{}] : "0x1";
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
    }) as never;
    return { calls, deps: { fetch, now: () => Date.now() } };
  };
  it("nonceUsed reads authorizationState on the paid token; unknown token = unknown", async () => {
    const c = rpcCapture(); setPremiumRpcForTests(c.deps);
    const from = "0x" + "11".repeat(20), n1 = "0x" + "01".repeat(32), n2 = "0x" + "02".repeat(32);
    expect(await nonceUsed(from, n1, EURC_BASE)).toBe("used");
    expect(await nonceUsed(from, n2)).toBe("used");
    expect(c.calls.map((x) => x.to?.toLowerCase())).toEqual([EURC_BASE, USDC_BASE.toLowerCase()]);
    expect(await nonceUsed(from, "0x" + "03".repeat(32), "0x" + "99".repeat(20))).toBe("unknown");
  });
  it("assetContractFor maps by parsed asset", () => {
    expect(assetContractFor({ asset: EURC_BASE.toUpperCase().replace("0X", "0x") })).toBe(EURC_BASE);
    expect(assetContractFor({ asset: USDC_BASE })).toBe(USDC_BASE);
    expect(assetContractFor({ asset: "" })).toBe(USDC_BASE);
  });
});

describe("unconfirmed-settle recovery", () => {
  it("premium settleLanded checks state AND AuthorizationUsed logs on the paid token", async () => {
    const calls: { method: string; to?: string; address?: string }[] = [];
    const deps = { now: () => Date.now(), fetch: (async (_u: string, init: { body: string }) => {
      const b = JSON.parse(init.body); const p = b.params?.[0] ?? {}; calls.push({ method: b.method, to: p.to, address: p.address });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: b.method === "eth_call" ? "0x" + "0".repeat(63) + "1" : [{}] }), { status: 200 });
    }) as never };
    setPremiumRpcForTests(deps); setJobRpcForTests(deps);
    const job = { payer: "0x" + "22".repeat(20), nonce: "0x" + "0a".repeat(32), block_at_accept: 100 } as never;
    expect(await settleLanded(job, EURC_BASE)).toBe("landed");
    const e = calls.filter((c) => c.method === "eth_call" || c.method === "eth_getLogs").map((c) => (c.to ?? c.address)!.toLowerCase());
    expect(e.length).toBeGreaterThanOrEqual(2);
    expect(new Set(e)).toEqual(new Set([EURC_BASE]));
  });
  it("DD redeem/cron: token taken from OUR verdict cache (EURC) or USDC when absent", async () => {
    const store = new MemoryPremiumStore();
    const seen: [string, string | undefined][] = [];
    setSellerDdBuyerNonceForTests(async (_f, n, t) => { seen.push([n, t]); return "unknown"; });
    const from = "0x" + "33".repeat(20);
    const nE = "0x" + "e1".repeat(32), nU = "0x" + "d1".repeat(32);
    const ckE = `claim:${from}:${nE}`, ckU = `claim:${from}:${nU}`;
    await store.set(ddKeys.verdict(ckE), JSON.stringify({ rq: "r", from, verdict: {}, reservation: null, validBefore: 1, asset: EURC_BASE }), 600);
    await store.set(ddKeys.verdict(ckU), JSON.stringify({ rq: "r", from, verdict: {}, reservation: null, validBefore: 1 }), 600);
    const past = Math.floor(Date.now() / 1000) - 100;
    await store.zadd(ddKeys.unconfirmed(), past, ckE, 600);
    await store.zadd(ddKeys.unconfirmed(), past, ckU, 600);
    const r = await reconcileUnconfirmed(store, Date.now());
    expect(r.checked).toBe(2);
    expect(Object.fromEntries(seen)).toEqual({ [nE]: EURC_BASE, [nU]: undefined });
    setSellerDdBuyerNonceForTests(null);
    expect(typeof buyerNonceState).toBe("function");
  });
});
