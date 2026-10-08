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
 *     bounded wait (initTimeoutMs) per instance per window.
 */
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
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
} from "@x402/core/http";
import { withX402 } from "@x402/next";
import {
  SOLANA_MAINNET_CAIP2,
  SOLANA_PAYTO,
  USDC_SOLANA_MINT,
  isValidSolanaPubkey,
  type SolanaRailConfig,
} from "./solana-config";

const LOG = "[solana-rail]";
const RETRY_AFTER_MS = 60_000;
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
};

async function defaultLoader(): Promise<SolanaModules> {
  const [server, root] = await Promise.all([import("@x402/svm/exact/server"), import("@x402/svm")]);
  return {
    ExactSvmScheme: server.ExactSvmScheme as unknown as new () => SchemeNetworkServer,
    SOLANA_MAINNET_CAIP2: root.SOLANA_MAINNET_CAIP2,
    USDC_MAINNET_ADDRESS: root.USDC_MAINNET_ADDRESS,
  };
}

let loader: () => Promise<SolanaModules> = defaultLoader;

/** Tests only: swap the package loader (e.g. to simulate an import failure). */
export function __setSolanaModuleLoaderForTests(fn: (() => Promise<SolanaModules>) | null): void {
  loader = fn ?? defaultLoader;
  resetSolanaRailForTests();
}

export function resetSolanaRailForTests(): void {
  railKey = null;
  railPromise = null;
  failedKey = null;
  failedUntil = 0;
  paidHandlers = new WeakMap();
}

function warn(msg: string, err?: unknown): void {
  const detail = err instanceof Error ? err.message : err === undefined ? "" : String(err);
  console.warn(`${LOG} ${msg}${detail ? `: ${detail}` : ""} (serving Base-only)`);
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
    const supported = await this.inner.getSupported();
    const kinds = (supported.kinds ?? []).filter(
      (k) => k.x402Version === 2 && k.scheme === "exact" && k.network === this.network,
    );
    if (kinds.length === 0) {
      throw new Error(`PayAI does not list x402 v2 exact on ${this.network}`);
    }
    const feePayer = (kinds[0].extra as { feePayer?: unknown } | undefined)?.feePayer;
    if (!isValidSolanaPubkey(feePayer)) {
      throw new Error("PayAI exact kind has no valid extra.feePayer");
    }
    const signers = Object.fromEntries(
      Object.entries(supported.signers ?? {}).filter(([k]) => k.startsWith("solana:")),
    );
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
    return this.inner.verify(payload, requirements);
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    this.guard(payload, requirements);
    return this.inner.settle(payload, requirements);
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
  if (railKey !== key || !railPromise) {
    railKey = key;
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
function solanaOnlyRoutes(rail: Rail, routes: RoutesConfig, atomicUsdc: string): RoutesConfig {
  const out: Record<string, RouteConfig> = {};
  for (const [key, cfg] of Object.entries(routes as Record<string, RouteConfig>)) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { extensions: _bazaar, ...rest } = cfg;
    out[key] = {
      ...rest,
      accepts: [
        {
          scheme: "exact",
          network: rail.config.network,
          payTo: rail.config.payTo,
          price: solanaPrice(atomicUsdc),
          maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
        },
      ],
    };
  }
  return out;
}

let paidHandlers = new WeakMap<object, { rail: Rail; handler: AppRouteHandler }>();

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
    const rail = await getRail(config);
    if (!rail) return null;

    const requirement = await buildSolanaRequirement(rail, atomicUsdc);
    const payload = decodePaymentSignatureHeader(req.headers.get("payment-signature")!.trim()) as PaymentPayload;
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
        handler: withX402(routeHandler, solanaOnlyRoutes(rail, routes, atomicUsdc), rail.server, undefined, undefined, false),
      };
      paidHandlers.set(routes as object, entry);
    }
    const res = await entry.handler(req);
    if (res.status === 402) {
      warn("Solana payment not accepted (402 from Solana server)");
      return null;
    }
    return res;
  } catch (err) {
    warn("Solana payment path threw", err);
    return null;
  }
}
