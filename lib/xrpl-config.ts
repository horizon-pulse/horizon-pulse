/**
 * XRPL RLUSD rail (x402 `exact` on the XRP Ledger): feature flag + constants.
 * Pure and synchronous.
 *
 * Rail decisions come from the feasibility doc
 * (oversight/streams/horizon-pulse/xrpl-rail-feasibility-2026-10-08.md):
 *   - settle in RLUSD only (not XRP: volatile, would need per-call FX);
 *   - CAIP-2 ids from the x402 exact-XRPL spec: xrpl:0 mainnet, xrpl:1 testnet;
 *   - TESTNET ONLY for now: the default (and only usable) network is xrpl:1
 *     with the free x402.org facilitator. xrpl:0 is locked in code
 *     (XRPL_MAINNET_ALLOWED = false) and has no allow-listed facilitator;
 *   - Base stays the first `accepts` entry on every route.
 *
 * This module deliberately imports nothing from @x402/xrpl or xrpl, so a
 * broken/missing XRPL package can never break config parsing (or anything
 * that imports this file). The runtime half lives in lib/xrpl-rail.ts and
 * loads the package lazily.
 *
 * The rail is ON only when ALL of these hold; anything else is OFF and every
 * route serves the exact 402 it served before this branch:
 *   - HP_XRPL_ENABLED is exactly the string "true"
 *   - HP_XRPL_NETWORK, if set, is exactly "xrpl:1" (testnet). "xrpl:0" is
 *     refused while XRPL_MAINNET_ALLOWED is false.
 *   - HP_XRPL_PAYTO is exactly the payTo pinned for that network
 *     (xrplPayToFor; character for character, no trimming or case folding)
 *   - the pinned payTos are checksummed XRPL classic addresses (runtime check)
 *   - the facilitator URL is on XRPL_FACILITATOR_ALLOWLIST for that network
 *     (testnet default: x402.org; mainnet has NO default and must be named)
 *   - HP_XRPL_RPC_URL, if set, is an https URL on the allow-listed read-only
 *     RPC host for that network (no userinfo, no IP literal, no localhost,
 *     default port)
 *   - HP_XRPL_ASSET_TRANSFER_METHOD, if set, is "sequence" or "ticketSequence"
 * Even when ON, the XRPL entry is only shown while the payTo account exists
 * on the configured network and holds an RLUSD trust line to the issuer
 * (lib/xrpl-rail.ts, read-only RPC). 2026-10-12: the testnet payTo has its
 * testnet RLUSD trust line; r3Fbir is activated on mainnet but has NO RLUSD
 * trust line (and mainnet is locked anyway).
 *
 * Moving the payout to any other address needs a code change to XRPL_PAYTO
 * plus a fresh passphrase from Michael; the env alone can only switch the
 * rail on or off.
 *
 * See docs/xrpl-rail.md.
 */
import { createHash } from "node:crypto";

/**
 * Michael's Ledger XRPL classic address: the ONLY mainnet (xrpl:0) payTo.
 * Activated on mainnet (1.43 XRP, read 2026-10-12 8:28 AM ET), NO RLUSD trust
 * line yet; the trust line is Michael's own Ledger action. Nothing in this repo funds it,
 * sends to it, or creates trust lines.
 */
export const XRPL_PAYTO = "r3FbirL83RAB2CwnUdxE5pCohMkuo6LQcf" as const;

/**
 * TESTNET-ONLY payTo (xrpl:1): a throwaway XRPL testnet faucet wallet created
 * 2026-10-12 for the @x402/xrpl interop proof (Odin PASS on the plan, Michael
 * 9:01 AM ET "Start XRP on testnet now"). Holds only testnet XRP / testnet
 * RLUSD; worthless. Its seed lives only in a box env file marked TESTNET,
 * never in this repo. It can never be paired with xrpl:0 (xrplPayToFor).
 */
export const XRPL_TESTNET_PAYTO = "rs2cF8jYDp4D7Ny2SrNV21xkNJRp3HiVTJ" as const;

