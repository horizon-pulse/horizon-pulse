import { readFileSync } from "node:fs";
import path from "node:path";
import { vi } from "vitest";
import { CDP_URL_PREFIX, CDP_SUPPORTED, installFacilitatorMock, type FacilitatorBehaviour } from "./facilitator-mock";
import { CDP_ENV } from "./capture";
import { PAYAI_FACILITATOR_URL, SOLANA_PAYTO, base58Encode } from "@/lib/solana-config";

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

export function stubSolanaOn(extra: Record<string, string> = {}, cdp = true) {
  vi.unstubAllEnvs();
  vi.stubEnv("HP_SOLANA_ENABLED", "true");
  vi.stubEnv("HP_SOLANA_PAYTO", SOLANA_PAYTO);
  for (const [k, v] of Object.entries(extra)) vi.stubEnv(k, v);
  setCdp(cdp);
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
