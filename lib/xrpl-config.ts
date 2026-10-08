/**
 * XRPL RLUSD rail: feature-flag + env parsing. Pure and synchronous.
 *
 * This module deliberately imports nothing from @x402/xrpl or xrpl, so a
 * broken/missing XRPL package can never break config parsing (or anything that
 * imports this file). The runtime half lives in lib/xrpl-rail.ts and loads the
 * package lazily.
 *
 * The rail is ON only when ALL of these hold; anything else is OFF and every
 * route serves the exact Base-only 402 it served before this branch:
 *   - HP_XRPL_ENABLED is exactly the string "true"
 *   - HP_XRPL_PAYTO is a valid XRPL classic address (r..., checksum verified)
 *   - HP_XRPL_NETWORK (default xrpl:1 = testnet) is xrpl:0 or xrpl:1
 *   - a facilitator URL resolves (HP_XRPL_FACILITATOR_URL, https only; the
 *     public x402.org facilitator is the default for testnet ONLY, mainnet
 *     must name one explicitly)
 *   - HP_XRPL_ASSET_TRANSFER_METHOD, if set, is "sequence" or "ticketSequence"
 *
 * See docs/xrpl-rail.md.
 */
import { createHash } from "node:crypto";

/** RLUSD currency code as XRPL 160-bit hex (ASCII "RLUSD", zero padded). */
export const RLUSD_CURRENCY_HEX = "524C555344000000000000000000000000000000" as const;

/** Ripple's public RLUSD issuer on XRPL mainnet (docs.ripple.com, RLUSD on the XRPL). */
export const RLUSD_MAINNET_ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De" as const;

/** CAIP-2 ids from the x402 exact-XRPL spec (specs/schemes/exact/scheme_exact_xrpl.md). */
export const XRPL_MAINNET_CAIP2 = "xrpl:0" as const;
export const XRPL_TESTNET_CAIP2 = "xrpl:1" as const;
export type XrplRailNetwork = typeof XRPL_MAINNET_CAIP2 | typeof XRPL_TESTNET_CAIP2;

/** Public x402.org facilitator: default for xrpl:1 (testnet) only. */
export const X402_ORG_FACILITATOR_URL = "https://x402.org/facilitator" as const;

export type XrplAssetTransferMethod = "sequence" | "ticketSequence";

export type XrplRailConfig = {
  network: XrplRailNetwork;
  payTo: string;
  facilitatorUrl: string;
  /** Omitted from requirements when undefined (clients then default to "sequence"). */
  assetTransferMethod?: XrplAssetTransferMethod;
  /** Max wait for the XRPL facilitator during lazy init (unpaid 402 path). */
  initTimeoutMs: number;
};

export type XrplConfigResult =
  | { enabled: true; config: XrplRailConfig }
  | { enabled: false; reason: string; /** flag was "true" but the rest was unusable */ misconfigured: boolean };

// ---------------------------------------------------------------------------
// XRPL classic address validation (base58check, Ripple alphabet, version 0x00)
// ---------------------------------------------------------------------------

const RIPPLE_ALPHABET = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";
const ALPHABET_INDEX = new Map([...RIPPLE_ALPHABET].map((c, i) => [c, i]));

function sha256d(bytes: Uint8Array): Uint8Array {
  const once = createHash("sha256").update(bytes).digest();
  return createHash("sha256").update(once).digest();
}

