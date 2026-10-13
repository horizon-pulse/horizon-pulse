/**
 * XRPL RLUSD rail: runtime half (see lib/xrpl-config.ts for the flag).
 *
 * Same structure as the Solana rail (lib/solana-rail.ts, Odin-reviewed
 * 2026-10-08), adapted to the x402 exact-XRPL spec:
 *
 * Isolation contract (the Base path must never notice this file):
 *   - @x402/xrpl (and through it `xrpl`) is imported lazily (dynamic import)
 *     and only when the flag is on; an import failure just turns the rail off.
 *   - The XRPL rail has its OWN x402ResourceServer whose ONLY facilitator is
 *     the configured XRPL facilitator, wrapped so it advertises/accepts nothing
 *     but v2 `exact` on the configured xrpl:N, refuses any payTo/asset/issuer
 *     but the pinned ones, and reports no extensions (so this server never
 *     declares or enriches Bazaar: CDP/Base stays the only Bazaar-indexed
 *     entry). The Base server in lib/x402-server.ts keeps the CDP facilitator
 *     as its only client and never sees XRPL. A Base payload can only reach
 *     CDP and an XRPL payload can only reach the XRPL facilitator.
 *   - Every exported entry point catches everything. On any XRPL failure
 *     before money can move (import, bad env, facilitator down/timeout/missing
 *     kind, unexpected requirement, verify-phase error) callers get the
 *     untouched pre-XRPL 402 (main's) and a console.warn; see "Paid-path
 *     outcomes" below for the settle phase and handler throws.
 *   - Failed init is cached for RETRY_AFTER_MS so an outage costs at most one
 *     bounded wait (initTimeoutMs) per instance per window. A good init is
 *     refreshed every RAIL_TTL_MS (re-fetches the facilitator's /supported).
 *   - payTo readiness guard (the Solana token-account guard's XRPL twin): the
 *     XRPL entry is shown ONLY while the pinned payTo account exists on the
 *     configured network AND holds an RLUSD trust line to the issuer (limit
 *     > 0, not frozen) AND does not require a destination tag / deposit
 *     authorization. Read-only JSON-RPC (account_info + account_lines),
 *     cached READY_TTL_MS (~10 min), so it flips on by itself once Michael
 *     activates the account and adds the trust line (no redeploy). Absent /
 *     RPC error → hidden.
 *   - Incoming XRPL payloads have any `extensions.bazaar` stripped before
 *     they reach the facilitator.
 *   - Facilitator rejections are logged with REASON CODES ONLY (R1): a code is
 *     kept only if it matches /^[a-z0-9_]+$/ (else "unrecognized"); facilitator
 *     free text is never logged, and errors are re-thrown scrubbed at the
 *     wrapper boundary so x402 core's own console.warn cannot leak them.
 *   - Paid-path outcomes (same table as the Solana rail):
 *       verify phase (nothing charged): any rejection, throw, timeout or
 *         malformed response → exactly main's Base-only 402;
 *       settle DEFINITIVE failure (success:false / 4xx SettleError, no tx hash,
 *         not pending) → Base-only 402;
 *       settle AMBIGUOUS (timeout, transport error, malformed response,
 *         settlement_pending, duplicate_settlement, 5xx/429/409, or a tx hash
 *         with success:false) → generic 504 (timeout) / 502
 *         {"error":"settlement_unconfirmed"}, NEVER a 402 (a 402 would invite
 *         the client to pay twice);
 *       route handler throws → re-thrown, same as the Base path (Next 500).
 *   - Replay guard: one request per XRPL payment slot. Keyed on sha256 of
 *     (network, payer Account, Sequence or TicketSequence) decoded from the
 *     signed blob, i.e. the slot only one transaction can ever consume, so a
 *     re-encoded or re-signed variant is the same payment. Checked BEFORE
 *     verify; kept REPLAY_TTL_MS; a duplicate gets 409
 *     {"error":"duplicate_payment"}. Released when nothing was charged.
 *     Cross-instance: after a successful settle the tx's ledger close time is
 *     read (read-only `tx`); closed before this request started (minus
 *     REPLAY_CONFIRM_SKEW_MS) → 409. RPC error / unknown → fail open.
 *   - Ops alert: ≥ WARN_ALERT_THRESHOLD [xrpl-rail] warnings in
 *     WARN_ALERT_WINDOW_MS → one setXrplAlertHook call (default console.error).
 */
import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { RAIL_REJECT, reasonFromRailResponse, settleFailReason, type OnReject } from "./rail-reject";
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
import { FacilitatorResponseError, FacilitatorTimeoutError, SettleError, VerifyError } from "@x402/core/types";
import { withX402 } from "@x402/next";
import {
  RLUSD_CURRENCY_HEX,
  RLUSD_MAINNET_ISSUER,
  RLUSD_TESTNET_ISSUER,
  XRPL_MAINNET_CAIP2,
  XRPL_MAX_INIT_TIMEOUT_MS,
  XRPL_SELF_FACILITATOR,
  XRPL_SELF_WS_URL,
  XRPL_TESTNET_CAIP2,
  assertXrplPairing,
  isLegalXrplPairing,
  xrplPayToFor,
  isValidXrplClassicAddress,
  usdcAtomicToRlusdValue,
  type XrplRailConfig,
} from "./xrpl-config";
import { createReplayStore, type ReplayState, type ReplayStore } from "./xrpl-replay-store";
import { runOnPaidRail, xrplRail } from "./paid-rail";

const LOG = "[xrpl-rail]";
const RETRY_AFTER_MS = 60_000;
/** Re-initialise a good rail (re-fetch the facilitator's /supported) this often. */
export const RAIL_TTL_MS = 10 * 60_000;
/** payTo readiness result (ready or not) is cached this long. */
export const READY_TTL_MS = 10 * 60_000;
/** RPC error → cached as "not ready" for this long before retrying. */
const READY_ERROR_RETRY_MS = 60_000;
/** Max age of a confirmed ready=true kept through transient RPC failures. */
export const READY_STALE_MAX_MS = 60 * 60_000;
/** Same default @x402/core applies to the Base entry. */
export const MAX_TIMEOUT_SECONDS = 300;
/** Upper bound on the signed blob we forward (a single-signed Payment is ~250 bytes; multisig more). */
export const MAX_SIGNED_TX_BYTES = 4096;
const TF_PARTIAL_PAYMENT = 0x00020000;
/** AccountRoot flags that would make an x402 RLUSD payment to payTo fail. */
export const LSF_REQUIRE_DEST_TAG = 0x00020000;
export const LSF_DEPOSIT_AUTH = 0x01000000;
/**
 * Facilitator deadlines. XRPL settle waits for a VALIDATED result (spec
 * §Settlement; ledgers close every ~3-5 s), so settle gets more room than the
 * Solana rail's 12 s. A timeout here is the ambiguous 504 above.
 */
export const XRPL_VERIFY_TIMEOUT_MS = 6_000;
export const XRPL_SETTLE_TIMEOUT_MS = 20_000; // testnet e2e 2026-10-12: settle p50 8.1 s, max 10.7 s (incl. its internal re-verify)
/** Replay guard retention (≥ maxTimeoutSeconds; same 25 h as the Solana rail). */
export const REPLAY_TTL_MS = 25 * 60 * 60_000;
/** Cross-instance check: ledger close time must not be earlier than request start minus this. */
export const REPLAY_CONFIRM_SKEW_MS = 30_000;
/** XRPL "ripple epoch" (2000-01-01T00:00:00Z) in Unix ms. */
const RIPPLE_EPOCH_MS = 946_684_800_000;
/** Warn-rate alert: this many [xrpl-rail] warnings inside the window. */
export const WARN_ALERT_THRESHOLD = 20;
export const WARN_ALERT_WINDOW_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Lazy package loading (test-overridable)
// ---------------------------------------------------------------------------

