/**
 * Solana USDC rail: runtime half (see lib/solana-config.ts for the flag).
 *
 * Isolation contract (the Base path must never notice this file):
 *   - @x402/svm is imported lazily (dynamic import) and only when the flag is
 *     on; an import failure just turns the rail off.
 *   - The Solana rail has its OWN x402ResourceServer whose ONLY facilitator is
 *     PayAI, wrapped so it advertises/accepts nothing but `exact` on Solana
 *     mainnet and reports no extensions (so this server never declares or
 *     enriches Bazaar: CDP/Base stays the only Bazaar-indexed entry). The Base
 *     server in lib/x402-server.ts keeps the CDP facilitator as its only
 *     client and never sees Solana or PayAI. A Base payload can only reach
 *     CDP and a Solana payload can only reach PayAI.
 *   - Every exported entry point catches everything. On any Solana failure
 *     (import, bad env, PayAI down/timeout/missing kind, unexpected
 *     requirement, verify/settle throw) callers get the untouched Base-only
 *     402 and a console.warn.
 *   - Failed init is cached for RETRY_AFTER_MS so an outage costs at most one
 *     bounded wait (initTimeoutMs) per instance per window. A good init is
 *     refreshed every RAIL_TTL_MS (re-fetches PayAI /supported).
 *   - Fee payer: the `extra.feePayer` PayAI advertises for exact/Solana-mainnet
 *     must also appear in PayAI's own live signer list (same HTTPS /supported
 *     response, `signers["solana:*"]` or `signers[<network>]`). Not listed, or
 *     list unavailable → fail closed (Base-only).
 *   - Token-account guard: the Solana entry is shown ONLY while the payTo's
 *     USDC token account (SOLANA_PAYTO_USDC_ATA) exists on mainnet, checked by
 *     read-only JSON-RPC and cached ATA_TTL_MS (~10 min), so it flips on by
 *     itself once the account is created (no redeploy). Absent / RPC error →
 *     Base-only.
 *   - Incoming Solana payloads have any `extensions.bazaar` stripped before
 *     they reach PayAI; the Solana server never declares Bazaar.
 *   - PayAI rejections (verify invalid / settle failed / throws) are logged
 *     server-side with the reason code only (addresses, tx data redacted); the
 *     client still gets exactly main's Base-only 402.
 */
