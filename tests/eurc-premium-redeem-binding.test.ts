/**
 * Sentinel LOW-1 (10/24, cfcfb3d review): a $1 brief EURC redeem is bound to the asset + amount stored in the claim at
 * pay time, not to today's EURC flag or rate (as Seller DD binds to its verdict cache).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as eurcCfg from "@/lib/eurc-config";
import { EURC_BASE } from "@/lib/eurc-config";
import { PREMIUM_TIERS } from "@/lib/premium/tiers";
import { EURC_BASE_DOMAIN, acceptsFor, assetContractFor, decodePayment, paidRail, priceBindingError } from "@/lib/premium/payment";
import { claimKey, type Claim } from "@/lib/premium/claim";
import { MemoryPremiumStore, setPremiumStoreForTests } from "@/lib/premium/store";
import { storedBindingError, storedRedeemBinding } from "@/lib/premium/handler";

const brief = PREMIUM_TIERS.find((t) => t.id === "brief")!;
const FRESH = new Date("2026-10-24T14:00:00Z");
const TYPES = { TransferWithAuthorization: [
  { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] } as const;

async function signed(req: { asset: string; amount: string; payTo: string } & Record<string, unknown>, domain: object) {
  const acct = privateKeyToAccount(generatePrivateKey());
  const nonce = `0x${"cd".repeat(32)}` as `0x${string}`;
  const msg = { from: acct.address, to: req.payTo as `0x${string}`, value: BigInt(req.amount), validAfter: 0n, validBefore: 9_999_999_999n, nonce };
  const signature = await acct.signTypedData({ domain: domain as never, types: TYPES, primaryType: "TransferWithAuthorization", message: msg });
  const h = encodePaymentSignatureHeader({ x402Version: 2, accepted: req, payload: { signature, authorization: { ...msg, value: String(req.amount), validAfter: "0", validBefore: "9999999999" } } } as never);
  return decodePayment(h)!;
}

let store: MemoryPremiumStore;
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(FRESH); vi.stubEnv("HP_EURC_ENABLED", "true"); store = new MemoryPremiumStore(); setPremiumStoreForTests(store); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); setPremiumStoreForTests(null); });

async function payAndStoreUnconfirmed() {
  const d = await signed(acceptsFor(brief)[1] as never, EURC_BASE_DOMAIN);
  expect(paidRail(d, brief)).toBe("eurc");
  expect(priceBindingError(d, brief)).toBeNull();
  const c: Claim = { s: "unconfirmed", o: "o", rq: "rq", at: Date.now(), rc: "rc_1", tier: "brief", pa: assetContractFor(d).toLowerCase(), pv: d.value! };
  await store.set(claimKey(d.from!, d.nonce!), JSON.stringify(c), 3600);
  return d;
}

describe("brief EURC redeem binds to the stored claim", () => {
  it("flag off after the claim: today's rail check would refuse, the stored binding still matches", async () => {
    const d = await payAndStoreUnconfirmed();
    vi.stubEnv("HP_EURC_ENABLED", "false");
    expect(paidRail(d, brief)).toBeNull(); // the old path: rail_unavailable
    const b = await storedRedeemBinding(brief, d);
    expect(b).toEqual({ pa: EURC_BASE.toLowerCase(), pv: d.value });
    expect(storedBindingError(d, b!)).toBeNull();
  });
  it("rate updated after the claim: today's price binding would refuse, the stored binding still matches", async () => {
    const d = await payAndStoreUnconfirmed();
    vi.spyOn(eurcCfg, "eurcAtomicFromUsdAtomic").mockReturnValue("880000");
    expect(priceBindingError(d, brief)).toBe("amount_mismatch"); // the old path
    const b = await storedRedeemBinding(brief, d);
    expect(storedBindingError(d, b!)).toBeNull();
  });
  it("stored binding still refuses a different asset, amount or payTo", async () => {
    const d = await payAndStoreUnconfirmed();
    const b = (await storedRedeemBinding(brief, d))!;
    expect(storedBindingError({ ...d, asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }, b)).toBe("rail_unavailable");
    expect(storedBindingError({ ...d, amount: "1", value: "1" }, b)).toBe("amount_mismatch");
    expect(storedBindingError({ ...d, payTo: `0x${"11".repeat(20)}` }, b)).toBe("payto_mismatch");
  });
  it("no stored binding for a non-unconfirmed claim, another tier, or a pre-LOW-1 claim without pa/pv", async () => {
    const d = await payAndStoreUnconfirmed();
    const k = claimKey(d.from!, d.nonce!);
    const ext = PREMIUM_TIERS.find((t) => t.id !== "brief" && t.mode === "sync");
    if (ext) expect(await storedRedeemBinding(ext, d)).toBeNull();
    await store.set(k, JSON.stringify({ s: "unconfirmed", o: "o", rq: "rq", at: Date.now(), rc: "rc_1", tier: "brief" }), 3600);
    expect(await storedRedeemBinding(brief, d)).toBeNull();
    await store.set(k, JSON.stringify({ s: "inflight", o: "o", rq: "rq", at: Date.now(), tier: "brief", pa: "x", pv: "1" }), 3600);
    expect(await storedRedeemBinding(brief, d)).toBeNull();
  });
});