type DecodedTx = Record<string, unknown>;

export type XrplModules = {
  ExactXrplScheme: new () => SchemeNetworkServer;
  XRPL_MAINNET: string;
  XRPL_TESTNET: string;
  RLUSD_TESTNET_ISSUER: string;
  RLUSD_MAINNET_ISSUER: string;
  RLUSD_CURRENCY: string;
  decodeSignedTransactionBlob: (blob: string) => unknown;
  compareDecimalStrings: (a: string, b: string) => number;
};

async function defaultLoader(): Promise<XrplModules> {
  const [server, root] = await Promise.all([import("@x402/xrpl/exact/server"), import("@x402/xrpl")]);
  return {
    ExactXrplScheme: server.ExactXrplScheme as unknown as new () => SchemeNetworkServer,
    XRPL_MAINNET: root.XRPL_MAINNET,
    XRPL_TESTNET: root.XRPL_TESTNET,
    RLUSD_TESTNET_ISSUER: root.RLUSD_TESTNET_ISSUER,
    RLUSD_MAINNET_ISSUER: root.RLUSD_MAINNET_ISSUER,
    RLUSD_CURRENCY: root.RLUSD_CURRENCY,
    decodeSignedTransactionBlob: root.decodeSignedTransactionBlob,
    compareDecimalStrings: root.compareDecimalStrings,
  };
}

let loader: () => Promise<XrplModules> = defaultLoader;

/** Tests only: the real lazy loader (to wrap/tamper with in isolation tests). */
export const __loadRealXrplModulesForTests = defaultLoader;

/** Tests only: swap the package loader (e.g. to simulate an import failure). */
export function __setXrplModuleLoaderForTests(fn: (() => Promise<XrplModules>) | null): void {
  loader = fn ?? defaultLoader;
  resetXrplRailForTests();
}

// ---------------------------------------------------------------------------
// Read-only JSON-RPC (test-overridable)
// ---------------------------------------------------------------------------

/** rippled JSON-RPC: returns `result` (which may itself carry status:"error"). */
export type XrplRpc = (url: string, method: string, params: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;

async function defaultRpc(url: string, method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params: [params] }),
    // Never follow a redirect (a 307/308 could bounce the POST anywhere).
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const json = (await res.json()) as { result?: unknown };
  if (!json || typeof json !== "object" || !("result" in json)) throw new Error("RPC malformed response");
  return json.result;
}

let rpc: XrplRpc = defaultRpc;

/** Tests only: the real fetch-based RPC (to assert its fetch options). */
export const __defaultXrplRpcForTests = defaultRpc;

/** Tests only: swap the read-only RPC (null = real fetch). Also clears the readiness cache. */
export function __setXrplRpcForTests(fn: XrplRpc | null): void {
  rpc = fn ?? defaultRpc;
  readyCache = null;
  readyRefresh = null;
}

let timeouts = { verifyMs: XRPL_VERIFY_TIMEOUT_MS, settleMs: XRPL_SETTLE_TIMEOUT_MS };

/** Tests only: shorten the facilitator deadlines to exercise a REAL FacilitatorTimeoutError (null = defaults). */
export function __setXrplFacilitatorTimeoutsForTests(t: { verifyMs: number; settleMs: number } | null): void {
  timeouts = t ?? { verifyMs: XRPL_VERIFY_TIMEOUT_MS, settleMs: XRPL_SETTLE_TIMEOUT_MS };
  resetXrplRailForTests();
}

export function resetXrplRailForTests(): void {
  railState = null;
  railInit = null;
  failedKey = null;
  failedUntil = 0;
  readyCache = null;
  readyRefresh = null;
  paidHandlers = new WeakMap();
  replay = createReplayStore();
  replayWarned = false;
  txLookupDelays = [0, 1, 1, 1]; // tests: same retry count, no real sleep
  attempts.clear();
  warnTimes = [];
  warnAlertedAt = 0;
  alertHook = defaultAlertHook;
}

/** Tests only: wait for every background refresh (payTo readiness, rail) to settle. */
export async function __flushXrplBackgroundForTests(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const pending = [readyRefresh, railInit?.promise].filter(Boolean);
    if (pending.length === 0) return;
    await Promise.allSettled(pending);
  }
}

/**
 * Strip anything that could identify a payer or transaction from a log line:
 * XRPL classic addresses, long hex (≥ 20: tx hashes, blobs; the 16-hex fp=
 * fingerprint survives), long base64. Keeps reason codes. Max 200 chars.
 */
export function redact(text: string): string {
  return text
    .replace(/r[1-9A-HJ-NP-Za-km-z]{24,34}/g, "<addr>")
    .replace(/(?:0x)?[0-9a-fA-F]{20,}/g, "<hex>")
    .replace(/[A-Za-z0-9+/]{60,}={0,2}/g, "<b64>")
    .slice(0, 200);
}

// ---------------------------------------------------------------------------
// Ops alerts (warn rate)
// ---------------------------------------------------------------------------

export type XrplAlert = { kind: "warn_rate"; count: number; windowMs: number; threshold: number };

function defaultAlertHook(alert: XrplAlert): void {
  console.error(`${LOG}[ALERT] ${JSON.stringify(alert)}`);
}

let alertHook: (alert: XrplAlert) => void = defaultAlertHook;

/** Route [xrpl-rail] alerts somewhere else (pager, webhook). null = default console.error line. */
export function setXrplAlertHook(fn: ((alert: XrplAlert) => void) | null): void {
  alertHook = fn ?? defaultAlertHook;
}

let warnTimes: number[] = [];
let warnAlertedAt = 0;

function noteWarn(): void {
  const now = Date.now();
  warnTimes.push(now);
  const cutoff = now - WARN_ALERT_WINDOW_MS;
  while (warnTimes.length && warnTimes[0] <= cutoff) warnTimes.shift();
  if (warnTimes.length >= WARN_ALERT_THRESHOLD && now - warnAlertedAt >= WARN_ALERT_WINDOW_MS) {
    warnAlertedAt = now;
    try {
      alertHook({ kind: "warn_rate", count: warnTimes.length, windowMs: WARN_ALERT_WINDOW_MS, threshold: WARN_ALERT_THRESHOLD });
    } catch {
      /* an alert sink must never break a request */
    }
  }
}

function warn(msg: string, err?: unknown, fallback = true): void {
  // R1: a facilitator/SDK error never contributes free text to a log line.
  const facilitatorShaped =
    err instanceof FacilitatorResponseError ||
    err instanceof SettleError ||
    err instanceof VerifyError ||
    (err instanceof Error && err.message.startsWith("Facilitator "));
  const detail = facilitatorShaped
    ? (facilitatorErrorDetail(err) ?? "")
    : err instanceof Error
      ? err.message
      : err === undefined
        ? ""
        : String(err);
  console.warn(`${LOG} ${redact(msg)}${detail ? `: ${redact(detail)}` : ""}${fallback ? " (serving Base-only)" : ""}`);
  noteWarn();
}

// ---------------------------------------------------------------------------
// Per-payment attempt record (replay key → what happened)
// ---------------------------------------------------------------------------

type SettleOutcome = { outcome: "success" | "failed" | "unconfirmed"; reason: string; raw: string; timeout: boolean; transaction?: string };
type Attempt = {
  handlerRan: boolean;
  handlerThrew: boolean;
  handlerError?: unknown;
  verify?: "valid" | "invalid" | "error";
  settle?: SettleOutcome;
};
const attempts = new Map<string, Attempt>();

/** R1: only plain lower-case reason codes (/^[a-z0-9_]+$/, ≤ 80 chars) are ever logged. */
export function safeCode(value: unknown): string {
  return typeof value === "string" && value.length <= 80 && /^[a-z0-9_]+$/.test(value) ? value : "unrecognized";
}

