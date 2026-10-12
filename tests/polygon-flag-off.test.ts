/**
 * Polygon flag-off byte-identity (same golden as x402-flag-off / xrpl-flag-off):
 * with the Polygon rail off (unset, malformed, or mainnet while
 * POLYGON_MAINNET_ALLOWED=false), every 402 / OPTIONS / discovery surface is
 * byte-identical to main and no non-CDP facilitator is contacted.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFacilitatorMock } from "./helpers/facilitator-mock";
import { CDP_ENV, captureDiscovery, captureRoutes } from "./helpers/capture";
import { resetPolygonRailForTests } from "@/lib/polygon-rail";

const GOLDEN = path.join(__dirname, "fixtures", "x402-flag-off.golden.json");
const PAYTO = "0x5b32c973596078a967562ca652761404f19be0e9";

async function captureWith(env: Record<string, string>) {
  vi.unstubAllEnvs();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  vi.stubEnv("CDP_API_KEY_ID", CDP_ENV.CDP_API_KEY_ID);
  vi.stubEnv("CDP_API_KEY_SECRET", CDP_ENV.CDP_API_KEY_SECRET);
  const cdp = await captureRoutes();
  vi.stubEnv("CDP_API_KEY_ID", "");
  vi.stubEnv("CDP_API_KEY_SECRET", "");
  const local = await captureRoutes();
  return { cdp, local, discovery: await captureDiscovery() };
}

const ON = { HP_POLYGON_ENABLED: "true", HP_POLYGON_PAYTO: PAYTO };
const OFF_VARIANTS: Record<string, Record<string, string>> = {
  unset: {},
  "payTo set, flag unset": { HP_POLYGON_PAYTO: PAYTO },
  "flag=TRUE": { ...ON, HP_POLYGON_ENABLED: "TRUE" },
  "flag=1": { ...ON, HP_POLYGON_ENABLED: "1" },
  "flag=' true'": { ...ON, HP_POLYGON_ENABLED: " true" },
  "mainnet (default network) while code-locked": ON,
  "mainnet explicit while code-locked": { ...ON, HP_POLYGON_NETWORK: "eip155:137" },
  "amoy without HP_POLYGON_TESTNET": { ...ON, HP_POLYGON_NETWORK: "eip155:80002" },
  "network 'polygon' (not CAIP-2)": { ...ON, HP_POLYGON_NETWORK: "polygon", HP_POLYGON_TESTNET: "true" },
  "amoy, payTo checksummed case": { ...ON, HP_POLYGON_NETWORK: "eip155:80002", HP_POLYGON_TESTNET: "true", HP_POLYGON_PAYTO: "0x5B32c973596078a967562ca652761404f19be0E9" },
  "amoy, payTo other address": { ...ON, HP_POLYGON_NETWORK: "eip155:80002", HP_POLYGON_TESTNET: "true", HP_POLYGON_PAYTO: "0x" + "1".repeat(40) },
  "amoy, payTo missing": { HP_POLYGON_ENABLED: "true", HP_POLYGON_NETWORK: "eip155:80002", HP_POLYGON_TESTNET: "true" },
};

describe("Polygon flag off: byte-identical to main", () => {
  beforeEach(() => {
    resetPolygonRailForTests();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  for (const [name, env] of Object.entries(OFF_VARIANTS)) {
    it(`env ${name}`, async () => {
      const calls = installFacilitatorMock();
      const all = await captureWith(env);
      expect(JSON.stringify(all, null, 1) + "\n").toBe(readFileSync(GOLDEN, "utf8"));
      expect(calls.every((c) => c.url.startsWith("https://api.cdp.coinbase.com/"))).toBe(true);
    });
  }
});
