/**
 * XRPL RLUSD rail: runtime half (see lib/xrpl-config.ts for the flag).
 *
 * Isolation contract (the Base path must never notice this file):
 *   - @x402/xrpl is imported lazily (dynamic import) and only when the flag
 *     is on; an import failure just turns the rail off.
 *   - The XRPL rail has its OWN x402ResourceServer whose ONLY facilitator is
 *     the XRPL one (wrapped so it advertises/accepts nothing but the
 *     configured xrpl:N network). The Base server in lib/x402-server.ts keeps
 *     the CDP facilitator as its only client and never sees XRPL. So a Base
 *     payload can only reach CDP and an XRPL payload can only reach the XRPL
 *     facilitator, even through @x402/core's "try every client" fallback.
 *   - Every exported entry point catches everything. On any XRPL failure
 *     (import, bad env, facilitator down/timeout, verify/settle throw) callers
 *     get the untouched Base-only 402 and a console.warn.
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
  RLUSD_CURRENCY_HEX,
  RLUSD_MAINNET_ISSUER,
  XRPL_MAINNET_CAIP2,
  type XrplRailConfig,
  usdcAtomicToRlusdValue,
} from "./xrpl-config";

const LOG = "[xrpl-rail]";
const RETRY_AFTER_MS = 60_000;
/** Same default @x402/core applies to the Base entry. */
const MAX_TIMEOUT_SECONDS = 300;
const TF_PARTIAL_PAYMENT = 0x00020000;

// ---------------------------------------------------------------------------
// Lazy package loading (test-overridable)
// ---------------------------------------------------------------------------

type DecodedTx = Record<string, unknown>;

export type XrplModules = {
  ExactXrplScheme: new () => SchemeNetworkServer;
  RLUSD_TESTNET_ISSUER: string;
  RLUSD_MAINNET_ISSUER: string;
  RLUSD_CURRENCY: string;
  decodeSignedTransactionBlob: (blob: string) => unknown;
  compareDecimalStrings: (a: string, b: string) => number;
};

async function defaultLoader(): Promise<XrplModules> {
  const [server, root] = await Promise.all([import("@x402/xrpl/exact/server"), import("@x402/xrpl")]);
  return {
    ExactXrplScheme: server.ExactXrplScheme,
    RLUSD_TESTNET_ISSUER: root.RLUSD_TESTNET_ISSUER,
    RLUSD_MAINNET_ISSUER: root.RLUSD_MAINNET_ISSUER,
    RLUSD_CURRENCY: root.RLUSD_CURRENCY,
    decodeSignedTransactionBlob: root.decodeSignedTransactionBlob,
    compareDecimalStrings: root.compareDecimalStrings,
  };
}

let loader: () => Promise<XrplModules> = defaultLoader;

/** Tests only: swap the package loader (e.g. to simulate an import failure). */
export function __setXrplModuleLoaderForTests(fn: (() => Promise<XrplModules>) | null): void {
  loader = fn ?? defaultLoader;
  resetXrplRailForTests();
}