/** Reasons that mean "the outcome is not known yet" (spec §Duplicate Settlement: duplicate_settlement = seen, not settled). */
const UNRESOLVED_SETTLE_REASONS = new Set(["settlement_pending", "duplicate_settlement"]);

function classifySettleResult(res: SettleResponse): SettleOutcome {
  if (res.success) {
    return { outcome: "success", reason: "success", raw: "success", timeout: false, transaction: typeof res.transaction === "string" ? res.transaction : undefined };
  }
  const raw = String(res.errorReason ?? "unknown");
  const unresolved = UNRESOLVED_SETTLE_REASONS.has(raw) || (typeof res.transaction === "string" && res.transaction !== "");
  return { outcome: unresolved ? "unconfirmed" : "failed", reason: safeCode(raw), raw, timeout: false };
}

function classifySettleThrow(err: unknown): SettleOutcome {
  if (err instanceof FacilitatorTimeoutError) return { outcome: "unconfirmed", reason: "facilitator_timeout", raw: "facilitator_timeout", timeout: true };
  if (err instanceof FacilitatorResponseError) {
    return { outcome: "unconfirmed", reason: "facilitator_malformed_response", raw: "facilitator_malformed_response", timeout: false };
  }
  if (err instanceof SettleError) {
    const raw = String(err.errorReason ?? "unknown");
    const status = err.statusCode;
    const unresolved =
      UNRESOLVED_SETTLE_REASONS.has(raw) ||
      status >= 500 ||
      status === 429 ||
      status === 409 ||
      (typeof err.transaction === "string" && err.transaction !== "");
    return { outcome: unresolved ? "unconfirmed" : "failed", reason: safeCode(raw), raw, timeout: false };
  }
  // fetch failed / connection reset / non-JSON 5xx body: the request may have reached the facilitator.
  return { outcome: "unconfirmed", reason: "transport_error", raw: "transport_error", timeout: false };
}

function errorKind(err: unknown): string {
  return err instanceof Error ? err.name || "Error" : typeof err;
}

/** What of a facilitator client error may be logged (R1): never the facilitator's text. */
function facilitatorErrorDetail(err: unknown): string | undefined {
  if (err instanceof FacilitatorTimeoutError) return /^Facilitator \w+ request timed out after \d+ms$/.test(err.message) ? err.message : undefined;
  if (err instanceof FacilitatorResponseError) return undefined;
  if (err instanceof SettleError) return `reason=${safeCode(err.errorReason)}`;
  if (err instanceof Error && err.name === "VerifyError") return `reason=${safeCode((err as { invalidReason?: unknown }).invalidReason)}`;
  const msg = err instanceof Error ? err.message : "";
  const m = /^(Facilitator (?:verify|settle|getSupported|supported) failed \(\d{3}\))(?::|$)/.exec(msg);
  return m ? m[1] : undefined;
}

/** R1 boundary: same error CLASS handed back to the SDK, no facilitator free text. */
function scrubFacilitatorError(err: unknown, op: "verify" | "settle" | "supported"): unknown {
  if (err instanceof FacilitatorTimeoutError) return err; // SDK-generated message only
  if (err instanceof FacilitatorResponseError) return new FacilitatorResponseError(`XRPL facilitator ${op} returned a malformed response`);
  if (err instanceof SettleError) {
    return new SettleError(err.statusCode, {
      success: false,
      errorReason: safeCode(err.errorReason),
      transaction: typeof err.transaction === "string" ? err.transaction : "",
      network: err.network,
    } as SettleResponse);
  }
  if (err instanceof VerifyError) {
    return new VerifyError(err.statusCode, { isValid: false, invalidReason: safeCode(err.invalidReason) } as VerifyResponse);
  }
  const detail = facilitatorErrorDetail(err);
  return new Error(detail ?? `XRPL facilitator ${op} failed (${errorKind(err)})`);
}

// ---------------------------------------------------------------------------
// Replay key
// ---------------------------------------------------------------------------

type KeyFn = (payload: PaymentPayload | undefined) => string | null;

function blobOf(payload: PaymentPayload | undefined): string | null {
  const blob = (payload?.payload as Record<string, unknown> | undefined)?.signedTxBlob;
  return typeof blob === "string" && blob !== "" ? blob : null;
}

/**
 * sha256 (hex) of the payment SLOT: network + payer Account + (Sequence or
 * TicketSequence). Only one transaction can ever consume a slot, so any
 * re-encoding / re-signing of the same payment maps to the same key.
 */
export function xrplPaymentKeyFromTx(network: string, tx: DecodedTx): string | null {
  const account = tx.Account;
  if (!isValidXrplClassicAddress(account)) return null;
  const ticket = tx.TicketSequence;
  const seq = tx.Sequence;
  const slot = typeof ticket === "number" ? `t:${ticket}` : typeof seq === "number" ? `s:${seq}` : null;
  if (!slot) return null;
  return createHash("sha256").update(`${network}|${account}|${slot}`).digest("hex");
}

function makeKeyFn(network: string, mods: Pick<XrplModules, "decodeSignedTransactionBlob">): KeyFn {
  return (payload) => {
    const blob = blobOf(payload);
    if (!blob) return null;
    try {
      return xrplPaymentKeyFromTx(network, mods.decodeSignedTransactionBlob(blob) as DecodedTx);
    } catch {
      return null;
    }
  };
}

/** Short, non-reversible fingerprint for logs / reconciliation (16 hex of the key). */
const fp = (key: string) => key.slice(0, 16);

/** XRPL tx hash of a signed blob: SHA-512Half("TXN\0" || blob). */
export function xrplSignedTxHash(blobHex: string): string | null {
  if (!/^[0-9A-Fa-f]+$/.test(blobHex) || blobHex.length % 2) return null;
  return createHash("sha512")
    .update(Buffer.concat([Buffer.from("54584E00", "hex"), Buffer.from(blobHex, "hex")]))
    .digest("hex")
    .slice(0, 64)
    .toUpperCase();
}

/** Everything a human needs to reconcile one ambiguous XRPL settlement. */
export type ReconcileCtx = {
  network: string;
  route: string;
  payer: string;
  slot: string;
  required: { currency: string; issuer: string; value: string };
  /** Hash computed from the signed blob (known even when settle timed out). */
  blobHash: string | null;
};
export const XRPL_RECONCILE_TAG = "XRPL_RECONCILE";

/**
 * One grep-able JSON line per settlement_unconfirmed (502/504) outcome.
 * Not redacted on purpose: only public ledger data (hash, addresses,
 * amounts), no payload, no facilitator text. See docs/xrpl-rail.md runbook.
 */
export function logXrplReconcile(ctx: ReconcileCtx, status: 502 | 504, reason: string, settledHash?: string, delivered?: unknown): void {
  const rec = {
    tag: XRPL_RECONCILE_TAG,
    at: new Date().toISOString(),
    status,
    reason: safeCode(reason),
    txHash: typeof settledHash === "string" && /^[0-9A-Fa-f]{64}$/.test(settledHash) ? settledHash.toUpperCase() : ctx.blobHash,
    network: ctx.network,
    route: ctx.route,
    payer: ctx.payer,
    slot: ctx.slot,
    required: ctx.required,
    delivered: delivered ?? null,
  };
  console.warn(`${LOG} ${XRPL_RECONCILE_TAG} ${JSON.stringify(rec)}`);
}

// ---------------------------------------------------------------------------
// XRPL-only facilitator client
// ---------------------------------------------------------------------------

/**
 * Wraps the XRPL facilitator so it can only ever be used for v2 `exact` on
 * the configured xrpl:N, pinned payTo, RLUSD + the network's issuer:
 * getSupported is filtered to that one kind (and reports no extensions, so the
 * XRPL server never declares Bazaar), and verify/settle refuse anything else.
 * `settleInner` (same URL, longer deadline) is used for settle only.
 */
