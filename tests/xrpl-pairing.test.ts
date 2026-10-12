/**
 * Odin fix 2: the testnet RLUSD issuer only ever goes with xrpl:1, the mainnet
 * issuer only with xrpl:0 (same for the pinned payTos). Every mix is refused
 * at config, at requirement build (assertXrplRequirement), and at the
 * facilitator wrapper (constructor + guard). Offline.
 */
import { describe, expect, it } from "vitest";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  RLUSD_CURRENCY_HEX,
  RLUSD_MAINNET_ISSUER,
  RLUSD_TESTNET_ISSUER,
  XRPL_PAYTO,
  XRPL_TESTNET_PAYTO,
  assertXrplPairing,
  getXrplRailConfig,
  isLegalXrplPairing,
  isValidXrplClassicAddress,
  rlusdIssuerFor,
  xrplPayToFor,
} from "@/lib/xrpl-config";
import { XrplOnlyFacilitatorClient, assertXrplRequirement } from "@/lib/xrpl-rail";

const T54_MAIN = "https://xrpl-facilitator-mainnet.t54.ai";
const NETS = ["xrpl:0", "xrpl:1", "xrpl:2", "xrpl:01", "XRPL:1", " xrpl:1", "", "eip155:8453"];
const ISSUERS = [RLUSD_MAINNET_ISSUER, RLUSD_TESTNET_ISSUER, "rrrrrrrrrrrrrrrrrrrrrhoLvTp", ""];
const PAYTOS = [XRPL_PAYTO, XRPL_TESTNET_PAYTO, "rrrrrrrrrrrrrrrrrrrrrhoLvTp"];

