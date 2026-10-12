/**
 * XRPL mainnet self-facilitation (branch xrpl-self-facilitate): the only
 * xrpl:0 facilitator is in-process (@x402/xrpl reference facilitator scheme).
 * Offline: the scheme is stubbed except for a module-load smoke check; nothing
 * is signed, submitted, or sent to any network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { FacilitatorTimeoutError } from "@x402/core/types";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  RLUSD_CURRENCY_HEX,
  RLUSD_MAINNET_ISSUER,
  XRPL_PAYTO,
  XRPL_SELF_FACILITATOR,
  XRPL_SELF_WS_URL,
  getXrplRailConfig,
  type XrplRailConfig,
} from "@/lib/xrpl-config";
import {
  LocalXrplFacilitatorClient,
  __setXrplFacilitatorTimeoutsForTests,
  createXrplFacilitator,
  type XrplFacilitatorScheme,
} from "@/lib/xrpl-rail";

const MAIN_ENV = {
  HP_XRPL_ENABLED: "true",
  HP_XRPL_NETWORK: "xrpl:0",
  HP_XRPL_PAYTO: XRPL_PAYTO,
  HP_XRPL_FACILITATOR_URL: XRPL_SELF_FACILITATOR,
  XRPL_MAINNET_ALLOWED: "true",
  UPSTASH_REDIS_REST_URL: "https://x.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "t",
};
const stubScheme = (over: Partial<XrplFacilitatorScheme> = {}): XrplFacilitatorScheme => ({
  getExtra: () => ({ areFeesSponsored: false }),
  verify: async () => ({ isValid: true, payer: "rX" }),
  settle: async () => ({ success: true, transaction: "A".repeat(64), network: "xrpl:0", payer: "rX" }),
  ...over,
});
const REQ = { scheme: "exact", network: "xrpl:0", payTo: XRPL_PAYTO, asset: RLUSD_CURRENCY_HEX, amount: "0.005", maxTimeoutSeconds: 300, extra: { issuer: RLUSD_MAINNET_ISSUER } } as PaymentRequirements;
const PAY = { x402Version: 2, accepted: REQ, payload: { signedTxBlob: "00" } } as unknown as PaymentPayload;

afterEach(() => __setXrplFacilitatorTimeoutsForTests(null));

describe("config", () => {
  it("xrpl:0 enables ONLY with self + XRPL_MAINNET_ALLOWED=true + Upstash + pinned payTo; defaults to the allow-listed RPC", () => {
    const r = getXrplRailConfig(MAIN_ENV);
    expect(r.enabled).toBe(true);
    if (r.enabled) {
      expect(r.config).toMatchObject({ network: "xrpl:0", payTo: XRPL_PAYTO, issuer: RLUSD_MAINNET_ISSUER, facilitatorUrl: "self", rpcUrl: "https://xrplcluster.com/" });
    }
    expect(getXrplRailConfig({ ...MAIN_ENV, XRPL_MAINNET_ALLOWED: "" }).enabled).toBe(false);
    expect(getXrplRailConfig({ ...MAIN_ENV, UPSTASH_REDIS_REST_TOKEN: "" }).enabled).toBe(false);
    expect(getXrplRailConfig({ ...MAIN_ENV, HP_XRPL_FACILITATOR_URL: "https://xrpl-facilitator-mainnet.t54.ai" }).enabled).toBe(false);
    expect(getXrplRailConfig({ ...MAIN_ENV, HP_XRPL_FACILITATOR_URL: "" }).enabled).toBe(false);
    expect(getXrplRailConfig({ ...MAIN_ENV, HP_XRPL_ENABLED: "" }).enabled).toBe(false);
    // "self" is not a testnet option.
    expect(getXrplRailConfig({ HP_XRPL_ENABLED: "true", HP_XRPL_PAYTO: "rs2cF8jYDp4D7Ny2SrNV21xkNJRp3HiVTJ", HP_XRPL_FACILITATOR_URL: "self" }).enabled).toBe(false);
  });
  it("testnet 'self' only with HP_XRPL_TESTNET_SELF=true (e2e switch), exact string", () => {
    const t = { HP_XRPL_ENABLED: "true", HP_XRPL_PAYTO: "rs2cF8jYDp4D7Ny2SrNV21xkNJRp3HiVTJ", HP_XRPL_FACILITATOR_URL: "self" };
    expect(getXrplRailConfig({ ...t, HP_XRPL_TESTNET_SELF: "true" })).toMatchObject({ enabled: true, config: { network: "xrpl:1", facilitatorUrl: "self" } });
    expect(getXrplRailConfig({ ...t, HP_XRPL_TESTNET_SELF: "TRUE" }).enabled).toBe(false);
    expect(getXrplRailConfig({ ...t, HP_XRPL_FACILITATOR_URL: " self", HP_XRPL_TESTNET_SELF: "true" }).enabled).toBe(false);
  });
  it("self WS uses the same allow-listed mainnet host as the RPC", () => {
    expect(new URL(XRPL_SELF_WS_URL["xrpl:0"]).hostname).toBe("xrplcluster.com");
  });
});

describe("LocalXrplFacilitatorClient", () => {
  const cfg = (getXrplRailConfig(MAIN_ENV) as { config: XrplRailConfig }).config;

  it("advertises exactly one xrpl:0 exact kind, no extensions, and passes the XRPL-only wrapper", async () => {
    const f = createXrplFacilitator(cfg, undefined, new LocalXrplFacilitatorClient("xrpl:0", stubScheme()));
    const s = await f.getSupported();
    expect(s.kinds).toEqual([{ x402Version: 2, scheme: "exact", network: "xrpl:0", extra: { areFeesSponsored: false } }]);
    expect(s.extensions).toEqual([]);
  });

  it("self config without the in-process client refuses to build", () => {
    expect(() => createXrplFacilitator(cfg)).toThrow(/in-process/);
  });

  it("wrapper still refuses non-pinned payTo before the scheme is called", async () => {
    const verify = vi.fn(async () => ({ isValid: true }));
    const f = createXrplFacilitator(cfg, undefined, new LocalXrplFacilitatorClient("xrpl:0", stubScheme({ verify })));
    await expect(f.verify(PAY, { ...REQ, payTo: "rs2cF8jYDp4D7Ny2SrNV21xkNJRp3HiVTJ" })).rejects.toThrow();
    expect(verify).not.toHaveBeenCalled();
    expect((await f.verify(PAY, REQ)).isValid).toBe(true);
  });

  it("settle throw or timeout → FacilitatorTimeoutError (classified unconfirmed, never a 402)", async () => {
    __setXrplFacilitatorTimeoutsForTests({ verifyMs: 50, settleMs: 20 });
    const hang = new LocalXrplFacilitatorClient("xrpl:0", stubScheme({ settle: () => new Promise(() => {}) }));
    await expect(hang.settle(PAY, REQ)).rejects.toBeInstanceOf(FacilitatorTimeoutError);
    const boom = new LocalXrplFacilitatorClient("xrpl:0", stubScheme({ settle: async () => { throw new Error("ws closed"); } }));
    await expect(boom.settle(PAY, REQ)).rejects.toBeInstanceOf(FacilitatorTimeoutError);
  });

  it("the real @x402/xrpl facilitator scheme loads and reports areFeesSponsored=false (no network)", async () => {
    const m = await import("@x402/xrpl/exact/facilitator");
    const s = new m.ExactXrplScheme({ wsUrlByNetwork: { "xrpl:0": XRPL_SELF_WS_URL["xrpl:0"] } });
    expect(s.getExtra("xrpl:0")).toMatchObject({ areFeesSponsored: false });
    expect(s.getSigners("xrpl:0")).toEqual([]);
  });
});