export function resetXrplRailForTests(): void {
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
// XRPL-only facilitator client
// ---------------------------------------------------------------------------

/**
 * Wraps the XRPL facilitator so it can only ever be used for the configured
 * xrpl:N network: getSupported is filtered to that network, and verify/settle
 * refuse anything else. Registered as the sole client of the XRPL server.
 */
export class XrplOnlyFacilitatorClient implements FacilitatorClient {
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
      throw new Error(`XRPL facilitator does not list exact on ${this.network}`);
    }
    return { ...supported, kinds };
  }

  private guard(payload: PaymentPayload, requirements: PaymentRequirements): void {
    if (requirements.network !== this.network || payload.accepted?.network !== this.network) {
      throw new Error(`XRPL facilitator refuses non-${this.network} payment`);
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
  config: XrplRailConfig;
  server: x402ResourceServer;
  mods: XrplModules;
  issuer: string;
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

async function initRail(config: XrplRailConfig): Promise<Rail> {
  const mods = await loader();
  // The issuer we advertise: our pinned public mainnet constant, or the
  // package's testnet constant. Cross-check mainnet against the package.
  if (config.network === XRPL_MAINNET_CAIP2 && mods.RLUSD_MAINNET_ISSUER !== RLUSD_MAINNET_ISSUER) {
    throw new Error("RLUSD mainnet issuer mismatch between repo constant and @x402/xrpl");
  }
  if (mods.RLUSD_CURRENCY !== RLUSD_CURRENCY_HEX) {
    throw new Error("RLUSD currency code mismatch between repo constant and @x402/xrpl");
  }
  const issuer = config.network === XRPL_MAINNET_CAIP2 ? RLUSD_MAINNET_ISSUER : mods.RLUSD_TESTNET_ISSUER;
  const facilitator = new XrplOnlyFacilitatorClient(
    new HTTPFacilitatorClient({ url: config.facilitatorUrl, timeoutMs: 30_000 }),
    config.network,
  );
  const server = new x402ResourceServer(facilitator).register(config.network, new mods.ExactXrplScheme());
  await server.initialize();
  return { config, server, mods, issuer };
}

async function getRail(config: XrplRailConfig): Promise<Rail | null> {
  const key = JSON.stringify(config);
  if (failedKey === key && Date.now() < failedUntil) return null;
  if (railKey !== key || !railPromise) {
    railKey = key;
    railPromise = withTimeout(initRail(config), config.initTimeoutMs, "XRPL rail init");
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

function xrplPrice(rail: Rail, atomicUsdc: string): AssetAmount {
  return {
    amount: usdcAtomicToRlusdValue(atomicUsdc),
    asset: RLUSD_CURRENCY_HEX,
    extra: { issuer: rail.issuer },
  };
}

function xrplExtra(rail: Rail): Record<string, unknown> | undefined {
  return rail.config.assetTransferMethod ? { assetTransferMethod: rail.config.assetTransferMethod } : undefined;
}

async function buildXrplRequirement(rail: Rail, atomicUsdc: string): Promise<PaymentRequirements> {
  const [req] = await rail.server.buildPaymentRequirements({
    scheme: "exact",
    network: rail.config.network,
    payTo: rail.config.payTo,
    price: xrplPrice(rail, atomicUsdc),
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: xrplExtra(rail),
  });
  if (!req) throw new Error("no XRPL requirement built");
  return req;
}

/**
 * The RLUSD `accepts` entry for a route priced at `atomicUsdc` (USDC 6-dec
 * units), or null if the rail is unavailable. Never throws.
 */
export async function getXrplAccept(config: XrplRailConfig, atomicUsdc: string): Promise<PaymentRequirements | null> {
  try {
    const rail = await getRail(config);
    if (!rail) return null;
    return await buildXrplRequirement(rail, atomicUsdc);
  } catch (err) {
    warn("could not build RLUSD requirement", err);
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
    /* non-JSON body (e.g. {} is JSON; HTML never reaches here): keep as is */
  }

  const headers = new Headers(res.headers);
  headers.set("PAYMENT-REQUIRED", encodePaymentRequiredHeader(pr));
  headers.delete("content-length");
  return new NextResponse(body, { status: res.status, headers });
}

/**
 * Flag-on helper for unpaid 402s and OPTIONS: append the RLUSD entry, or
 * return `res` untouched (same object) if anything at all goes wrong.
 */
export async function withXrplAccept<T extends Response>(
  res: T,
  config: XrplRailConfig,
  atomicUsdc: string,
): Promise<T | NextResponse> {
  try {
    const accept = await getXrplAccept(config, atomicUsdc);
    if (!accept) return res;
    return await appendAccept(res, accept);
  } catch (err) {
    warn("could not append RLUSD requirement", err);
    return res;
  }
}

// ---------------------------------------------------------------------------
// Paid path
// ---------------------------------------------------------------------------

/** True when the request carries a v2 PAYMENT-SIGNATURE whose accepted network is XRPL. Never throws. */
export function isXrplPaymentRequest(req: NextRequest): boolean {
  try {
    const raw = req.headers.get("payment-signature");
    if (!raw || !raw.trim()) return false;
    const payload = decodePaymentSignatureHeader(raw.trim()) as Partial<PaymentPayload>;
    const net = payload?.accepted?.network;
    return payload?.x402Version === 2 && typeof net === "string" && net.startsWith("xrpl:");
  } catch {
    return false;
  }
}

type AppRouteHandler = (req: NextRequest) => Promise<NextResponse>;

/** Same route keys/descriptions/extensions, but the only accept is the RLUSD one. */
function xrplOnlyRoutes(rail: Rail, routes: RoutesConfig, atomicUsdc: string): RoutesConfig {
  const out: Record<string, RouteConfig> = {};
  for (const [key, cfg] of Object.entries(routes as Record<string, RouteConfig>)) {
    out[key] = {
      ...cfg,
      accepts: [
        {
          scheme: "exact",
          network: rail.config.network,
          payTo: rail.config.payTo,
          price: xrplPrice(rail, atomicUsdc),
          maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
          extra: xrplExtra(rail),
        },
      ],
    };
  }
  return out;
}

let paidHandlers = new WeakMap<object, { rail: Rail; handler: AppRouteHandler }>();

/**
 * Serve an XRPL-paid request through the XRPL-only server. Returns null when
 * the rail is unavailable, the payload fails the spec wire-format preflight,
 * or the XRPL path throws; the caller then serves the Base-only 402.
 */
export async function handleXrplPayment(
  req: NextRequest,
  routeHandler: AppRouteHandler,
  routes: RoutesConfig,
  atomicUsdc: string,
  config: XrplRailConfig,
): Promise<NextResponse | null> {
  try {
    const rail = await getRail(config);
    if (!rail) return null;

    const requirement = await buildXrplRequirement(rail, atomicUsdc);
    const payload = decodePaymentSignatureHeader(req.headers.get("payment-signature")!.trim()) as PaymentPayload;
    const check = validateXrplPaymentPayload(payload, requirement, rail.mods);
    if (!check.ok) {
      warn(`rejected XRPL payload before facilitator (${check.reason})`);
      return null;
    }

    let entry = paidHandlers.get(routes as object);
    if (!entry || entry.rail !== rail) {
      // syncFacilitatorOnStart=false: rail.server was already initialized.
      entry = { rail, handler: withX402(routeHandler, xrplOnlyRoutes(rail, routes, atomicUsdc), rail.server, undefined, undefined, false) };
      paidHandlers.set(routes as object, entry);
    }
    return await entry.handler(req);
  } catch (err) {
    warn("XRPL payment path threw", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Spec wire-format preflight (x402 specs/schemes/exact/scheme_exact_xrpl.md)
// ---------------------------------------------------------------------------

export type WireCheck = { ok: true; tx: DecodedTx } | { ok: false; reason: string };

const fail = (reason: string): WireCheck => ({ ok: false, reason });

function isIssuedAmount(v: unknown): v is { currency: string; issuer: string; value: string } {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as Record<string, unknown>).currency === "string" &&
    typeof (v as Record<string, unknown>).issuer === "string" &&
    typeof (v as Record<string, unknown>).value === "string"
  );
}

/**
 * Offline, static subset of the spec's facilitator MUST-checks for an IOU
 * (RLUSD) exact payment. It runs BEFORE we forward to the facilitator so
 * malformed or non-spec payloads (e.g. t54-style Memos binding) are dropped
 * early. Signature, sequence/ticket availability, LastLedgerSequence window,
 * fee policy and simulation stay with the facilitator (they need the ledger).
 */
export function validateXrplPaymentPayload(
  payload: PaymentPayload,
  requirement: PaymentRequirements,
  mods: Pick<XrplModules, "decodeSignedTransactionBlob" | "compareDecimalStrings">,
): WireCheck {
  // §1 envelope
  if (!payload || payload.x402Version !== 2) return fail("x402Version must be 2");
  const accepted = payload.accepted;
  if (!accepted || accepted.scheme !== "exact") return fail("accepted.scheme must be exact");
  for (const f of ["scheme", "network", "asset", "payTo", "amount", "maxTimeoutSeconds"] as const) {
    if (accepted[f] !== requirement[f]) return fail(`accepted.${f} does not match requirements`);
  }
  const aExtra = (accepted.extra ?? {}) as Record<string, unknown>;
  const rExtra = (requirement.extra ?? {}) as Record<string, unknown>;
  if (aExtra.areFeesSponsored !== false) return fail("accepted.extra.areFeesSponsored must be false");
  if (aExtra.issuer !== rExtra.issuer) return fail("accepted.extra.issuer does not match");
  const reqMethod = rExtra.assetTransferMethod;
  const method = aExtra.assetTransferMethod ?? reqMethod ?? "sequence";
  if (method !== "sequence" && method !== "ticketSequence") return fail("unsupported assetTransferMethod");
  if (reqMethod !== undefined && method !== reqMethod) return fail("assetTransferMethod differs from requirements");

  const blob = (payload.payload as Record<string, unknown> | undefined)?.signedTxBlob;
  if (typeof blob !== "string" || !/^(?:[0-9A-Fa-f]{2})+$/.test(blob)) return fail("payload.signedTxBlob must be hex");

  // §2 decode
  let tx: DecodedTx;
  try {
    tx = mods.decodeSignedTransactionBlob(blob) as DecodedTx;
  } catch {
    return fail("signedTxBlob does not decode");
  }

  // §3 type, §4 destination, §5 network binding (xrpl:0/1 are <= 1024)
  if (tx.TransactionType !== "Payment") return fail("TransactionType must be Payment");
  if (tx.Destination !== requirement.payTo) return fail("Destination does not match payTo");
  if (rExtra.destinationTag !== undefined && tx.DestinationTag !== rExtra.destinationTag) {
    return fail("DestinationTag does not match");
  }
  if (tx.NetworkID !== undefined) return fail("NetworkID must be omitted on standard networks");

  // §6 amount (IOU)
  const hasAmount = tx.Amount !== undefined;
  const hasDeliverMax = tx.DeliverMax !== undefined;
  if (hasAmount && hasDeliverMax) return fail("both Amount and DeliverMax present");
  if (!hasAmount && !hasDeliverMax) return fail("neither Amount nor DeliverMax present");
  const dest = hasDeliverMax ? tx.DeliverMax : tx.Amount;
  if (!isIssuedAmount(dest)) return fail("destination amount must be an issued-currency object");
  if (dest.currency !== requirement.asset) return fail("currency does not match asset");
  if (dest.issuer !== rExtra.issuer) return fail("issuer does not match");
  if (mods.compareDecimalStrings(dest.value, requirement.amount) !== 0) return fail("value does not match amount");
  const sendMax = tx.SendMax;
  if (!isIssuedAmount(sendMax)) return fail("SendMax must be present for IOU payments");
  if (sendMax.currency !== dest.currency || sendMax.issuer !== dest.issuer) return fail("SendMax must be the same issued currency");
  if (mods.compareDecimalStrings(sendMax.value, dest.value) < 0) return fail("SendMax below destination amount");

  // §9 safety
  if (tx.Paths !== undefined) return fail("Paths present");
  if (tx.DeliverMin !== undefined) return fail("DeliverMin present");
  if (tx.Memos !== undefined) return fail("Memos present (spec forbids Memos; use InvoiceID)");
  if (tx.Delegate !== undefined) return fail("Delegate present");
  const flags = typeof tx.Flags === "number" ? tx.Flags : 0;
  if ((flags & TF_PARTIAL_PAYMENT) !== 0) return fail("tfPartialPayment set");

  // §7 expiry + sequencing (static part)
  if (typeof tx.LastLedgerSequence !== "number") return fail("LastLedgerSequence missing");
  if (method === "sequence") {
    if (tx.TicketSequence !== undefined) return fail("TicketSequence present with sequence method");
  } else {
    if (tx.Sequence !== 0) return fail("Sequence must be 0 with ticketSequence method");
    if (typeof tx.TicketSequence !== "number") return fail("TicketSequence missing");
  }

  return { ok: true, tx };
}

/** Convenience for callers without a loaded rail (tests, tooling). */
export async function checkXrplPaymentWireFormat(
  payload: PaymentPayload,
  requirement: PaymentRequirements,
): Promise<WireCheck> {
  return validateXrplPaymentPayload(payload, requirement, await loader());
}