describe("XRPL network/issuer/payTo pairing", () => {
  it("constants: distinct, valid, and mapped one-to-one", () => {
    for (const a of [XRPL_PAYTO, XRPL_TESTNET_PAYTO, RLUSD_MAINNET_ISSUER, RLUSD_TESTNET_ISSUER]) expect(isValidXrplClassicAddress(a)).toBe(true);
    expect(new Set([XRPL_PAYTO, XRPL_TESTNET_PAYTO, RLUSD_MAINNET_ISSUER, RLUSD_TESTNET_ISSUER]).size).toBe(4);
    expect(rlusdIssuerFor("xrpl:0")).toBe(RLUSD_MAINNET_ISSUER);
    expect(rlusdIssuerFor("xrpl:1")).toBe(RLUSD_TESTNET_ISSUER);
    expect(xrplPayToFor("xrpl:0")).toBe(XRPL_PAYTO);
    expect(xrplPayToFor("xrpl:1")).toBe(XRPL_TESTNET_PAYTO);
    expect(() => rlusdIssuerFor("xrpl:2" as never)).toThrow();
    expect(() => xrplPayToFor("xrpl:2" as never)).toThrow();
  });

  it("exhaustive: exactly two legal (network, issuer, payTo) triples", () => {
    const legal: string[] = [];
    for (const n of NETS) for (const i of ISSUERS) for (const p of PAYTOS) {
      const ok = isLegalXrplPairing(n, i, p);
      if (ok) legal.push(`${n}|${i}|${p}`);
      if (!ok) expect(() => assertXrplPairing(n, i, p)).toThrow();
    }
    expect(legal.sort()).toEqual([`xrpl:0|${RLUSD_MAINNET_ISSUER}|${XRPL_PAYTO}`, `xrpl:1|${RLUSD_TESTNET_ISSUER}|${XRPL_TESTNET_PAYTO}`].sort());
  });

  it("config: each network only accepts its own payTo; issuer always follows the network", () => {
    const base = { HP_XRPL_ENABLED: "true" };
    // testnet payTo on mainnet, mainnet payTo on testnet → OFF
    expect(getXrplRailConfig({ ...base, HP_XRPL_PAYTO: XRPL_TESTNET_PAYTO, HP_XRPL_NETWORK: "xrpl:0", HP_XRPL_FACILITATOR_URL: T54_MAIN }).enabled).toBe(false);
    expect(getXrplRailConfig({ ...base, HP_XRPL_PAYTO: XRPL_PAYTO, HP_XRPL_NETWORK: "xrpl:1" }).enabled).toBe(false);
    expect(getXrplRailConfig({ ...base, HP_XRPL_PAYTO: XRPL_PAYTO }).enabled).toBe(false); // default net = xrpl:1
    const t = getXrplRailConfig({ ...base, HP_XRPL_PAYTO: XRPL_TESTNET_PAYTO });
    const m = getXrplRailConfig({ ...base, HP_XRPL_PAYTO: XRPL_PAYTO, HP_XRPL_NETWORK: "xrpl:0", HP_XRPL_FACILITATOR_URL: T54_MAIN });
    expect(t.enabled && [t.config.network, t.config.issuer, t.config.payTo]).toEqual(["xrpl:1", RLUSD_TESTNET_ISSUER, XRPL_TESTNET_PAYTO]);
    expect(m.enabled).toBe(false); // mainnet locked in code (XRPL_MAINNET_ALLOWED=false)
    // no env var can name an issuer
    const t2 = getXrplRailConfig({ ...base, HP_XRPL_PAYTO: XRPL_TESTNET_PAYTO, HP_XRPL_ISSUER: RLUSD_MAINNET_ISSUER } as never);
    expect(t2.enabled && t2.config.issuer).toBe(RLUSD_TESTNET_ISSUER);
  });

  it("facilitator wrapper refuses to be built for a mixed pair", () => {
    const inner = { verify: async () => ({}), settle: async () => ({}), getSupported: async () => ({}) } as never;
    expect(() => new XrplOnlyFacilitatorClient(inner, "xrpl:1", RLUSD_MAINNET_ISSUER)).toThrow();
    expect(() => new XrplOnlyFacilitatorClient(inner, "xrpl:0", RLUSD_TESTNET_ISSUER)).toThrow();
    expect(() => new XrplOnlyFacilitatorClient(inner, "xrpl:2", RLUSD_TESTNET_ISSUER)).toThrow();
    expect(new XrplOnlyFacilitatorClient(inner, "xrpl:1", RLUSD_TESTNET_ISSUER).payTo).toBe(XRPL_TESTNET_PAYTO);
    expect(new XrplOnlyFacilitatorClient(inner, "xrpl:0", RLUSD_MAINNET_ISSUER).payTo).toBe(XRPL_PAYTO);
  });

  it("facilitator wrapper refuses verify/settle for any mixed requirement", async () => {
    let calls = 0;
    const inner = { verify: async () => (calls++, { isValid: true }), settle: async () => (calls++, { success: true }), getSupported: async () => ({}) } as never;
    const c = new XrplOnlyFacilitatorClient(inner, "xrpl:1", RLUSD_TESTNET_ISSUER);
    for (const [network, issuer, payTo] of [
      ["xrpl:1", RLUSD_MAINNET_ISSUER, XRPL_TESTNET_PAYTO],
      ["xrpl:1", RLUSD_TESTNET_ISSUER, XRPL_PAYTO],
      ["xrpl:0", RLUSD_MAINNET_ISSUER, XRPL_PAYTO],
      ["xrpl:0", RLUSD_TESTNET_ISSUER, XRPL_TESTNET_PAYTO],
    ]) {
      const req = { scheme: "exact", network, payTo, asset: RLUSD_CURRENCY_HEX, amount: "0.005", maxTimeoutSeconds: 300, extra: { issuer } } as unknown as PaymentRequirements;
      const payload = { x402Version: 2, accepted: req, payload: {} } as unknown as PaymentPayload;
      await expect(c.verify(payload, req)).rejects.toThrow();
      await expect(c.settle(payload, req)).rejects.toThrow();
    }
    expect(calls).toBe(0);
  });

  it("assertXrplRequirement flags a mixed issuer even when config agrees with it", () => {
    const bad = { network: "xrpl:1", issuer: RLUSD_MAINNET_ISSUER, payTo: XRPL_TESTNET_PAYTO, asset: RLUSD_CURRENCY_HEX, facilitatorUrl: "x", rpcUrl: "x", initTimeoutMs: 1 } as never;
    const req = { scheme: "exact", network: "xrpl:1", payTo: XRPL_TESTNET_PAYTO, asset: RLUSD_CURRENCY_HEX, amount: "0.005", maxTimeoutSeconds: 300, extra: { issuer: RLUSD_MAINNET_ISSUER, areFeesSponsored: false } } as unknown as PaymentRequirements;
    expect(() => assertXrplRequirement(req, bad, "5000")).toThrow(/network\/issuer\/payTo mix/);
  });
});
