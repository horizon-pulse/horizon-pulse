/**
 * Runtime configuration, read once from the environment.
 *
 * Safety defaults: no key means the server never pays (it only quotes the
 * 402 challenge). With a key it pays only Horizon Pulse's published payTo, in
 * USDC on Base, and never more than HP_MAX_USD_PER_CALL per call or
 * HP_MAX_USD_TOTAL per server process.
 */

/**
 * Horizon Pulse treasury (payTo) as published on https://horizonpulse.dev/llms.txt.
 * Hardcoded on purpose: there is no environment override, so this server can only
 * ever pay this address. A payTo change ships as a new release of this package.
 */
export const EXPECTED_PAY_TO = "0x5b32c973596078a967562ca652761404f19be0e9";
/** USDC on Base mainnet. */
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
/** Base mainnet, CAIP-2. */
export const BASE_CAIP2 = "eip155:8453";

export const DEFAULT_BASE_URL = "https://horizonpulse.dev";
/** Highest Horizon Pulse route price today is $0.04, so $0.05 covers every route with no headroom for surprises. */
export const DEFAULT_MAX_USD_PER_CALL = 0.05;
export const DEFAULT_MAX_USD_TOTAL = 1.0;

export type Config = {
  baseUrl: string;
  privateKey?: `0x${string}`;
  maxAtomicPerCall: bigint;
  maxAtomicTotal: bigint;
  expectedPayTo: string;
  dryRun: boolean;
  timeoutMs: number;
};

function usdToAtomic(name: string, raw: string | undefined, fallback: number): bigint {
  const v = raw?.trim() ? Number(raw) : fallback;
  if (!Number.isFinite(v) || v < 0) throw new Error(`${name} must be a non-negative number of US dollars (got ${JSON.stringify(raw)})`);
  return BigInt(Math.round(v * 1e6));
}

export function atomicToUsd(a: bigint | string): string {
  const n = Number(BigInt(a)) / 1e6;
  return `$${n.toFixed(6).replace(/0+$/, "").replace(/\.$/, ".00")}`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const baseUrl = (env.HP_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
  if (!/^https?:\/\//.test(baseUrl)) throw new Error("HP_BASE_URL must be an http(s) URL");

  let privateKey: `0x${string}` | undefined;
  const rawKey = env.HP_PRIVATE_KEY?.trim();
  if (rawKey) {
    const k = rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error("HP_PRIVATE_KEY must be a 32-byte hex private key (0x + 64 hex)");
    privateKey = k as `0x${string}`;
  }

  // payTo is not configurable (no HP_EXPECTED_PAY_TO); see EXPECTED_PAY_TO above.
  const expectedPayTo = EXPECTED_PAY_TO.toLowerCase();

  const timeoutSec = Number(env.HP_TIMEOUT_SECONDS?.trim() || "60");

  return {
    baseUrl,
    privateKey,
    maxAtomicPerCall: usdToAtomic("HP_MAX_USD_PER_CALL", env.HP_MAX_USD_PER_CALL, DEFAULT_MAX_USD_PER_CALL),
    maxAtomicTotal: usdToAtomic("HP_MAX_USD_TOTAL", env.HP_MAX_USD_TOTAL, DEFAULT_MAX_USD_TOTAL),
    expectedPayTo,
    dryRun: /^(1|true|yes)$/i.test(env.HP_DRY_RUN?.trim() ?? ""),
    timeoutMs: Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec * 1000 : 60_000,
  };
}