/** RLUSD currency code as XRPL 160-bit hex (ASCII "RLUSD", zero padded). */
export const RLUSD_CURRENCY_HEX = "524C555344000000000000000000000000000000" as const;

/** Ripple's RLUSD issuer on XRPL mainnet (docs.ripple.com, RLUSD on the XRPL; = @x402/xrpl RLUSD_MAINNET_ISSUER). */
export const RLUSD_MAINNET_ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De" as const;
/** Ripple's RLUSD issuer on XRPL testnet (= @x402/xrpl RLUSD_TESTNET_ISSUER; cross-checked at init). */
export const RLUSD_TESTNET_ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV" as const;

/** CAIP-2 ids from the x402 exact-XRPL spec (specs/schemes/exact/scheme_exact_xrpl.md). */
export const XRPL_MAINNET_CAIP2 = "xrpl:0" as const;
export const XRPL_TESTNET_CAIP2 = "xrpl:1" as const;
/**
 * Code-level mainnet lock (Odin, 2026-10-12). While false, xrpl:0 is OFF
 * (misconfigured) no matter what env is set. Flipping it is a code change +
 * Class A + Michael's yes, after his RLUSD trust line on r3Fbir exists.
 */
export const XRPL_MAINNET_ALLOWED = false as boolean;

/**
 * Mainnet lock switch: xrpl:0 is permitted only when the env var
 * XRPL_MAINNET_ALLOWED is exactly "true" (default: XRPL_MAINNET_ALLOWED,
 * false). Every other guard below (pinned payTo, allow-listed facilitator and
 * RPC, shared replay store, RLUSD trust line at runtime) still applies.
 */
export function xrplMainnetAllowed(env: Record<string, string | undefined>): boolean {
  return env.XRPL_MAINNET_ALLOWED === undefined ? XRPL_MAINNET_ALLOWED : env.XRPL_MAINNET_ALLOWED === "true";
}

export type XrplRailNetwork = typeof XRPL_MAINNET_CAIP2 | typeof XRPL_TESTNET_CAIP2;

/**
 * Network → RLUSD issuer. The ONLY place an issuer is chosen. The mainnet
 * issuer only ever goes with xrpl:0, the testnet issuer only with xrpl:1;
 * anything else throws (callers catch → rail OFF). Pairing is re-checked by
 * assertXrplPairing() wherever a requirement is built or accepted.
 */
export function rlusdIssuerFor(network: XrplRailNetwork): string {
  if (network === XRPL_MAINNET_CAIP2) return RLUSD_MAINNET_ISSUER;
  if (network === XRPL_TESTNET_CAIP2) return RLUSD_TESTNET_ISSUER;
  throw new Error("unrecognized XRPL network");
}

/** Network → pinned payTo: Michael's Ledger address on xrpl:0, the throwaway testnet wallet on xrpl:1. */
export function xrplPayToFor(network: XrplRailNetwork): string {
  if (network === XRPL_MAINNET_CAIP2) return XRPL_PAYTO;
  if (network === XRPL_TESTNET_CAIP2) return XRPL_TESTNET_PAYTO;
  throw new Error("unrecognized XRPL network");
}

/**
 * True only for the two legal (network, issuer, payTo) triples. Any mix of
 * mainnet and testnet values (testnet issuer on xrpl:0, mainnet issuer on
 * xrpl:1, testnet payTo on xrpl:0, …) or an unknown network is false.
 */
export function isLegalXrplPairing(network: string, issuer: string, payTo?: string): boolean {
  if (network === XRPL_MAINNET_CAIP2) return issuer === RLUSD_MAINNET_ISSUER && (payTo === undefined || payTo === XRPL_PAYTO);
  if (network === XRPL_TESTNET_CAIP2) return issuer === RLUSD_TESTNET_ISSUER && (payTo === undefined || payTo === XRPL_TESTNET_PAYTO);
  return false;
}

export function assertXrplPairing(network: string, issuer: string, payTo?: string): void {
  if (!isLegalXrplPairing(network, issuer, payTo)) throw new Error("XRPL network/issuer/payTo mix refused");
}