export class XrplOnlyFacilitatorClient implements FacilitatorClient {
  constructor(
    private readonly inner: FacilitatorClient,
    readonly network: string,
    readonly issuer: string,
    private readonly keyOf: KeyFn = () => null,
    private readonly settleInner: FacilitatorClient = inner,
  ) {
    // Refuse any mainnet/testnet mix at construction (unknown network throws too).
    this.payTo = xrplPayToFor(network as typeof XRPL_MAINNET_CAIP2);
    assertXrplPairing(network, issuer, this.payTo);
  }
  readonly payTo: string;

  async getSupported(): Promise<SupportedResponse> {
    for (const c of [this.inner, this.settleInner]) {
      const url = (c as { url?: unknown }).url;
      if (c instanceof LocalXrplFacilitatorClient) continue;
      if (typeof url !== "string" || !url.startsWith("https://")) {
        throw new Error("XRPL facilitator URL must be https");
      }
    }
    let supported: SupportedResponse;
    try {
      supported = await this.inner.getSupported();
    } catch (err) {
      throw scrubFacilitatorError(err, "supported");
    }
    const kinds = (supported.kinds ?? []).filter(
      (k) => k.x402Version === 2 && k.scheme === "exact" && k.network === this.network,
    );
    if (kinds.length !== 1) {
      throw new Error(`XRPL facilitator does not list exactly one x402 v2 exact kind on ${this.network}`);
    }
    const sponsored = (kinds[0].extra as { areFeesSponsored?: unknown } | undefined)?.areFeesSponsored;
    if (sponsored !== undefined && sponsored !== false) {
      throw new Error("XRPL facilitator advertises areFeesSponsored != false (spec requires false)");
    }
    const signers = Object.fromEntries(
      Object.entries((supported.signers ?? {}) as Record<string, unknown>).filter(([k]) => k.startsWith("xrpl:")),
    ) as SupportedResponse["signers"];
    // extensions: [] → the XRPL server never declares or enriches Bazaar.
    return { kinds, extensions: [], signers };
  }

  private guard(payload: PaymentPayload, requirements: PaymentRequirements): void {
    const issuer = (requirements.extra as Record<string, unknown> | undefined)?.issuer;
    if (
      requirements.network !== this.network ||
      payload.accepted?.network !== this.network ||
      requirements.scheme !== "exact" ||
      requirements.payTo !== this.payTo ||
      requirements.asset !== RLUSD_CURRENCY_HEX ||
      issuer !== this.issuer ||
      typeof issuer !== "string" ||
      !isLegalXrplPairing(requirements.network, issuer, requirements.payTo)
    ) {
      throw new Error(`XRPL facilitator refuses non-${this.network} / non-pinned payment`);
    }
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    this.guard(payload, requirements);
    const k = this.keyOf(payload);
    const att = k ? attempts.get(k) : undefined;
    let res: VerifyResponse;
    try {
      res = await this.inner.verify(payload, requirements);
    } catch (err) {
      if (att) att.verify = "error";
      warn(`XRPL facilitator verify threw (${errorKind(err)})`, facilitatorErrorDetail(err));
      throw scrubFacilitatorError(err, "verify");
    }
    if (att) att.verify = res.isValid ? "valid" : "invalid";
    if (!res.isValid) {
      warn(`XRPL facilitator verify rejected: reason=${safeCode(res.invalidReason)}`);
      return { ...res, invalidReason: safeCode(res.invalidReason), invalidMessage: undefined };
    }
    return res;
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    this.guard(payload, requirements);
    const k = this.keyOf(payload);
    const att = k ? attempts.get(k) : undefined;
    let res: SettleResponse;
    try {
      res = await this.settleInner.settle(payload, requirements);
    } catch (err) {
      const c = classifySettleThrow(err);
      if (att) att.settle = c;
      warn(`XRPL facilitator settle threw (${errorKind(err)}): outcome=${c.outcome} reason=${c.reason}`, facilitatorErrorDetail(err), c.outcome === "failed");
      throw scrubFacilitatorError(err, "settle");
    }
    const c = classifySettleResult(res);
    if (att) att.settle = c;
    if (!res.success) {
      warn(`XRPL facilitator settle failed: outcome=${c.outcome} reason=${c.reason}`, undefined, c.outcome === "failed");
      return { ...res, errorReason: c.reason, errorMessage: undefined };
    }
    return res;
  }
}

/** Minimal facilitator-side scheme surface used for self-facilitation (= @x402/xrpl/exact/facilitator ExactXrplScheme). */
export type XrplFacilitatorScheme = {
  getExtra(network: string): Record<string, unknown> | undefined;
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
};

/**
 * In-process facilitator: the @x402/xrpl reference facilitator scheme
 * (offline signature + signer authorization, NetworkID, exact amount, no
 * partial payment / Paths / DeliverMin / Memos, fee cap, LastLedgerSequence,
 * simulate; settle = submitAndWait, success only on validated tesSUCCESS).
 * Cross-instance dedup is our Upstash claim BEFORE verify; the ledger
 * self-check after settle re-reads delivered_amount independently.
 * Deadlines as for the HTTP facilitator (a timeout = ambiguous 504).
 */
export class LocalXrplFacilitatorClient implements FacilitatorClient {
  readonly url = XRPL_SELF_FACILITATOR;
  constructor(
    private readonly network: string,
    private readonly scheme: XrplFacilitatorScheme,
  ) {}
  async getSupported(): Promise<SupportedResponse> {
    return {
      kinds: [{ x402Version: 2, scheme: "exact", network: this.network as `${string}:${string}`, extra: this.scheme.getExtra(this.network) }],
      extensions: [],
      signers: { "xrpl:*": [] },
    } as SupportedResponse;
  }
  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    // Verify submits nothing: a throw/timeout means "not accepted" (Base-only 402).
    return withTimeout(this.scheme.verify(payload, requirements), timeouts.verifyMs, "XRPL self verify");
  }
  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    // A throw or timeout here is classified unconfirmed (the blob may have been submitted).
    return withTimeout(this.scheme.settle(payload, requirements), timeouts.settleMs, "XRPL self settle").catch(() => {
      throw new FacilitatorTimeoutError("settle", timeouts.settleMs);
    });
  }
}

async function defaultFacilitatorSchemeLoader(network: string): Promise<XrplFacilitatorScheme> {
  const m = await import("@x402/xrpl/exact/facilitator");
  return new m.ExactXrplScheme({ wsUrlByNetwork: { [network]: XRPL_SELF_WS_URL[network as typeof XRPL_MAINNET_CAIP2] } }) as unknown as XrplFacilitatorScheme;
}
let facilitatorSchemeLoader: (network: string) => Promise<XrplFacilitatorScheme> = defaultFacilitatorSchemeLoader;
/** Tests only: swap the self-facilitation scheme (null = real @x402/xrpl facilitator). */
export function __setXrplFacilitatorSchemeLoaderForTests(fn: ((network: string) => Promise<XrplFacilitatorScheme>) | null): void {
  facilitatorSchemeLoader = fn ?? defaultFacilitatorSchemeLoader;
}

/** Build the facilitator client pair: verify/supported at XRPL_VERIFY_TIMEOUT_MS, settle at XRPL_SETTLE_TIMEOUT_MS. */
export function createXrplFacilitator(config: XrplRailConfig, keyOf?: KeyFn, local?: LocalXrplFacilitatorClient): XrplOnlyFacilitatorClient {
  if (config.facilitatorUrl === XRPL_SELF_FACILITATOR) {
    if (!local) throw new Error("self-facilitation needs the in-process XRPL facilitator");
    return new XrplOnlyFacilitatorClient(local, config.network, config.issuer, keyOf, local);
  }
  return new XrplOnlyFacilitatorClient(
    new HTTPFacilitatorClient({ url: config.facilitatorUrl, timeoutMs: timeouts.verifyMs }),
    config.network,
    config.issuer,
    keyOf,
    new HTTPFacilitatorClient({ url: config.facilitatorUrl, timeoutMs: timeouts.settleMs }),
  );
}

