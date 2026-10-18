import { readFileSync } from "node:fs";
import path from "node:path";
import { vi } from "vitest";
import { CDP_URL_PREFIX, CDP_SUPPORTED, installFacilitatorMock, type FacilitatorBehaviour } from "./facilitator-mock";
import { CDP_ENV } from "./capture";
import {
  PAYAI_FACILITATOR_URL,
  SOLANA_PAYTO,
  SOLANA_PAYTO_USDC_ATA,
  SPL_TOKEN_PROGRAM,
  USDC_SOLANA_MINT,
  base58Encode,
} from "@/lib/solana-config";
import { __setSolanaRpcForTests, type SolanaRpc } from "@/lib/solana-rail";

export const PINNED_PAYTO = "BjY98A6dS3GGLZdz2zHy8wK7XAwnQgNhCc66mfmBTRPz";

/**
 * PayAI's real GET /supported, recorded read-only on 2026-10-08 (multi-network;
 * the Solana-only wrapper must filter it down to v2 exact on Solana mainnet).
 */
export const PAYAI_SUPPORTED = JSON.parse(
  readFileSync(path.join(__dirname, "..", "fixtures", "payai-supported.2026-10-08.json"), "utf8"),
);

/** PayAI's mainnet Solana fee payer as listed in the recorded /supported. */
export const PAYAI_FEE_PAYER: string = PAYAI_SUPPORTED.kinds.find(
  (k: { x402Version: number; scheme: string; network: string }) =>
    k.x402Version === 2 && k.scheme === "exact" && k.network === "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
).extra.feePayer;

/**
 * Syntactically valid 32-byte base58 strings from a filler byte. NOT wallets:
 * no key pair exists for them, nothing is generated, funded, or sent anywhere.
 */
export function fillerPubkey(fill: number): string {
  return base58Encode(new Uint8Array(32).fill(fill));
}
export const SOL_PAYER = fillerPubkey(9);

/**
 * Odin 1:39 N2: a wire-shaped Solana tx our preflight can PARSE (not signed for real, not valid on-chain):
 * [2 sigs][fee-payer slot][buyer slot][legacy message: header 2/0/1, 4 filler keys (keys[1], the buyer, is NOT SOL_PAYER: PayAI-reported data stays distinguishable), filler].
 * The message is `msgLen` bytes; `tag` makes the message (and so the replay key) unique.
 */
export function parseableSolanaTx(tag: number, opts: { feeFill?: number; buyerFill?: number; msgLen?: number } = {}): string {
  const { feeFill = 0, buyerFill = 0xaa, msgLen = 220 } = opts;
  const head = Buffer.concat([Buffer.from([2, 0, 1, 4]), Buffer.alloc(32, 0x31), Buffer.alloc(32, 0x32), Buffer.alloc(32, 0x33), Buffer.alloc(32, 0x34)]);
  const msg = Buffer.concat([head, Buffer.alloc(Math.max(0, msgLen - head.length), tag)]);
  return Buffer.concat([Buffer.from([2]), Buffer.alloc(64, feeFill), Buffer.alloc(64, buyerFill), msg]).toString("base64");
}

/** The jsonParsed getAccountInfo value of an initialized USDC token account owned by payTo. */
export const ATA_ACCOUNT_VALUE = {
  owner: SPL_TOKEN_PROGRAM,
  lamports: 2039280,
  executable: false,
  rentEpoch: 0,
  space: 165,
  data: {
    program: "spl-token",
    space: 165,
    parsed: {
      type: "account",
      info: {
        mint: USDC_SOLANA_MINT,
        owner: SOLANA_PAYTO,
        state: "initialized",
        isNative: false,
        tokenAmount: { amount: "0", decimals: 6, uiAmount: 0, uiAmountString: "0" },
      },
    },
  },
};

/** Default request-start slot answered by getSlot in tests. */
export const DEFAULT_START_SLOT = 300_000_000;

export type AtaMode = "present" | "absent" | "error" | (() => unknown);
export type RpcCall = { url: string; method: string; account: unknown; opts?: unknown };

