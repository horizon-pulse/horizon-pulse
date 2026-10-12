import { describe, expect, it } from "vitest";
import { isValidClassicAddress } from "xrpl";
import * as pkg from "@x402/xrpl";
import {
  DEFAULT_XRPL_RPC_URL,
  RLUSD_CURRENCY_HEX,
  RLUSD_MAINNET_ISSUER,
  RLUSD_TESTNET_ISSUER,
  XRPL_FACILITATOR_ALLOWLIST,
  XRPL_MAINNET_ALLOWED,
  XRPL_PAYTO,
  XRPL_TESTNET_PAYTO,
  getXrplRailConfig,
  isValidXrplClassicAddress,
  parseXrplRpcUrl,
  usdcAtomicToRlusdValue,
} from "@/lib/xrpl-config";
import { fillerAddress } from "./helpers/xrpl-env";

const ON = { HP_XRPL_ENABLED: "true", HP_XRPL_PAYTO: "rs2cF8jYDp4D7Ny2SrNV21xkNJRp3HiVTJ" }; // testnet payTo (default xrpl:1)
const ON_MAIN = { HP_XRPL_ENABLED: "true", HP_XRPL_PAYTO: "r3FbirL83RAB2CwnUdxE5pCohMkuo6LQcf", HP_XRPL_NETWORK: "xrpl:0" };

describe("xrpl-config", () => {
  it("pinned payTo is Michael's r3Fbir… address and a valid checksummed classic address (cross-checked with xrpl.js)", () => {
    expect(XRPL_PAYTO).toBe("r3FbirL83RAB2CwnUdxE5pCohMkuo6LQcf");
    expect(isValidXrplClassicAddress(XRPL_PAYTO)).toBe(true);
    expect(isValidClassicAddress(XRPL_PAYTO)).toBe(true);
  });

  it("address validation agrees with xrpl.js on valid / edited / non-addresses", () => {
    const cases = [
      XRPL_PAYTO, RLUSD_MAINNET_ISSUER, RLUSD_TESTNET_ISSUER, fillerAddress(1), fillerAddress(200),
      XRPL_PAYTO.slice(0, -1) + "d", XRPL_PAYTO.slice(0, -1), `${XRPL_PAYTO} `, XRPL_PAYTO.toLowerCase(),
      "X7AcgcsBL6XDcUb289X4mJ8djcdyKaB5hJDWMArnXr61cqZ", "0x5b32c973596078a967562ca652761404f19be0e9", "",
    ];
    for (const a of cases) expect(isValidXrplClassicAddress(a), a).toBe(isValidClassicAddress(a) && a.startsWith("r"));
  });

  it("RLUSD constants match @x402/xrpl 2.27.0 (and the CAIP-2 ids)", () => {
    expect(pkg.RLUSD_CURRENCY).toBe(RLUSD_CURRENCY_HEX);
    expect(pkg.RLUSD_MAINNET_ISSUER).toBe(RLUSD_MAINNET_ISSUER);
    expect(pkg.RLUSD_TESTNET_ISSUER).toBe(RLUSD_TESTNET_ISSUER);
    expect(pkg.XRPL_MAINNET).toBe("xrpl:0");
    expect(pkg.XRPL_TESTNET).toBe("xrpl:1");
    expect(Buffer.from(RLUSD_CURRENCY_HEX.slice(0, 10), "hex").toString()).toBe("RLUSD");
  });

  it("price conversion: every route price maps 1:1 to an exact RLUSD decimal (no floats)", () => {
    const table: Record<string, string> = {
      "5000": "0.005", "10000": "0.01", "15000": "0.015", "20000": "0.02", "30000": "0.03", "40000": "0.04",
      "1": "0.000001", "1000000": "1", "1500000": "1.5", "123456789": "123.456789",
    };
    for (const [a, v] of Object.entries(table)) expect(usdcAtomicToRlusdValue(a)).toBe(v);
    for (const bad of ["0", "", "-5", "1.5", "05000", "abc"]) expect(() => usdcAtomicToRlusdValue(bad), bad).toThrow();
  });

  it("ON only with exactly 'true' + exactly the pinned payTo; testnet + x402.org by default", () => {
    const r = getXrplRailConfig(ON);
    expect(r).toEqual({
      enabled: true,
      config: {
        network: "xrpl:1",
        payTo: XRPL_TESTNET_PAYTO,
        asset: RLUSD_CURRENCY_HEX,
        issuer: RLUSD_TESTNET_ISSUER,
        facilitatorUrl: "https://x402.org/facilitator",
        rpcUrl: DEFAULT_XRPL_RPC_URL["xrpl:1"],
        initTimeoutMs: 2500,
      },
    });
    expect(getXrplRailConfig({}).enabled).toBe(false);
    expect(getXrplRailConfig({}) as { misconfigured: boolean }).toMatchObject({ misconfigured: false });
    expect(getXrplRailConfig({ ...ON, HP_XRPL_PAYTO: fillerAddress(7) })).toMatchObject({ enabled: false, misconfigured: true });
  });

  it("payTo always comes from the pinned constant, never from env content", () => {
    const r = getXrplRailConfig(ON);
    expect(r.enabled && r.config.payTo).toBe(XRPL_TESTNET_PAYTO);
  });

  it("mainnet is locked in code: XRPL_MAINNET_ALLOWED=false, xrpl:0 allowlist = self only, xrpl:0 OFF/misconfigured with every env set", () => {
    expect(XRPL_MAINNET_ALLOWED).toBe(false);
    expect(XRPL_FACILITATOR_ALLOWLIST["xrpl:0"]).toEqual(["self"]) // in-process self-facilitation only (branch xrpl-self-facilitate);
    expect(JSON.stringify(XRPL_FACILITATOR_ALLOWLIST)).not.toContain("mainnet.t54.ai");
    for (const fac of ["", "https://xrpl-facilitator-mainnet.t54.ai", "https://x402.org/facilitator"]) {
      const r = getXrplRailConfig({ ...ON_MAIN, HP_XRPL_FACILITATOR_URL: fac, HP_XRPL_RPC_URL: "https://xrplcluster.com/" });
      expect(r, fac).toMatchObject({ enabled: false, misconfigured: true });
    }
    expect(getXrplRailConfig({ ...ON_MAIN }) as { reason: string }).toMatchObject({ reason: expect.stringContaining("locked") });
  });

  it("network must be exactly xrpl:1 / xrpl:0", () => {
    for (const n of ["xrpl:2", "XRPL:1", "testnet", "mainnet", " xrpl:1", "xrpl:01"]) {
      expect(getXrplRailConfig({ ...ON, HP_XRPL_NETWORK: n }).enabled, n).toBe(false);
    }
    expect(getXrplRailConfig({ ...ON, HP_XRPL_NETWORK: "xrpl:1" }).enabled).toBe(true);
  });

  it("RPC override hardening: https, allow-listed host for that network, no userinfo / IP / localhost / port", () => {
    expect(parseXrplRpcUrl(" https://testnet.xrpl-labs.com ", "xrpl:1")).toEqual({ ok: true, url: "https://testnet.xrpl-labs.com/" });
    for (const bad of [
      "http://testnet.xrpl-labs.com/", "https://u:p@testnet.xrpl-labs.com/", "https://127.0.0.1/", "https://[::1]/",
      "https://localhost/", "https://testnet.xrpl-labs.com:51234/", "https://xrplcluster.com/", "https://evil.example/", "not a url",
    ]) {
      expect(parseXrplRpcUrl(bad, "xrpl:1").ok, bad).toBe(false);
    }
    expect(parseXrplRpcUrl("https://xrplcluster.com", "xrpl:0").ok).toBe(true);
  });

  it("transfer method + init timeout parsing", () => {
    const t = getXrplRailConfig({ ...ON, HP_XRPL_ASSET_TRANSFER_METHOD: "ticketSequence", HP_XRPL_INIT_TIMEOUT_MS: "900" });
    expect(t).toMatchObject({ enabled: true, config: { assetTransferMethod: "ticketSequence", initTimeoutMs: 900 } });
    expect(getXrplRailConfig({ ...ON, HP_XRPL_INIT_TIMEOUT_MS: "999999" })).toMatchObject({ config: { initTimeoutMs: 2500 } });
    expect(getXrplRailConfig({ ...ON, HP_XRPL_ASSET_TRANSFER_METHOD: "batch" }).enabled).toBe(false);
  });
});

