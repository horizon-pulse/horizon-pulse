/**
 * Solana USDC rail (x402 `exact` on Solana mainnet, PayAI facilitator):
 * feature flag + constants. Pure and synchronous.
 *
 * This module deliberately imports nothing from @x402/svm or @solana/*, so a
 * broken/missing Solana package can never break config parsing (or anything
 * that imports this file). The runtime half lives in lib/solana-rail.ts and
 * loads the package lazily.
 *
 * The rail is ON only when ALL of these hold; anything else is OFF and every
 * route serves the exact Base-only 402 it served before this branch:
 *   - HP_SOLANA_ENABLED is exactly the string "true"
 *   - HP_SOLANA_PAYTO is exactly SOLANA_PAYTO (character for character: no
 *     trimming, no case folding, no other address; Michael 9:33 AM ET
 *     2026-10-08, matched by Odin 9:34 AM ET)
 *   - SOLANA_PAYTO decodes as a 32-byte base58 Solana public key (runtime check)
 *   - HP_SOLANA_NETWORK, if set, is exactly the Solana mainnet CAIP-2 id
 *   - HP_SOLANA_RPC_URL, if set, is an https URL (read-only RPC)
 * Even when ON, the Solana entry is only shown while the payTo's USDC token
 * account exists and PayAI's live fee payer checks out (lib/solana-rail.ts).
 *
 * Moving the payout to any other address (e.g. a treasury account) needs a
 * code change to SOLANA_PAYTO plus a fresh passphrase from Michael; the env
 * alone can only switch the rail on or off.
 *
 * See docs/solana-rail.md.
 */

/** Michael's Ledger Solana receive address. The ONLY Solana payTo. */
export const SOLANA_PAYTO = "BjY98A6dS3GGLZdz2zHy8wK7XAwnQgNhCc66mfmBTRPz" as const;

/** CAIP-2 id for Solana mainnet-beta (x402 v2 / PayAI `/supported`; = @x402/svm SOLANA_MAINNET_CAIP2). */
export const SOLANA_MAINNET_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as const;

/** Circle's native USDC mint on Solana mainnet (6 decimals, SPL Token program; = @x402/svm USDC_MAINNET_ADDRESS). */
export const USDC_SOLANA_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as const;
export const USDC_SOLANA_DECIMALS = 6 as const;

/** PayAI facilitator: allowed for the Solana rail ONLY (Bazaar + refunds stay on CDP/Base). */
export const PAYAI_FACILITATOR_URL = "https://facilitator.payai.network" as const;

/** SPL Token program (owner of the USDC mint) and the Associated Token Account program. */
export const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as const;
export const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" as const;

/**
 * The payTo's USDC associated token account (ATA(SOLANA_PAYTO, USDC_SOLANA_MINT,
 * SPL Token)): the account an x402 `exact` payment credits. Pinned here and
 * re-derived at rail init; any mismatch keeps the rail off. The Solana entry is
 * advertised ONLY while this account exists on mainnet (lib/solana-rail.ts,
 * read-only RPC, re-checked every ~10 minutes).
 */
export const SOLANA_PAYTO_USDC_ATA = "3v95wKFDYRxegtZQYYeUzNnPrhogaCs9UpaR4QD7MzZu" as const;

/** Public read-only Solana mainnet JSON-RPC (override with HP_SOLANA_RPC_URL, https only). */
export const DEFAULT_SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com" as const;

export type SolanaRailConfig = {
  network: typeof SOLANA_MAINNET_CAIP2;
  payTo: typeof SOLANA_PAYTO;
  asset: typeof USDC_SOLANA_MINT;
  facilitatorUrl: typeof PAYAI_FACILITATOR_URL;
  /** Read-only JSON-RPC used only for the token-account existence check. */
  rpcUrl: string;
  /** Max wait for PayAI during lazy init (unpaid 402 path). */
  initTimeoutMs: number;
};

export type SolanaConfigResult =
  | { enabled: true; config: SolanaRailConfig }
  | { enabled: false; reason: string; /** flag was "true" but the rest was unusable */ misconfigured: boolean };

// ---------------------------------------------------------------------------
// Solana public key validation (base58, Bitcoin alphabet, exactly 32 bytes)
// ---------------------------------------------------------------------------

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_INDEX = new Map([...B58_ALPHABET].map((c, i) => [c, i]));