/**
 * Sentinel "facilitator URL" for in-process self-facilitation with the
 * @x402/xrpl reference facilitator scheme (verify + submit against the
 * allow-listed public rippled; no third party, no keys: the payer signs and
 * pays the fee). The ONLY mainnet option: no hosted xrpl:0 facilitator accepts
 * the standard @x402/xrpl payload (t54 needs its own invoice binding).
 */
export const XRPL_SELF_FACILITATOR = "self" as const;

/** Public x402.org facilitator: the default for xrpl:1 (testnet) ONLY. */
export const X402_ORG_FACILITATOR_URL = "https://x402.org/facilitator" as const;

/**
 * Facilitator URLs the rail may use, per network (exact string match after
 * trimming trailing slashes). From the feasibility doc: x402.org (free
 * testnet) and t54's hosted XRPL facilitators. Mainnet has no default: going
 * live on xrpl:0 means naming the mainnet URL explicitly (Michael/Odin
 * decision). Any other facilitator (e.g. self-hosted @x402/xrpl, which needs
 * a shared settle-dedup store = a new KV account) is a code change + review.
 */
export const XRPL_FACILITATOR_ALLOWLIST: Readonly<Record<XrplRailNetwork, readonly string[]>> = {
  [XRPL_TESTNET_CAIP2]: [X402_ORG_FACILITATOR_URL, "https://xrpl-facilitator-testnet.t54.ai"],
  // Empty while XRPL_MAINNET_ALLOWED is false. t54 mainnet was removed: its
  // testnet twin rejects spec-shaped @x402/xrpl payloads (missing_invoice_id).
  // In-process self-facilitation only (branch xrpl-self-facilitate). Still
  // behind XRPL_MAINNET_ALLOWED + the Upstash replay store + HP_XRPL_ENABLED.
  [XRPL_MAINNET_CAIP2]: [XRPL_SELF_FACILITATOR],
};

/** Read/submit WebSocket for self-facilitation: same allow-listed host as the RPC. */
export const XRPL_SELF_WS_URL: Readonly<Record<XrplRailNetwork, string>> = {
  [XRPL_TESTNET_CAIP2]: "wss://testnet.xrpl-labs.com/",
  [XRPL_MAINNET_CAIP2]: "wss://xrplcluster.com/",
};

/** Public read-only JSON-RPC per network (payTo readiness check + settled-tx time). */
export const DEFAULT_XRPL_RPC_URL: Readonly<Record<XrplRailNetwork, string>> = {
  [XRPL_TESTNET_CAIP2]: "https://testnet.xrpl-labs.com/",
  [XRPL_MAINNET_CAIP2]: "https://xrplcluster.com/",
};

/**
 * Hostnames HP_XRPL_RPC_URL may point at, per network (exact match after URL
 * parsing). A dedicated provider needs an account = Michael's decision; add
 * its exact hostname here (code change + review).
 */
export const XRPL_RPC_HOST_ALLOWLIST: Readonly<Record<XrplRailNetwork, readonly string[]>> = {
  [XRPL_TESTNET_CAIP2]: ["testnet.xrpl-labs.com"],
  [XRPL_MAINNET_CAIP2]: ["xrplcluster.com"],
};

export type XrplAssetTransferMethod = "sequence" | "ticketSequence";

