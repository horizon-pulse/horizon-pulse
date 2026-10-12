/**
 * XRPL flag-off byte-identity: with the XRPL rail off (HP_XRPL_ENABLED unset,
 * or anything other than exactly "true" together with HP_XRPL_PAYTO equal to
 * the pinned payout address and a valid network/facilitator/RPC config),
 * every 402 / OPTIONS / discovery surface must be byte-identical to main.
 *
 * Same golden as tests/x402-flag-off.test.ts (generated on clean main
 * fc7e5f6 before any rail code existed, and unchanged by the Solana rail).
 * Also proves the lazy load: with the flag off, @x402/xrpl is never loaded,
 * and neither an XRPL facilitator nor the XRPL RPC is ever contacted.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFacilitatorMock } from "./helpers/facilitator-mock";
import { CDP_ENV, captureDiscovery, captureRoutes } from "./helpers/capture";
import { __loadRealXrplModulesForTests, __setXrplModuleLoaderForTests, resetXrplRailForTests } from "@/lib/xrpl-rail";
import { PINNED_XRPL_PAYTO as PINNED, T54_MAINNET, fillerAddress, installXrplFacilitators, installXrplRpc } from "./helpers/xrpl-env";

const GOLDEN = path.join(__dirname, "fixtures", "x402-flag-off.golden.json");
const ROOT = path.resolve(__dirname, "..");

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

const ON = { HP_XRPL_ENABLED: "true", HP_XRPL_PAYTO: PINNED };

/** Env variants that must all be treated as flag OFF. */
const OFF_VARIANTS: Record<string, Record<string, string>> = {
  "unset": {},
  "payTo set, flag unset": { HP_XRPL_PAYTO: PINNED },
  "flag=TRUE (case)": { ...ON, HP_XRPL_ENABLED: "TRUE" },
  "flag=1": { ...ON, HP_XRPL_ENABLED: "1" },
  "flag=' true' (whitespace)": { ...ON, HP_XRPL_ENABLED: " true" },
  "flag=false": { ...ON, HP_XRPL_ENABLED: "false" },
  "flag=true, payTo missing": { HP_XRPL_ENABLED: "true" },
  "flag=true, payTo empty": { ...ON, HP_XRPL_PAYTO: "" },
  "flag=true, payTo one char edited": { ...ON, HP_XRPL_PAYTO: PINNED.slice(0, -1) + "d" },
  "flag=true, payTo truncated": { ...ON, HP_XRPL_PAYTO: PINNED.slice(0, -1) },
  "flag=true, payTo lower-cased": { ...ON, HP_XRPL_PAYTO: PINNED.toLowerCase() },
  "flag=true, payTo with trailing space": { ...ON, HP_XRPL_PAYTO: `${PINNED} ` },
  "flag=true, payTo another valid classic address": { ...ON, HP_XRPL_PAYTO: fillerAddress(7) },
  "flag=true, payTo is the RLUSD issuer": { ...ON, HP_XRPL_PAYTO: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De" },
  "flag=true, payTo is the Base EVM payTo": { ...ON, HP_XRPL_PAYTO: "0x5b32c973596078a967562ca652761404f19be0e9" },
  "flag=true, network devnet xrpl:2": { ...ON, HP_XRPL_NETWORK: "xrpl:2" },
  "flag=true, network 'mainnet' (not CAIP-2)": { ...ON, HP_XRPL_NETWORK: "mainnet" },
  "flag=true, mainnet without facilitator URL": { ...ON, HP_XRPL_NETWORK: "xrpl:0" },
  "flag=true, mainnet with the testnet x402.org facilitator": { ...ON, HP_XRPL_NETWORK: "xrpl:0", HP_XRPL_FACILITATOR_URL: "https://x402.org/facilitator" },
  "flag=true, facilitator not allow-listed": { ...ON, HP_XRPL_FACILITATOR_URL: "https://evil.example/facilitator" },
  "flag=true, facilitator http": { ...ON, HP_XRPL_FACILITATOR_URL: "http://x402.org/facilitator" },
  "flag=true, testnet with the t54 MAINNET facilitator": { ...ON, HP_XRPL_FACILITATOR_URL: T54_MAINNET },
  "flag=true, RPC not allow-listed": { ...ON, HP_XRPL_RPC_URL: "https://rpc.example.com/" },
  "flag=true, RPC mainnet host on testnet": { ...ON, HP_XRPL_RPC_URL: "https://xrplcluster.com/" },
  "flag=true, transfer method garbage": { ...ON, HP_XRPL_ASSET_TRANSFER_METHOD: "upfront" },
};

describe("XRPL flag off: byte-identical to main", () => {
  let loads = 0;
  beforeEach(() => {
    resetXrplRailForTests();
    loads = 0;
    __setXrplModuleLoaderForTests(async () => {
      loads++;
      return __loadRealXrplModulesForTests();
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    __setXrplModuleLoaderForTests(null);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  for (const [name, env] of Object.entries(OFF_VARIANTS)) {
    it(`env ${name}`, async () => {
      // Only CDP is answered: any XRPL facilitator call would throw and be recorded.
      const calls = installFacilitatorMock();
      const rpc = installXrplRpc("ready");
      const golden = readFileSync(GOLDEN, "utf8");
      const all = await captureWith(env);
      expect(JSON.stringify(all, null, 1) + "\n").toBe(golden);
      expect(calls.every((c) => c.url.startsWith("https://api.cdp.coinbase.com/"))).toBe(true);
      expect(rpc).toEqual([]);
      expect(loads).toBe(0);
    });
  }

  it("flag ON but payTo NOT activated (today's reality): still byte-identical to main, entry hidden", async () => {
    installXrplFacilitators();
    const rpc = installXrplRpc("unactivated");
    const golden = readFileSync(GOLDEN, "utf8");
    const all = await captureWith(ON);
    expect(JSON.stringify(all, null, 1) + "\n").toBe(golden);
    expect(rpc.some((c) => c.method === "account_info")).toBe(true);
  });

  it("lazy load: no static import of @x402/xrpl / xrpl outside the dynamic import in lib/xrpl-rail.ts", () => {
    const staticImport = /^\s*import\s+(?!type\b)[^;]*from\s+["'](?:@x402\/xrpl[^"']*|xrpl)["']/m;
    for (const f of ["lib/x402-server.ts", "lib/xrpl-config.ts", "lib/xrpl-rail.ts"]) {
      expect(staticImport.test(readFileSync(path.join(ROOT, f), "utf8")), f).toBe(false);
    }
    const rail = readFileSync(path.join(ROOT, "lib/xrpl-rail.ts"), "utf8");
    expect(rail).toContain('import("@x402/xrpl/exact/server")');
    expect(rail).toContain('import("@x402/xrpl")');
  });
});