/** Strict base58 decode (no whitespace, no normalisation). Null on any invalid character. */
export function base58Decode(s: string): Uint8Array | null {
  if (s.length === 0) return null;
  let n = BigInt(0);
  for (const c of s) {
    const v = B58_INDEX.get(c);
    if (v === undefined) return null;
    n = n * BigInt(58) + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > BigInt(0)) {
    bytes.unshift(Number(n % BigInt(256)));
    n /= BigInt(256);
  }
  for (const c of s) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

export function base58Encode(bytes: Uint8Array): string {
  let n = BigInt(0);
  for (const b of bytes) n = n * BigInt(256) + BigInt(b);
  let out = "";
  while (n > BigInt(0)) {
    out = B58_ALPHABET[Number(n % BigInt(58))] + out;
    n /= BigInt(58);
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

/**
 * True only for a canonical base58 string that decodes to exactly 32 bytes
 * (a Solana public key). Canonical = re-encoding the bytes gives back the
 * identical string, so no padded/edited variant passes.
 */
export function isValidSolanaPubkey(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  const bytes = base58Decode(value);
  return !!bytes && bytes.length === 32 && base58Encode(bytes) === value;
}

// ---------------------------------------------------------------------------
// Env parsing
// ---------------------------------------------------------------------------

type Env = Record<string, string | undefined>;

const DEFAULT_INIT_TIMEOUT_MS = 2500;

function off(reason: string, misconfigured: boolean): SolanaConfigResult {
  return { enabled: false, reason, misconfigured };
}

/** Never throws. */
export function getSolanaRailConfig(env: Env = process.env): SolanaConfigResult {
  try {
    if (env.HP_SOLANA_ENABLED !== "true") return off("HP_SOLANA_ENABLED is not exactly 'true'", false);

    // Pinned constant must itself be a valid 32-byte base58 pubkey (runtime check).
    if (!isValidSolanaPubkey(SOLANA_PAYTO)) return off("pinned SOLANA_PAYTO is not a valid 32-byte base58 pubkey", true);

    const payTo = env.HP_SOLANA_PAYTO;
    if (payTo === undefined || payTo === "") return off("HP_SOLANA_PAYTO is not set", true);
    // Exact, untrimmed comparison: any edit, truncation, whitespace or other address = OFF.
    if (payTo !== SOLANA_PAYTO) return off("HP_SOLANA_PAYTO does not match the pinned Solana payTo exactly", true);
    if (!isValidSolanaPubkey(payTo)) return off("HP_SOLANA_PAYTO is not a valid 32-byte base58 pubkey", true);

    const rawNet = env.HP_SOLANA_NETWORK;
    if (rawNet !== undefined && rawNet !== "" && rawNet !== SOLANA_MAINNET_CAIP2) {
      return off(`HP_SOLANA_NETWORK must be ${SOLANA_MAINNET_CAIP2} (mainnet only)`, true);
    }

    const rawRpc = env.HP_SOLANA_RPC_URL ?? "";
    let rpcUrl: string = DEFAULT_SOLANA_RPC_URL;
    if (rawRpc !== "") {
      let u: URL;
      try {
        u = new URL(rawRpc);
      } catch {
        return off("HP_SOLANA_RPC_URL is not a URL", true);
      }
      if (u.protocol !== "https:") return off("HP_SOLANA_RPC_URL must be https", true);
      rpcUrl = rawRpc;
    }

    const rawTimeout = Number((env.HP_SOLANA_INIT_TIMEOUT_MS ?? "").trim() || DEFAULT_INIT_TIMEOUT_MS);
    const initTimeoutMs =
      Number.isInteger(rawTimeout) && rawTimeout > 0 && rawTimeout <= 30_000 ? rawTimeout : DEFAULT_INIT_TIMEOUT_MS;

    return {
      enabled: true,
      config: {
        network: SOLANA_MAINNET_CAIP2,
        payTo: SOLANA_PAYTO,
        asset: USDC_SOLANA_MINT,
        facilitatorUrl: PAYAI_FACILITATOR_URL,
        rpcUrl,
        initTimeoutMs,
      },
    };
  } catch {
    return off("Solana config parse error", true);
  }
}