describe("XRPL_MAINNET_ALLOWED switch (branch xrpl-mainnet-allowed)", () => {
  const MAIN = {
    HP_XRPL_ENABLED: "true",
    HP_XRPL_NETWORK: "xrpl:0",
    HP_XRPL_PAYTO: "r3FbirL83RAB2CwnUdxE5pCohMkuo6LQcf",
    HP_XRPL_FACILITATOR_URL: "https://xrpl-facilitator-mainnet.t54.ai",
    UPSTASH_REDIS_REST_URL: "https://x.upstash.io",
    UPSTASH_REDIS_REST_TOKEN: "t",
  };
  it("default (unset) and anything but exactly 'true' keep xrpl:0 locked", async () => {
    const { getXrplRailConfig, xrplMainnetAllowed } = await import("@/lib/xrpl-config");
    expect(xrplMainnetAllowed({})).toBe(false);
    for (const v of ["", "TRUE", "1", "yes", " true", "true "]) {
      expect(xrplMainnetAllowed({ XRPL_MAINNET_ALLOWED: v })).toBe(false);
      const r = getXrplRailConfig({ ...MAIN, XRPL_MAINNET_ALLOWED: v });
      expect(r.enabled).toBe(false);
      if (!r.enabled) expect(r.reason).toMatch(/locked/);
    }
    expect(getXrplRailConfig(MAIN).enabled).toBe(false);
  });
  it("'true' only lifts the lock: the other guards still refuse (empty mainnet facilitator allowlist, Upstash env)", async () => {
    const { getXrplRailConfig, xrplMainnetAllowed } = await import("@/lib/xrpl-config");
    expect(xrplMainnetAllowed({ XRPL_MAINNET_ALLOWED: "true" })).toBe(true);
    const r = getXrplRailConfig({ ...MAIN, XRPL_MAINNET_ALLOWED: "true" });
    expect(r.enabled).toBe(false);
    if (!r.enabled) expect(r.reason).toMatch(/allow-list/);
    const noKv = getXrplRailConfig({ ...MAIN, XRPL_MAINNET_ALLOWED: "true", UPSTASH_REDIS_REST_URL: "" });
    expect(noKv.enabled).toBe(false);
    if (!noKv.enabled) expect(noKv.reason).toMatch(/UPSTASH/);
    const wrongPayTo = getXrplRailConfig({ ...MAIN, XRPL_MAINNET_ALLOWED: "true", HP_XRPL_PAYTO: "rs2cF8jYDp4D7Ny2SrNV21xkNJRp3HiVTJ" });
    expect(wrongPayTo.enabled).toBe(false);
  });
});