// ---------------------------------------------------------------------------
// Rail init (cached, stale-while-revalidate)
// ---------------------------------------------------------------------------

type Rail = {
  config: XrplRailConfig;
  server: x402ResourceServer;
  mods: XrplModules;
  keyOf: KeyFn;
};

let railState: { key: string; rail: Rail; builtAt: number } | null = null;
let railInit: { key: string; promise: Promise<Rail | null> } | null = null;
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
  // Cross-check our pinned constants against the package.
  if (mods.XRPL_MAINNET !== XRPL_MAINNET_CAIP2 || mods.XRPL_TESTNET !== XRPL_TESTNET_CAIP2) {
    throw new Error("XRPL CAIP-2 mismatch between repo constants and @x402/xrpl");
  }
  if (mods.RLUSD_CURRENCY !== RLUSD_CURRENCY_HEX) {
    throw new Error("RLUSD currency code mismatch between repo constant and @x402/xrpl");
  }
  if (mods.RLUSD_MAINNET_ISSUER !== RLUSD_MAINNET_ISSUER || mods.RLUSD_TESTNET_ISSUER !== RLUSD_TESTNET_ISSUER) {
    throw new Error("RLUSD issuer mismatch between repo constants and @x402/xrpl");
  }
  const keyOf = makeKeyFn(config.network, mods);
  const local =
    config.facilitatorUrl === XRPL_SELF_FACILITATOR
      ? new LocalXrplFacilitatorClient(config.network, await facilitatorSchemeLoader(config.network))
      : undefined;
  const server = new x402ResourceServer(createXrplFacilitator(config, keyOf, local)).register(config.network, new mods.ExactXrplScheme());
  await server.initialize();
  return { config, server, mods, keyOf };
}

function startRailInit(config: XrplRailConfig, key: string): Promise<Rail | null> {
  if (railInit?.key === key) return railInit.promise;
  const promise: Promise<Rail | null> = withTimeout(initRail(config), config.initTimeoutMs, "XRPL rail init")
    .then(
      (rail): Rail | null => {
        railState = { key, rail, builtAt: Date.now() };
        failedKey = null;
        return rail;
      },
      (err): Rail | null => {
        warn("rail init failed", err);
        // Fail closed: a failed refresh retires the old rail.
        if (railState?.key === key) railState = null;
        failedKey = key;
        failedUntil = Date.now() + RETRY_AFTER_MS;
        return null;
      },
    )
    .finally(() => {
      if (railInit?.promise === promise) railInit = null;
    });
  railInit = { key, promise };
  return promise;
}

async function getRail(config: XrplRailConfig): Promise<Rail | null> {
  const key = JSON.stringify(config);
  if (railState?.key === key) {
    if (Date.now() - railState.builtAt > RAIL_TTL_MS) void startRailInit(config, key);
    return railState.rail;
  }
  if (failedKey === key && Date.now() < failedUntil) return null;
  return startRailInit(config, key);
}

// ---------------------------------------------------------------------------
// payTo readiness guard (read-only RPC, cached, stale-while-revalidate)
// ---------------------------------------------------------------------------

type ReadyState = { key: string; ready: boolean; until: number; confirmedAt?: number };
let readyCache: ReadyState | null = null;
let readyRefresh: Promise<boolean> | null = null;

type RpcResult = { status?: unknown; error?: unknown; validated?: unknown; [k: string]: unknown };

function asResult(r: unknown, method: string): RpcResult {
  if (!r || typeof r !== "object") throw new Error(`malformed ${method} result`);
  return r as RpcResult;
}

/**
 * Ready = payTo exists on the configured network (validated ledger), has no
 * RequireDest / DepositAuth flag, and holds an RLUSD trust line to the issuer
 * with limit > 0 that neither side has frozen. actNotFound → not ready.
 * Any other RPC error → throws (caller treats as not ready, retries in 60 s).
 */
async function checkPayToReady(config: XrplRailConfig): Promise<boolean> {
  const [infoRaw, linesRaw] = await Promise.all([
    rpc(config.rpcUrl, "account_info", { account: config.payTo, ledger_index: "validated" }, config.initTimeoutMs),
    rpc(config.rpcUrl, "account_lines", { account: config.payTo, peer: config.issuer, ledger_index: "validated" }, config.initTimeoutMs),
  ]);
  const info = asResult(infoRaw, "account_info");
  const lines = asResult(linesRaw, "account_lines");
  for (const r of [info, lines]) {
    if (r.status === "error") {
      if (r.error === "actNotFound") {
        warn("payTo account not activated on this network; XRPL entry hidden");
        return false;
      }
      throw new Error(`RPC error ${safeCode(r.error)}`);
    }
  }
  const flags = (info.account_data as { Flags?: unknown } | undefined)?.Flags;
  if (typeof flags !== "number") throw new Error("malformed account_info result");
  if ((flags & LSF_REQUIRE_DEST_TAG) !== 0 || (flags & LSF_DEPOSIT_AUTH) !== 0) {
    warn("payTo requires a destination tag or deposit authorization; XRPL entry hidden");
    return false;
  }
  if (!Array.isArray(lines.lines)) throw new Error("malformed account_lines result");
  const line = (lines.lines as Array<Record<string, unknown>>).find(
    (l) => l && l.account === config.issuer && l.currency === RLUSD_CURRENCY_HEX,
  );
  if (!line) {
    warn("payTo has no RLUSD trust line to the issuer; XRPL entry hidden");
    return false;
  }
  const limit = typeof line.limit === "string" ? Number(line.limit) : NaN;
  if (!(limit > 0) || line.freeze === true || line.freeze_peer === true) {
    warn("payTo RLUSD trust line has no limit or is frozen; XRPL entry hidden");
    return false;
  }
  return true;
}

function refreshReady(config: XrplRailConfig, key: string): Promise<boolean> {
  if (readyRefresh) return readyRefresh;
  const p: Promise<boolean> = (async () => {
    try {
      const ready = await checkPayToReady(config);
      readyCache = { key, ready, until: Date.now() + READY_TTL_MS, ...(ready ? { confirmedAt: Date.now() } : {}) };
      return ready;
    } catch (err) {
      // Transient RPC failure (timeout, 5xx). A definitive answer (actNotFound,
      // no trust line, frozen, flags) never lands here. Keep the last CONFIRMED
      // ready=true for up to READY_STALE_MAX_MS (same pattern as solana-rail),
      // retrying every READY_ERROR_RETRY_MS; cold or never-confirmed stays hidden.
      const prev = readyCache && readyCache.key === key ? readyCache : null;
      const now = Date.now();
      if (prev?.ready && prev.confirmedAt !== undefined && now - prev.confirmedAt < READY_STALE_MAX_MS) {
        warn("payTo readiness RPC check failed; keeping last confirmed result (present)", err);
        readyCache = { key, ready: true, until: now + READY_ERROR_RETRY_MS, confirmedAt: prev.confirmedAt };
        return true;
      }
      warn("payTo readiness RPC check failed", err);
      readyCache = { key, ready: false, until: now + READY_ERROR_RETRY_MS };
      return false;
    }
  })().finally(() => {
    if (readyRefresh === p) readyRefresh = null;
  });
  readyRefresh = p;
  return p;
}

/**
 * True while payTo is activated with a usable RLUSD trust line. Warm: answers
 * from cache and re-checks in the background after the TTL. Cold: one bounded
 * check. RPC failure → false (hidden), retried after 60 s. Never throws.
 */
export async function xrplPayToReady(config: XrplRailConfig): Promise<boolean> {
  const key = `${config.network}|${config.rpcUrl}|${config.issuer}|${config.payTo}`;
  if (readyCache && readyCache.key === key) {
    if (Date.now() >= readyCache.until) void refreshReady(config, key);
    return readyCache.ready;
  }
  return refreshReady(config, key);
}