export type XrplRailConfig = {
  network: XrplRailNetwork;
  /** xrplPayToFor(network): never a free env value. */
  payTo: string;
  asset: typeof RLUSD_CURRENCY_HEX;
  issuer: string;
  facilitatorUrl: string;
  /** Read-only JSON-RPC used for the payTo readiness check and the settled-tx time check. */
  rpcUrl: string;
  /** Omitted from requirements when undefined (clients then default to "sequence"). */
  assetTransferMethod?: XrplAssetTransferMethod;
  /** Max wait for the XRPL facilitator / RPC during lazy init (unpaid 402 path). */
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

/** True only for a canonical, checksummed XRPL classic address (r...). X-addresses are rejected. */
export function isValidXrplClassicAddress(value: unknown): value is string {
  if (typeof value !== "string" || !/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(value)) return false;
  const bytes = base58Decode(value);
  if (!bytes || bytes.length !== 25 || bytes[0] !== 0x00) return false;
  const check = sha256d(bytes.subarray(0, 21)).subarray(0, 4);
  return check.every((b, i) => b === bytes[21 + i]) && base58Encode(bytes) === value;
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
 * amount IS the ledger value string. RLUSD is 1:1 USD, so no FX.
 */
export function usdcAtomicToRlusdValue(atomic: string): string {
  if (!/^[1-9]\d*$/.test(atomic)) throw new Error(`invalid atomic amount: ${atomic}`);
  const digits = atomic.padStart(7, "0");
  const whole = digits.slice(0, -6).replace(/^0+(?=\d)/, "");
  const frac = digits.slice(-6).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

// ---------------------------------------------------------------------------
// URL checks
// ---------------------------------------------------------------------------

export type UrlCheck = { ok: true; url: string } | { ok: false; reason: string };

/**
 * Parse + validate an RPC override (same hardening as HP_SOLANA_RPC_URL):
 * https, no userinfo, not an IP literal, not localhost, default port,
 * hostname on XRPL_RPC_HOST_ALLOWLIST[network]. Never throws.
 */
export function parseXrplRpcUrl(raw: string, network: XrplRailNetwork): UrlCheck {
  const trimmed = raw.trim();
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return { ok: false, reason: "HP_XRPL_RPC_URL is not a URL" };
  }
  if (u.protocol !== "https:") return { ok: false, reason: "HP_XRPL_RPC_URL must be https" };
  if (u.username !== "" || u.password !== "") return { ok: false, reason: "HP_XRPL_RPC_URL must not contain userinfo" };
  const host = u.hostname;
  if (host.startsWith("[") || host.includes(":") || /^[0-9.]+$/.test(host)) {
    return { ok: false, reason: "HP_XRPL_RPC_URL must not be an IP literal" };
  }
  if (host === "localhost" || host.endsWith(".localhost") || host === "localhost.") {
    return { ok: false, reason: "HP_XRPL_RPC_URL must not be localhost" };
  }
  if (u.port !== "") return { ok: false, reason: "HP_XRPL_RPC_URL must use the default https port" };
  if (!XRPL_RPC_HOST_ALLOWLIST[network].includes(host)) {
    return { ok: false, reason: `HP_XRPL_RPC_URL host is not on the ${network} allow-list` };
  }
  return { ok: true, url: u.toString() };
}

/** Facilitator URL: exact member of XRPL_FACILITATOR_ALLOWLIST[network] (trailing slashes ignored). */
export function parseXrplFacilitatorUrl(raw: string, network: XrplRailNetwork): UrlCheck {
  const v = raw.trim().replace(/\/+$/, "");
  if (!XRPL_FACILITATOR_ALLOWLIST[network].includes(v)) {
    return { ok: false, reason: `HP_XRPL_FACILITATOR_URL is not on the ${network} facilitator allow-list` };
  }
  return { ok: true, url: v };
}

// ---------------------------------------------------------------------------
// Env parsing
// ---------------------------------------------------------------------------

type Env = Record<string, string | undefined>;

const DEFAULT_INIT_TIMEOUT_MS = 2500;
/** Cap on HP_XRPL_INIT_TIMEOUT_MS (time budget, Odin C1). */
export const XRPL_MAX_INIT_TIMEOUT_MS = 5_000;

function off(reason: string, misconfigured: boolean): XrplConfigResult {
  return { enabled: false, reason, misconfigured };
}

/** Both Upstash REST env vars present and the URL is https (mirrors createReplayStore's selection). */
export function hasSharedReplayStoreEnv(env: Env): boolean {
  const url = (env.UPSTASH_REDIS_REST_URL ?? "").trim();
  const token = (env.UPSTASH_REDIS_REST_TOKEN ?? "").trim();
  return url !== "" && token !== "" && /^https:\/\//.test(url);
}

/** Never throws. */
export function getXrplRailConfig(env: Env = process.env): XrplConfigResult {
  try {
    if (env.HP_XRPL_ENABLED !== "true") return off("HP_XRPL_ENABLED is not exactly 'true'", false);

    // Pinned constants must themselves be valid checksummed classic addresses (runtime check).
    if (!isValidXrplClassicAddress(XRPL_PAYTO) || !isValidXrplClassicAddress(XRPL_TESTNET_PAYTO))
      return off("pinned XRPL payTo is not a valid XRPL classic address", true);

    const rawNet = env.HP_XRPL_NETWORK;
    let network: XrplRailNetwork;
    if (rawNet === undefined || rawNet === "" || rawNet === XRPL_TESTNET_CAIP2) network = XRPL_TESTNET_CAIP2;
    else if (rawNet === XRPL_MAINNET_CAIP2) {
      if (!xrplMainnetAllowed(env)) return off("xrpl:0 (mainnet) is locked (XRPL_MAINNET_ALLOWED is not exactly 'true')", true);
      // Mainnet fails closed without the shared replay store (per-instance
      // memory cannot stop a cross-instance replay of a real payment).
      if (!hasSharedReplayStoreEnv(env)) return off("xrpl:0 requires UPSTASH_REDIS_REST_URL (https) and UPSTASH_REDIS_REST_TOKEN (shared replay store)", true);
      network = XRPL_MAINNET_CAIP2;
    }
    else return off("HP_XRPL_NETWORK must be exactly xrpl:1 (testnet) or xrpl:0 (mainnet)", true);

    const payTo = env.HP_XRPL_PAYTO;
    if (payTo === undefined || payTo === "") return off("HP_XRPL_PAYTO is not set", true);
    // Exact, untrimmed comparison against the payTo pinned FOR THIS NETWORK:
    // any edit, whitespace, other address, or the other network's payTo = OFF.
    const pinned = xrplPayToFor(network);
    if (payTo !== pinned) return off("HP_XRPL_PAYTO does not match the pinned XRPL payTo for this network exactly", true);

    const issuer = rlusdIssuerFor(network);
    if (payTo === issuer) return off("HP_XRPL_PAYTO must not be the RLUSD issuer", true);
    if (!isLegalXrplPairing(network, issuer, pinned)) return off("XRPL network/issuer/payTo mix refused", true);

    const rawFac = env.HP_XRPL_FACILITATOR_URL ?? "";
    let facilitatorUrl: string;
    if (rawFac.trim() !== "") {
      const checked = parseXrplFacilitatorUrl(rawFac, network);
      if (!checked.ok) return off(checked.reason, true);
      facilitatorUrl = checked.url;
    } else if (network === XRPL_TESTNET_CAIP2) {
      facilitatorUrl = X402_ORG_FACILITATOR_URL;
    } else {
      return off("HP_XRPL_FACILITATOR_URL is required for xrpl:0 (mainnet has no default facilitator)", true);
    }

    const rawRpc = env.HP_XRPL_RPC_URL ?? "";
    let rpcUrl: string = DEFAULT_XRPL_RPC_URL[network];
    if (rawRpc.trim() !== "") {
      const checked = parseXrplRpcUrl(rawRpc, network);
      if (!checked.ok) return off(checked.reason, true);
      rpcUrl = checked.url;
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
      Number.isInteger(rawTimeout) && rawTimeout > 0 && rawTimeout <= XRPL_MAX_INIT_TIMEOUT_MS ? rawTimeout : DEFAULT_INIT_TIMEOUT_MS;

    const config: XrplRailConfig = {
      network,
      payTo: pinned,
      asset: RLUSD_CURRENCY_HEX,
      issuer,
      facilitatorUrl,
      rpcUrl,
      initTimeoutMs,
    };
    if (assetTransferMethod) config.assetTransferMethod = assetTransferMethod;
    return { enabled: true, config };
  } catch {
    return off("XRPL config parse error", true);
  }
}
