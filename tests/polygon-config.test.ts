import { describe, expect, it } from "vitest";
import { getPolygonRailConfig, POLYGON_MAINNET_ALLOWED, USDC_POLYGON, USDC_E_POLYGON_REFUSED, USDC_AMOY } from "@/lib/polygon-config";
import { buildPolygonRequirement, validatePolygonPaymentPayload } from "@/lib/polygon-rail";

const PAYTO = "0x5b32c973596078a967562ca652761404f19be0e9";
const CDP = { CDP_API_KEY_ID: "k", CDP_API_KEY_SECRET: "s" };

describe("polygon config", () => {
  it("mainnet is code-locked", () => {
    expect(POLYGON_MAINNET_ALLOWED).toBe(false);
    expect(getPolygonRailConfig({ HP_POLYGON_ENABLED: "true", HP_POLYGON_PAYTO: PAYTO, ...CDP }).enabled).toBe(false);
  });
  it("mainnet (if unlocked) pins native USDC, never USDC.e, CDP facilitator", () => {
    const r = getPolygonRailConfig({ HP_POLYGON_ENABLED: "true", HP_POLYGON_PAYTO: PAYTO, ...CDP }, true);
    expect(r.enabled).toBe(true);
    if (!r.enabled) return;
    expect(r.config).toEqual({ network: "eip155:137", asset: USDC_POLYGON, eip712: { name: "USD Coin", version: "2" }, payTo: PAYTO, facilitator: "cdp" });
    expect(r.config.asset.toLowerCase()).not.toBe(USDC_E_POLYGON_REFUSED.toLowerCase());
    expect(USDC_POLYGON).toBe("0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359");
  });
  it("mainnet (if unlocked) without CDP keys is off", () => {
    expect(getPolygonRailConfig({ HP_POLYGON_ENABLED: "true", HP_POLYGON_PAYTO: PAYTO }, true).enabled).toBe(false);
  });
  it("amoy needs the testnet flag and uses Polygon's Amoy facilitator", () => {
    const env = { HP_POLYGON_ENABLED: "true", HP_POLYGON_PAYTO: PAYTO, HP_POLYGON_NETWORK: "eip155:80002" };
    expect(getPolygonRailConfig(env).enabled).toBe(false);
    const r = getPolygonRailConfig({ ...env, HP_POLYGON_TESTNET: "true" });
    expect(r.enabled && r.config.asset).toBe(USDC_AMOY);
    expect(r.enabled && r.config.facilitator).toBe("https://x402-amoy.polygon.technology");
  });
  it("payload preflight rejects a USDC.e / other-payTo / other-amount payload", () => {
    const r = getPolygonRailConfig({ HP_POLYGON_ENABLED: "true", HP_POLYGON_PAYTO: PAYTO, ...CDP }, true);
    if (!r.enabled) throw new Error("off");
    const req = buildPolygonRequirement(r.config, "5000");
    const ok = { x402Version: 2, accepted: { ...req }, payload: {} } as never;
    expect(validatePolygonPaymentPayload(ok, req).ok).toBe(true);
    for (const bad of [{ asset: USDC_E_POLYGON_REFUSED }, { payTo: "0x" + "1".repeat(40) }, { amount: "1" }, { network: "eip155:8453" }]) {
      expect(validatePolygonPaymentPayload({ x402Version: 2, accepted: { ...req, ...bad }, payload: {} } as never, req).ok).toBe(false);
    }
  });
});