/** Read-only RPC stub for the token-account guard (+ allowance receipt count). Records every call. */
export function installRpc(
  mode: AtaMode = "present",
  receipts: number | (() => unknown) = 0,
  /** getTransaction result for a settled signature (default: confirmed "now"). */
  getTransaction: (signature: string, opts?: Record<string, unknown>) => unknown = () => ({ slot: 1, blockTime: Math.floor(Date.now() / 1000), meta: { err: null } }),
  /** getSlot (request-start chain slot). Default: a healthy node answers (Odin 1:19: no start slot = 503 before PayAI). */
  getSlot: () => unknown = () => DEFAULT_START_SLOT,
): RpcCall[] {
  const calls: RpcCall[] = [];
  let current: AtaMode = mode;
  const fn: SolanaRpc = async (url, method, params) => {
    calls.push({ url, method, account: params[0], opts: params[1] });
    if (method === "getSlot") return getSlot();
    if (method === "getTransaction") return getTransaction(String(params[0]), params[1] as Record<string, unknown>);
    if (method === "getSignaturesForAddress" && params[0] === SOLANA_PAYTO_USDC_ATA) {
      if (typeof receipts === "function") return receipts();
      return Array.from({ length: receipts }, (_, i) => ({ signature: `sig${i}`, slot: i, err: null }));
    }
    if (method !== "getAccountInfo" || params[0] !== SOLANA_PAYTO_USDC_ATA) throw new Error(`unexpected RPC ${method}`);
    if (typeof current === "function") return current();
    if (current === "error") throw new Error("RPC unreachable");
    return { context: { slot: 1 }, value: current === "present" ? ATA_ACCOUNT_VALUE : null };
  };
  __setSolanaRpcForTests(fn);
  (calls as RpcCall[] & { set?: (m: AtaMode) => void }).set = (m: AtaMode) => {
    current = m;
  };
  return calls;
}

export function setAtaMode(calls: RpcCall[], m: AtaMode) {
  (calls as RpcCall[] & { set: (m: AtaMode) => void }).set(m);
}

/** Only the token-account (getAccountInfo) calls. */
export const ataCalls = (calls: RpcCall[]) => calls.filter((c) => c.method === "getAccountInfo");

/** Trigger the stale-while-revalidate refreshes (token account + rail) and wait for them. */
export async function revalidateSolana(): Promise<void> {
  const { getSolanaRailConfig } = await import("@/lib/solana-config");
  const { getSolanaAccept, __flushSolanaBackgroundForTests } = await import("@/lib/solana-rail");
  const c = getSolanaRailConfig();
  if (c.enabled) await getSolanaAccept(c.config, "5000");
  await __flushSolanaBackgroundForTests();
  if (c.enabled) await getSolanaAccept(c.config, "5000");
  await __flushSolanaBackgroundForTests();
}

export function stubSolanaOn(extra: Record<string, string> = {}, cdp = true, ata: AtaMode = "present"): RpcCall[] {
  const calls = installRpc(ata);
  vi.unstubAllEnvs();
  vi.stubEnv("HP_SOLANA_ENABLED", "true");
  vi.stubEnv("HP_SOLANA_PAYTO", SOLANA_PAYTO);
  for (const [k, v] of Object.entries(extra)) vi.stubEnv(k, v);
  setCdp(cdp);
  return calls;
}

export function setCdp(on: boolean) {
  vi.stubEnv("CDP_API_KEY_ID", on ? CDP_ENV.CDP_API_KEY_ID : "");
  vi.stubEnv("CDP_API_KEY_SECRET", on ? CDP_ENV.CDP_API_KEY_SECRET : "");
}

/** CDP answers as usual; PayAI answers with its recorded /supported (override per test). */
export function installBothFacilitators(overrides: FacilitatorBehaviour = {}) {
  return installFacilitatorMock({
    supported: (url) => {
      if (url.startsWith(CDP_URL_PREFIX)) return CDP_SUPPORTED;
      if (url !== PAYAI_FACILITATOR_URL) throw new Error(`unexpected facilitator ${url}`);
      if (overrides.supported) return overrides.supported(url);
      return PAYAI_SUPPORTED;
    },
    verify: overrides.verify,
    settle: overrides.settle,
  });
}
