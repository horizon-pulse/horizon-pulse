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
 *   - Keep-present (fix 2026-10-17, live fault 9:34 AM ET: 33/108 prod 402s
 *     had no XRPL entry; same shape as the Solana fix of 10/8, 190f85c/153d1f3):
 *       - once this instance has CONFIRMED the entry (good rail init + payTo
 *         ready), a later failed or timed-out check (account_info /
 *         account_lines RPC, facilitator /supported refresh, SDK init) NEVER
 *         hides it. Only a CONFIRMED ABSENCE does: the RPC answered that the
 *         account is gone / has no usable RLUSD trust line / needs a dest tag,
 *         or the facilitator answered /supported without the one exact kind
 *         (XrplRailAbsentError), with an "[xrpl-rail][ALERT] xrpl_entry_dropped".
 *       - cold (never confirmed): a failed check is retried inside the same
 *         request (COLD_ATTEMPTS, COLD_RETRY_DELAY_MS, whole cold check capped
 *         at initTimeoutMs + COLD_EXTRA_BUDGET_MS, i.e. 4.0 s by default),
 *         then re-checked after COLD_BACKOFF_BASE_MS doubling to
 *         COLD_BACKOFF_MAX_MS (5 s, 10 s, 20 s, 40 s, 60 s...).
 *       - cold-start fix (2026-10-18, Odin 11:08; prod 10:28 24/81 and 11:04
 *         29/81 402s without XRPL right after a deploy): a cold check that
 *         FAILED (timeout / transport / 5xx / malformed / slow SDK load) is not
 *         an absence, so the entry STAYS in the 402 meanwhile. Until the rail
 *         has initialised, the entry is built from config by
 *         coldXrplRequirement(): byte-identical to the SDK-built one (same
 *         fields, same key order, same assertXrplRequirement check; payTo is
 *         the pinned config.payTo). Only a CONFIRMED absence hides it, cold
 *         or warm, with one "[xrpl-rail][ALERT] xrpl_entry_dropped" per
 *         transition (payto_not_ready / facilitator_kind_absent /
 *         sdk_unavailable = the @x402/xrpl import itself rejected). The paid
 *         path is unchanged: it still needs a confirmed rail + payTo ready
 *         (else the untouched Base-only 402, nothing charged).
 *       - checks that keep failing raise "[xrpl-rail][ALERT] xrpl_check_failing"
 *         after ALERT_CONSECUTIVE_FAILURES in a row and again after
 *         ALERT_STALE_MS without success, each at most once per check+reason
 *         per episode (re-armed by the next success).
 *   - A good init is refreshed every RAIL_TTL_MS (re-fetches the facilitator's
 *     /supported); a failed refresh of a confirmed rail is retried every
 *     WARM_RETRY_MS while the confirmed rail keeps serving.
 *   - payTo readiness guard (the Solana token-account guard's XRPL twin): the
 *     XRPL entry is shown ONLY while the pinned payTo account exists on the
 *     configured network AND holds an RLUSD trust line to the issuer (limit
 *     > 0, not frozen) AND does not require a destination tag / deposit
 *     authorization. Read-only JSON-RPC (account_info + account_lines),
 *     cached READY_TTL_MS (~10 min), so it flips on by itself once Michael
 *     activates the account and adds the trust line (no redeploy). Confirmed
 *     absent → hidden. RPC error → see keep-present above.
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
import { createHash, randomBytes } from "node:crypto";
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
  encodePaymentResponseHeader,
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
import { ReplaySelfTestError, createReplayStore, encodeReplayValue, parseReplayValue, type ReplayState, type ReplayStore } from "./xrpl-replay-store";
import { runOnPaidRail, xrplRail } from "./paid-rail";

const LOG = "[xrpl-rail]";
/** Confirmed absence (facilitator answered without the kind / pinned constants disagree): re-check after this long. */
const RETRY_AFTER_MS = 60_000;
/** Re-initialise a good rail (re-fetch the facilitator's /supported) this often. */
export const RAIL_TTL_MS = 10 * 60_000;
/** payTo readiness result (ready or not) is cached this long. */
export const READY_TTL_MS = 10 * 60_000;
/** Confirmed instance, failed refresh (entry kept): retry the check this often. */
export const WARM_RETRY_MS = 60_000;
/** Cold check: attempts inside one request before giving up for this request. */
export const COLD_ATTEMPTS = 2;
/** Cold check: pause between attempts. */
export const COLD_RETRY_DELAY_MS = 250;
/**
 * Cold check budget: all attempts together finish within initTimeoutMs + this
 * (default 2.5 s + 1.5 s = 4.0 s; max 5 s + 1.5 s). Readiness and rail init run
 * in parallel, so this also bounds the first 402 of a cold instance. A fast
 * failure (refused / 5xx) costs ~COLD_RETRY_DELAY_MS extra, not the budget.
 */
export const COLD_EXTRA_BUDGET_MS = 1_500;
/** Cold, still failing: hidden for 5 s after the 1st failed check, then 10, 20, 40, capped at 60 s (never longer than before the fix). */
export const COLD_BACKOFF_BASE_MS = 5_000;
export const COLD_BACKOFF_MAX_MS = 60_000;
/** ALERT after this many failed checks in a row (one failed check never alerts). */
export const ALERT_CONSECUTIVE_FAILURES = 3;
/** ALERT when a check has had no success for this long (since the last confirmation, or the first failure if never confirmed). */
export const ALERT_STALE_MS = 30 * 60_000;
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
/**
 * Redemption lease (stored in the value, not the TTL): a request that won the undelivered → redeeming CAS owns
 * delivery for this long. > XRPL_ROUTE_MAX_DURATION_S (60 s) so a live owner never loses it; a crashed owner's
 * lease can be taken over (again by CAS) after it.
 */
export const XRPL_REDEEM_LEASE_MS = 90_000;
/** M1: an in_flight claim older than this (> route maxDuration 60 s) belongs to a dead request → redeemable. */
export const XRPL_IN_FLIGHT_STALE_MS = XRPL_REDEEM_LEASE_MS;
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
  railAbsentKey = null;
  readyCache = null;
  readyRefresh = null;
  failures.ready = freshFailure();
  failures.rail = freshFailure();
  alertedEpisodes.clear();
  paidHandlers = new WeakMap();
  replay = createReplayStore();
  replayWarned = false;
  evalCache = null;
  evalInflight = null;
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

export type XrplCheck = "payto_ready" | "rail";
export type XrplAlert =
  | { kind: "warn_rate"; count: number; windowMs: number; threshold: number }
  /** A check keeps failing (3 in a row, or no success for 30 min). entry: whether this instance still shows XRPL. */
  | { kind: "xrpl_check_failing"; check: XrplCheck; reason: "consecutive_failures" | "stale"; failures: number; sinceMs: number; entry: "kept" | "hidden" }
  /** A confirmed absence hid the entry (an entry this instance had confirmed, or a cold instance's first definitive answer). Once per transition. */
  | { kind: "xrpl_entry_dropped"; reason: "payto_not_ready" | "facilitator_kind_absent" | "sdk_unavailable" }
  /**
   * HIGH: settle reported validated tesSUCCESS (funds moved) but our independent ledger re-read could not confirm
   * it; the paid response was delivered anyway. field = what differed (or "unreadable"). Sentinel acts on these.
   */
  | { kind: "xrpl_settled_unverified"; severity: "high"; field: XrplMismatchField; reason: string }
  /**
   * HIGH: the shared replay store refused/failed a trivial EVAL (cas needs it). The XRPL rail is treated as
   * confirmed absent on this instance (no XRPL entry in the 402, XRPL payments refused) until a recheck passes.
   * Once per failure episode.
   */
  | { kind: "xrpl_replay_eval_unavailable"; severity: "high"; reason: string }
  /** HIGH: an ambiguous settle named a tx hash other than the one we computed from the blob we submitted (L1). Not delivered. */
  | { kind: "xrpl_settle_hash_mismatch"; severity: "high" };

/** Which part of a settled payment the ledger re-read disagreed on ("transaction": not a Payment / other payer). */
export type XrplMismatchField = "destination" | "issuer" | "amount" | "unreadable" | "transaction";

/** verifySettledTx result → mismatch field. */
export function xrplMismatchField(v: string): XrplMismatchField {
  if (v === "missing") return "unreadable";
  if (v === "destination_mismatch" || v === "unexpected_destination_tag") return "destination";
  if (v === "delivered_issuer_mismatch") return "issuer";
  if (v === "delivered_amount_mismatch" || v === "delivered_value_unparseable" || v === "delivered_not_issued" || v === "delivered_currency_mismatch") return "amount";
  return "transaction";
}

function defaultAlertHook(alert: XrplAlert): void {
  console.error(`${LOG}[ALERT]${"severity" in alert && alert.severity === "high" ? "[HIGH]" : ""} ${JSON.stringify(alert)}`);
}

let alertHook: (alert: XrplAlert) => void = defaultAlertHook;

/** Route [xrpl-rail] alerts somewhere else (pager, webhook). null = default console.error line. */
export function setXrplAlertHook(fn: ((alert: XrplAlert) => void) | null): void {
  alertHook = fn ?? defaultAlertHook;
}

let warnTimes: number[] = [];
let warnAlertedAt = 0;

function emitAlert(alert: XrplAlert): void {
  try {
    alertHook(alert);
  } catch {
    /* an alert sink must never break a request */
  }
}

/** Consecutive failed checks for one check kind (a cold check's in-request retry counts as one check). */
type Failure = { streak: number; firstFailAt: number };
const freshFailure = (): Failure => ({ streak: 0, firstFailAt: 0 });
const failures: { ready: Failure; rail: Failure } = { ready: freshFailure(), rail: freshFailure() };
/** Dedupe: "<check>:<reason>" alerted in the current failure episode (cleared by the next success). */
const alertedEpisodes = new Set<string>();

function noteCheckFailure(check: XrplCheck, f: Failure, confirmedAt: number | undefined, entry: "kept" | "hidden"): void {
  const now = Date.now();
  f.streak++;
  if (!f.firstFailAt) f.firstFailAt = now;
  const since = now - (confirmedAt ?? f.firstFailAt);
  const fire = (reason: "consecutive_failures" | "stale") => {
    const k = `${check}:${reason}`;
    if (alertedEpisodes.has(k)) return;
    alertedEpisodes.add(k);
    emitAlert({ kind: "xrpl_check_failing", check, reason, failures: f.streak, sinceMs: since, entry });
  };
  if (f.streak >= ALERT_CONSECUTIVE_FAILURES) fire("consecutive_failures");
  if (since >= ALERT_STALE_MS) fire("stale");
}

function noteCheckSuccess(check: XrplCheck, f: Failure): void {
  f.streak = 0;
  f.firstFailAt = 0;
  alertedEpisodes.delete(`${check}:consecutive_failures`);
  alertedEpisodes.delete(`${check}:stale`);
}

/** Cold backoff after `streak` failed checks: 5 s, 10 s, 20 s, 40 s, 60 s, 60 s... */
export function coldBackoffMs(streak: number): number {
  return Math.min(COLD_BACKOFF_BASE_MS * 2 ** Math.max(0, streak - 1), COLD_BACKOFF_MAX_MS);
}

/** Cold check: up to COLD_ATTEMPTS tries within initTimeoutMs + COLD_EXTRA_BUDGET_MS; a confirmed absence is not retried. */
async function coldAttempts<T>(initTimeoutMs: number, attempt: (timeoutMs: number) => Promise<T>): Promise<T> {
  const deadline = Date.now() + initTimeoutMs + COLD_EXTRA_BUDGET_MS;
  let lastErr: unknown;
  for (let i = 0; i < COLD_ATTEMPTS; i++) {
    if (i > 0) {
      if (isConfirmedAbsence(lastErr) || deadline - Date.now() - COLD_RETRY_DELAY_MS < 100) break;
      await new Promise((res) => setTimeout(res, COLD_RETRY_DELAY_MS));
    }
    try {
      return await attempt(Math.max(1, Math.min(initTimeoutMs, deadline - Date.now())));
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

function noteWarn(): void {
  const now = Date.now();
  warnTimes.push(now);
  const cutoff = now - WARN_ALERT_WINDOW_MS;
  while (warnTimes.length && warnTimes[0] <= cutoff) warnTimes.shift();
  if (warnTimes.length >= WARN_ALERT_THRESHOLD && now - warnAlertedAt >= WARN_ALERT_WINDOW_MS) {
    warnAlertedAt = now;
    emitAlert({ kind: "warn_rate", count: warnTimes.length, windowMs: WARN_ALERT_WINDOW_MS, threshold: WARN_ALERT_THRESHOLD });
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
  /** Clone of the route handler's own (<400) response: delivered if an ambiguous settle is then confirmed on the ledger. */
  paidRes?: Response;
  /** The SUBMITTED tx (hash computed from the blob we verified + submitted, its LastLedgerSequence), stored in the slot. */
  sub?: SubmittedTx;
  /** The exact value our claim wrote (N6 compare-and-delete). */
  claimValue?: string;
};
/** Stored in the replay slot from claim time on (Odin 11:56 H1): later lookups / never-landed proofs use ONLY this. */
type SubmittedTx = { hash: string; lls: number };
const attempts = new Map<string, Attempt>();

/** R1: only plain lower-case reason codes (/^[a-z0-9_]+$/, ≤ 80 chars) are ever logged. */
export function safeCode(value: unknown): string {
  return typeof value === "string" && value.length <= 80 && /^[a-z0-9_]+$/.test(value) ? value : "unrecognized";
}

/** Reasons that mean "the outcome is not known yet" (spec §Duplicate Settlement: duplicate_settlement = seen, not settled). */
const UNRESOLVED_SETTLE_REASONS = new Set(["settlement_pending", "duplicate_settlement"]);

function wellFormedHash(v: unknown): string | undefined {
  return typeof v === "string" && /^[0-9A-Fa-f]{64}$/.test(v) ? v : undefined;
}

function classifySettleResult(res: SettleResponse): SettleOutcome {
  if (res.success) {
    return { outcome: "success", reason: "success", raw: "success", timeout: false, transaction: typeof res.transaction === "string" ? res.transaction : undefined };
  }
  const raw = String(res.errorReason ?? "unknown");
  const unresolved = UNRESOLVED_SETTLE_REASONS.has(raw) || (typeof res.transaction === "string" && res.transaction !== "");
  // L1: keep the hash the facilitator named (if well-formed) so the ambiguous path can require it to equal ours.
  return { outcome: unresolved ? "unconfirmed" : "failed", reason: safeCode(raw), raw, timeout: false, transaction: wellFormedHash(res.transaction) };
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
    return { outcome: unresolved ? "unconfirmed" : "failed", reason: safeCode(raw), raw, timeout: false, transaction: wellFormedHash(err.transaction) };
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

/**
 * Odin 12:07 F1: is `blobHex` a validly signed tx whose SigningPubKey derives to its own Account (master key), with
 * the signature cryptographically verified? Single-signed only: multisig (Signers), regular-key (SigningPubKey of
 * another account) and unsigned blobs are rejected. Never throws (any error → not ok).
 */
export type XrplMasterSigResult = { ok: true; account: string } | { ok: false; reason: "unsigned" | "multisig" | "not_master_key" | "bad_signature" | "undecodable" };
async function defaultMasterSigCheck(blobHex: string): Promise<XrplMasterSigResult> {
  try {
    const x = await import("xrpl");
    const tx = x.decode(blobHex) as Record<string, unknown>;
    if (tx.Signers !== undefined) return { ok: false, reason: "multisig" };
    const pub = tx.SigningPubKey;
    const sig = tx.TxnSignature;
    if (typeof pub !== "string" || !/^[0-9A-Fa-f]{66}$/.test(pub) || typeof sig !== "string" || sig.length === 0) return { ok: false, reason: "unsigned" };
    if (typeof tx.Account !== "string" || x.deriveAddress(pub) !== tx.Account) return { ok: false, reason: "not_master_key" };
    return x.verifySignature(blobHex) ? { ok: true, account: tx.Account } : { ok: false, reason: "bad_signature" };
  } catch {
    return { ok: false, reason: "undecodable" };
  }
}
let masterSigCheck: (blobHex: string) => Promise<XrplMasterSigResult> = defaultMasterSigCheck;
export const xrplMasterKeySigned = (blobHex: string): Promise<XrplMasterSigResult> => masterSigCheck(blobHex);
/** Tests only: replace the signature check (null = the real xrpl.js check). */
export function __setXrplMasterSigCheckForTests(fn: ((blobHex: string) => Promise<XrplMasterSigResult>) | null): void {
  masterSigCheck = fn ?? defaultMasterSigCheck;
}

/**
 * Odin 12:17 (delta 5, decision 2): a master-key signature only binds if the master key is still ENABLED on the
 * validated ledger. One read-only `account_info` (ledger_index validated) for the Account, bounded by
 * XRPL_MASTER_CHECK_DEADLINE_MS. "enabled" only when the answer is validated and Flags lacks lsfDisableMaster;
 * lsfDisableMaster → "disabled"; any error / non-validated / malformed / timeout → "unknown" (callers fail closed).
 */
export const LSF_DISABLE_MASTER = 0x00100000;
export const XRPL_MASTER_CHECK_DEADLINE_MS = 2_000;
let masterCheckDeadlineMs = XRPL_MASTER_CHECK_DEADLINE_MS;
/** Tests only: shorten the master-key check deadline (null = default). */
export function __setXrplMasterCheckDeadlineForTests(ms: number | null): void {
  masterCheckDeadlineMs = ms ?? XRPL_MASTER_CHECK_DEADLINE_MS;
}
export async function xrplMasterKeyEnabled(config: XrplRailConfig, account: string): Promise<"enabled" | "disabled" | "unknown"> {
  try {
    const ms = Math.max(1, Math.min(config.initTimeoutMs, masterCheckDeadlineMs));
    const r = asResult(
      await withTimeout(rpc(config.rpcUrl, "account_info", { account, ledger_index: "validated" }, ms), ms, "XRPL master-key check"),
      "account_info",
    );
    if (r.status === "error" || r.validated !== true) return "unknown";
    const flags = (r.account_data as { Flags?: unknown; Account?: unknown } | undefined)?.Flags;
    if (typeof flags !== "number" || !Number.isInteger(flags)) return "unknown";
    return (flags & LSF_DISABLE_MASTER) !== 0 ? "disabled" : "enabled";
  } catch {
    return "unknown";
  }
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
 * One grep-able JSON line per settlement_unconfirmed (502/504) outcome, and per
 * paid response delivered without a clean ledger confirmation (status 200).
 * Not redacted on purpose: only public ledger data (hash, addresses,
 * amounts), no payload, no facilitator text. See docs/xrpl-rail.md runbook.
 */
export function logXrplReconcile(ctx: ReconcileCtx, status: 200 | 402 | 502 | 504, reason: string, settledHash?: string, delivered?: unknown): void {
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
 * A CONFIRMED absence on the rail side: the facilitator answered /supported
 * but no longer offers the one exact kind we need (or advertises fee
 * sponsoring), or our pinned constants disagree with the SDK. Only this may
 * retire a rail this instance has confirmed; anything else thrown during a
 * refresh (timeout, transport, HTTP status, malformed reply, SDK init error)
 * is transient and keeps the confirmed rail.
 */
export class XrplRailAbsentError extends Error {
  override name = "XrplRailAbsentError";
}

/** The @x402/xrpl import itself rejected (a slow import that times out is NOT this). Confirmed absence: nothing can run. */
export class XrplSdkUnavailableError extends XrplRailAbsentError {
  override name = "XrplSdkUnavailableError";
}

function sdkUnavailable(err: unknown): never {
  const e = new XrplSdkUnavailableError("XRPL SDK could not be loaded");
  (e as { cause?: unknown }).cause = err;
  throw e;
}

/** True if `err` (or anything on its `cause` chain, e.g. the SDK's "Failed to initialize" wrapper) is a confirmed absence. */
export function isConfirmedAbsence(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && i < 5; e = (e as { cause?: unknown }).cause, i++) {
    if (e instanceof XrplRailAbsentError) return true;
  }
  return false;
}

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
        throw new XrplRailAbsentError("XRPL facilitator URL must be https");
      }
    }
    let supported: SupportedResponse;
    try {
      supported = await this.inner.getSupported();
    } catch (err) {
      throw scrubFacilitatorError(err, "supported");
    }
    // A malformed reply is a transient error, not a confirmed absence.
    if (!supported || !Array.isArray(supported.kinds)) throw new Error("XRPL facilitator /supported returned a malformed response");
    const kinds = supported.kinds.filter(
      (k) => k.x402Version === 2 && k.scheme === "exact" && k.network === this.network,
    );
    if (kinds.length !== 1) {
      throw new XrplRailAbsentError(`XRPL facilitator does not list exactly one x402 v2 exact kind on ${this.network}`);
    }
    const sponsored = (kinds[0].extra as { areFeesSponsored?: unknown } | undefined)?.areFeesSponsored;
    if (sponsored !== undefined && sponsored !== false) {
      throw new XrplRailAbsentError("XRPL facilitator advertises areFeesSponsored != false (spec requires false)");
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

/** builtAt = last SUCCESSFUL (confirmed) init; retryAt = earliest next refresh after a failed one. */
let railState: { key: string; rail: Rail; builtAt: number; retryAt?: number } | null = null;
let railInit: { key: string; promise: Promise<Rail | null> } | null = null;
let failedKey: string | null = null;
let failedUntil = 0;
/** Key whose last DEFINITIVE rail answer was a confirmed absence (cleared by a good init; a later transient failure keeps it). */
let railAbsentKey: string | null = null;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

async function initRail(config: XrplRailConfig): Promise<Rail> {
  const mods = await loader().catch(sdkUnavailable);
  // Cross-check our pinned constants against the package.
  if (mods.XRPL_MAINNET !== XRPL_MAINNET_CAIP2 || mods.XRPL_TESTNET !== XRPL_TESTNET_CAIP2) {
    throw new XrplRailAbsentError("XRPL CAIP-2 mismatch between repo constants and @x402/xrpl");
  }
  if (mods.RLUSD_CURRENCY !== RLUSD_CURRENCY_HEX) {
    throw new XrplRailAbsentError("RLUSD currency code mismatch between repo constant and @x402/xrpl");
  }
  if (mods.RLUSD_MAINNET_ISSUER !== RLUSD_MAINNET_ISSUER || mods.RLUSD_TESTNET_ISSUER !== RLUSD_TESTNET_ISSUER) {
    throw new XrplRailAbsentError("RLUSD issuer mismatch between repo constants and @x402/xrpl");
  }
  const keyOf = makeKeyFn(config.network, mods);
  const local =
    config.facilitatorUrl === XRPL_SELF_FACILITATOR
      ? new LocalXrplFacilitatorClient(config.network, await facilitatorSchemeLoader(config.network).catch(sdkUnavailable))
      : undefined;
  let scheme: SchemeNetworkServer;
  try {
    scheme = new mods.ExactXrplScheme();
  } catch (err) {
    sdkUnavailable(err); // a throwing SDK constructor is deterministic, not a cold-start blip
  }
  const server = new x402ResourceServer(createXrplFacilitator(config, keyOf, local)).register(config.network, scheme);
  await server.initialize();
  return { config, server, mods, keyOf };
}

function startRailInit(config: XrplRailConfig, key: string): Promise<Rail | null> {
  if (railInit?.key === key) return railInit.promise;
  const prev = railState?.key === key ? railState : null;
  // Confirmed rail: one bounded refresh in the background. Cold: retried inside this request.
  const attempt = (ms: number) => withTimeout(initRail(config), ms, "XRPL rail init");
  const promise: Promise<Rail | null> = (prev ? attempt(config.initTimeoutMs) : coldAttempts(config.initTimeoutMs, attempt))
    .then(
      (rail): Rail | null => {
        railState = { key, rail, builtAt: Date.now() };
        failedKey = null;
        railAbsentKey = null;
        noteCheckSuccess("rail", failures.rail);
        return rail;
      },
      (err): Rail | null => {
        const now = Date.now();
        const absent = isConfirmedAbsence(err);
        const cur = railState?.key === key ? railState : null;
        if (cur && !absent) {
          // Refresh ERROR (timeout / transport / malformed / SDK init): NOT evidence XRPL is gone.
          // Keep the confirmed rail, however old; retry after WARM_RETRY_MS.
          warn("rail refresh failed; keeping last confirmed rail (present)", err, false);
          cur.retryAt = now + WARM_RETRY_MS;
          noteCheckFailure("rail", failures.rail, cur.builtAt, "kept");
          return cur.rail;
        }
        failedKey = key;
        if (absent) {
          warn(cur ? "facilitator confirmed the XRPL kind is gone; rail retired" : "rail init failed (confirmed absence)", err);
          // One ALERT per transition into "absent" (warm retire or a cold instance's first definitive answer).
          if (railAbsentKey !== key) {
            const sdk = (() => {
              for (let e: unknown = err, i = 0; e && i < 5; e = (e as { cause?: unknown }).cause, i++) if (e instanceof XrplSdkUnavailableError) return true;
              return false;
            })();
            emitAlert({ kind: "xrpl_entry_dropped", reason: sdk ? "sdk_unavailable" : "facilitator_kind_absent" });
          }
          railAbsentKey = key;
          railState = null;
          noteCheckSuccess("rail", failures.rail); // a definitive answer, not a failing check
          failedUntil = now + RETRY_AFTER_MS;
          return null;
        }
        // Cold and still failing after the in-request retry: NOT an absence. The 402 keeps XRPL
        // (coldXrplRequirement) unless the last definitive answer was absent; re-check after the backoff.
        warn("rail init failed (cold); XRPL entry kept from config until a check confirms", err, false);
        noteCheckFailure("rail", failures.rail, undefined, railAbsentKey === key ? "hidden" : "kept");
        failedUntil = now + coldBackoffMs(failures.rail.streak);
        return null;
      },
    )
    .finally(() => {
      if (railInit?.promise === promise) railInit = null;
    });
  railInit = { key, promise };
  return promise;
}

/**
 * Warm: returns the confirmed rail immediately; after RAIL_TTL_MS a background
 * refresh re-fetches /supported. A refresh ERROR keeps it (retried every
 * WARM_RETRY_MS); only a confirmed absence retires it. Cold: one bounded
 * in-request retry, then hidden for the cold backoff.
 */
async function getRail(config: XrplRailConfig): Promise<Rail | null> {
  const key = JSON.stringify(config);
  if (railState?.key === key) {
    const now = Date.now();
    if (now - railState.builtAt > RAIL_TTL_MS && now >= (railState.retryAt ?? 0)) void startRailInit(config, key);
    return railState.rail;
  }
  if (failedKey === key && Date.now() < failedUntil) return null;
  return startRailInit(config, key);
}

// ---------------------------------------------------------------------------
// payTo readiness guard (read-only RPC, cached, stale-while-revalidate)
// ---------------------------------------------------------------------------

/**
 * ready: what this instance shows. confirmedAt: last RPC answer confirming
 * ready (kept through transient errors, cleared by a definitive not-ready).
 * definitive: `ready` came from an RPC answer (not a cold failure).
 */
type ReadyState = { key: string; ready: boolean; until: number; confirmedAt?: number; definitive: boolean };
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
async function checkPayToReady(config: XrplRailConfig, timeoutMs: number = config.initTimeoutMs): Promise<boolean> {
  const [infoRaw, linesRaw] = await Promise.all([
    rpc(config.rpcUrl, "account_info", { account: config.payTo, ledger_index: "validated" }, timeoutMs),
    rpc(config.rpcUrl, "account_lines", { account: config.payTo, peer: config.issuer, ledger_index: "validated" }, timeoutMs),
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
    const prev = readyCache && readyCache.key === key ? readyCache : null;
    const confirmedAt = prev?.ready ? prev.confirmedAt : undefined;
    try {
      // Confirmed instance: one bounded check (background). Cold: retried inside this request.
      const ready = confirmedAt !== undefined ? await checkPayToReady(config) : await coldAttempts(config.initTimeoutMs, (ms) => checkPayToReady(config, ms));
      const now = Date.now();
      // A definitive RPC answer either way (ready, or confirmed absence: actNotFound, no/frozen/zero trust line, flags).
      // One ALERT per transition into "absent": from confirmed, or a cold instance's first definitive answer.
      if (!ready && !(prev?.definitive && !prev.ready)) emitAlert({ kind: "xrpl_entry_dropped", reason: "payto_not_ready" });
      readyCache = { key, ready, until: now + READY_TTL_MS, definitive: true, ...(ready ? { confirmedAt: now } : {}) };
      noteCheckSuccess("payto_ready", failures.ready);
      return ready;
    } catch (err) {
      // Transient RPC failure (timeout, transport, 5xx, malformed). Never a reason to hide a confirmed entry.
      const now = Date.now();
      if (confirmedAt !== undefined) {
        warn("payTo readiness RPC check failed; keeping last confirmed result (present)", err, false);
        readyCache = { key, ready: true, until: now + WARM_RETRY_MS, confirmedAt, definitive: false };
        noteCheckFailure("payto_ready", failures.ready, confirmedAt, "kept");
        return true;
      }
      if (prev?.definitive && !prev.ready) {
        // Last definitive answer was "not ready": keep it, re-check after WARM_RETRY_MS.
        warn("payTo readiness RPC check failed; last answer was not ready", err);
        readyCache = { ...prev, until: now + WARM_RETRY_MS };
        noteCheckFailure("payto_ready", failures.ready, undefined, "hidden");
        return false;
      }
      // Cold, never answered: NOT an absence, the 402 keeps XRPL (getXrplAccept); re-check after the backoff.
      warn("payTo readiness RPC check failed (cold); XRPL entry kept until a check confirms", err, false);
      noteCheckFailure("payto_ready", failures.ready, undefined, "kept");
      readyCache = { key, ready: false, until: now + coldBackoffMs(failures.ready.streak), definitive: false };
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
 * from cache and re-checks in the background after the TTL. Cold (never
 * confirmed, last check failed): the first request after the backoff re-checks
 * inline (bounded). Transient failures never hide a confirmed entry. Never throws.
 */
export async function xrplPayToReady(config: XrplRailConfig): Promise<boolean> {
  const key = `${config.network}|${config.rpcUrl}|${config.issuer}|${config.payTo}`;
  if (readyCache && readyCache.key === key) {
    if (Date.now() >= readyCache.until) {
      const coldFailed = !readyCache.ready && !readyCache.definitive;
      if (coldFailed) return refreshReady(config, key);
      void refreshReady(config, key);
    }
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

/** True only if the last readiness answer for this config was a DEFINITIVE not-ready (RPC said so). */
function payToConfirmedAbsent(config: XrplRailConfig): boolean {
  const key = `${config.network}|${config.rpcUrl}|${config.issuer}|${config.payTo}`;
  return !!readyCache && readyCache.key === key && !readyCache.ready && readyCache.definitive;
}

/**
 * The entry a cold instance serves before its rail has initialised: built from
 * config alone, field for field and in the same key order as the SDK-built one
 * (tests assert byte-identity), and held to the same assertXrplRequirement.
 * payTo is the pinned config.payTo, never anything else.
 */
export function coldXrplRequirement(config: XrplRailConfig, atomicUsdc: string): PaymentRequirements {
  const price = xrplPrice(config, atomicUsdc);
  const req = {
    scheme: "exact",
    network: config.network,
    amount: price.amount,
    asset: price.asset,
    payTo: config.payTo,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    // Same key order as the SDK-built entry: route extra (issuer, assetTransferMethod) first, then the facilitator's areFeesSponsored.
    extra: { issuer: config.issuer, ...(config.assetTransferMethod ? { assetTransferMethod: config.assetTransferMethod } : {}), areFeesSponsored: false },
  } as PaymentRequirements;
  assertXrplRequirement(req, config, atomicUsdc);
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
    const [ready, rail, evalOk] = await Promise.all([xrplPayToReady(config), getRail(config), xrplReplayEvalOk()]);
    // Replay store can't run EVAL (cas): fail closed, XRPL confirmed absent on this instance (Odin 11:44 (e)).
    if (!evalOk) return null;
    // Hidden ONLY on a confirmed absence; a failed/unanswered cold check keeps the entry (Odin 11:08).
    if (!ready && payToConfirmedAbsent(config)) return null;
    if (!rail && railAbsentKey === JSON.stringify(config)) return null;
    return rail ? await buildXrplRequirement(rail, atomicUsdc) : coldXrplRequirement(config, atomicUsdc);
  } catch (err) {
    warn("could not build XRPL requirement", err);
    return null;
  }
}

/**
 * Odin 2:32 (2), LOW-1: the XRPL entry built ONLY from warm per-instance state, for the Solana reject/unavailable
 * 402. Never starts rail init, never runs the payTo readiness RPC or the replay-store EVAL probe (so that path keeps
 * its time margin). null (left out) unless: the shared-store gate passes, the rail for this exact config is already
 * built, payTo readiness has been checked for this config and is not a confirmed absence (same rule as
 * getXrplAccept), and (stores with EVAL) the last EVAL probe passed. Never throws.
 */
export async function getXrplAcceptIfWarm(config: XrplRailConfig, atomicUsdc: string): Promise<PaymentRequirements | null> {
  try {
    if (!replayStoreOkFor(config)) return null;
    if (railState?.key !== JSON.stringify(config)) return null;
    const rkey = `${config.network}|${config.rpcUrl}|${config.issuer}|${config.payTo}`;
    if (!readyCache || readyCache.key !== rkey) return null;
    if (payToConfirmedAbsent(config)) return null;
    if (replay.probeEval && !(evalCache && evalCache.store === replay && evalCache.ok)) return null;
    return await buildXrplRequirement(railState.rail, atomicUsdc);
  } catch (err) {
    warn("could not build warm XRPL requirement", err);
    return null;
  }
}

/** withXrplAccept, but only from warm state (getXrplAcceptIfWarm); unchanged response when XRPL is cold or absent. */
export async function withXrplAcceptIfWarm<T extends Response>(res: T, config: XrplRailConfig, atomicUsdc: string): Promise<T | NextResponse> {
  try {
    const accept = await getXrplAcceptIfWarm(config, atomicUsdc);
    return accept ? await appendAccept(res, accept) : res;
  } catch (err) {
    warn("could not append warm XRPL requirement", err);
    return res;
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
  evalCache = null;
  evalInflight = null;
}

// ---------------------------------------------------------------------------
// Replay-store EVAL probe (Odin 11:44 (e), BLOCKER, fail closed)
// ---------------------------------------------------------------------------
/** A passing probe is trusted this long per instance before it is re-run. */
export const XRPL_EVAL_OK_RECHECK_MS = 10 * 60_000;
/** A failing probe is re-run after this long (the rail stays absent until then). */
export const XRPL_EVAL_FAIL_RECHECK_MS = 60_000;
/**
 * Odin 12:28: the probe is now EVAL + a 5-command self-test (6 sequential Upstash REST calls, each also capped at the
 * store's 1.5 s). Whole probe bounded at 3 s: runs in parallel with rail init (≤ XRPL_MAX_INIT_TIMEOUT_MS 5 s), so it
 * adds nothing to the worst case; a timeout = unavailable (reason "timeout").
 */
export const XRPL_EVAL_PROBE_DEADLINE_MS = 3_000;
export type XrplReplayEvalStatus = "ok" | "unavailable" | "not_applicable";
let evalCache: { store: ReplayStore; ok: boolean; until: number } | null = null;
let evalInflight: Promise<boolean> | null = null;

/**
 * True when the replay store can run the atomic scripts the rail depends on (cas = Upstash EVAL). Runs a trivial
 * `EVAL "return 1" 0` plus the replay-store self-test (SET / wrong-value CAS_DELETE keeps it / right-value
 * CAS_DELETE removes it, Odin 12:28) once per instance (cached: ok 10 min, failure 60 s; concurrent callers share
 * one probe). Any error, timeout (whole probe XRPL_EVAL_PROBE_DEADLINE_MS 3 s; each store call 1.5 s), wrong answer
 * or failed self-test step = unavailable → the caller treats the XRPL rail as
 * confirmed absent and an ALERT xrpl_replay_eval_unavailable fires (once per failure episode).
 * Stores without probeEval (per-instance memory: testnet only, atomic in-process) are not probed.
 */
export async function xrplReplayEvalOk(): Promise<boolean> {
  const store = replay;
  if (!store.probeEval) return true;
  const now = Date.now();
  if (evalCache && evalCache.store === store && now < evalCache.until) return evalCache.ok;
  if (evalInflight) return evalInflight;
  const wasOk = !evalCache || evalCache.store !== store || evalCache.ok;
  evalInflight = (async () => {
    let ok = true;
    let reason = "";
    try {
      await withTimeout(store.probeEval!(), XRPL_EVAL_PROBE_DEADLINE_MS, "replay store probe");
    } catch (err) {
      ok = false;
      // Same alert kind (xrpl_replay_eval_unavailable); reason = the failing self-test step, "timeout", or the error kind.
      reason =
        err instanceof ReplaySelfTestError ? err.step : err instanceof Error && / timed out after \d+ms$/.test(err.message) ? "timeout" : errorKind(err);
    }
    evalCache = { store, ok, until: Date.now() + (ok ? XRPL_EVAL_OK_RECHECK_MS : XRPL_EVAL_FAIL_RECHECK_MS) };
    if (!ok) {
      warn(`replay store EVAL probe failed (${reason}); XRPL rail treated as absent (fail closed), recheck in ${XRPL_EVAL_FAIL_RECHECK_MS / 1000} s`, undefined, false);
      if (wasOk) emitAlert({ kind: "xrpl_replay_eval_unavailable", severity: "high", reason });
    }
    return ok;
  })().finally(() => {
    evalInflight = null;
  });
  return evalInflight;
}

/**
 * Non-secret status for the post-deploy smoke (/status meta hp-xrpl-replay-eval): "ok" | "unavailable", or
 * "not_applicable" when no shared store is configured (memory store). Runs the probe if the cache is stale. Never throws.
 */
export async function xrplReplayEvalStatus(): Promise<XrplReplayEvalStatus> {
  try {
    if (!replay.probeEval) return "not_applicable";
    return (await xrplReplayEvalOk()) ? "ok" : "unavailable";
  } catch {
    return "unavailable";
  }
}

async function replaySet(key: string, state: ReplayState | string): Promise<void> {
  try {
    await replay.set(key, state, REPLAY_TTL_MS);
  } catch (err) {
    warn(`replay store set failed fp=${fp(key)} state=${state}`, err, false);
  }
}
/**
 * Not delivered (charged or unknown): redeemable by a retry once the ledger confirms (see redeemUndelivered).
 * `sub` = the submitted tx (hash + LLS) that redemption will look up; omitted → not auto-redeemable (502 until
 * reconciled by hand: used when the facilitator named a different tx than ours, L1).
 */
async function replayMarkUndelivered(key: string, firstSeen: number, sub: SubmittedTx | undefined): Promise<void> {
  await replaySet(key, encodeReplayValue({ state: "settle_unconfirmed", firstSeen, ...(sub ?? {}) }) as ReplayState);
}
let afterDeliveryMarkHook: (() => void) | null = null;
/** Tests only: runs right after a payment is marked delivered (simulates a failure between the mark and the response). */
export function __setXrplAfterDeliveryMarkHookForTests(fn: (() => void) | null): void {
  afterDeliveryMarkHook = fn;
}
/** Mark DELIVERED ("settled"): the only state a duplicate gets 409 for. */
async function markDelivered(key: string): Promise<void> {
  await replaySet(key, "settled");
  afterDeliveryMarkHook?.();
}
/**
 * N6: a proven never-landed submitted tx frees the slot. Atomic compare-and-delete against exactly the value this
 * request owns (its claim value, or its redemption lease). Lost the race (value changed) → leave it alone. A store
 * without casDelete (custom/test stores) → leave the slot (its TTL expires); never settle_failed.
 */
async function neverLandedDelete(key: string, owned: string): Promise<void> {
  if (!replay.casDelete) {
    warn(`replay store has no compare-and-delete fp=${fp(key)}; never-landed slot left to expire`, undefined, false);
    return;
  }
  try {
    if (!(await replay.casDelete(key, owned))) warn(`never-landed delete lost (slot changed) fp=${fp(key)}; left as is`, undefined, false);
  } catch (err) {
    warn(`replay store compare-and-delete failed fp=${fp(key)}`, err, false);
  }
}
async function replayRelease(key: string): Promise<void> {
  try {
    await replay.release(key);
  } catch (err) {
    warn(`replay store release failed fp=${fp(key)}`, err, false);
  }
}

/**
 * 502/504 body for a payment that may have been charged but is not delivered yet (Odin 11:44 (b)). A retry must
 * carry the SAME signed payment: it is redeemed against the ledger and delivered once, never charged twice; a
 * re-signed payment is a NEW payment. Not golden-pinned (goldens cover 402s only).
 */
export const SETTLEMENT_UNCONFIRMED_BODY = {
  error: "settlement_unconfirmed",
  retry: "same_payment",
  message:
    "Settlement could not be confirmed yet. Retry this request with the SAME PAYMENT-SIGNATURE header (do not sign a new payment): it is delivered once the ledger confirms it (retry within 24 hours) and is never charged twice. A newly signed payment is a separate payment.",
} as const;
function unconfirmed(status: 502 | 504): NextResponse {
  return new NextResponse(JSON.stringify(SETTLEMENT_UNCONFIRMED_BODY), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
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

async function decide(key: string, att: Attempt, res: NextResponse | null, threw: boolean, thrown: unknown, rc: ReconcileCtx, firstSeen: number): Promise<Decision> {
  const s = att.settle;
  if (s) {
    if (s.outcome === "success" && res && res.status < 400) {
      await markDelivered(key);
      return { kind: "response", res };
    }
    if (s.outcome === "failed") {
      // Definitive: nothing landed. Key kept (the same tx would fail again).
      await replaySet(key, "settle_failed");
      return { kind: "base", reason: settleFailReason(s.reason) };
    }
    // Ambiguous (or settled but no deliverable response): the tx may have
    // landed. Never a 402 (would invite a second payment); no facilitator text.
    // Not delivered: a retry of the same payment redeems it once the ledger shows it (redeemUndelivered).
    await replayMarkUndelivered(key, firstSeen, att.sub);
    const timeout = s.outcome === "unconfirmed" && s.timeout;
    warn(
      `settlement unconfirmed fp=${fp(key)} reason=${s.outcome === "success" ? "settled_without_response" : s.reason}; client gets ${timeout ? 504 : 502} settlement_unconfirmed (reconcile on-ledger)`,
      undefined,
      false,
    );
    logXrplReconcile(rc, timeout ? 504 : 502, s.outcome === "success" ? "settled_without_response" : s.reason, s.transaction);
    return { kind: "response", res: unconfirmed(timeout ? 504 : 502) };
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
/** Never-landed proof (provablyNeverLanded, Odin 11:44 (d)): runs only after the validated-tx lookup came back empty. */
export const XRPL_LLS_CHECK_DEADLINE_MS = 2_500;
export const XRPL_LLS_SEARCH_SPAN = 999;
export const XRPL_WORST_CASE_MS =
  XRPL_MAX_INIT_TIMEOUT_MS + XRPL_VERIFY_TIMEOUT_MS + XRPL_SETTLE_TIMEOUT_MS + XRPL_TX_LOOKUP_DEADLINE_MS + XRPL_LLS_CHECK_DEADLINE_MS;
/**
 * Delta 5: the redeem path (no verify, no settle) = init + master-key check (F1(b) only) + validated-tx lookup +
 * never-landed proof. Asserted ≤ XRPL_WORST_CASE_MS (so it fits every XRPL route's existing budget).
 */
export const XRPL_REDEEM_WORST_CASE_MS =
  XRPL_MAX_INIT_TIMEOUT_MS + XRPL_MASTER_CHECK_DEADLINE_MS + XRPL_TX_LOOKUP_DEADLINE_MS + XRPL_LLS_CHECK_DEADLINE_MS;
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
 * Odin 11:44 (d): proof that a signed tx can NEVER land. rippled drops a tx once the validated ledger index passes
 * its LastLedgerSequence (tefMAX_LEDGER), so if
 *   1. the validated ledger index is > LastLedgerSequence (read FIRST), and
 *   2. `tx` restricted to [LastLedgerSequence − 999, LastLedgerSequence] answers txnNotFound with searched_all:true
 *      (the node holds that whole range; 1000 ledgers is rippled's max span),
 * the tx is in no ledger and never will be. Anything else (other error, searched_all false/missing, found, RPC
 * down, timeout) → false = unknown. Read-only, allow-listed RPC, ≤ XRPL_LLS_CHECK_DEADLINE_MS. A tx included
 * before LastLedgerSequence − 999 would have closed long before we first saw the payment (verify bounds the
 * window), which is the "closed before first sighting" case anyway (not paid through this flow).
 */
export async function provablyNeverLanded(config: XrplRailConfig, hash: string | null | undefined, lastLedgerSequence: unknown): Promise<boolean> {
  if (typeof hash !== "string" || !/^[0-9A-Fa-f]{64}$/.test(hash)) return false;
  const lls = lastLedgerSequence;
  if (typeof lls !== "number" || !Number.isSafeInteger(lls) || lls <= 0) return false;
  const deadline = Date.now() + XRPL_LLS_CHECK_DEADLINE_MS;
  const left = () => Math.min(config.initTimeoutMs, deadline - Date.now());
  try {
    const l = asResult(await rpc(config.rpcUrl, "ledger", { ledger_index: "validated" }, Math.max(1, left())), "ledger");
    const rawIdx = l.ledger_index ?? (l.ledger as { ledger_index?: unknown } | undefined)?.ledger_index;
    const idx = typeof rawIdx === "number" ? rawIdx : typeof rawIdx === "string" && /^\d{1,12}$/.test(rawIdx) ? Number(rawIdx) : NaN;
    if (l.status === "error" || l.validated !== true || !Number.isSafeInteger(idx) || idx <= lls) return false;
    if (left() <= 0) return false;
    const t = asResult(
      await rpc(config.rpcUrl, "tx", { transaction: hash, binary: false, min_ledger: Math.max(1, lls - XRPL_LLS_SEARCH_SPAN), max_ledger: lls }, Math.max(1, left())),
      "tx",
    );
    return t.status === "error" && t.error === "txnNotFound" && t.searched_all === true;
  } catch {
    return false;
  }
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

/**
 * The paid response for a payment confirmed on the validated ledger after an ambiguous settle: the route
 * handler's own response plus PAYMENT-RESPONSE and a private Cache-Control, as @x402/next's settle-success path.
 */
function deliverConfirmed(handlerRes: Response, settle: SettleResponse): NextResponse {
  const headers = new Headers(handlerRes.headers);
  headers.delete("transfer-encoding");
  headers.delete("settlement-overrides");
  headers.set("PAYMENT-RESPONSE", encodePaymentResponseHeader(settle));
  const cc = headers.get("cache-control");
  headers.set("Cache-Control", !cc ? "private" : cc.split(",").map((d) => d.trim().toLowerCase()).includes("private") ? cc : `${cc}, private`);
  return new NextResponse(handlerRes.body, { status: handlerRes.status, headers });
}

/** Another request holds this payment slot right now (in flight / redeeming): not delivered yet, not a duplicate. */
function inProgress(k: string): NextResponse {
  warn(`XRPL payment slot busy fp=${fp(k)}; client gets 503 payment_in_progress (retry)`, undefined, false);
  const res = jsonError(503, "payment_in_progress");
  res.headers.set("Retry-After", "5");
  return res;
}

type RedeemCtx = {
  req: NextRequest;
  routeHandler: AppRouteHandler;
  config: XrplRailConfig;
  requirement: PaymentRequirements;
  compare: (a: string, b: string) => number;
  payer: string;
  /** The retry's signed blob (hex). F1: used ONLY to check it is bound to the stored tx; never looked up or stored. */
  retryBlob: string | null;
  route: string;
  reject: (reason: string) => null;
};

/**
 * A retry of a payment we settled ambiguously (or that failed after settle) and NEVER delivered. Ledger-only:
 * nothing is verified or submitted again. Delta 4 F1: a retry whose blob hash differs from the STORED hash must be
 * master-key signed by the same Account (signature verified) or it gets 502 with the slot untouched. Exactly one
 * request wins the undelivered → redeeming CAS; it reads the validated ledger for the STORED submitted hash and:
 *   - exact payment to payTo, closed at/after firstSeen (−skew) → run the route, mark delivered (CAS), deliver;
 *   - exact payment but closed BEFORE we first saw it → not paid through our flow (a replay of a consumed blob):
 *     terminal, 409, never delivered;
 *   - validated, not tesSUCCESS → nothing moved: settle_failed, Base-only 402;
 *   - not visible and provably never landed (past the stored LLS) → N6: slot atomically deleted, Base-only 402;
 *   - not visible / not checkable / mismatch → back to undelivered, 502 settlement_unconfirmed (retry later).
 * Losers of the CAS (or a live lease) get 503 payment_in_progress. If the route errors, the slot goes back to
 * undelivered and the client gets the route's own error (status ≥ 400) or 502 (route threw).
 */
async function redeemUndelivered(k: string, ctx: RedeemCtx): Promise<NextResponse | null> {
  const { config } = ctx;
  if (!replay.get || !replay.cas) return jsonError(502, "settlement_unconfirmed");
  let raw: string | null;
  try {
    raw = await replay.get(k);
  } catch (err) {
    warn(`replay store read failed fp=${fp(k)}`, err, false);
    return inProgress(k);
  }
  const rec = parseReplayValue(raw);
  if (!raw || !rec) return inProgress(k);
  if (rec.state === "settled") return jsonError(409, "duplicate_payment");
  if (rec.state === "settle_failed") return ctx.reject(settleFailReason("transaction_failed"));
  const now = Date.now();
  if (rec.state === "in_flight") {
    // M1: an in_flight claim older than the lease belongs to a request that died (maxDuration 60 s < 90 s): it may
    // have submitted, so treat it as undelivered (ledger-only redemption below). Bare legacy in_flight: busy.
    if (rec.firstSeen === undefined || now - rec.firstSeen < XRPL_IN_FLIGHT_STALE_MS) return inProgress(k);
    warn(`stale in_flight XRPL slot fp=${fp(k)} (owner died); taking it over for ledger-only redemption`, undefined, false);
  }
  if (rec.firstSeen === undefined) {
    // Legacy / testnet-memory marker without firstSeen: can't prove it closed after we saw it → manual reconcile.
    warn(`undelivered XRPL payment fp=${fp(k)} has no firstSeen; not auto-redeemable, client gets 502`, undefined, false);
    return jsonError(502, "settlement_unconfirmed");
  }
  if (rec.hash === undefined || rec.lls === undefined) {
    // H1: no stored submitted tx (legacy value, or the facilitator named a different tx than ours): the retry blob
    // is NEVER used for a lookup or a never-landed proof → manual reconcile, slot unchanged.
    warn(`undelivered XRPL payment fp=${fp(k)} has no stored submitted tx; not auto-redeemable, client gets 502`, undefined, false);
    return jsonError(502, "settlement_unconfirmed");
  }
  // F1 (Odin 12:07): a retry may redeem ONLY if (a) its blob hashes to the stored submitted hash, or (b) it is a
  // validly signed tx whose SigningPubKey derives to the slot's Account (master key), signature verified (the
  // payer re-signed the same Sequence). Anything else (unsigned, regular-key, multisig, bad signature) → 502 with
  // the slot untouched: no lease, no takeover, no transition, no lookup.
  const retryHash = ctx.retryBlob ? xrplSignedTxHash(ctx.retryBlob) : null;
  if (retryHash !== rec.hash) {
    const sig = ctx.retryBlob ? await xrplMasterKeySigned(ctx.retryBlob) : ({ ok: false, reason: "undecodable" } as const);
    if (!sig.ok) {
      // Odin 12:28 (1): BARE 502 body (not the redeemable "retry with the same payment" body): this blob is not
      // bound to the stored tx, so retrying it can never redeem.
      warn(`XRPL retry not bound to the stored tx fp=${fp(k)} (${sig.reason}); slot untouched, client gets bare 502`, undefined, false);
      return jsonError(502, "settlement_unconfirmed");
    }
    // Delta 5 (Odin 12:17): F1(b) only. The master key must still be enabled (validated account_info, bounded);
    // lsfDisableMaster set, or the read fails / times out → 502, slot untouched (fail closed). F1(a) never reads.
    const master = await xrplMasterKeyEnabled(config, sig.account);
    if (master !== "enabled") {
      warn(`XRPL master-key re-sign rejected fp=${fp(k)} (master key ${master}); slot untouched, client gets bare 502`, undefined, false);
      return jsonError(502, "settlement_unconfirmed");
    }
  }
  if (rec.state === "redeeming" && rec.lease !== undefined && now - rec.lease < XRPL_REDEEM_LEASE_MS) return inProgress(k);
  const firstSeen = rec.firstSeen;
  const sub: SubmittedTx = { hash: rec.hash, lls: rec.lls };
  const owner = randomBytes(8).toString("hex");
  const mine = encodeReplayValue({ state: "redeeming", firstSeen, lease: now, owner, ...sub });
  const myDelivered = encodeReplayValue({ state: "settled", firstSeen, owner, ...sub });
  const undelivered = encodeReplayValue({ state: "settle_unconfirmed", firstSeen, ...sub });
  const cas = async (to: string): Promise<boolean> => {
    try {
      return await replay.cas!(k, mine, to, REPLAY_TTL_MS);
    } catch (err) {
      warn(`replay store cas failed fp=${fp(k)}`, err, false);
      return false;
    }
  };
  let won: boolean;
  try {
    won = await replay.cas(k, raw, mine, REPLAY_TTL_MS);
  } catch (err) {
    warn(`replay store cas failed fp=${fp(k)}`, err, false);
    won = false;
  }
  if (!won) return inProgress(k);

  const rc: ReconcileCtx = {
    network: config.network,
    route: ctx.route,
    payer: ctx.payer,
    slot: "redeem",
    required: { currency: ctx.requirement.asset, issuer: String((ctx.requirement.extra as Record<string, unknown>).issuer), value: ctx.requirement.amount },
    blobHash: sub.hash,
  };
  try {
    // H1: the STORED submitted hash / LLS only. The retry blob (unverified: no signature or LLS check on this path)
    // just located the slot; it is never looked up and never used for the never-landed proof.
    const looked = await lookupValidatedTx(config, sub.hash);
    const v = looked ? verifySettledTx(looked, ctx.requirement as never, ctx.compare, ctx.payer) : "missing";
    if (looked && v === "result_not_tessuccess") {
      await cas("settle_failed");
      warn(`redeem: tx is not tesSUCCESS on the validated ledger fp=${fp(k)}; not charged, Base-only 402`, undefined, false);
      return ctx.reject(settleFailReason("transaction_failed"));
    }
    if (looked && v === "ok") {
      // N4: redeem requires "fresh" (unknown time → not delivered). Unlike the first request (which SDK-verified the
      // slot unused during this very request), a redeemer has verified nothing itself; only a readable close time
      // ≥ firstSeen − skew ties the on-ledger payment to our own flow.
      const when = await settledBeforeRequest(looked, firstSeen);
      if (when === "replay") {
        await cas(myDelivered);
        warn(`redeem: payment closed before we first saw it fp=${fp(k)}; not paid through this flow, client gets 409`, undefined, false);
        return jsonError(409, "duplicate_payment");
      }
      if (when === "fresh") {
        let out: Response;
        try {
          out = await runOnPaidRail(() => xrplRail(config), ctx.routeHandler)(ctx.req);
        } catch (err) {
          await cas(undelivered);
          throw err; // route threw: still undelivered → 502 below; a later retry can redeem
        }
        if (out.status >= 400) {
          await cas(undelivered);
          return out instanceof NextResponse ? out : new NextResponse(out.body, { status: out.status, headers: out.headers });
        }
        if (!(await cas(myDelivered))) warn(`redeem: delivered mark lost (lease expired) fp=${fp(k)}; delivering anyway (paid)`, undefined, false);
        afterDeliveryMarkHook?.();
        const txHash = (typeof looked.hash === "string" && /^[0-9A-Fa-f]{64}$/.test(looked.hash) ? looked.hash : sub.hash).toUpperCase();
        logXrplReconcile(rc, 200, "redeemed_after_undelivered", txHash, (looked.meta as { delivered_amount?: unknown } | undefined)?.delivered_amount);
        warn(`redeemed undelivered XRPL payment fp=${fp(k)}; serving the paid response`, undefined, false);
        return deliverConfirmed(out, { success: true, transaction: txHash, network: config.network, payer: ctx.payer } as SettleResponse);
      }
    }
    if (!looked && (await provablyNeverLanded(config, sub.hash, sub.lls))) {
      // The SUBMITTED tx: validated ledger past its LastLedgerSequence and not in any ledger up to it → it can never
      // land. Nothing moved → Base-only 402. N6 (Odin 12:07): DELETE the slot (atomic compare-and-delete against our
      // own lease value) so the same Sequence can be re-signed and paid; never settle_failed (the sequence is unused).
      await neverLandedDelete(k, mine);
      logXrplReconcile(rc, 402, "redeem_never_landed_past_last_ledger");
      warn(`redeem: validated ledger is past the submitted tx's LastLedgerSequence and the tx is not in it fp=${fp(k)}; never charged, Base-only 402`, undefined, false);
      return ctx.reject(settleFailReason("transaction_failed"));
    }
    await cas(undelivered);
    logXrplReconcile(rc, 502, `redeem_${looked ? safeCode(v) : "not_visible"}`);
    return unconfirmed(502);
  } catch (err) {
    // Any failure after we own the lease (route threw, store error, a failure right after OUR delivered mark): never
    // delivered → back to undelivered. N3: one atomic compare-and-set against exactly our lease value or our own
    // owner-tagged delivered mark; another redeemer's values (after a lease takeover) are never touched.
    try {
      if (replay.casAny) await replay.casAny(k, [mine, myDelivered], undelivered, REPLAY_TTL_MS);
      else if (!(await replay.cas!(k, mine, undelivered, REPLAY_TTL_MS))) await replay.cas!(k, myDelivered, undelivered, REPLAY_TTL_MS);
    } catch (e) {
      warn(`replay store reset failed fp=${fp(k)}`, e, false);
    }
    warn(`redeem failed fp=${fp(k)}; back to undelivered, client gets 502`, err, false);
    return unconfirmed(502);
  }
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
 *   - 502/504 {"error":"settlement_unconfirmed"} → ambiguous settle the validated ledger can't confirm
 *     either way (never after a settle success: funds moved → the paid response, ALERT if unverified);
 *   - the paid response → settled, or an ambiguous settle confirmed on the validated ledger;
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
  let rcOuter: ReconcileCtx | undefined;
  let firstSeen = Date.now();
  const startedAt = Date.now();
  try {
    if (!replayStoreOkFor(config)) {
      warn("xrpl:0 payment refused: shared replay store (UPSTASH_REDIS_REST_* or KV_REST_API_URL/TOKEN) not configured");
      return reject(RAIL_REJECT.unavailable);
    }
    const [ready, rail, evalOk] = await Promise.all([xrplPayToReady(config), getRail(config), xrplReplayEvalOk()]);
    if (!evalOk) return reject(RAIL_REJECT.unavailable); // replay store can't run EVAL: fail closed, nothing verified or charged
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
      // Reason code (Odin F4): no Sequence/TicketSequence means the signed tx is
      // malformed for us, so this is the buyer's payload problem → invalid_payload.
      warn("rejected XRPL payload before facilitator (no payment slot)");
      return reject(RAIL_REJECT.invalidPayload);
    }
    if (replay.kind === "memory" && !replayWarned) {
      replayWarned = true;
      warn("XRPL replay store is per-instance memory (UPSTASH_REDIS_REST_* / KV_REST_API_URL+TOKEN not set); cross-instance replays rely on the ledger-close check", undefined, false);
    }
    let seen: ReplayState | null;
    firstSeen = Date.now();
    // H1: the slot records the tx THIS request will verify and submit (hash of its blob + its LastLedgerSequence).
    const blobHashHere = (() => {
      const b = blobOf(payload);
      return b ? xrplSignedTxHash(b) : null;
    })();
    const llsHere = check.tx.LastLedgerSequence;
    const subHere: SubmittedTx | undefined =
      blobHashHere && typeof llsHere === "number" && Number.isSafeInteger(llsHere) && llsHere > 0 ? { hash: blobHashHere, lls: llsHere } : undefined;
    const claimValue = encodeReplayValue({ state: "in_flight", firstSeen, ...(subHere ?? {}) });
    try {
      seen = await replay.claim(k, REPLAY_TTL_MS, claimValue);
    } catch (err) {
      // Fail closed: nothing verified or charged; caller serves the Base-only 402.
      // Reason code (Odin F4): our replay store is down, not the buyer's fault →
      // rail_unavailable (retry later or pay on Base), never invalid_payload.
      warn(`replay store claim failed fp=${fp(k)}; XRPL payment not accepted`, err);
      return reject(RAIL_REJECT.unavailable);
    }
    if (seen) {
      // 409 means ONLY "already delivered" (Odin 11:34). Undelivered → redeem (ledger-only, nothing re-submitted).
      if (seen === "settled") {
        warn(`duplicate XRPL payment rejected before verify fp=${fp(k)} state=settled; client gets 409`, undefined, false);
        return jsonError(409, "duplicate_payment");
      }
      if (seen === "settle_failed") {
        // The same tx failed definitively: nothing charged → Base-only 402 (re-sign a new payment).
        warn(`XRPL payment slot already failed fp=${fp(k)}; client gets the Base-only 402`, undefined, false);
        return reject(settleFailReason("transaction_failed"));
      }
      // in_flight: busy (503) unless stale (M1) → redeemUndelivered decides.
      return await redeemUndelivered(k, {
        req: payload === received ? req : withPaymentSignature(req, payload),
        routeHandler,
        config,
        requirement,
        compare: rail.mods.compareDecimalStrings,
        payer: String(check.tx.Account),
        retryBlob: blobOf(payload),
        route: (() => {
          try {
            return new URL(req.url).pathname;
          } catch {
            return "unknown";
          }
        })(),
        reject,
      });
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
      blobHash: blobHashHere,
    };
    rcOuter = rc;
    const att: Attempt = { handlerRan: false, handlerThrew: false, sub: subHere, claimValue };
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
          const out = await runOnPaidRail(() => xrplRail(rail.config), routeHandler)(r);
          if (a && out.status < 400) a.paidRes = out.clone();
          return out;
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
      // Settle succeeded: on xrpl:0 (in-process facilitator) that means submitAndWait saw the tx VALIDATED with
      // tesSUCCESS, i.e. the funds moved. The re-read below is an independent check on another node and can
      // lag or fail (txnNotFound / validated:false / timeout). Rule (as Base/Solana): after funds moved, the
      // buyer gets the response, never a 5xx. Only a validated ledger answer proving the tx FAILED (nothing
      // moved) withholds it.
      // F2 (Odin 12:07): the facilitator's hash must equal OUR blob hash; we only ever look up ours. A different
      // hash → 502 + HIGH ALERT + manual reconcile: nothing (no 402, no settle_failed, no delivery) is derived from
      // a tx we did not submit. Slot undelivered WITHOUT a stored tx (not auto-redeemable).
      const oursS = rc.blobHash ?? undefined;
      const facS = wellFormedHash(att.settle.transaction)?.toUpperCase();
      if (!oursS || (facS !== undefined && facS !== oursS.toUpperCase())) {
        await replayMarkUndelivered(key, firstSeen, undefined);
        logXrplReconcile(rc, 502, "settle_hash_mismatch", facS);
        emitAlert({ kind: "xrpl_settle_hash_mismatch", severity: "high" });
        warn(`settle success named a tx other than the one we submitted fp=${fp(key)}; not delivered, client gets 502 (manual reconcile)`, undefined, false);
        return jsonError(502, "settlement_unconfirmed");
      }
      const looked = await lookupValidatedTx(config, oursS);
      const when = await settledBeforeRequest(looked, startedAt);
      // Self-verification against the validated ledger. Mainnet: must be
      // checkable AND ok to be clean. Testnet: checked when the result carries meta.
      const v = looked ? verifySettledTx(looked, requirement as never, rail.mods.compareDecimalStrings, rc.payer) : "missing";
      const delivered = (looked?.meta as { delivered_amount?: unknown } | undefined)?.delivered_amount;
      if (v === "result_not_tessuccess") {
        // The validated ledger says this tx did not succeed: no RLUSD moved (only the buyer's XRP fee, as for any
        // failed submit). Not charged → definitive settle failure: Base-only 402, slot kept as settle_failed.
        await replaySet(key, "settle_failed");
        warn(`settled tx is not tesSUCCESS on the validated ledger fp=${fp(key)}; not charged, client gets the Base-only 402`, undefined, false);
        return reject(settleFailReason("transaction_failed"));
      }
      if (when === "replay") {
        await replaySet(key, "settled");
        warn(`cross-instance replay: ledger closed before this request fp=${fp(key)}; client gets 409`, undefined, false);
        return jsonError(409, "duplicate_payment");
      }
      if (v !== "ok" && v !== "missing") {
        // N1 (Odin 11:56): the validated ledger CONTRADICTS the payment (destination / issuer / amount / not a Payment
        // or another payer). A facilitator/SDK bug or a hash mix-up: never deliver on that. 502 + HIGH ALERT +
        // reconcile; slot undelivered with the stored submitted tx, so a retry re-checks the ledger (delivers only
        // if a later read is clean, else 502 again).
        const reason = `self_check_${safeCode(v)}`;
        await replayMarkUndelivered(key, firstSeen, att.sub);
        logXrplReconcile(rc, 502, reason, att.settle.transaction, delivered);
        emitAlert({ kind: "xrpl_settled_unverified", severity: "high", field: xrplMismatchField(v), reason });
        warn(`settled tx CONTRADICTED by the validated ledger re-read fp=${fp(key)} reason=${safeCode(v)}; not delivered, client gets 502 (reconcile)`, undefined, false);
        return unconfirmed(502);
      }
      if (v === "missing" && config.network === XRPL_MAINNET_CAIP2) {
        // Funds moved per the validated settle, but our re-read could not be read (lagging / unreachable node, no
        // meta): deliver + HIGH ALERT (field unreadable) + reconcile. The only non-ok re-read that delivers.
        const reason = "self_check_missing";
        logXrplReconcile(rc, 200, reason, att.settle.transaction, delivered);
        emitAlert({ kind: "xrpl_settled_unverified", severity: "high", field: "unreadable", reason });
        warn(`settled tx not readable on the ledger re-read fp=${fp(key)}; serving the paid response (funds moved per validated settle; reconcile)`, undefined, false);
      } else if (when === "unknown") {
        // N4: success path delivers on an unknown close time with the shared store: settle success = OUR verified
        // blob validated tesSUCCESS, and the SDK verify in this request proved the slot unused when it started.
        if (replay.kind === "memory") {
          // Testnet only (xrpl:0 requires the shared store). No shared store and the ledger time can't be read:
          // a cross-instance replay can't be ruled out, so don't deliver. Settled → never a 402.
          await replaySet(key, "settle_unconfirmed"); // testnet only; no firstSeen → not auto-redeemable (Odin 11:34 (3): unchanged)
          logXrplReconcile(rc, 502, "settled_tx_time_unreadable", att.settle.transaction);
          warn(`could not read settled tx time fp=${fp(key)} on memory replay store; client gets 502 settlement_unconfirmed`, undefined, false);
          return jsonError(502, "settlement_unconfirmed");
        }
        warn(`could not read settled tx time fp=${fp(key)}; serving the paid response (shared replay store)`, undefined, false);
      }
    } else if (att.settle?.outcome === "unconfirmed" && att.paidRes && !att.handlerThrew) {
      // Ambiguous settle (throw / timeout / unresolved code): the blob may have landed. Ask the validated ledger
      // (bounded, same budget as the success path's re-read; only one of the two runs per request).
      // L1/N5 (Odin 11:56): look up OUR computed blob hash only. If the facilitator named a different tx, don't
      // deliver: 502 + HIGH ALERT; the slot is marked undelivered WITHOUT a stored tx (manual reconcile), because
      // the facilitator may have submitted another tx for this slot: neither auto-delivery on our hash nor a
      // never-landed 402 on our hash would be safe.
      const ours = rc.blobHash ?? undefined;
      const facHash = att.settle.transaction && /^[0-9A-Fa-f]{64}$/.test(att.settle.transaction) ? att.settle.transaction.toUpperCase() : undefined;
      if (facHash && (!ours || facHash !== ours.toUpperCase())) {
        await replayMarkUndelivered(key, firstSeen, undefined);
        logXrplReconcile(rc, 502, "settle_hash_mismatch", facHash);
        emitAlert({ kind: "xrpl_settle_hash_mismatch", severity: "high" });
        warn(`ambiguous settle named a tx other than the one we submitted fp=${fp(key)}; not delivered, client gets 502 (manual reconcile)`, undefined, false);
        return jsonError(502, "settlement_unconfirmed");
      }
      const hash = ours;
      const looked = await lookupValidatedTx(config, hash);
      if (looked) {
        const v = verifySettledTx(looked, requirement as never, rail.mods.compareDecimalStrings, rc.payer);
        const when = await settledBeforeRequest(looked, startedAt);
        if (v === "result_not_tessuccess") {
          await replaySet(key, "settle_failed");
          warn(`ambiguous settle: tx is not tesSUCCESS on the validated ledger fp=${fp(key)}; not charged, client gets the Base-only 402`, undefined, false);
          return reject(settleFailReason("transaction_failed"));
        }
        if (v === "ok" && when === "replay") {
          await replaySet(key, "settled");
          warn(`ambiguous settle: ledger closed before this request fp=${fp(key)}; client gets 409`, undefined, false);
          return jsonError(409, "duplicate_payment");
        }
        // N4: unknown close time delivers only with the shared store (as the success path): the SDK verify in THIS
        // request proved the slot unused when it started, so the validated tx (our hash) closed after that.
        if (v === "ok" && (when === "fresh" || replay.kind === "upstash")) {
          // The exact payment is on the validated ledger: the buyer paid → deliver the handler's response.
          await markDelivered(key);
          const txHash = (typeof looked.hash === "string" && /^[0-9A-Fa-f]{64}$/.test(looked.hash) ? looked.hash : hash ?? "").toUpperCase();
          logXrplReconcile(rc, 200, "settle_unconfirmed_ledger_confirmed", txHash, (looked.meta as { delivered_amount?: unknown } | undefined)?.delivered_amount);
          warn(`ambiguous settle confirmed on the validated ledger fp=${fp(key)}; serving the paid response`, undefined, false);
          return deliverConfirmed(att.paidRes, { success: true, transaction: txHash, network: config.network, payer: rc.payer } as SettleResponse);
        }
      } else if (await provablyNeverLanded(config, att.sub?.hash, att.sub?.lls)) {
        // Odin 11:44 (d): the validated ledger is past this tx's LastLedgerSequence and the tx is not in any ledger
        // up to it → it can never land, nothing moved: Base-only 402. N6 (Odin 12:07): the slot is DELETED (atomic
        // compare-and-delete against exactly our claim value), so the same Sequence can be re-signed and paid.
        if (att.claimValue) await neverLandedDelete(key, att.claimValue);
        logXrplReconcile(rc, 402, "never_landed_past_last_ledger", att.settle.transaction);
        warn(`ambiguous settle: validated ledger is past LastLedgerSequence and the tx is not in it fp=${fp(key)}; never charged, client gets the Base-only 402`, undefined, false);
        return reject(settleFailReason("transaction_failed"));
      }
      // Not visible / not checkable: genuinely unknown → unchanged 502/504 settlement_unconfirmed (decide).
    }
    decision = await decide(key, att, res, threw, thrown, rc, firstSeen);
  } catch (err) {
    const s = key ? attempts.get(key)?.settle : undefined;
    if (key && s && s.outcome !== "failed") {
      // Our code threw AFTER a settle that moved (or may have moved) funds, e.g. between the delivered mark and the
      // response: never a 402 / never "delivered". Mark undelivered so a retry of the same payment redeems it.
      await replayMarkUndelivered(key, firstSeen, attempts.get(key)?.sub);
      if (rcOuter) logXrplReconcile(rcOuter, 502, "post_settle_error", s.transaction);
      warn(`XRPL post-settle error fp=${fp(key)}; marked undelivered, client gets 502 settlement_unconfirmed (retry redeems)`, err, false);
      return unconfirmed(502);
    }
    // Our own code threw before/around the facilitator: nothing was settled.
    if (key && !s) await replayRelease(key);
    warn("XRPL payment path threw", err);
    return reject(RAIL_REJECT.error);
  } finally {
    if (key) attempts.delete(key);
  }
  if (decision.kind === "rethrow") throw decision.err;
  return decision.kind === "response" ? decision.res : reject(decision.reason);
}