// ---------------------------------------------------------------------------
// Requirements
// ---------------------------------------------------------------------------

function xrplPrice(config: XrplRailConfig, atomicUsdc: string): AssetAmount {
  return { amount: usdcAtomicToRlusdValue(atomicUsdc), asset: RLUSD_CURRENCY_HEX, extra: { issuer: config.issuer } };
}

function xrplRouteExtra(config: XrplRailConfig): Record<string, unknown> | undefined {
  return config.assetTransferMethod ? { assetTransferMethod: config.assetTransferMethod } : undefined;
}

/** Throws unless the SDK-built requirement is exactly what we intend to advertise. */
export function assertXrplRequirement(req: PaymentRequirements, config: XrplRailConfig, atomicUsdc: string): void {
  const extra = (req.extra ?? {}) as Record<string, unknown>;
  const problems: string[] = [];
  if (req.scheme !== "exact") problems.push("scheme");
  if (req.network !== config.network) problems.push("network");
  if (req.payTo !== config.payTo) problems.push("payTo");
  if (typeof extra.issuer !== "string" || !isLegalXrplPairing(req.network, extra.issuer, req.payTo)) problems.push("network/issuer/payTo mix");
  if (req.asset !== RLUSD_CURRENCY_HEX) problems.push("asset");
  if (req.amount !== usdcAtomicToRlusdValue(atomicUsdc)) problems.push("amount");
  if (req.maxTimeoutSeconds !== MAX_TIMEOUT_SECONDS) problems.push("maxTimeoutSeconds");
  if (extra.issuer !== config.issuer) problems.push("extra.issuer");
  if (extra.areFeesSponsored !== false) problems.push("extra.areFeesSponsored");
  if (extra.assetTransferMethod !== config.assetTransferMethod) problems.push("extra.assetTransferMethod");
  const allowed = new Set(["issuer", "areFeesSponsored", ...(config.assetTransferMethod ? ["assetTransferMethod"] : [])]);
  for (const k of Object.keys(extra)) if (!allowed.has(k)) problems.push(`extra.${k}`);
  if (problems.length) throw new Error(`unexpected XRPL requirement (${problems.join(", ")})`);
}

async function buildXrplRequirement(rail: Rail, atomicUsdc: string): Promise<PaymentRequirements> {
  const [req] = await rail.server.buildPaymentRequirements({
    scheme: "exact",
    network: rail.config.network,
    payTo: rail.config.payTo,
    price: xrplPrice(rail.config, atomicUsdc),
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: xrplRouteExtra(rail.config),
  });
  if (!req) throw new Error("no XRPL requirement built");
  assertXrplRequirement(req, rail.config, atomicUsdc);
  return req;
}

/**
 * The RLUSD `accepts` entry for a route priced at `atomicUsdc` (USDC 6-dec
 * units), or null if the rail is unavailable. Never throws.
 */
export async function getXrplAccept(config: XrplRailConfig, atomicUsdc: string): Promise<PaymentRequirements | null> {
  try {
    // payTo readiness check and rail init run in parallel (cold start ≤ one initTimeoutMs).
    if (!replayStoreOkFor(config)) {
      warn("xrpl:0 refused: shared replay store (UPSTASH_REDIS_REST_* or KV_REST_API_URL/TOKEN) not configured");
      return null;
    }
    const [ready, rail] = await Promise.all([xrplPayToReady(config), getRail(config)]);
    if (!ready || !rail) return null;
    return await buildXrplRequirement(rail, atomicUsdc);
  } catch (err) {
    warn("could not build XRPL requirement", err);
    return null;
  }
}

/**
 * Return a copy of a 402/OPTIONS response with `accept` appended after the
 * existing entries (Base, then Solana when that rail is on), in both the
 * PAYMENT-REQUIRED header and, when the body is a v2 PaymentRequired, the JSON
 * body. Throws on malformed input; callers fall back to the original response.
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
    warn("could not append XRPL requirement", err);
    return res;
  }
}

// ---------------------------------------------------------------------------
// Paid path helpers
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

/**
 * Same route keys/description/resource metadata, but the only accept is the
 * RLUSD one and NO extensions (the XRPL server never declares Bazaar).
 */
export function buildXrplOnlyRoutes(config: XrplRailConfig, routes: RoutesConfig, atomicUsdc: string): RoutesConfig {
  const out: Record<string, RouteConfig> = {};
  for (const [key, cfg] of Object.entries(routes as Record<string, RouteConfig>)) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { extensions: _bazaar, ...rest } = cfg;
    const extra = xrplRouteExtra(config);
    out[key] = {
      ...rest,
      accepts: [
        {
          scheme: "exact",
          network: config.network,
          payTo: config.payTo,
          price: xrplPrice(config, atomicUsdc),
          maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
          ...(extra ? { extra } : {}),
        },
      ],
    };
  }
  return out;
}

let paidHandlers = new WeakMap<object, { rail: Rail; handler: AppRouteHandler }>();

/** Copy of the payload with any `extensions.bazaar` removed. Same object when there is nothing to strip. */
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
 * (RLUSD) exact payment, run BEFORE anything is forwarded to the facilitator
 * so malformed or non-spec payloads (e.g. Memos binding) are dropped early.
 * Signature, sequence/ticket availability, LastLedgerSequence window, fee
 * policy and simulation stay with the facilitator (they need the ledger).
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
  if (blob.length / 2 > MAX_SIGNED_TX_BYTES) return fail(`payload.signedTxBlob is ${blob.length / 2} bytes`);

  // §2 decode
  let tx: DecodedTx;
  try {
    tx = mods.decodeSignedTransactionBlob(blob) as DecodedTx;
  } catch {
    return fail("signedTxBlob does not decode");
  }

  // §3 type, §4 destination, §5 network binding (xrpl:0/1 are <= 1024)
  if (tx.TransactionType !== "Payment") return fail("TransactionType must be Payment");
  if (!isValidXrplClassicAddress(tx.Account)) return fail("Account is not a classic address");
  if (tx.Account === requirement.payTo) return fail("Account equals payTo");
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
    if (typeof tx.Sequence !== "number" || tx.Sequence <= 0) return fail("Sequence missing");
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

// ---------------------------------------------------------------------------
// Replay guard
// ---------------------------------------------------------------------------

let replay: ReplayStore = createReplayStore();
let replayWarned = false;
/** The active replay store (Upstash when configured, else per-instance memory). */
export function xrplReplayStoreKind(): ReplayStore["kind"] {
  return replay.kind;
}
/** Tests only: swap the store. */
export function setXrplReplayStoreForTests(s: ReplayStore | null): void {
  replay = s ?? createReplayStore();
}

async function replaySet(key: string, state: ReplayState): Promise<void> {
  try {
    await replay.set(key, state, REPLAY_TTL_MS);
  } catch (err) {
    warn(`replay store set failed fp=${fp(key)} state=${state}`, err, false);
  }
}
async function replayRelease(key: string): Promise<void> {
  try {
    await replay.release(key);
  } catch (err) {
    warn(`replay store release failed fp=${fp(key)}`, err, false);
  }
}