import type { NextRequest } from "next/server";
import { NextRequest as NextRequestCtor, NextResponse } from "next/server";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type { FacilitatorClient, RouteConfig, RoutesConfig } from "@x402/core/server";
import type {
  AssetAmount,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkServer,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import {
  decodePaymentRequiredHeader,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import { withX402 } from "@x402/next";
import {
  SOLANA_MAINNET_CAIP2,
  SOLANA_PAYTO,
  SOLANA_PAYTO_USDC_ATA,
  SPL_TOKEN_PROGRAM,
  USDC_SOLANA_MINT,
  isValidSolanaPubkey,
  type SolanaRailConfig,
} from "./solana-config";

const LOG = "[solana-rail]";
const RETRY_AFTER_MS = 60_000;
/** Re-initialise a good rail (re-fetch PayAI /supported + fee payer list) this often. */
export const RAIL_TTL_MS = 10 * 60_000;
/** Token-account existence result (present or absent) is cached this long. */
export const ATA_TTL_MS = 10 * 60_000;
/** RPC error → cached as "absent" for this long before retrying. */
const ATA_ERROR_RETRY_MS = 60_000;
/** Same default @x402/core applies to the Base entry. */
const MAX_TIMEOUT_SECONDS = 300;
/** Solana packet limit for a serialized transaction. */
const MAX_TX_BYTES = 1232;

// ---------------------------------------------------------------------------
// Lazy package loading (test-overridable)
// ---------------------------------------------------------------------------

export type SolanaModules = {
  ExactSvmScheme: new () => SchemeNetworkServer;
  SOLANA_MAINNET_CAIP2: string;
  USDC_MAINNET_ADDRESS: string;
  /** ATA(owner, mint) under the SPL Token program. */
  deriveUsdcAta: (owner: string, mint: string) => Promise<string>;
};

async function defaultLoader(): Promise<SolanaModules> {
  const [server, root, kit] = await Promise.all([
    import("@x402/svm/exact/server"),
    import("@x402/svm"),
    import("@solana/kit"),
  ]);
  return {
    ExactSvmScheme: server.ExactSvmScheme as unknown as new () => SchemeNetworkServer,
    SOLANA_MAINNET_CAIP2: root.SOLANA_MAINNET_CAIP2,
    USDC_MAINNET_ADDRESS: root.USDC_MAINNET_ADDRESS,
    deriveUsdcAta: async (owner, mint) => {
      const enc = kit.getAddressEncoder();
      const [pda] = await kit.getProgramDerivedAddress({
        programAddress: kit.address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
        seeds: [enc.encode(kit.address(owner)), enc.encode(kit.address(SPL_TOKEN_PROGRAM)), enc.encode(kit.address(mint))],
      });
      return pda.toString();
    },
  };
}

// ---------------------------------------------------------------------------
// Read-only JSON-RPC (test-overridable)
// ---------------------------------------------------------------------------

export type SolanaRpc = (url: string, method: string, params: unknown[], timeoutMs: number) => Promise<unknown>;

async function defaultRpc(url: string, method: string, params: unknown[], timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const json = (await res.json()) as { result?: unknown; error?: { code?: number } };
  if (json.error) throw new Error(`RPC error ${json.error.code ?? ""}`);
  return json.result;
}

let rpc: SolanaRpc = defaultRpc;

/** Tests only: swap the read-only RPC (null = real fetch). Also clears the token-account cache. */
export function __setSolanaRpcForTests(fn: SolanaRpc | null): void {
  rpc = fn ?? defaultRpc;
  ataCache = null;
}

let loader: () => Promise<SolanaModules> = defaultLoader;

/** Tests only: the real lazy loader (to wrap/tamper with in isolation tests). */
export const __loadRealSolanaModulesForTests = defaultLoader;

/** Tests only: swap the package loader (e.g. to simulate an import failure). */
export function __setSolanaModuleLoaderForTests(fn: (() => Promise<SolanaModules>) | null): void {
  loader = fn ?? defaultLoader;
  resetSolanaRailForTests();
}

export function resetSolanaRailForTests(): void {
  railKey = null;
  railPromise = null;
  railBuiltAt = 0;
  failedKey = null;
  failedUntil = 0;
  ataCache = null;
  paidHandlers = new WeakMap();
}

/**
 * Strip anything that could identify a payer or transaction from a log line:
 * base58 runs that look like addresses/signatures/blockhashes, 0x hex, long
 * base64. Keeps reason codes. Max 200 chars.
 */
export function redact(text: string): string {
  return text
    .replace(/0x[0-9a-fA-F]{8,}/g, "<hex>")
    .replace(/[1-9A-HJ-NP-Za-km-z]{32,}/g, "<b58>")
    .replace(/[A-Za-z0-9+/]{60,}={0,2}/g, "<b64>")
    .slice(0, 200);
}

function warn(msg: string, err?: unknown): void {
  const detail = err instanceof Error ? err.message : err === undefined ? "" : String(err);
  console.warn(`${LOG} ${redact(msg)}${detail ? `: ${redact(detail)}` : ""} (serving Base-only)`);
}

// ---------------------------------------------------------------------------
// Solana-only facilitator client (PayAI)
// ---------------------------------------------------------------------------

/**
 * Wraps PayAI so it can only ever be used for `exact` on Solana mainnet:
 * getSupported is filtered to that one kind (and reports no extensions, so
 * the Solana server never declares Bazaar), and verify/settle refuse
 * anything else. Registered as the sole client of the Solana server.
 */
export class SolanaOnlyFacilitatorClient implements FacilitatorClient {
  constructor(
    private readonly inner: FacilitatorClient,
    readonly network: string,
  ) {}

  async getSupported(): Promise<SupportedResponse> {
    // HTTPS only: the fee payer list must come from PayAI over TLS.
    const url = (this.inner as { url?: unknown }).url;
    if (typeof url !== "string" || !url.startsWith("https://")) {
      throw new Error("PayAI facilitator URL must be https");
    }
    const supported = await this.inner.getSupported();
    const kinds = (supported.kinds ?? []).filter(
      (k) => k.x402Version === 2 && k.scheme === "exact" && k.network === this.network,
    );
    if (kinds.length !== 1) {
      throw new Error(`PayAI does not list exactly one x402 v2 exact kind on ${this.network}`);
    }
    const feePayer = (kinds[0].extra as { feePayer?: unknown } | undefined)?.feePayer;
    if (!isValidSolanaPubkey(feePayer)) {
      throw new Error("PayAI exact kind has no valid extra.feePayer");
    }
    // The advertised fee payer must be one of PayAI's own live Solana signers.
    const allSigners = (supported.signers ?? {}) as Record<string, unknown>;
    const listed = [allSigners["solana:*"], allSigners[this.network]]
      .filter(Array.isArray)
      .flat()
      .filter((a): a is string => typeof a === "string");
    if (listed.length === 0) throw new Error("PayAI /supported has no Solana signer list");
    if (!listed.includes(feePayer)) throw new Error("PayAI feePayer is not in PayAI's live Solana signer list");
    if (feePayer === SOLANA_PAYTO) throw new Error("PayAI feePayer equals payTo");
    const signers = Object.fromEntries(
      Object.entries(allSigners).filter(([k]) => k.startsWith("solana:")),
    ) as SupportedResponse["signers"];
    // extensions: [] → the Solana server never declares or enriches Bazaar.
    return { kinds, extensions: [], signers };
  }

  private guard(payload: PaymentPayload, requirements: PaymentRequirements): void {
    if (
      requirements.network !== this.network ||
      payload.accepted?.network !== this.network ||
      requirements.scheme !== "exact" ||
      requirements.payTo !== SOLANA_PAYTO ||
      requirements.asset !== USDC_SOLANA_MINT
    ) {
      throw new Error(`Solana facilitator refuses non-${this.network} / non-pinned payment`);
    }
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    this.guard(payload, requirements);
    let res: VerifyResponse;
    try {
      res = await this.inner.verify(payload, requirements);
    } catch (err) {
      warn("PayAI verify threw", err);
      throw err;
    }
    if (!res.isValid) {
      // Reason code only; payer / tx never logged.
      warn(`PayAI verify rejected: reason=${res.invalidReason ?? "unknown"}${res.invalidMessage ? ` message=${res.invalidMessage}` : ""}`);
    }
    return res;
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    this.guard(payload, requirements);
    let res: SettleResponse;
    try {
      res = await this.inner.settle(payload, requirements);
    } catch (err) {
      warn("PayAI settle threw", err);
      throw err;
    }
    if (!res.success) {
      warn(`PayAI settle failed: reason=${res.errorReason ?? "unknown"}${res.errorMessage ? ` message=${res.errorMessage}` : ""}`);
    }
    return res;
  }
}

// ---------------------------------------------------------------------------
// Rail init (cached)
// ---------------------------------------------------------------------------

type Rail = {
  config: SolanaRailConfig;
  server: x402ResourceServer;
};

let railKey: string | null = null;
let railPromise: Promise<Rail> | null = null;
let railBuiltAt = 0;
let failedKey: string | null = null;
let failedUntil = 0;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

async function initRail(config: SolanaRailConfig): Promise<Rail> {
  const mods = await loader();
  // Cross-check our pinned constants against the package.
  if (mods.SOLANA_MAINNET_CAIP2 !== SOLANA_MAINNET_CAIP2) {
    throw new Error("Solana mainnet CAIP-2 mismatch between repo constant and @x402/svm");
  }
  if (mods.USDC_MAINNET_ADDRESS !== USDC_SOLANA_MINT) {
    throw new Error("USDC mint mismatch between repo constant and @x402/svm");
  }
  if ((await mods.deriveUsdcAta(config.payTo, USDC_SOLANA_MINT)) !== SOLANA_PAYTO_USDC_ATA) {
    throw new Error("payTo USDC token account derivation does not match the pinned constant");
  }
  const facilitator = new SolanaOnlyFacilitatorClient(
    new HTTPFacilitatorClient({ url: config.facilitatorUrl, timeoutMs: 30_000 }),
    config.network,
  );
  const server = new x402ResourceServer(facilitator).register(config.network, new mods.ExactSvmScheme());
  await server.initialize();
  return { config, server };
}

async function getRail(config: SolanaRailConfig): Promise<Rail | null> {
  const key = JSON.stringify(config);
  if (failedKey === key && Date.now() < failedUntil) return null;
  if (railKey !== key || !railPromise || Date.now() - railBuiltAt > RAIL_TTL_MS) {
    railKey = key;
    railBuiltAt = Date.now();
    railPromise = withTimeout(initRail(config), config.initTimeoutMs, "Solana rail init");
  }
  try {
    return await railPromise;
  } catch (err) {
    warn("rail init failed", err);
    if (railKey === key) {
      railKey = null;
      railPromise = null;
    }
    failedKey = key;
    failedUntil = Date.now() + RETRY_AFTER_MS;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Token-account guard (read-only RPC, cached, re-checking)
// ---------------------------------------------------------------------------

type AtaState = { exists: boolean; until: number; pending?: Promise<boolean> };
let ataCache: AtaState | null = null;

type ParsedTokenAccount = {
  value: null | {
    owner?: string;
    data?: { parsed?: { type?: string; info?: { mint?: string; owner?: string; state?: string } } };
  };
};

async function checkAta(config: SolanaRailConfig): Promise<boolean> {
  const result = (await rpc(
    config.rpcUrl,
    "getAccountInfo",
    [SOLANA_PAYTO_USDC_ATA, { encoding: "jsonParsed", commitment: "confirmed" }],
    config.initTimeoutMs,
  )) as ParsedTokenAccount;
  if (!result || !("value" in result)) throw new Error("malformed getAccountInfo result");
  const v = result.value;
  if (v === null) return false;
  const info = v.data?.parsed?.info;
  const ok =
    v.owner === SPL_TOKEN_PROGRAM &&
    v.data?.parsed?.type === "account" &&
    info?.mint === USDC_SOLANA_MINT &&
    info?.owner === SOLANA_PAYTO &&
    info?.state === "initialized";
  if (!ok) warn("payTo USDC token account exists but is not an initialized USDC account owned by payTo");
  return ok;
}

/**
 * True while the payTo's USDC token account exists. Read-only RPC, result
 * cached ATA_TTL_MS (present or absent), so creation of the account is picked
 * up automatically. RPC failure → false (Base-only), retried after 60 s.
 * Never throws.
 */
export async function solanaTokenAccountReady(config: SolanaRailConfig): Promise<boolean> {
  const now = Date.now();
  if (ataCache && now < ataCache.until) return ataCache.exists;
  if (ataCache?.pending) return ataCache.pending;
  const previous = ataCache;
  const pending = (async () => {
    try {
      const exists = await checkAta(config);
      if (!exists) warn("payTo USDC token account not found; Solana entry hidden");
      ataCache = { exists, until: Date.now() + ATA_TTL_MS };
      return exists;
    } catch (err) {
      warn("token-account RPC check failed", err);
      ataCache = { exists: false, until: Date.now() + ATA_ERROR_RETRY_MS };
      return false;
    }
  })();
  ataCache = { exists: previous?.exists ?? false, until: 0, pending };
  return pending;
}

// ---------------------------------------------------------------------------
// Requirements
// ---------------------------------------------------------------------------

/** Same atomic USDC amount as the Base route (both USDCs have 6 decimals). */
function solanaPrice(atomicUsdc: string): AssetAmount {
  if (!/^[1-9]\d*$/.test(atomicUsdc)) throw new Error(`invalid atomic amount: ${atomicUsdc}`);
  return { amount: atomicUsdc, asset: USDC_SOLANA_MINT, extra: {} };
}

/** Throws unless the SDK-built requirement is exactly what we intend to advertise. */
export function assertSolanaRequirement(req: PaymentRequirements, atomicUsdc: string): void {
  const extra = (req.extra ?? {}) as Record<string, unknown>;
  const problems: string[] = [];
  if (req.scheme !== "exact") problems.push("scheme");
  if (req.network !== SOLANA_MAINNET_CAIP2) problems.push("network");
  if (req.payTo !== SOLANA_PAYTO) problems.push("payTo");
  if (req.asset !== USDC_SOLANA_MINT) problems.push("asset");
  if (req.amount !== atomicUsdc) problems.push("amount");
  if (req.maxTimeoutSeconds !== MAX_TIMEOUT_SECONDS) problems.push("maxTimeoutSeconds");
  if (!isValidSolanaPubkey(extra.feePayer)) problems.push("extra.feePayer");
  if (extra.feePayer === SOLANA_PAYTO) problems.push("feePayer==payTo");
  if (problems.length) throw new Error(`unexpected Solana requirement (${problems.join(", ")})`);
}

async function buildSolanaRequirement(rail: Rail, atomicUsdc: string): Promise<PaymentRequirements> {
  const [req] = await rail.server.buildPaymentRequirements({
    scheme: "exact",
    network: rail.config.network,
    payTo: rail.config.payTo,
    price: solanaPrice(atomicUsdc),
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
  });
  if (!req) throw new Error("no Solana requirement built");
  assertSolanaRequirement(req, atomicUsdc);
  return req;
}

/**
 * The Solana USDC `accepts` entry for a route priced at `atomicUsdc` (USDC
 * 6-dec units), or null if the rail is unavailable. Never throws.
 */
export async function getSolanaAccept(config: SolanaRailConfig, atomicUsdc: string): Promise<PaymentRequirements | null> {
  try {
    if (!(await solanaTokenAccountReady(config))) return null;
    const rail = await getRail(config);
    if (!rail) return null;
    return await buildSolanaRequirement(rail, atomicUsdc);
  } catch (err) {
    warn("could not build Solana requirement", err);
    return null;
  }
}

/**
 * Return a copy of a 402/OPTIONS response with `accept` appended after the
 * existing (Base) entries, in both the PAYMENT-REQUIRED header and, when the
 * body is a v2 PaymentRequired, the JSON body. Throws on malformed input;
 * callers fall back to the original response.
 */
export async function appendAccept(res: Response, accept: PaymentRequirements): Promise<NextResponse> {
  const header = res.headers.get("payment-required");
  if (!header) throw new Error("response has no PAYMENT-REQUIRED header");
  const pr = decodePaymentRequiredHeader(header);
  if (!Array.isArray(pr.accepts) || pr.accepts.length === 0) throw new Error("PAYMENT-REQUIRED has no accepts");
  pr.accepts = [...pr.accepts, accept];

  let body = await res.clone().text();
  try {
    const parsed = JSON.parse(body) as { x402Version?: unknown; accepts?: unknown };
    if (parsed && parsed.x402Version === 2 && Array.isArray(parsed.accepts)) {
      parsed.accepts = [...parsed.accepts, accept];
      body = JSON.stringify(parsed);
    }
  } catch {
    /* non-JSON body: keep as is */
  }

  const headers = new Headers(res.headers);
  headers.set("PAYMENT-REQUIRED", encodePaymentRequiredHeader(pr));
  headers.delete("content-length");
  return new NextResponse(body, { status: res.status, headers });
}

/**
 * Flag-on helper for unpaid 402s and OPTIONS: append the Solana entry, or
 * return `res` untouched (same object) if anything at all goes wrong.
 */
export async function withSolanaAccept<T extends Response>(
  res: T,
  config: SolanaRailConfig,
  atomicUsdc: string,
): Promise<T | NextResponse> {
  try {
    const accept = await getSolanaAccept(config, atomicUsdc);
    if (!accept) return res;
    return await appendAccept(res, accept);
  } catch (err) {
    warn("could not append Solana requirement", err);
    return res;
  }
}

// ---------------------------------------------------------------------------
// Paid path
// ---------------------------------------------------------------------------

/** True when the request carries a v2 PAYMENT-SIGNATURE whose accepted network is Solana. Never throws. */
export function isSolanaPaymentRequest(req: NextRequest): boolean {
  try {
    const raw = req.headers.get("payment-signature");
    if (!raw || !raw.trim()) return false;
    const payload = decodePaymentSignatureHeader(raw.trim()) as Partial<PaymentPayload>;
    const net = payload?.accepted?.network;
    return payload?.x402Version === 2 && typeof net === "string" && net.startsWith("solana:");
  } catch {
    return false;
  }
}

type AppRouteHandler = (req: NextRequest) => Promise<NextResponse>;

/**
 * Same route keys/description/resource metadata, but the only accept is the
 * Solana one and NO extensions (the Solana/PayAI server never declares Bazaar).
 */
export function buildSolanaOnlyRoutes(config: SolanaRailConfig, routes: RoutesConfig, atomicUsdc: string): RoutesConfig {
  const out: Record<string, RouteConfig> = {};
  for (const [key, cfg] of Object.entries(routes as Record<string, RouteConfig>)) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { extensions: _bazaar, ...rest } = cfg;
    out[key] = {
      ...rest,
      accepts: [
        {
          scheme: "exact",
          network: config.network,
          payTo: config.payTo,
          price: solanaPrice(atomicUsdc),
          maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
        },
      ],
    };
  }
  return out;
}

let paidHandlers = new WeakMap<object, { rail: Rail; handler: AppRouteHandler }>();

/**
 * Copy of the payment payload with any `extensions.bazaar` removed (the
 * client echoes the Base 402's Bazaar block; it must never reach PayAI).
 * Returns the same object when there is nothing to strip.
 */
export function stripBazaar(payload: PaymentPayload): PaymentPayload {
  const ext = (payload as { extensions?: Record<string, unknown> }).extensions;
  if (!ext || typeof ext !== "object" || !("bazaar" in ext)) return payload;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { bazaar: _dropped, ...rest } = ext;
  const out = { ...payload } as PaymentPayload & { extensions?: Record<string, unknown> };
  if (Object.keys(rest).length > 0) out.extensions = rest;
  else delete out.extensions;
  return out;
}

function withPaymentSignature(req: NextRequest, payload: PaymentPayload): NextRequest {
  const headers = new Headers(req.headers);
  headers.set("payment-signature", encodePaymentSignatureHeader(payload));
  headers.delete("x-payment");
  return new NextRequestCtor(req.url, { method: req.method, headers, body: req.body, duplex: "half" } as never);
}

export type WireCheck = { ok: true } | { ok: false; reason: string };
const fail = (reason: string): WireCheck => ({ ok: false, reason });

/**
 * Offline envelope preflight before anything is forwarded to PayAI. The
 * transaction itself (TransferChecked to payTo's USDC ATA, amount, fee payer,
 * compute budget, signatures, simulation) is checked by the facilitator.
 */
export function validateSolanaPaymentPayload(payload: PaymentPayload, requirement: PaymentRequirements): WireCheck {
  if (!payload || payload.x402Version !== 2) return fail("x402Version must be 2");
  const accepted = payload.accepted;
  if (!accepted || accepted.scheme !== "exact") return fail("accepted.scheme must be exact");
  for (const f of ["scheme", "network", "asset", "payTo", "amount", "maxTimeoutSeconds"] as const) {
    if (accepted[f] !== requirement[f]) return fail(`accepted.${f} does not match requirements`);
  }
  const aFee = (accepted.extra as Record<string, unknown> | undefined)?.feePayer;
  const rFee = (requirement.extra as Record<string, unknown> | undefined)?.feePayer;
  if (aFee !== rFee) return fail("accepted.extra.feePayer does not match requirements");
  const tx = (payload.payload as Record<string, unknown> | undefined)?.transaction;
  if (typeof tx !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(tx)) return fail("payload.transaction must be base64");
  const len = Buffer.from(tx, "base64").length;
  if (len === 0 || len > MAX_TX_BYTES) return fail(`payload.transaction is ${len} bytes`);
  return { ok: true };
}

/**
 * Serve a Solana-paid request through the Solana-only server. Returns null
 * when the rail is unavailable, the payload fails the preflight, the Solana
 * server answers 402 (rejected / settle failed), or the path throws; the
 * caller then serves the Base-only 402.
 */
export async function handleSolanaPayment(
  req: NextRequest,
  routeHandler: AppRouteHandler,
  routes: RoutesConfig,
  atomicUsdc: string,
  config: SolanaRailConfig,
): Promise<NextResponse | null> {
  try {
    if (!(await solanaTokenAccountReady(config))) return null;
    const rail = await getRail(config);
    if (!rail) return null;

    const requirement = await buildSolanaRequirement(rail, atomicUsdc);
    const received = decodePaymentSignatureHeader(req.headers.get("payment-signature")!.trim()) as PaymentPayload;
    const payload = stripBazaar(received);
    const check = validateSolanaPaymentPayload(payload, requirement);
    if (!check.ok) {
      warn(`rejected Solana payload before facilitator (${check.reason})`);
      return null;
    }

    let entry = paidHandlers.get(routes as object);
    if (!entry || entry.rail !== rail) {
      // syncFacilitatorOnStart=false: rail.server was already initialized.
      entry = {
        rail,
        handler: withX402(routeHandler, buildSolanaOnlyRoutes(rail.config, routes, atomicUsdc), rail.server, undefined, undefined, false),
      };
      paidHandlers.set(routes as object, entry);
    }
    const res = await entry.handler(payload === received ? req : withPaymentSignature(req, payload));
    if (res.status === 402) {
      let reason = "";
      try {
        const pr = decodePaymentRequiredHeader(res.headers.get("payment-required") ?? "");
        reason = typeof pr.error === "string" ? ` error=${pr.error}` : "";
      } catch {
        /* no header */
      }
      warn(`Solana payment not accepted (402 from Solana server${reason})`);
      return null;
    }
    return res;
  } catch (err) {
    warn("Solana payment path threw", err);
    return null;
  }
}
