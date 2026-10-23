import { afterEach, describe, expect, it, vi } from "vitest";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { validateDiscoveryExtension } from "@x402/extensions/bazaar";

vi.mock("@/lib/route-log", async (orig) => ({ ...(await orig<typeof import("@/lib/route-log")>()), logPaidSettle: vi.fn() }));

import { requirementFor, resetPremiumFacilitatorForTests, settlePayment, withServerBazaarExtension, type Decoded } from "@/lib/premium/payment";
import { PREMIUM_TIERS } from "@/lib/premium/tiers";
import { briefBazaarExtension } from "@/lib/premium/bazaar";
import { sellerDdBazaarExtension } from "@/lib/seller-dd/bazaar";
import { DD_PATH, DD_TIER } from "@/lib/seller-dd/config";

const brief = PREMIUM_TIERS.find((x) => x.id === "brief")!;
const others = PREMIUM_TIERS.filter((x) => x.id !== "brief");
const payload = (extra: Record<string, unknown> = {}) => ({
  x402Version: 2,
  resource: { url: "https://horizonpulse.dev/x" },
  accepted: { scheme: "exact", network: "eip155:8453", amount: "1000000" },
  payload: { signature: "0xsig", authorization: { from: "0x1", to: "0x2", value: "1000000", nonce: "0x3" } },
  ...extra,
});
const dec = (raw: any): Decoded => ({ raw, scheme: "exact", network: "eip155:8453", asset: "", amount: "", payTo: "", from: "0x1", to: "0x2", value: "1", nonce: "0x3", validAfter: "0", validBefore: "9", signature: "0xsig" });

function spySettle() {
  resetPremiumFacilitatorForTests();
  return vi.spyOn(HTTPFacilitatorClient.prototype, "settle").mockResolvedValue({ success: true, transaction: "0xtx", network: "eip155:8453", payer: "0x1" } as never);
}

describe("server-side bazaar extension at settle", () => {
  afterEach(() => { vi.restoreAllMocks(); resetPremiumFacilitatorForTests(); });

  it("Seller DD: header without extensions gets sellerDdBazaarExtension, payment fields untouched", async () => {
    const s = spySettle();
    const raw = payload();
    const r = await settlePayment(dec(raw), DD_TIER, DD_PATH);
    expect(r.ok).toBe(true);
    const sent = s.mock.calls[0][0] as any;
    expect(sent.extensions.bazaar).toEqual(sellerDdBazaarExtension().bazaar);
    expect((validateDiscoveryExtension(sent.extensions.bazaar) as any).valid).toBe(true);
    expect(sent.payload).toEqual(raw.payload);
    expect(sent.accepted).toEqual(raw.accepted);
    expect(s.mock.calls[0][1]).toEqual(requirementFor(DD_TIER));
    expect((raw as any).extensions).toBeUndefined(); // no mutation
  });

  it("brief: header without extensions gets briefBazaarExtension; other extension keys are kept", async () => {
    const s = spySettle();
    await settlePayment(dec(payload({ extensions: { other: { a: 1 } } })), brief);
    const sent = s.mock.calls[0][0] as any;
    expect(sent.extensions.bazaar).toEqual(briefBazaarExtension().bazaar);
    expect(sent.extensions.other).toEqual({ a: 1 });
  });

  it("header that already has extensions.bazaar is passed through unchanged (same object)", async () => {
    for (const [tier, path] of [[DD_TIER, DD_PATH], [brief, undefined]] as const) {
      const s = spySettle();
      const raw = payload({ extensions: { bazaar: { info: { mine: true } } } });
      await settlePayment(dec(raw), tier, path);
      expect(s.mock.calls[0][0]).toBe(raw);
      vi.restoreAllMocks();
    }
  });

  it("other premium tiers are unaffected (same object, no extensions)", async () => {
    expect(others.length).toBeGreaterThan(0);
    for (const x of others) {
      const s = spySettle();
      const raw = payload();
      await settlePayment(dec(raw), x);
      expect(s.mock.calls[0][0]).toBe(raw);
      vi.restoreAllMocks();
    }
  });

  it("non-v2 or non-object payloads are passed through", () => {
    const v1 = { x402Version: 1, payload: {} };
    expect(withServerBazaarExtension(v1, brief)).toBe(v1);
    expect(withServerBazaarExtension(null, brief)).toBeNull();
  });
});