function jsonError(status: number, error: string): NextResponse {
  return new NextResponse(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// ---------------------------------------------------------------------------
// Paid path
// ---------------------------------------------------------------------------

type Decision = { kind: "response"; res: NextResponse } | { kind: "base"; reason: string } | { kind: "rethrow"; err: unknown };

async function decide(key: string, att: Attempt, res: NextResponse | null, threw: boolean, thrown: unknown, rc: ReconcileCtx): Promise<Decision> {
  const s = att.settle;
  if (s) {
    if (s.outcome === "success" && res && res.status < 400) {
      await replaySet(key, "settled");
      return { kind: "response", res };
    }
    if (s.outcome === "failed") {
      // Definitive: nothing landed. Key kept (the same tx would fail again).
      await replaySet(key, "settle_failed");
      return { kind: "base", reason: settleFailReason(s.reason) };
    }
    // Ambiguous (or settled but no deliverable response): the tx may have
    // landed. Never a 402 (would invite a second payment); no facilitator text.
    await replaySet(key, "settle_unconfirmed");
    const timeout = s.outcome === "unconfirmed" && s.timeout;
    warn(
      `settlement unconfirmed fp=${fp(key)} reason=${s.outcome === "success" ? "settled_without_response" : s.reason}; client gets ${timeout ? 504 : 502} settlement_unconfirmed (reconcile on-ledger)`,
      undefined,
      false,
    );
    logXrplReconcile(rc, timeout ? 504 : 502, s.outcome === "success" ? "settled_without_response" : s.reason, s.transaction);
    return { kind: "response", res: jsonError(timeout ? 504 : 502, "settlement_unconfirmed") };
  }
  // No settle attempted → nothing charged → release the key.
  await replayRelease(key);
  if (att.handlerThrew) return { kind: "rethrow", err: att.handlerError };
  if (att.handlerRan && res && res.status >= 400) return { kind: "response", res }; // route's own error, as on Base
  if (threw) {
    warn("XRPL payment path threw", thrown);
    return { kind: "base", reason: RAIL_REJECT.error };
  } else {
    let reason = "";
    try {
      const pr = decodePaymentRequiredHeader(res?.headers.get("payment-required") ?? "");
      reason = typeof pr.error === "string" && /^[a-z0-9_]+$/.test(pr.error) && pr.error.length <= 80 ? ` error=${pr.error}` : "";
    } catch {
      /* no header */
    }
    warn(`XRPL payment not accepted (status ${res?.status ?? "none"} from XRPL server${reason})`);
  }
  return { kind: "base", reason: reasonFromRailResponse(res, RAIL_REJECT.verifyFailed) };
}

/**
 * Validated-tx lookup with bounded backoff. A settle that just returned
 * tesSUCCESS can still read txnNotFound / validated:false on a public rippled
 * for a ledger or two (load balancers, lagging nodes), so the read is retried
 * on throw / error / not-yet-validated. Bounded: XRPL_TX_LOOKUP_DELAYS_MS
 * (≤ 4 tries, 2.5 s of sleep) AND a hard XRPL_TX_LOOKUP_DEADLINE_MS overall.
 * Returns the validated result or null (unknown).
 */
export const XRPL_TX_LOOKUP_DELAYS_MS: readonly number[] = [0, 400, 800, 1300];
export const XRPL_TX_LOOKUP_DEADLINE_MS = 4_000;
/**
 * Odin C1: worst-case XRPL time inside one paid request = init/readiness
 * (≤ XRPL_MAX_INIT_TIMEOUT_MS) + verify + settle + validated-tx lookup.
 * Must stay well below the maxDuration of every route that can take XRPL
 * (XRPL_ROUTE_MAX_DURATION_S, asserted in tests/xrpl-time-budget.test.ts),
 * leaving the rest for the route handler itself.
 */
export const XRPL_ROUTE_MAX_DURATION_S = 60;
export const XRPL_WORST_CASE_MS = XRPL_MAX_INIT_TIMEOUT_MS + XRPL_VERIFY_TIMEOUT_MS + XRPL_SETTLE_TIMEOUT_MS + XRPL_TX_LOOKUP_DEADLINE_MS;
let txLookupDelays: readonly number[] = XRPL_TX_LOOKUP_DELAYS_MS;
/** Tests only: shrink the backoff (null = defaults). */
export function __setXrplTxLookupDelaysForTests(d: readonly number[] | null): void {
  txLookupDelays = d ?? XRPL_TX_LOOKUP_DELAYS_MS;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function lookupValidatedTx(config: XrplRailConfig, hash: string | undefined): Promise<RpcResult | null> {
  if (typeof hash !== "string" || !/^[0-9A-Fa-f]{64}$/.test(hash)) return null;
  const deadline = Date.now() + XRPL_TX_LOOKUP_DEADLINE_MS;
  for (const delay of txLookupDelays) {
    if (delay > 0) {
      if (Date.now() + delay >= deadline) break;
      await sleep(delay);
    }
    const left = deadline - Date.now();
    if (left <= 0) break;
    try {
      const r = asResult(await rpc(config.rpcUrl, "tx", { transaction: hash, binary: false }, Math.min(config.initTimeoutMs, left)), "tx");
      if (r.status !== "error" && r.validated === true) return r;
      // txnNotFound / not validated yet: retry. Any other rippled error: also retry (bounded).
    } catch {
      /* network / malformed: retry (bounded) */
    }
  }
  return null;
}

/**
 * Self-verification of a settled payment against the validated ledger
 * (independent of what the facilitator reported):
 *   - meta.TransactionResult === tesSUCCESS
 *   - TransactionType Payment, Destination === payTo, no DestinationTag
 *     unless we asked for one (we never do)
 *   - meta.delivered_amount is EXACTLY the required RLUSD amount from the
 *     pinned issuer (never trusts Amount: partial payments)
 * "missing" = the result carries no meta/tx body to check.
 */
export function verifySettledTx(
  r: RpcResult,
  requirement: Pick<PaymentRequirements, "payTo" | "amount" | "asset"> & { extra?: Record<string, unknown> },
  compareDecimal: (a: string, b: string) => number,
  /** Account of the signed tx we claimed + verified (the slot payer). */
  payer?: string,
): "ok" | "missing" | string {
  const meta = r.meta as { TransactionResult?: unknown; delivered_amount?: unknown } | undefined;
  const tx = ((r.tx_json as Record<string, unknown> | undefined) ?? r) as Record<string, unknown>;
  if (!meta || typeof meta !== "object") return "missing";
  if (meta.TransactionResult !== "tesSUCCESS") return "result_not_tessuccess";
  if (tx.TransactionType !== "Payment") return "not_payment";
  if (payer !== undefined && tx.Account !== payer) return "payer_mismatch";
  if (tx.Destination !== requirement.payTo) return "destination_mismatch";
  if (tx.DestinationTag !== undefined) return "unexpected_destination_tag";
  const d = meta.delivered_amount;
  if (!isIssuedAmount(d)) return "delivered_not_issued";
  if (d.currency !== requirement.asset) return "delivered_currency_mismatch";
  if (d.issuer !== requirement.extra?.issuer) return "delivered_issuer_mismatch";
  let cmp: number;
  try {
    cmp = compareDecimal(d.value, requirement.amount);
  } catch {
    return "delivered_value_unparseable";
  }
  if (cmp !== 0) return "delivered_amount_mismatch";
  return "ok";
}

/**
 * Cross-instance replay check: a genuine settle's ledger closes during this
 * request; a replayed success closed earlier. Read-only `tx` on the
 * allow-listed RPC, retried with bounded backoff. Unknown → caller decides.
 */
async function settledBeforeRequest(
  r: RpcResult | null,
  startedAt: number,
): Promise<"replay" | "fresh" | "unknown"> {
  if (!r) return "unknown";
  const date = typeof r.date === "number" ? r.date : (r.tx_json as { date?: unknown } | undefined)?.date ?? (r as { close_time_iso?: unknown }).close_time_iso;
  let closedMs: number;
  if (typeof date === "number" && Number.isFinite(date)) closedMs = RIPPLE_EPOCH_MS + date * 1000;
  else if (typeof date === "string" && !Number.isNaN(Date.parse(date))) closedMs = Date.parse(date);
  else return "unknown";
  return closedMs < startedAt - REPLAY_CONFIRM_SKEW_MS ? "replay" : "fresh";
}

/** Mainnet needs the shared (Upstash) replay store; per-instance memory is testnet-only. */
function replayStoreOkFor(config: XrplRailConfig): boolean {
  return config.network !== XRPL_MAINNET_CAIP2 || replay.kind === "upstash";
}

/**
 * Serve an XRPL-paid request through the XRPL-only server.
 *   - null → caller serves main's exact Base-only 402 (rail unavailable,
 *     payTo not ready, preflight failed, verify-phase rejection/throw/timeout,
 *     or a definitive settle failure);
 *   - 409 {"error":"duplicate_payment"} → replay of a payment slot already in
 *     flight / settled / unconfirmed (checked before verify), or a settle whose
 *     ledger closed before this request started;
 *   - 502/504 {"error":"settlement_unconfirmed"} → ambiguous settle;
 *   - the paid response → settled;
 *   - throws → the route handler threw (same as the Base path: Next 500).
 */
export async function handleXrplPayment(
  req: NextRequest,
  routeHandler: AppRouteHandler,
  routes: RoutesConfig,
  atomicUsdc: string,
  config: XrplRailConfig,
  onReject?: OnReject,
): Promise<NextResponse | null> {
  const reject = (reason: string): null => {
    try {
      onReject?.(reason);
    } catch {
      /* never let a reporter break the paid path */
    }
    return null;
  };
  let key: string | null = null;
  let decision: Decision;
  const startedAt = Date.now();
  try {
    if (!replayStoreOkFor(config)) {
      warn("xrpl:0 payment refused: shared replay store (UPSTASH_REDIS_REST_* or KV_REST_API_URL/TOKEN) not configured");
      return reject(RAIL_REJECT.unavailable);
    }
    const [ready, rail] = await Promise.all([xrplPayToReady(config), getRail(config)]);
    if (!ready || !rail) return reject(RAIL_REJECT.unavailable);

    const requirement = await buildXrplRequirement(rail, atomicUsdc);
    const received = decodePaymentSignatureHeader(req.headers.get("payment-signature")!.trim()) as PaymentPayload;
    const payload = stripBazaar(received);
    const check = validateXrplPaymentPayload(payload, requirement, rail.mods);
    if (!check.ok) {
      warn(`rejected XRPL payload before facilitator (${check.reason})`);
      return reject(RAIL_REJECT.invalidPayload);
    }

    // Replay guard: BEFORE verify.
    const k = xrplPaymentKeyFromTx(config.network, check.tx);
    if (!k) {
      warn("rejected XRPL payload before facilitator (no payment slot)");
      return reject(RAIL_REJECT.invalidPayload);
    }
    if (replay.kind === "memory" && !replayWarned) {
      replayWarned = true;
      warn("XRPL replay store is per-instance memory (UPSTASH_REDIS_REST_* / KV_REST_API_URL+TOKEN not set); cross-instance replays rely on the ledger-close check", undefined, false);
    }
    let seen: ReplayState | null;
    try {
      seen = await replay.claim(k, REPLAY_TTL_MS);
    } catch (err) {
      // Fail closed: nothing verified or charged; caller serves the Base-only 402.
      warn(`replay store claim failed fp=${fp(k)}; XRPL payment not accepted`, err);
      return reject(RAIL_REJECT.unavailable);
    }
    if (seen) {
      warn(`duplicate XRPL payment rejected before verify fp=${fp(k)} state=${seen}; client gets 409`, undefined, false);
      return jsonError(409, "duplicate_payment");
    }
    key = k;
    const ticket = check.tx.TicketSequence;
    const rc: ReconcileCtx = {
      network: config.network,
      route: (() => {
        try {
          return new URL(req.url).pathname;
        } catch {
          return "unknown";
        }
      })(),
      payer: String(check.tx.Account),
      slot: typeof ticket === "number" ? `ticket:${ticket}` : `sequence:${String(check.tx.Sequence)}`,
      required: { currency: requirement.asset, issuer: String((requirement.extra as Record<string, unknown>).issuer), value: requirement.amount },
      blobHash: (() => {
        const b = blobOf(payload);
        return b ? xrplSignedTxHash(b) : null;
      })(),
    };
    const att: Attempt = { handlerRan: false, handlerThrew: false };
    attempts.set(key, att);

    let entry = paidHandlers.get(routes as object);
    if (!entry || entry.rail !== rail) {
      const keyOf = rail.keyOf;
      const tracked: AppRouteHandler = async (r) => {
        const sig = r.headers.get("payment-signature");
        let a: Attempt | undefined;
        try {
          const kk = sig ? keyOf(decodePaymentSignatureHeader(sig.trim()) as PaymentPayload) : null;
          a = kk ? attempts.get(kk) : undefined;
        } catch {
          a = undefined;
        }
        if (a) a.handlerRan = true;
        try {
          return await runOnPaidRail(() => xrplRail(rail.config), routeHandler)(r);
        } catch (err) {
          if (a) {
            a.handlerThrew = true;
            a.handlerError = err;
          }
          throw err;
        }
      };
      entry = {
        rail,
        // syncFacilitatorOnStart=false: rail.server was already initialized.
        handler: withX402(tracked, buildXrplOnlyRoutes(rail.config, routes, atomicUsdc), rail.server, undefined, undefined, false),
      };
      paidHandlers.set(routes as object, entry);
    }

    let res: NextResponse | null = null;
    let threw = false;
    let thrown: unknown;
    try {
      res = await entry.handler(payload === received ? req : withPaymentSignature(req, payload));
    } catch (err) {
      threw = true;
      thrown = err;
    }
    if (att.settle?.outcome === "success" && res && res.status < 400) {
      const looked = await lookupValidatedTx(config, att.settle.transaction);
      const when = await settledBeforeRequest(looked, startedAt);
      // Self-verification against the validated ledger. Mainnet: must be
      // checkable AND ok. Testnet: checked when the result carries meta.
      const v = looked ? verifySettledTx(looked, requirement as never, rail.mods.compareDecimalStrings, rc.payer) : "missing";
      if (v !== "ok" && (v !== "missing" || config.network === XRPL_MAINNET_CAIP2)) {
        await replaySet(key, "settle_unconfirmed");
        logXrplReconcile(rc, 502, `self_check_${v}`, att.settle.transaction, (looked?.meta as { delivered_amount?: unknown } | undefined)?.delivered_amount);
        warn(`settled tx failed ledger self-check fp=${fp(key)} reason=${safeCode(v)}; client gets 502 settlement_unconfirmed`, undefined, false);
        return jsonError(502, "settlement_unconfirmed");
      }
      if (when === "replay") {
        await replaySet(key, "settled");
        warn(`cross-instance replay: ledger closed before this request fp=${fp(key)}; client gets 409`, undefined, false);
        return jsonError(409, "duplicate_payment");
      }
      if (when === "unknown") {
        if (replay.kind === "memory") {
          // No shared store and the ledger time can't be read: a cross-instance
          // replay can't be ruled out, so don't deliver. Settled → never a 402.
          await replaySet(key, "settle_unconfirmed");
          logXrplReconcile(rc, 502, "settled_tx_time_unreadable", att.settle.transaction);
          warn(`could not read settled tx time fp=${fp(key)} on memory replay store; client gets 502 settlement_unconfirmed`, undefined, false);
          return jsonError(502, "settlement_unconfirmed");
        }
        warn(`could not read settled tx time fp=${fp(key)}; serving the paid response (shared replay store)`, undefined, false);
      }
    }
    decision = await decide(key, att, res, threw, thrown, rc);
  } catch (err) {
    // Our own code threw before/around the facilitator: nothing was settled.
    if (key && !attempts.get(key)?.settle) await replayRelease(key);
    warn("XRPL payment path threw", err);
    return reject(RAIL_REJECT.error);
  } finally {
    if (key) attempts.delete(key);
  }
  if (decision.kind === "rethrow") throw decision.err;
  return decision.kind === "response" ? decision.res : reject(decision.reason);
}