function base58Decode(s: string): Uint8Array | null {
  let n = BigInt(0);
  for (const c of s) {
    const v = ALPHABET_INDEX.get(c);
    if (v === undefined) return null;
    n = n * BigInt(58) + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > BigInt(0)) {
    bytes.unshift(Number(n % BigInt(256)));
    n /= BigInt(256);
  }
  for (const c of s) {
    if (c !== RIPPLE_ALPHABET[0]) break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

function base58Encode(bytes: Uint8Array): string {
  let n = BigInt(0);
  for (const b of bytes) n = n * BigInt(256) + BigInt(b);
  let out = "";
  while (n > BigInt(0)) {
    out = RIPPLE_ALPHABET[Number(n % BigInt(58))] + out;
    n /= BigInt(58);
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = RIPPLE_ALPHABET[0] + out;
  }
  return out;
}

/** True only for a checksummed XRPL classic address (r...). X-addresses are rejected. */
export function isValidXrplClassicAddress(value: unknown): value is string {
  if (typeof value !== "string" || !/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(value)) return false;
  const bytes = base58Decode(value);
  if (!bytes || bytes.length !== 25 || bytes[0] !== 0x00) return false;
  const check = sha256d(bytes.subarray(0, 21)).subarray(0, 4);
  return check.every((b, i) => b === bytes[21 + i]);
}

/** Encode a 20-byte account id as a classic address (used by tests; no key material involved). */
export function encodeXrplClassicAddress(accountId: Uint8Array): string {
  if (accountId.length !== 20) throw new Error("account id must be 20 bytes");
  const payload = new Uint8Array(21);
  payload.set(accountId, 1);
  const check = sha256d(payload).subarray(0, 4);
  const full = new Uint8Array(25);
  full.set(payload, 0);
  full.set(check, 21);
  return base58Encode(full);
}

// ---------------------------------------------------------------------------
// Pricing: same USD price, RLUSD issued-currency decimal value
// ---------------------------------------------------------------------------

/**
 * USDC atomic units (6 decimals, as used by every route's paymentOpts) to the
 * exact decimal string the XRPL spec wants for an IOU `amount`
 * ("5000" -> "0.005", "15000" -> "0.015", "1000000" -> "1"). Integer string
 * math only, no floats. The spec defines no `decimals` for XRPL IOUs: the
 * amount IS the ledger value string.
 */
export function usdcAtomicToRlusdValue(atomic: string): string {
  if (!/^\d+$/.test(atomic)) throw new Error(`invalid atomic amount: ${atomic}`);
  const digits = atomic.replace(/^0+(?=\d)/, "").padStart(7, "0");
  const whole = digits.slice(0, -6).replace(/^0+(?=\d)/, "");
  const frac = digits.slice(-6).replace(/0+$/, "");
  const value = frac ? `${whole}.${frac}` : whole;
  if (value === "0") throw new Error("price must be > 0");
  return value;
}

// ---------------------------------------------------------------------------
// Env parsing
// ---------------------------------------------------------------------------

type Env = Record<string, string | undefined>;

const DEFAULT_INIT_TIMEOUT_MS = 2500;

function parseNetwork(raw: string | undefined): XrplRailNetwork | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "" || v === XRPL_TESTNET_CAIP2 || v === "testnet") return XRPL_TESTNET_CAIP2;
  if (v === XRPL_MAINNET_CAIP2 || v === "mainnet") return XRPL_MAINNET_CAIP2;
  return null;
}

function parseHttpsUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" ? raw.replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
}

function off(reason: string, misconfigured: boolean): XrplConfigResult {
  return { enabled: false, reason, misconfigured };
}

/** Never throws. */
export function getXrplRailConfig(env: Env = process.env): XrplConfigResult {
  try {
    if (env.HP_XRPL_ENABLED !== "true") return off("HP_XRPL_ENABLED is not exactly 'true'", false);

    const payTo = (env.HP_XRPL_PAYTO ?? "").trim();
    if (!payTo) return off("HP_XRPL_PAYTO is not set", true);
    if (!isValidXrplClassicAddress(payTo)) return off("HP_XRPL_PAYTO is not a valid XRPL classic address", true);
    if (payTo === RLUSD_MAINNET_ISSUER) return off("HP_XRPL_PAYTO must not be the RLUSD issuer", true);

    const network = parseNetwork(env.HP_XRPL_NETWORK);
    if (!network) return off("HP_XRPL_NETWORK must be xrpl:0 (mainnet) or xrpl:1 (testnet)", true);

    const rawUrl = (env.HP_XRPL_FACILITATOR_URL ?? "").trim();
    let facilitatorUrl: string | null;
    if (rawUrl) {
      facilitatorUrl = parseHttpsUrl(rawUrl);
      if (!facilitatorUrl) return off("HP_XRPL_FACILITATOR_URL must be an https URL", true);
    } else if (network === XRPL_TESTNET_CAIP2) {
      facilitatorUrl = X402_ORG_FACILITATOR_URL;
    } else {
      return off("HP_XRPL_FACILITATOR_URL is required for xrpl:0 (mainnet)", true);
    }

    const rawMethod = (env.HP_XRPL_ASSET_TRANSFER_METHOD ?? "").trim();
    let assetTransferMethod: XrplAssetTransferMethod | undefined;
    if (rawMethod) {
      if (rawMethod !== "sequence" && rawMethod !== "ticketSequence") {
        return off("HP_XRPL_ASSET_TRANSFER_METHOD must be 'sequence' or 'ticketSequence'", true);
      }
      assetTransferMethod = rawMethod;
    }

    const rawTimeout = Number((env.HP_XRPL_INIT_TIMEOUT_MS ?? "").trim() || DEFAULT_INIT_TIMEOUT_MS);
    const initTimeoutMs =
      Number.isInteger(rawTimeout) && rawTimeout > 0 && rawTimeout <= 30_000 ? rawTimeout : DEFAULT_INIT_TIMEOUT_MS;

    return {
      enabled: true,
      config: { network, payTo, facilitatorUrl, assetTransferMethod, initTimeoutMs },
    };
  } catch {
    return off("XRPL config parse error", true);
  }
}
