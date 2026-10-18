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
 *     before money can move (import, bad env, PayAI down/timeout/missing kind,
 *     unexpected requirement, verify-phase error) callers get the untouched
 *     Base-only 402 and a console.warn; see "Paid-path outcomes" below for the
 *     settle phase and handler throws.
 *   - Failed init is cached for RETRY_AFTER_MS so an outage costs at most one
 *     bounded wait (initTimeoutMs) per instance per window. A good init is
 *     refreshed every RAIL_TTL_MS (re-fetches PayAI /supported).
 *   - Rail refresh (fix 2026-10-08, live fault 2:46 PM ET: 12/15 resources
 *     Base-only for 30-60 s after the 10-min refresh failed with only a warn):
 *     a refresh ERROR (timeout / transport / HTTP / malformed reply / SDK
 *     init error) never retires a rail this instance has confirmed; the last
 *     good rail is kept (≤ RAIL_MAX_STALE_MS) and the refresh is retried after
 *     RETRY_AFTER_MS. Only a CONFIRMED ABSENCE (PayAI answered /supported and
 *     no longer offers the exact/Solana kind or a valid listed fee payer —
 *     SolanaRailAbsentError) retires it, with a "[solana-rail][ALERT]
 *     solana_entry_dropped" line.
 *   - Fee payer: the `extra.feePayer` PayAI advertises for exact/Solana-mainnet
 *     must also appear in PayAI's own live signer list (same HTTPS /supported
 *     response, `signers["solana:*"]` or `signers[<network>]`). Not listed, or
 *     list unavailable → fail closed (Base-only).
 *   - Token-account guard: the Solana entry is shown ONLY while the payTo's
 *     USDC token account (SOLANA_PAYTO_USDC_ATA) exists on mainnet, checked by
 *     read-only JSON-RPC and cached ATA_TTL_MS (~10 min), so it flips on by
 *     itself once the account is created (no redeploy). Confirmed absent →
 *     Base-only. RPC error: a cold instance retries once (ATA_COLD_ATTEMPTS),
 *     then fails closed with a "[solana-rail][ALERT] solana_entry_dropped"
 *     line; an instance that has confirmed the account keeps that result
 *     through transient RPC errors for up to ATA_MAX_STALE_MS (6 h).
 *   - Incoming Solana payloads have any `extensions.bazaar` stripped before
 *     they reach PayAI; the Solana server never declares Bazaar.
 *   - PayAI rejections (verify invalid / settle failed / throws) are logged
 *     server-side with REASON CODES ONLY (R1): a PayAI-supplied code is kept
 *     only if it matches /^[a-z0-9_]+$/ (else "unrecognized"); PayAI free
 *     text (invalidMessage, errorMessage, HTTP error-body excerpts) is never
 *     logged — PayAI errors are re-thrown scrubbed at the facilitator-wrapper
 *     boundary, so x402 core's own console.warn cannot leak them either.
 *   - Paid-path outcomes (Odin code review 2026-10-08, fix 1):
 *       verify phase (nothing charged): any rejection, throw, timeout or
 *         malformed PayAI response → exactly main's Base-only 402;
 *       settle DEFINITIVE failure (success:false / 4xx SettleError, no tx,
 *         not pending) → Base-only 402;
 *       settle AMBIGUOUS (timeout, transport error, malformed response,
 *         settlement_pending, duplicate_settlement, 5xx/429/409, or a tx
 *         signature with success:false) → generic 504 (timeout) / 502
 *         {"error":"settlement_unconfirmed"}, NO PayAI text and NEVER a 402
 *         (a 402 would invite the client to pay twice);
 *       route handler throws → re-thrown, same as the Base path (Next 500).
 *   - Replay guard (fix 2): one request per Solana payment. Keyed on
 *     sha256 of the transaction message (signature slots excluded), checked
 *     BEFORE verify; in-flight / settled / unconfirmed / failed-settle keys are
 *     kept REPLAY_TTL_MS (25 h ≥ maxTimeoutSeconds; covers PayAI's 24 h
 *     replay of recorded outcomes); a duplicate gets 409
 *     {"error":"duplicate_payment"}. Keys are released when nothing was
 *     charged (verify failed, handler error before settle).
 *     Cross-instance (N1, Odin 12:51 (b)): after a successful settle OUR
 *     message is looked up on-chain (base64, exact message + buyer signature;
 *     PayAI's signature only a hint); landed at slot ≤ the request-start slot
 *     → 409 duplicate_payment; PayAI's signature not ours / ours failed →
 *     502 + reconcile; RPC error / unknown → fail open. No start slot
 *     (getSlot failed / timed out) → 503 before PayAI verify (Odin 1:19).
 *   - Token-account check and PayAI /supported (fee payer list) refresh are
 *     stale-while-revalidate: once warm, a 402 never waits on them. On a cold
 *     instance both run in parallel (N3).
 *   - Ops alerts (should-fix 9): warn-rate alert and the 80%-of-PayAI-free-
 *     allowance alert go through setSolanaAlertHook (default: one
 *     console.error line tagged "[solana-rail][ALERT]").
 */
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
import { runOnPaidRail, solanaRail } from "./paid-rail";
import { ReplaySelfTestError, UpstashReplayStore, encodeReplayValue, parseReplayValue, resolveSharedReplayStoreEnv, type ReplayStore } from "./xrpl-replay-store";
import {
  SOLANA_MAINNET_CAIP2,
  SOLANA_PAYTO,
  SOLANA_DEFAULT_INIT_TIMEOUT_MS,
  SOLANA_MAX_INIT_TIMEOUT_MS,
  SOLANA_PAYTO_USDC_ATA,
  SPL_TOKEN_PROGRAM,
  USDC_SOLANA_MINT,
  base58Encode,
  getSolanaRailConfig,
  isValidSolanaPubkey,
  type SolanaRailConfig,
} from "./solana-config";

const LOG = "[solana-rail]";
const RETRY_AFTER_MS = 60_000;
/** Re-initialise a good rail (re-fetch PayAI /supported + fee payer list) this often. */
export const RAIL_TTL_MS = 10 * 60_000;
/** Token-account existence result (present or absent) is cached this long. */
export const ATA_TTL_MS = 10 * 60_000;
/**
 * RPC error → retried after this long. With no last-known-good "present"
 * result the error is cached as "absent" (fail closed) for this window; with
 * one, the last-known-good result is kept (see ATA_MAX_STALE_MS).
 */
export const ATA_ERROR_RETRY_MS = 60_000;
/**
 * Last-known-good window (fix 2026-10-08, live fault: public mainnet-beta RPC
 * timeouts from Vercel dropped the Solana entry on random instances for 60 s
 * at a time). A transient RPC error (timeout / transport / HTTP / JSON-RPC
 * error / malformed reply) never flips a CONFIRMED "present" to absent while
 * the last confirmation is younger than this. Only a successful RPC answer
 * saying the account is gone/invalid (or staleness beyond this) hides it.
 */
export const ATA_MAX_STALE_MS = 6 * 60 * 60_000;
/** Cold check: attempts at the token-account RPC before failing closed (each bounded by initTimeoutMs). */
export const ATA_COLD_ATTEMPTS = 2;
/** At most one "Solana entry dropped" ALERT line per instance per this window. */
export const DROP_ALERT_WINDOW_MS = 5 * 60_000;
/**
 * Rail last-known-good window: a confirmed rail survives refresh ERRORS this
 * long (same window as the token-account guard). Beyond it → Base-only + ALERT.
 */
export const RAIL_MAX_STALE_MS = ATA_MAX_STALE_MS;
/** Same default @x402/core applies to the Base entry. */
const MAX_TIMEOUT_SECONDS = 300;
/** Solana packet limit for a serialized transaction. */
const MAX_TX_BYTES = 1232;
/** PayAI request deadlines (Odin should-fix 7: settle cut from 30 s to 12 s). */
export const SOLANA_VERIFY_TIMEOUT_MS = 10_000;
export const SOLANA_SETTLE_TIMEOUT_MS = 12_000;
/**
 * Replay guard retention. Must be ≥ maxTimeoutSeconds (300 s); set to 25 h
 * because PayAI replays a recorded terminal settle outcome (incl. success) for
 * an identical body for 24 h (developers.md, 2026-10-08), so a shorter local
 * window would let a replay be "settled" again by PayAI and served for free.
 */
export const REPLAY_TTL_MS = 25 * 60 * 60_000;
const REPLAY_MAX_ENTRIES = 50_000;
/** Warn-rate alert: this many [solana-rail] warnings inside the window. */
export const WARN_ALERT_THRESHOLD = 20;
export const WARN_ALERT_WINDOW_MS = 5 * 60_000;
/** PayAI free tier: 1,000 credits per receiving wallet ≈ 650 Solana settlements (PayAI pricing, 2026-10-08). */
export const PAYAI_FREE_SETTLEMENTS = 650;
export const PAYAI_ALLOWANCE_ALERT_RATIO = 0.8;

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
    // Never follow a redirect (a 307/308 could bounce the POST anywhere).
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const json = (await res.json()) as { result?: unknown; error?: { code?: number } };
  if (json.error) throw new Error(`RPC error ${json.error.code ?? ""}`);
  return json.result;
}

let rpc: SolanaRpc = defaultRpc;

/** Tests only: the real fetch-based RPC (to assert its fetch options). */
export const __defaultSolanaRpcForTests = defaultRpc;

/** Tests only: swap the read-only RPC (null = real fetch). Also clears the token-account cache. */
export function __setSolanaRpcForTests(fn: SolanaRpc | null): void {
  rpc = fn ?? defaultRpc;
  ataCache = null;
  ataRefresh = null;
  ataConfirmedAt = 0;
}

let timeouts = { verifyMs: SOLANA_VERIFY_TIMEOUT_MS, settleMs: SOLANA_SETTLE_TIMEOUT_MS };

/** Tests only: shorten the PayAI deadlines to exercise a REAL FacilitatorTimeoutError (null = defaults). */
export function __setSolanaFacilitatorTimeoutsForTests(t: { verifyMs: number; settleMs: number } | null): void {
  timeouts = t ?? { verifyMs: SOLANA_VERIFY_TIMEOUT_MS, settleMs: SOLANA_SETTLE_TIMEOUT_MS };
  resetSolanaRailForTests();
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
  railState = null;
  railInit = null;
  failedKey = null;
  failedUntil = 0;
  ataCache = null;
  ataRefresh = null;
  ataConfirmedAt = 0;
  dropAlertedAt = 0;
  allowanceCheck = null;
  allowanceAlerted = false;
  lastReceiptCount = null;
  paidHandlers = new WeakMap();
  replay.clear();
  reconcileAlerted.clear();
  slotFailStreak = 0;
  slotAlerted = false;
  shared = createSolanaSharedStore();
  sharedPending = [];
  evalCache = null;
  evalInflight = null;
  attempts.clear();
  warnTimes = [];
  warnAlertedAt = 0;
  alertHook = defaultAlertHook;
}

/** Tests only: wait for every background refresh (token account, rail, allowance count) to settle. */
export async function __flushSolanaBackgroundForTests(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const pending = [ataRefresh, railInit?.promise, allowanceCheck].filter(Boolean);
    if (pending.length === 0) return;
    await Promise.allSettled(pending);
  }
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

// ---------------------------------------------------------------------------
// Ops alerts (warn rate, PayAI free allowance)
// ---------------------------------------------------------------------------

export type SolanaAlert =
  | { kind: "warn_rate"; count: number; windowMs: number; threshold: number }
  | {
      /**
       * The Solana entry was hidden: token-account RPC unavailable on a cold instance,
       * PayAI confirmed the exact/Solana kind or fee payer is gone (payai_kind_absent),
       * or /supported refresh errors outlasted RAIL_MAX_STALE_MS.
       */
      kind: "solana_entry_dropped";
      reason:
        | "token_account_rpc_unavailable"
        /** PayAI /supported answered and no longer offers exact/Solana or a valid listed fee payer (confirmed absence). */
        | "payai_kind_absent"
        /** /supported refresh kept failing for longer than RAIL_MAX_STALE_MS. */
        | "payai_supported_unavailable_stale";
    }
  | {
      /**
       * Odin 12:51: one per 502/504/409 answered from the unconfirmed-settle path, and per 502 from an unbindable
       * settle success: the buyer may have been charged without delivery → manual refund. Public chain data only.
       */
      kind: "solana_reconcile";
      status: number;
      reason: string;
      fp: string;
      payer: string | null;
      amount: string;
      asset: string;
      payTo: string;
      buyerSignature: string | null;
      txid?: string;
    }
  | {
      /** Odin 1:21: SOLANA_SLOT_ALERT_CONSECUTIVE paid requests in a row got no request-start slot (503, nothing charged). */
      kind: "solana_start_slot_unavailable";
      severity: "high";
      consecutive: number;
    }
  | {
      /**
       * Shared Solana claim store (Upstash) configured but its EVAL + self-test probe failed: Solana is off the 402
       * and paid Solana gets the Base-only 402 (fail closed) until a probe passes. Once per failure episode.
       */
      kind: "solana_replay_eval_unavailable";
      severity: "high";
      reason: string;
    }
  | {
      kind: "payai_allowance";
      source: "onchain_receipts" | "free_tier_exhausted";
      /** Upper-bound proxy: transactions that touched payTo's USDC account (or null when unknown). */
      used: number | null;
      allowance: number;
      threshold: number;
    };

function defaultAlertHook(alert: SolanaAlert): void {
  console.error(`${LOG}[ALERT] ${JSON.stringify(alert)}`);
}

let alertHook: (alert: SolanaAlert) => void = defaultAlertHook;

/** Route [solana-rail] alerts somewhere else (pager, webhook). null = default console.error line. */
export function setSolanaAlertHook(fn: ((alert: SolanaAlert) => void) | null): void {
  alertHook = fn ?? defaultAlertHook;
}

function emitAlert(alert: SolanaAlert): void {
  try {
    alertHook(alert);
  } catch {
    /* an alert sink must never break a request */
  }
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
    emitAlert({ kind: "warn_rate", count: warnTimes.length, windowMs: WARN_ALERT_WINDOW_MS, threshold: WARN_ALERT_THRESHOLD });
  }
}

const ALLOWANCE_ALERT_AT = Math.ceil(PAYAI_FREE_SETTLEMENTS * PAYAI_ALLOWANCE_ALERT_RATIO);
let allowanceAlerted = false;
let allowanceCheck: Promise<void> | null = null;
let lastReceiptCount: number | null = null;

function allowanceAlert(source: "onchain_receipts" | "free_tier_exhausted", used: number | null): void {
  if (allowanceAlerted && source === "onchain_receipts") return;
  allowanceAlerted = true;
  emitAlert({ kind: "payai_allowance", source, used, allowance: PAYAI_FREE_SETTLEMENTS, threshold: ALLOWANCE_ALERT_AT });
}

/** Ops view (no PII): last on-chain receipt count used for the allowance alert. */
export function getSolanaRailStats(): { receiptCount: number | null; allowanceAlertAt: number; allowanceAlerted: boolean } {
  return { receiptCount: lastReceiptCount, allowanceAlertAt: ALLOWANCE_ALERT_AT, allowanceAlerted };
}

function warn(msg: string, err?: unknown, fallback = true): void {
  // R1: a PayAI/SDK facilitator error never contributes free text to a log line.
  const payaiShaped =
    err instanceof FacilitatorResponseError ||
    err instanceof SettleError ||
    err instanceof VerifyError ||
    (err instanceof Error && err.message.startsWith("Facilitator "));
  const detail = payaiShaped
    ? (payaiErrorDetail(err) ?? "")
    : err instanceof Error
      ? err.message
      : err === undefined
        ? ""
        : String(err);
  console.warn(`${LOG} ${redact(msg)}${detail ? `: ${redact(detail)}` : ""}${fallback ? " (serving Base-only)" : ""}`);
  noteWarn();
}

// ---------------------------------------------------------------------------
// Per-payment attempt record (replay key → what happened), filled by the
// facilitator wrapper and the tracked route handler. The replay guard makes
// a key unique among in-flight requests, so this is race-free.
// ---------------------------------------------------------------------------

/** `reason` is log-safe (safeCode); `raw` is PayAI's value, used for matching only — never logged. */
type SettleOutcome = {
  outcome: "success" | "failed" | "unconfirmed";
  reason: string;
  raw: string;
  timeout: boolean;
  transaction?: string;
  /**
   * Odin 12:51 C1: PayAI says this payment is already settled / in flight elsewhere (ANY facilitator 409, including a
   * non-JSON 409, or a duplicate-shaped reason). Never searched on-chain, never delivered: 502 + reconcile.
   */
  duplicate?: true;
};
type Attempt = {
  handlerRan: boolean;
  handlerThrew: boolean;
  handlerError?: unknown;
  verify?: "valid" | "invalid" | "error";
  settle?: SettleOutcome;
  /** Clone of the route handler's own (<400) response: delivered if an ambiguous settle is then found on-chain. */
  paidRes?: Response;
};
const attempts = new Map<string, Attempt>();

/**
 * R1 (log hygiene): only machine reason codes from PayAI are ever logged.
 * Anything that is not a plain lower-case code (/^[a-z0-9_]+$/, ≤ 80 chars)
 * is replaced by "unrecognized". PayAI free text (messages, excerpts) is never
 * logged.
 */
export function safeCode(value: unknown): string {
  return typeof value === "string" && value.length <= 80 && /^[a-z0-9_]+$/.test(value) ? value : "unrecognized";
}

/** PayAI reasons that mean "the outcome is not known yet" (PayAI developers.md, 2026-10-08). */
const UNRESOLVED_SETTLE_REASONS = new Set(["settlement_pending", "duplicate_settlement"]);
/** Odin 12:51 C1: reasons that mean "another request already settled / is settling this payment". */
const DUPLICATE_SETTLE_REASON_RE = /duplicate|already|in_flight/;
/** The SDK's error for a non-JSON facilitator reply keeps the HTTP status in its message prefix. */
const NON_JSON_SETTLE_409_RE = /^Facilitator settle failed \(409\)(?::|$)/;

function classifySettleResult(res: SettleResponse): SettleOutcome {
  if (res.success) {
    return { outcome: "success", reason: "success", raw: "success", timeout: false, transaction: typeof res.transaction === "string" ? res.transaction : undefined };
  }
  const raw = String(res.errorReason ?? "unknown");
  const duplicate = DUPLICATE_SETTLE_REASON_RE.test(raw);
  const unresolved = duplicate || UNRESOLVED_SETTLE_REASONS.has(raw) || (typeof res.transaction === "string" && res.transaction !== "");
  const tx = typeof res.transaction === "string" && res.transaction !== "" ? res.transaction : undefined;
  // The signature (if any) is kept for the on-chain check only; never logged.
  return {
    outcome: unresolved ? "unconfirmed" : "failed",
    reason: safeCode(raw),
    raw,
    timeout: false,
    ...(unresolved && tx ? { transaction: tx } : {}),
    ...(duplicate ? { duplicate: true as const } : {}),
  };
}

function classifySettleThrow(err: unknown): SettleOutcome {
  if (err instanceof FacilitatorTimeoutError) return { outcome: "unconfirmed", reason: "facilitator_timeout", raw: "facilitator_timeout", timeout: true };
  if (err instanceof FacilitatorResponseError) {
    return { outcome: "unconfirmed", reason: "facilitator_malformed_response", raw: "facilitator_malformed_response", timeout: false };
  }
  if (err instanceof SettleError) {
    const raw = String(err.errorReason ?? "unknown");
    const status = err.statusCode;
    const duplicate = status === 409 || DUPLICATE_SETTLE_REASON_RE.test(raw);
    const unresolved =
      duplicate ||
      UNRESOLVED_SETTLE_REASONS.has(raw) ||
      status >= 500 ||
      status === 429 ||
      status === 409 ||
      (typeof err.transaction === "string" && err.transaction !== "");
    const tx = typeof err.transaction === "string" && err.transaction !== "" ? err.transaction : undefined;
    return {
      outcome: unresolved ? "unconfirmed" : "failed",
      reason: safeCode(raw),
      raw,
      timeout: false,
      ...(unresolved && tx ? { transaction: tx } : {}),
      ...(duplicate ? { duplicate: true as const } : {}),
    };
  }
  // Non-JSON 409 body: the SDK throws a plain Error("Facilitator settle failed (409): …"). Keep the status (C1).
  if (err instanceof Error && NON_JSON_SETTLE_409_RE.test(err.message)) {
    return { outcome: "unconfirmed", reason: "facilitator_409", raw: "facilitator_409", timeout: false, duplicate: true };
  }
  // fetch failed / connection reset / non-JSON 5xx body: the request may have reached PayAI.
  return { outcome: "unconfirmed", reason: "transport_error", raw: "transport_error", timeout: false };
}

// ---------------------------------------------------------------------------
// Solana-only facilitator client (PayAI)
// ---------------------------------------------------------------------------

/**
 * A CONFIRMED absence: PayAI's /supported answered, but it no longer offers
 * what the Solana entry needs (the one exact/Solana-mainnet kind, a valid fee
 * payer on its own live signer list), or our pinned constants disagree. Only
 * this may retire a rail that was confirmed present; anything else thrown
 * during a refresh (timeout, transport, HTTP status, malformed reply) is a
 * transient error and keeps the last good rail.
 */
export class SolanaRailAbsentError extends Error {
  override name = "SolanaRailAbsentError";
}

/** True if `err` (or anything on its `cause` chain, e.g. the SDK's "Failed to initialize" wrapper) is a confirmed absence. */
export function isConfirmedAbsence(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && i < 5; e = (e as { cause?: unknown }).cause, i++) {
    if (e instanceof SolanaRailAbsentError) return true;
  }
  return false;
}

/**
 * Wraps PayAI so it can only ever be used for `exact` on Solana mainnet:
 * getSupported is filtered to that one kind (and reports no extensions, so
 * the Solana server never declares Bazaar), and verify/settle refuse
 * anything else. Registered as the sole client of the Solana server.
 * `settleInner` (same PayAI URL, shorter deadline) is used for settle only.
 */
export class SolanaOnlyFacilitatorClient implements FacilitatorClient {
  constructor(
    private readonly inner: FacilitatorClient,
    readonly network: string,
    private readonly settleInner: FacilitatorClient = inner,
  ) {}

  async getSupported(): Promise<SupportedResponse> {
    // HTTPS only: the fee payer list must come from PayAI over TLS.
    for (const c of [this.inner, this.settleInner]) {
      const url = (c as { url?: unknown }).url;
      if (typeof url !== "string" || !url.startsWith("https://")) {
        throw new SolanaRailAbsentError("PayAI facilitator URL must be https");
      }
    }
    let supported: SupportedResponse;
    try {
      supported = await this.inner.getSupported();
    } catch (err) {
      throw scrubPayaiError(err, "supported");
    }
    // A malformed reply is a transient error, not a confirmed absence.
    if (!supported || !Array.isArray(supported.kinds)) throw new Error("PayAI /supported returned a malformed response");
    const kinds = supported.kinds.filter(
      (k) => k.x402Version === 2 && k.scheme === "exact" && k.network === this.network,
    );
    if (kinds.length !== 1) {
      throw new SolanaRailAbsentError(`PayAI does not list exactly one x402 v2 exact kind on ${this.network}`);
    }
    const feePayer = (kinds[0].extra as { feePayer?: unknown } | undefined)?.feePayer;
    if (!isValidSolanaPubkey(feePayer)) {
      throw new SolanaRailAbsentError("PayAI exact kind has no valid extra.feePayer");
    }
    // The advertised fee payer must be one of PayAI's own live Solana signers.
    const allSigners = (supported.signers ?? {}) as Record<string, unknown>;
    const listed = [allSigners["solana:*"], allSigners[this.network]]
      .filter(Array.isArray)
      .flat()
      .filter((a): a is string => typeof a === "string");
    if (listed.length === 0) throw new SolanaRailAbsentError("PayAI /supported has no Solana signer list");
    if (!listed.includes(feePayer)) throw new SolanaRailAbsentError("PayAI feePayer is not in PayAI's live Solana signer list");
    if (feePayer === SOLANA_PAYTO) throw new SolanaRailAbsentError("PayAI feePayer equals payTo");
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
    const att = await attemptFor(payload);
    let res: VerifyResponse;
    try {
      res = await this.inner.verify(payload, requirements);
    } catch (err) {
      if (att) att.verify = "error";
      warn(`PayAI verify threw (${errorKind(err)})`, payaiErrorDetail(err));
      throw scrubPayaiError(err, "verify");
    }
    if (att) att.verify = res.isValid ? "valid" : "invalid";
    if (!res.isValid) {
      // Reason code only (R1): invalidMessage, payer, tx never logged.
      warn(`PayAI verify rejected: reason=${safeCode(res.invalidReason)}`);
      return { ...res, invalidReason: safeCode(res.invalidReason), invalidMessage: undefined };
    }
    return res;
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    this.guard(payload, requirements);
    const att = await attemptFor(payload);
    let res: SettleResponse;
    try {
      res = await this.settleInner.settle(payload, requirements);
    } catch (err) {
      const c = classifySettleThrow(err);
      if (att) att.settle = c;
      warn(`PayAI settle threw (${errorKind(err)}): outcome=${c.outcome} reason=${c.reason}`, payaiErrorDetail(err), c.outcome === "failed");
      if (c.raw.startsWith("free_tier_exhausted")) allowanceAlert("free_tier_exhausted", lastReceiptCount);
      throw scrubPayaiError(err, "settle");
    }
    const c = classifySettleResult(res);
    if (att) att.settle = c;
    if (!res.success) {
      // Reason code only (R1): errorMessage never logged.
      warn(`PayAI settle failed: outcome=${c.outcome} reason=${c.reason}`, undefined, c.outcome === "failed");
      if (c.raw.startsWith("free_tier_exhausted")) allowanceAlert("free_tier_exhausted", lastReceiptCount);
      return { ...res, errorReason: c.reason, errorMessage: undefined };
    }
    return res;
  }
}

function errorKind(err: unknown): string {
  return err instanceof Error ? err.name || "Error" : typeof err;
}

/**
 * What of a PayAI client error may be logged (R1): never PayAI's text.
 *   - our SDK's own timeout message ("Facilitator settle request timed out after 12000ms");
 *   - "Facilitator <op> failed (<status>)" — the SDK prefix only, PayAI's excerpt cut;
 *   - VerifyError / SettleError → their reason code (safeCode) only;
 *   - anything else (malformed-response excerpts, unknown errors) → nothing.
 */
function payaiErrorDetail(err: unknown): string | undefined {
  if (err instanceof FacilitatorTimeoutError) return /^Facilitator \w+ request timed out after \d+ms$/.test(err.message) ? err.message : undefined;
  if (err instanceof FacilitatorResponseError) return undefined;
  if (err instanceof SettleError) return `reason=${safeCode(err.errorReason)}`;
  if (err instanceof Error && err.name === "VerifyError") return `reason=${safeCode((err as { invalidReason?: unknown }).invalidReason)}`;
  const msg = err instanceof Error ? err.message : "";
  const m = /^(Facilitator (?:verify|settle|getSupported|supported) failed \(\d{3}\))(?::|$)/.exec(msg);
  return m ? m[1] : undefined;
}

/**
 * R1 boundary: the error / response handed back to the x402 SDK carries no
 * PayAI free text either (the SDK logs some errors itself, and copies
 * reasons into the Solana server's 402 header). Same error CLASS, so the
 * SDK's behaviour and our classification are unchanged.
 */
function scrubPayaiError(err: unknown, op: "verify" | "settle" | "supported"): unknown {
  if (err instanceof FacilitatorTimeoutError) return err; // SDK-generated message only
  if (err instanceof FacilitatorResponseError) return new FacilitatorResponseError(`PayAI ${op} returned a malformed response`);
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
  const detail = payaiErrorDetail(err);
  return new Error(detail ?? `PayAI ${op} failed (${errorKind(err)})`);
}

/** Build the PayAI client pair: verify/supported at SOLANA_VERIFY_TIMEOUT_MS, settle at SOLANA_SETTLE_TIMEOUT_MS. */
export function createPayaiFacilitator(config: SolanaRailConfig): SolanaOnlyFacilitatorClient {
  return new SolanaOnlyFacilitatorClient(
    new HTTPFacilitatorClient({ url: config.facilitatorUrl, timeoutMs: timeouts.verifyMs }),
    config.network,
    new HTTPFacilitatorClient({ url: config.facilitatorUrl, timeoutMs: timeouts.settleMs }),
  );
}

// ---------------------------------------------------------------------------
// Rail init (cached, stale-while-revalidate)
// ---------------------------------------------------------------------------

type Rail = {
  config: SolanaRailConfig;
  server: x402ResourceServer;
};

/** builtAt = last SUCCESSFUL (confirmed) init; retryAt = earliest next refresh after a failed one. */
let railState: { key: string; rail: Rail; builtAt: number; retryAt?: number } | null = null;
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

async function initRail(config: SolanaRailConfig): Promise<Rail> {
  const mods = await loader();
  // Cross-check our pinned constants against the package.
  if (mods.SOLANA_MAINNET_CAIP2 !== SOLANA_MAINNET_CAIP2) {
    throw new SolanaRailAbsentError("Solana mainnet CAIP-2 mismatch between repo constant and @x402/svm");
  }
  if (mods.USDC_MAINNET_ADDRESS !== USDC_SOLANA_MINT) {
    throw new SolanaRailAbsentError("USDC mint mismatch between repo constant and @x402/svm");
  }
  if ((await mods.deriveUsdcAta(config.payTo, USDC_SOLANA_MINT)) !== SOLANA_PAYTO_USDC_ATA) {
    throw new SolanaRailAbsentError("payTo USDC token account derivation does not match the pinned constant");
  }
  const server = new x402ResourceServer(createPayaiFacilitator(config)).register(config.network, new mods.ExactSvmScheme());
  await server.initialize();
  return { config, server };
}

function startRailInit(config: SolanaRailConfig, key: string): Promise<Rail | null> {
  if (railInit?.key === key) return railInit.promise;
  const promise: Promise<Rail | null> = withTimeout(initRail(config), config.initTimeoutMs, "Solana rail init")
    .then(
      (rail): Rail | null => {
        railState = { key, rail, builtAt: Date.now() };
        failedKey = null;
        return rail;
      },
      (err): Rail | null => {
        const prev = railState?.key === key ? railState : null;
        const absent = isConfirmedAbsence(err);
        if (prev && !absent && Date.now() - prev.builtAt < RAIL_MAX_STALE_MS) {
          // Refresh ERROR (timeout / transport / malformed): NOT evidence Solana is gone.
          // Keep the confirmed rail; retry the refresh after RETRY_AFTER_MS.
          warn("rail refresh failed; keeping last confirmed rail (present)", err, false);
          prev.retryAt = Date.now() + RETRY_AFTER_MS;
          return prev.rail;
        }
        warn(prev ? "rail refresh failed; Solana entry retired" : "rail init failed", err);
        if (prev) dropAlert(absent ? "payai_kind_absent" : "payai_supported_unavailable_stale");
        // Fail closed: a confirmed absence (e.g. fee payer dropped from PayAI's list), a
        // stale rail past RAIL_MAX_STALE_MS, or a cold init failure → Base-only.
        if (prev) railState = null;
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

/**
 * Warm: returns the current rail immediately; after RAIL_TTL_MS a background
 * refresh re-fetches PayAI /supported (fee payer list) and replaces it. A
 * refresh ERROR keeps it (≤ RAIL_MAX_STALE_MS, retried after RETRY_AFTER_MS);
 * only a confirmed absence retires it. Cold: one bounded init (initTimeoutMs).
 */
async function getRail(config: SolanaRailConfig): Promise<Rail | null> {
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
// Token-account guard (read-only RPC, cached, stale-while-revalidate)
// ---------------------------------------------------------------------------

type AtaState = { exists: boolean; until: number };
let ataCache: AtaState | null = null;
/** Time of the last successful RPC answer confirming the account exists (0 = never). */
let ataConfirmedAt = 0;
let dropAlertedAt = 0;

type DropReason = Extract<SolanaAlert, { kind: "solana_entry_dropped" }>["reason"];
function dropAlert(reason: DropReason = "token_account_rpc_unavailable"): void {
  const now = Date.now();
  if (dropAlertedAt && now - dropAlertedAt < DROP_ALERT_WINDOW_MS) return;
  dropAlertedAt = now;
  emitAlert({ kind: "solana_entry_dropped", reason });
}
let ataRefresh: Promise<boolean> | null = null;

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
 * Allowance proxy (should-fix 9): number of transactions that touched payTo's
 * USDC account (read-only getSignaturesForAddress, ≤1000). Every PayAI
 * settlement is one of them; Michael's own transfers count too, so this is an
 * upper bound (alerts early, never late). Background only.
 */
function startAllowanceCheck(config: SolanaRailConfig): void {
  if (allowanceCheck) return;
  const p: Promise<void> = (async () => {
    try {
      const sigs = await rpc(
        config.rpcUrl,
        "getSignaturesForAddress",
        [SOLANA_PAYTO_USDC_ATA, { limit: 1000, commitment: "confirmed" }],
        config.initTimeoutMs,
      );
      if (!Array.isArray(sigs)) throw new Error("malformed getSignaturesForAddress result");
      lastReceiptCount = sigs.length;
      if (sigs.length >= ALLOWANCE_ALERT_AT) allowanceAlert("onchain_receipts", sigs.length);
    } catch (err) {
      warn("PayAI allowance receipt count failed", err, false);
    }
  })().finally(() => {
    if (allowanceCheck === p) allowanceCheck = null;
  });
  allowanceCheck = p;
}

function refreshAta(config: SolanaRailConfig): Promise<boolean> {
  if (ataRefresh) return ataRefresh;
  const p: Promise<boolean> = (async () => {
    // Cold (no answer yet on this instance): retry once before failing closed.
    const attempts = ataCache ? 1 : ATA_COLD_ATTEMPTS;
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        const exists = await checkAta(config);
        if (!exists) warn("payTo USDC token account not found; Solana entry hidden");
        ataCache = { exists, until: Date.now() + ATA_TTL_MS };
        ataConfirmedAt = exists ? Date.now() : 0;
        if (exists) startAllowanceCheck(config);
        return exists;
      } catch (err) {
        lastErr = err;
      }
    }
    // Transient RPC failure: NOT evidence the account is gone.
    if (ataConfirmedAt && Date.now() - ataConfirmedAt < ATA_MAX_STALE_MS) {
      warn("token-account RPC check failed; keeping last confirmed result (present)", lastErr, false);
      ataCache = { exists: true, until: Date.now() + ATA_ERROR_RETRY_MS };
      return true;
    }
    warn("token-account RPC check failed", lastErr);
    dropAlert();
    ataCache = { exists: false, until: Date.now() + ATA_ERROR_RETRY_MS };
    return false;
  })().finally(() => {
    if (ataRefresh === p) ataRefresh = null;
  });
  ataRefresh = p;
  return p;
}

/**
 * True while the payTo's USDC token account exists. Read-only RPC, result
 * cached ATA_TTL_MS (present or absent), so creation of the account is picked
 * up automatically. Warm: answers from cache at once and re-checks in the
 * background after the TTL. Cold: up to ATA_COLD_ATTEMPTS bounded checks.
 * RPC failure → last confirmed "present" kept (≤ ATA_MAX_STALE_MS) if this
 * instance has one, else false (Base-only + ALERT line); retried after 60 s.
 * Never throws.
 */
export async function solanaTokenAccountReady(config: SolanaRailConfig): Promise<boolean> {
  if (ataCache) {
    if (Date.now() >= ataCache.until) void refreshAta(config);
    return ataCache.exists;
  }
  return refreshAta(config);
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
    // N3: token-account check and rail init run in parallel (cold start ≤ one initTimeoutMs).
    // Odin 12:51 (d): the shared claim store's EVAL + self-test probe runs in parallel; failing → not advertised.
    const [ready, rail, evalOk] = await Promise.all([solanaTokenAccountReady(config), getRail(config), solanaReplayEvalOk()]);
    if (!ready || !rail || !evalOk) return null;
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

// ---------------------------------------------------------------------------
// Replay guard (Odin fix 2)
// ---------------------------------------------------------------------------

type ReplayState = "in_flight" | "settled" | "settle_failed" | "settle_unconfirmed";
const replay = new Map<string, { state: ReplayState; until: number }>();

/**
 * Bytes that identify one Solana payment: the transaction MESSAGE (blockhash,
 * fee payer, TransferChecked, amount, memo...). Signature slots are excluded,
 * so re-encodings or a tampered placeholder fee-payer signature map to the
 * same key. Falls back to the whole byte string if it does not parse.
 */
function paymentBytes(txB64: string): Uint8Array {
  const b = Buffer.from(txB64, "base64");
  let n = 0;
  let i = 0;
  for (;;) {
    if (i >= b.length || i >= 3) return b;
    const byte = b[i];
    n |= (byte & 0x7f) << (7 * i);
    i++;
    if ((byte & 0x80) === 0) break;
  }
  const start = i + 64 * n;
  if (n === 0 || start >= b.length) return b;
  return b.subarray(start);
}

/** sha256 (hex) of the payment's transaction message. Web Crypto: works in any runtime. */
export async function solanaPaymentKey(txB64: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", Uint8Array.from(paymentBytes(txB64)));
  return Buffer.from(digest).toString("hex");
}

/** Short, non-reversible fingerprint for logs / reconciliation (16 hex of the key). */
const fp = (key: string) => key.slice(0, 16);

function replayGet(key: string): ReplayState | null {
  const e = replay.get(key);
  if (!e) return null;
  if (Date.now() >= e.until) {
    replay.delete(key);
    return null;
  }
  return e.state;
}

function replaySet(key: string, state: ReplayState): void {
  replay.delete(key);
  replay.set(key, { state, until: Date.now() + REPLAY_TTL_MS });
  if (replay.size > REPLAY_MAX_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of replay) if (now >= v.until) replay.delete(k);
    for (const k of replay.keys()) {
      if (replay.size <= REPLAY_MAX_ENTRIES) break;
      replay.delete(k);
    }
  }
}

// ---------------------------------------------------------------------------
// Shared claim store (Odin 12:51 (d)): cross-instance atomic claim, modeled on the XRPL replay store
// ---------------------------------------------------------------------------
/** Solana keys live under their own prefix (disjoint from hp:xrpl:*); value format = encodeReplayValue. */
export const SOLANA_REPLAY_PREFIX = "hp:solana:replay:";
export const SOLANA_SELFTEST_KEY_PREFIX = "hp:solana:selftest:replay-eval:";
/** A passing probe is trusted this long per instance; a failing one is re-run after SOLANA_EVAL_FAIL_RECHECK_MS. */
export const SOLANA_EVAL_OK_RECHECK_MS = 10 * 60_000;
export const SOLANA_EVAL_FAIL_RECHECK_MS = 60_000;
/** Whole EVAL + self-test probe bound; runs in parallel with the token-account check and rail init. */
export const SOLANA_EVAL_PROBE_DEADLINE_MS = 3_000;

/**
 * Upstash (same credentials as the XRPL replay store: UPSTASH_REDIS_REST_* or KV_REST_API_URL/TOKEN; the read-only KV
 * token is never read) or null = no shared store → the per-instance map only (the previous behaviour, unchanged).
 */
function createSolanaSharedStore(env: Record<string, string | undefined> = process.env, fetchFn?: typeof fetch): ReplayStore | null {
  const c = resolveSharedReplayStoreEnv(env);
  if (!c) return null;
  try {
    return new UpstashReplayStore(c.url, c.token, fetchFn, 1500, SOLANA_REPLAY_PREFIX, SOLANA_SELFTEST_KEY_PREFIX);
  } catch {
    return null;
  }
}
let shared: ReplayStore | null = createSolanaSharedStore();
/** Shared writes scheduled by replaySet / replayRelease, awaited before the request answers. */
let sharedPending: Promise<void>[] = [];
/** Tests only: swap the shared store (null = none). */
export function setSolanaSharedStoreForTests(s: ReplayStore | null): void {
  shared = s;
  evalCache = null;
  evalInflight = null;
}
export function solanaSharedStoreKind(): "upstash" | "none" {
  return shared ? "upstash" : "none";
}

let evalCache: { store: ReplayStore; ok: boolean; until: number } | null = null;
let evalInflight: Promise<boolean> | null = null;
/**
 * True when there is no shared store, or the shared store passes `EVAL "return 1"` plus the self-test (SET / wrong-
 * value CAS_DELETE keeps / right-value CAS_DELETE removes, on a random hp:solana:selftest: key). Cached per instance
 * (ok 10 min / fail 60 s, single-flight). A failure = fail closed (Solana off the 402, paid Solana → Base-only 402)
 * and one HIGH ALERT solana_replay_eval_unavailable per failure episode.
 */
export async function solanaReplayEvalOk(): Promise<boolean> {
  const store = shared;
  if (!store?.probeEval) return true;
  const now = Date.now();
  if (evalCache && evalCache.store === store && now < evalCache.until) return evalCache.ok;
  if (evalInflight) return evalInflight;
  const wasOk = !evalCache || evalCache.store !== store || evalCache.ok;
  evalInflight = (async () => {
    let ok = true;
    let reason = "";
    try {
      await withTimeout(store.probeEval!(), SOLANA_EVAL_PROBE_DEADLINE_MS, "Solana claim store probe");
    } catch (err) {
      ok = false;
      reason = err instanceof ReplaySelfTestError ? err.step : err instanceof Error && / timed out after \d+ms$/.test(err.message) ? "timeout" : errorKind(err);
    }
    evalCache = { store, ok, until: Date.now() + (ok ? SOLANA_EVAL_OK_RECHECK_MS : SOLANA_EVAL_FAIL_RECHECK_MS) };
    if (!ok) {
      warn(`Solana claim store probe failed (${reason}); Solana treated as unavailable (fail closed)`, undefined, false);
      if (wasOk) emitAlert({ kind: "solana_replay_eval_unavailable", severity: "high", reason });
    }
    return ok;
  })().finally(() => {
    evalInflight = null;
  });
  return evalInflight;
}

/**
 * Solana slot values (same encodeReplayValue format as XRPL, under hp:solana:replay:). Odin 1:39 (3): the number in
 * the `@firstSeen` position is the first request's START SLOT (chain slot read before verify/settle: the freshness
 * bound a redeemer checks against), NOT a wall-clock time; the `@lease` position is wall-clock ms:
 *   in_flight@<startSlot>@<claimMs>            claimed, request running (stale after SOLANA_IN_FLIGHT_STALE_MS)
 *   settle_unconfirmed@<startSlot>             charged-or-unknown, NOT delivered → redeemable by a retry
 *   redeeming@<startSlot>@<leaseMs>!<owner>    one retry holds the redemption (lease SOLANA_REDEEM_LEASE_MS)
 *   settled                                    DELIVERED (409 forever after)
 *   settle_failed                              failed on-chain / definitive failure (409)
 */
export const SOLANA_REDEEM_LEASE_MS = 90_000;
/** An in_flight claim older than this (> route maxDuration 60 s) belongs to a dead request → redeemable. */
export const SOLANA_IN_FLIGHT_STALE_MS = SOLANA_REDEEM_LEASE_MS;

export type SolanaReplayEvalStatus = "ok" | "unavailable" | "not_applicable";
/**
 * Odin 1:39 (3): non-secret /status field <meta name="hp-solana-replay-eval">: not_applicable when the Solana rail is
 * off or no shared store is configured (per-instance map only); otherwise the cached EVAL + self-test probe result.
 */
export async function solanaReplayEvalStatus(env: Record<string, string | undefined> = process.env): Promise<SolanaReplayEvalStatus> {
  try {
    if (!getSolanaRailConfig(env).enabled || !shared?.probeEval) return "not_applicable";
    return (await solanaReplayEvalOk()) ? "ok" : "unavailable";
  } catch {
    return "unavailable";
  }
}

/** Atomic cross-instance claim BEFORE verify. null = ours; otherwise the raw value already held. Throws on store error. */
async function sharedClaim(key: string, startSlot: number, now: number): Promise<string | null> {
  if (!shared) return null;
  return shared.claim(key, REPLAY_TTL_MS, encodeReplayValue({ state: "in_flight", firstSeen: startSlot, lease: now }));
}
function sharedWrite(what: string, p: Promise<void>): void {
  sharedPending.push(
    p.catch((err) => {
      warn(`Solana claim store ${what} failed (slot keeps its previous value; never a second delivery)`, err, false);
    }),
  );
}
async function flushShared(): Promise<void> {
  const p = sharedPending;
  sharedPending = [];
  await Promise.all(p);
}
/** Local + shared state write. settled = DELIVERED; settle_unconfirmed@startSlot = charged-or-unknown, NOT delivered. */
function replayWrite(key: string, state: ReplayState, firstSeen: number): void {
  replaySet(key, state);
  if (shared) sharedWrite(`set ${state}`, shared.set(key, encodeReplayValue({ state, ...(state === "settle_unconfirmed" ? { firstSeen } : {}) }), REPLAY_TTL_MS));
}
/** Nothing was charged: release locally and in the shared store. */
function replayRelease(key: string): void {
  replay.delete(key);
  if (shared) sharedWrite("release", shared.release(key));
}

function txOf(payload: PaymentPayload | undefined): string | null {
  const tx = (payload?.payload as Record<string, unknown> | undefined)?.transaction;
  return typeof tx === "string" && tx !== "" ? tx : null;
}

async function attemptFor(payload: PaymentPayload | undefined): Promise<Attempt | undefined> {
  const tx = txOf(payload);
  return tx ? attempts.get(await solanaPaymentKey(tx)) : undefined;
}

/** Odin 1:21: the fixed no-start-slot body. */
export const SOLANA_NO_SLOT_BODY = '{"error":"solana_rpc_unavailable"}';
function noStartSlotResponse(): NextResponse {
  return new NextResponse(SOLANA_NO_SLOT_BODY, {
    status: 503,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Retry-After": String(SOLANA_NO_SLOT_RETRY_AFTER_S) },
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

function decide(key: string, att: Attempt, res: NextResponse | null, threw: boolean, thrown: unknown, firstSeen: number): Decision {
  const s = att.settle;
  if (s) {
    if (s.outcome === "success" && res && res.status < 400) {
      replayWrite(key, "settled", firstSeen);
      return { kind: "response", res };
    }
    if (s.outcome === "failed") {
      // Definitive: nothing landed. Key kept (the same tx would fail again).
      replayWrite(key, "settle_failed", firstSeen);
      return { kind: "base", reason: settleFailReason(s.reason) };
    }
    // Ambiguous (or settled but no deliverable response): the tx may have
    // landed. Never a 402 (would invite a second payment); no PayAI text.
    replayWrite(key, "settle_unconfirmed", firstSeen);
    const timeout = s.outcome === "unconfirmed" && s.timeout;
    warn(
      `settlement unconfirmed fp=${fp(key)} reason=${s.outcome === "success" ? "settled_without_response" : s.reason}; client gets ${timeout ? 504 : 502} settlement_unconfirmed (reconcile on-chain)`,
      undefined,
      false,
    );
    return { kind: "response", res: jsonError(timeout ? 504 : 502, "settlement_unconfirmed") };
  }
  // No settle attempted → nothing charged → release the key.
  replayRelease(key);
  if (att.handlerThrew) return { kind: "rethrow", err: att.handlerError };
  if (att.handlerRan && res && res.status >= 400) return { kind: "response", res }; // route's own error, as on Base
  if (threw) {
    warn("Solana payment path threw", thrown);
    return { kind: "base", reason: RAIL_REJECT.error };
  } else {
    let reason = "";
    try {
      const pr = decodePaymentRequiredHeader(res?.headers.get("payment-required") ?? "");
      // R1: only a plain reason code; core may put PayAI's raw excerpt here.
      reason = typeof pr.error === "string" && /^[a-z0-9_]+$/.test(pr.error) && pr.error.length <= 80 ? ` error=${pr.error}` : "";
    } catch {
      /* no header */
    }
    warn(`Solana payment not accepted (status ${res?.status ?? "none"} from Solana server${reason})`);
  }
  return { kind: "base", reason: reasonFromRailResponse(res, RAIL_REJECT.verifyFailed) };
}

// ---------------------------------------------------------------------------
// Ambiguous settle: on-chain confirmation (read-only, bounded)
// ---------------------------------------------------------------------------

/** Hard deadline for the whole on-chain search after an ambiguous settle (Solana settle budget 12 s + this). */
export const SOLANA_LEDGER_CHECK_DEADLINE_MS = 4_000;
/** Retry delays inside the deadline (confirmed-commitment indexing lag on public RPC). */
export const SOLANA_LEDGER_CHECK_DELAYS_MS: readonly number[] = [0, 500, 1000, 1500];
/**
 * Odin 12:31 (corrected 12:51): worst-case Solana time inside one paid request at the DEFAULT init timeout, cold
 * instance: token-account check (up to ATA_COLD_ATTEMPTS tries × init; rail init and the request-start getSlot,
 * capped at min(init, 1.5 s), run in parallel) + PayAI verify + settle + the on-chain check (ambiguous path incl. its
 * finalized re-read, or the success-path binding; same 4 s deadline) = 2 × 2.5 + 10 + 12 + 4 = 31 s. The budget test
 * uses SOLANA_MAX_WORST_CASE_MS (largest accepted init timeout).
 */
export const SOLANA_WORST_CASE_MS = ATA_COLD_ATTEMPTS * SOLANA_DEFAULT_INIT_TIMEOUT_MS + SOLANA_VERIFY_TIMEOUT_MS + SOLANA_SETTLE_TIMEOUT_MS + SOLANA_LEDGER_CHECK_DEADLINE_MS;
/**
 * Odin 12:51 C2: worst case at the LARGEST accepted HP_SOLANA_INIT_TIMEOUT_MS (SOLANA_MAX_INIT_TIMEOUT_MS) on a cold
 * instance, where the token-account check makes up to ATA_COLD_ATTEMPTS sequential tries, each bounded by the init
 * timeout (rail init and the start-slot read run in parallel with it): 2 × 7 + 10 + 12 + 4 = 40 s. The same 4 s
 * on-chain deadline bounds the success-path check, so both paths share this bound.
 */
export const SOLANA_MAX_WORST_CASE_MS =
  ATA_COLD_ATTEMPTS * SOLANA_MAX_INIT_TIMEOUT_MS + SOLANA_VERIFY_TIMEOUT_MS + SOLANA_SETTLE_TIMEOUT_MS + SOLANA_LEDGER_CHECK_DEADLINE_MS;
/** How many recent payTo-ATA signatures are inspected when PayAI gave us no signature. */
export const SOLANA_LEDGER_SCAN_LIMIT = 10;
let ledgerDelays: readonly number[] = SOLANA_LEDGER_CHECK_DELAYS_MS;
/** Tests only: shrink the retry delays (null = defaults). */
export function __setSolanaLedgerCheckDelaysForTests(d: readonly number[] | null): void {
  ledgerDelays = d ?? SOLANA_LEDGER_CHECK_DELAYS_MS;
}

/** base58 signatures present in a wire tx (non-zero 64-byte slots: the buyer's; the fee payer slot is a zero placeholder). */
export function payloadSignatures(txB64: string): string[] {
  const b = Buffer.from(txB64, "base64");
  let n = 0;
  let i = 0;
  for (;;) {
    if (i >= b.length || i >= 3) return [];
    const byte = b[i];
    n |= (byte & 0x7f) << (7 * i);
    i++;
    if ((byte & 0x80) === 0) break;
  }
  const out: string[] = [];
  for (let j = 0; j < n; j++) {
    const sig = b.subarray(i + 64 * j, i + 64 * (j + 1));
    if (sig.length !== 64) return [];
    if (sig.some((x) => x !== 0)) out.push(base58Encode(Uint8Array.from(sig)));
  }
  return out;
}

/**
 * Wire tx parts: signature slots and the MESSAGE bytes (exactly what every signer signed). Signer i signs slot i and
 * is account key i of the message (legacy and v0 share the header/key layout after the optional version byte).
 */
type WireTx = { sigs: Uint8Array[]; message: Uint8Array; keys: Uint8Array[] };
export function parseWireTx(bytes: Uint8Array): WireTx | null {
  const b = Buffer.from(bytes);
  const cu16 = (at: number): [number, number] | null => {
    let n = 0;
    for (let i = 0; i < 3; i++) {
      if (at + i >= b.length) return null;
      const byte = b[at + i];
      n |= (byte & 0x7f) << (7 * i);
      if ((byte & 0x80) === 0) return [n, at + i + 1];
    }
    return null;
  };
  const head = cu16(0);
  if (!head) return null;
  const [n, sigStart] = head;
  const msgStart = sigStart + 64 * n;
  if (n === 0 || msgStart >= b.length) return null;
  const sigs: Uint8Array[] = [];
  for (let j = 0; j < n; j++) sigs.push(Uint8Array.from(b.subarray(sigStart + 64 * j, sigStart + 64 * (j + 1))));
  const message = Uint8Array.from(b.subarray(msgStart));
  let at = message[0] & 0x80 ? 1 : 0; // v0 prefix
  at += 3; // header: numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned
  const mb = Buffer.from(message);
  let nk = 0;
  let i = 0;
  for (;;) {
    if (i >= 3 || at + i >= mb.length) return null;
    const byte = mb[at + i];
    nk |= (byte & 0x7f) << (7 * i);
    i++;
    if ((byte & 0x80) === 0) break;
  }
  at += i;
  if (at + 32 * nk > mb.length || nk < n) return null;
  const keys: Uint8Array[] = [];
  for (let j = 0; j < nk; j++) keys.push(Uint8Array.from(mb.subarray(at + 32 * j, at + 32 * (j + 1))));
  return { sigs, message, keys };
}
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

type ChainTx = {
  slot?: unknown;
  meta?: { err?: unknown; preTokenBalances?: unknown; postTokenBalances?: unknown } | null;
  transaction?: unknown;
};

/** USDC (atomic) received by payTo in this tx, from pre/post token balances; null if unreadable. */
function usdcReceivedByPayTo(tx: ChainTx): bigint | null {
  const sum = (list: unknown): bigint | null => {
    if (!Array.isArray(list)) return null;
    let t = 0n;
    for (const e of list as Array<{ mint?: unknown; owner?: unknown; uiTokenAmount?: { amount?: unknown } }>) {
      if (e?.mint === USDC_SOLANA_MINT && e?.owner === SOLANA_PAYTO) {
        const a = e.uiTokenAmount?.amount;
        if (typeof a !== "string" || !/^\d+$/.test(a)) return null;
        t += BigInt(a);
      }
    }
    return t;
  };
  const pre = sum(tx.meta?.preTokenBalances);
  const post = sum(tx.meta?.postTokenBalances);
  return pre === null || post === null ? null : post - pre;
}

/** Our own payment as we verified it: message bytes, the buyer's slot + signature, and the payer (key of that slot). */
export type OurPayment = { message: Uint8Array; slot: number; signature: string; payer: string };
export function ourPayment(txB64: string): OurPayment | null {
  const w = parseWireTx(Buffer.from(txB64, "base64"));
  if (!w) return null;
  const slot = w.sigs.findIndex((x) => x.some((y) => y !== 0));
  if (slot < 0) return null;
  return { message: w.message, slot, signature: base58Encode(w.sigs[slot]), payer: base58Encode(w.keys[slot]) };
}

type ChainFind =
  | { kind: "paid"; signature: string }
  | { kind: "failed" }
  | { kind: "replay"; signature: string }
  /** hintForeign: PayAI's signature resolved to a tx that is NOT our message; errSeen: ours, but failed at confirmed. */
  | { kind: "unknown"; hintForeign?: boolean; errSeen?: boolean };

/** Start-of-request chain position (Odin 12:31 S1): read before verify/settle, bounded so it never exceeds init. */
export const SOLANA_START_SLOT_TIMEOUT_MS = 1_500;
/** Odin 1:19: Retry-After (s) on the no-start-slot 503 (same value as the XRPL payment_in_progress 503). */
export const SOLANA_NO_SLOT_RETRY_AFTER_S = 5;
/** Odin 1:21: a second getSlot try only if at least this much of the init window is left. */
export const SOLANA_START_SLOT_MIN_RETRY_MS = 100;
/**
 * Request-start slot: up to 2 getSlot tries (Odin 1:21: retry ONCE), all inside the init window (initTimeoutMs, which
 * runs in parallel with the token-account check and rail init, so the worst case is unchanged). Each try is capped
 * at min(SOLANA_START_SLOT_TIMEOUT_MS, what is left of the window), enforced here as well as by the transport.
 * undefined = no slot → the caller answers 503 before PayAI.
 */
export async function readStartSlot(config: SolanaRailConfig): Promise<number | undefined> {
  const deadline = Date.now() + config.initTimeoutMs;
  for (let i = 0; i < 2; i++) {
    const left = deadline - Date.now();
    if (i > 0 && left < SOLANA_START_SLOT_MIN_RETRY_MS) break;
    const cap = Math.max(1, Math.min(left, SOLANA_START_SLOT_TIMEOUT_MS));
    try {
      const s = await withTimeout(rpc(config.rpcUrl, "getSlot", [{ commitment: "confirmed" }], cap), cap, "getSlot");
      if (typeof s === "number" && Number.isSafeInteger(s) && s > 0) {
        noteStartSlot(true);
        return s;
      }
    } catch {
      /* retry once within the window */
    }
  }
  noteStartSlot(false);
  return undefined;
}

/**
 * Odin 1:21: ALERT on SUSTAINED getSlot failure. One no-slot 503 is cheap (nothing charged, the buyer retries after
 * Retry-After) and can be RPC jitter; SOLANA_SLOT_ALERT_CONSECUTIVE paid requests in a row on this instance that each
 * failed BOTH getSlot tries (10 failed RPC calls) means the RPC is down for Solana payments → one HIGH alert per
 * episode (reset by the next successful read).
 */
export const SOLANA_SLOT_ALERT_CONSECUTIVE = 5;
let slotFailStreak = 0;
let slotAlerted = false;
function noteStartSlot(ok: boolean): void {
  if (ok) {
    slotFailStreak = 0;
    slotAlerted = false;
    return;
  }
  slotFailStreak++;
  if (slotFailStreak >= SOLANA_SLOT_ALERT_CONSECUTIVE && !slotAlerted) {
    slotAlerted = true;
    emitAlert({ kind: "solana_start_slot_unavailable", severity: "high", consecutive: slotFailStreak });
  }
}

/**
 * After an ambiguous settle: is OUR payment on-chain? (Odin 12:31 S1/S2, Sentinel S1/S2.)
 * A candidate counts ONLY if its MESSAGE bytes equal exactly the message we verified (fetched base64, decoded) and
 * its signature in the buyer's slot equals the buyer's signature in our payload. PayAI's signature is only a lookup
 * hint (fetched first, accepted only once it passes that binding); otherwise the recent payTo-ATA history with
 * slot > startSlot is scanned. Freshness is by chain slot, not wall clock: startSlot = confirmed slot read at request
 * start (before verify/settle), so a tx we submit lands at slot > startSlot; slot ≤ startSlot = it landed before this
 * request → "replay" (409).
 *   - bound, meta.err set at confirmed AND again at FINALIZED → "failed" (terminal Base-only 402);
 *   - bound, ok, payTo received exactly the amount, slot > startSlot → "paid" (delivery at confirmed);
 *   - bound, ok, slot ≤ startSlot → "replay";
 *   - anything else (no startSlot, not indexed, RPC down, amount unreadable/different, not finalized) → "unknown".
 */
async function findPaymentOnChain(
  config: SolanaRailConfig,
  settleSigHint: string | undefined,
  ours: OurPayment,
  requirement: PaymentRequirements,
  startSlot: number,
): Promise<ChainFind> {
  const deadline = Date.now() + SOLANA_LEDGER_CHECK_DEADLINE_MS;
  const sigRe = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
  const left = () => Math.max(1, Math.min(config.initTimeoutMs, deadline - Date.now()));
  let hintForeign = false;
  let errSeen = false;
  const fetchBound = async (sig: string, commitment: "confirmed" | "finalized"): Promise<ChainTx | null> => {
    const tx = (await rpc(config.rpcUrl, "getTransaction", [sig, { commitment, encoding: "base64", maxSupportedTransactionVersion: 0 }], left())) as ChainTx | null;
    const enc = tx?.transaction;
    if (!tx || !Array.isArray(enc) || typeof enc[0] !== "string" || enc[1] !== "base64") return null;
    const w = parseWireTx(Buffer.from(enc[0], "base64"));
    const s = w ? w.sigs[ours.slot] : undefined;
    if (!w || !sameBytes(w.message, ours.message) || !s || base58Encode(s) !== ours.signature) {
      if (sig === settleSigHint) hintForeign = true; // a real tx, but not OUR message / buyer signature
      return null;
    }
    return Object.assign(tx, { __txid: base58Encode(w.sigs[0]) });
  };
  for (const delay of ledgerDelays) {
    if (delay > 0) {
      if (Date.now() + delay >= deadline) break;
      await new Promise((r) => setTimeout(r, delay));
    }
    if (deadline - Date.now() <= 0) break;
    try {
      const candidates: string[] = [];
      if (typeof settleSigHint === "string" && sigRe.test(settleSigHint)) candidates.push(settleSigHint);
      const list = await rpc(config.rpcUrl, "getSignaturesForAddress", [SOLANA_PAYTO_USDC_ATA, { limit: SOLANA_LEDGER_SCAN_LIMIT, commitment: "confirmed" }], left());
      for (const e of Array.isArray(list) ? (list as Array<{ signature?: unknown; slot?: unknown }>) : []) {
        if (typeof e?.signature === "string" && sigRe.test(e.signature) && typeof e.slot === "number" && e.slot > startSlot && !candidates.includes(e.signature)) candidates.push(e.signature);
      }
      for (const sig of candidates) {
        if (deadline - Date.now() <= 0) break;
        const tx = await fetchBound(sig, "confirmed");
        if (!tx || !tx.meta) continue; // not ours / meta not served yet: retry within the deadline
        const txid = (tx as ChainTx & { __txid: string }).__txid;
        if (tx.meta.err !== null && tx.meta.err !== undefined) {
          // Terminal 402 only on FINALIZED failure (a confirmed fork could be dropped and the message re-included).
          errSeen = true;
          const fin = deadline - Date.now() > 0 ? await fetchBound(sig, "finalized") : null;
          return fin?.meta && fin.meta.err !== null && fin.meta.err !== undefined ? { kind: "failed" } : { kind: "unknown", errSeen };
        }
        const got = usdcReceivedByPayTo(tx);
        if (got === null || got !== BigInt(requirement.amount)) return { kind: "unknown" };
        if (typeof tx.slot !== "number" || !Number.isSafeInteger(tx.slot)) return { kind: "unknown" };
        if (tx.slot <= startSlot) return { kind: "replay", signature: txid };
        return { kind: "paid", signature: txid };
      }
    } catch {
      /* RPC down / malformed: retry within the deadline */
    }
  }
  return { kind: "unknown", hintForeign, errSeen };
}

/**
 * Manual-refund trail (Odin 12:31): one line per 502/504/409 answered from the ambiguous-settle path. Public chain data
 * only: payer (from OUR message), amount (server requirement), the buyer's signature from OUR payload, the chain tx
 * id when found, outcome. Never facilitator text.
 */
/** Buyer signatures already alerted (insertion-ordered, bounded; entries older than REPLAY_TTL_MS re-alert). */
const reconcileAlerted = new Map<string, number>();
const RECONCILE_ALERT_DEDUPE_MAX = 10_000;
function logSolanaReconcile(o: { status: number; reason: string; key: string; ours: OurPayment | null; amount: string; txid?: string }): void {
  const line = {
    status: o.status,
    reason: o.reason,
    fp: fp(o.key),
    payer: o.ours?.payer ?? null,
    amount: o.amount,
    asset: USDC_SOLANA_MINT,
    payTo: SOLANA_PAYTO,
    buyerSignature: o.ours?.signature ?? null,
    ...(o.txid ? { txid: o.txid } : {}),
  };
  console.warn(`[solana-rail] SOLANA_RECONCILE ${JSON.stringify(line)}`);
  // Odin 12:51: also an ALERT through the existing sink (setSolanaAlertHook; default one [ALERT] console.error line).
  // Odin 1:21: deduped per buyer signature (one alert per possible refund; the log line stays per occurrence).
  const dedupeKey = line.buyerSignature ?? `fp:${line.fp}`;
  const now = Date.now();
  const seenAt = reconcileAlerted.get(dedupeKey);
  if (seenAt !== undefined && now - seenAt < REPLAY_TTL_MS) return;
  reconcileAlerted.delete(dedupeKey);
  reconcileAlerted.set(dedupeKey, now);
  while (reconcileAlerted.size > RECONCILE_ALERT_DEDUPE_MAX) reconcileAlerted.delete(reconcileAlerted.keys().next().value!);
  emitAlert({ kind: "solana_reconcile", ...line });
}

/** Same response, PAYMENT-RESPONSE replaced (Odin 1:21: chain result instead of PayAI's foreign signature). */
function withPaymentResponse(res: NextResponse, settle: SettleResponse): NextResponse {
  const headers = new Headers(res.headers);
  headers.set("PAYMENT-RESPONSE", encodePaymentResponseHeader(settle));
  return new NextResponse(res.body, { status: res.status, headers });
}

/** The handler's own response + PAYMENT-RESPONSE + private Cache-Control, as @x402/next's settle-success path. */
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
function solanaInProgress(k: string): NextResponse {
  warn(`Solana payment slot busy fp=${fp(k)}; client gets 503 payment_in_progress (retry)`, undefined, false);
  const res = jsonError(503, "payment_in_progress");
  res.headers.set("Retry-After", String(SOLANA_NO_SLOT_RETRY_AFTER_S));
  return res;
}

type SolanaRedeemCtx = {
  req: NextRequest;
  routeHandler: AppRouteHandler;
  rail: Rail;
  config: SolanaRailConfig;
  requirement: PaymentRequirements;
  ours: OurPayment | null;
  reject: (reason: string) => null;
};

/**
 * Odin 1:39 (3): redeem-on-retry, modeled on the XRPL rail. A retry of a payment whose shared slot is NOT delivered
 * (settle_unconfirmed, a stale in_flight from a dead request, or an expired redemption lease) carries the SAME
 * message (the slot key is the sha256 of the message). Exactly one request wins the undelivered → redeeming CAS
 * (owner-tagged lease), then looks for OUR payment on-chain, read-only and bounded (findPaymentOnChain: message bytes
 * AND the buyer signature from THIS payload must match; slot freshness against the FIRST request's start slot stored
 * in the slot), with no PayAI verify or settle:
 *   - paid (slot > first start slot) → run the route, mark delivered (CAS), serve with PAYMENT-RESPONSE from the chain;
 *   - landed at/before the first start slot → 409 (not paid through this flow) + reconcile;
 *   - failed on-chain (confirmed + finalized) → settle_failed, Base-only 402 (nothing moved);
 *   - not visible / RPC down, route error → back to undelivered (CAS against our own lease) → 502, retry later.
 * Losers of the CAS, a live lease, or a fresh in_flight → 503 payment_in_progress. Store error → fail closed.
 */
async function redeemUndelivered(k: string, raw: string, rec: ReturnType<typeof parseReplayValue>, ctx: SolanaRedeemCtx): Promise<NextResponse | null> {
  const store = shared!;
  const now = Date.now();
  if (!rec) return solanaInProgress(k); // unreadable value: never touched; TTL or a human resolves it
  if (rec.state === "in_flight" && (rec.lease === undefined || now - rec.lease < SOLANA_IN_FLIGHT_STALE_MS)) return solanaInProgress(k);
  if (rec.state === "redeeming" && rec.lease !== undefined && now - rec.lease < SOLANA_REDEEM_LEASE_MS) return solanaInProgress(k);
  const firstSlot = rec.firstSeen;
  if (firstSlot === undefined || !Number.isSafeInteger(firstSlot) || firstSlot <= 0 || !ctx.ours || !store.cas) {
    warn(`undelivered Solana payment fp=${fp(k)} is not auto-redeemable (no start slot / unparseable payment); client gets 502`, undefined, false);
    return jsonError(502, "settlement_unconfirmed");
  }
  const ours = ctx.ours;
  const cas = store.cas.bind(store);
  const owner = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(8))).toString("hex");
  const mine = encodeReplayValue({ state: "redeeming", firstSeen: firstSlot, lease: now, owner });
  const undelivered = encodeReplayValue({ state: "settle_unconfirmed", firstSeen: firstSlot });
  let won: boolean;
  try {
    won = await cas(k, raw, mine, REPLAY_TTL_MS);
  } catch (err) {
    warn("Solana claim store unavailable during redeem; payment not accepted (fail closed)", err);
    return ctx.reject(RAIL_REJECT.unavailable);
  }
  if (!won) return solanaInProgress(k);
  const finish = async (next: string, what: string): Promise<boolean> => {
    try {
      return await cas(k, mine, next, REPLAY_TTL_MS);
    } catch (err) {
      warn(`redeem: claim store ${what} failed fp=${fp(k)}`, err, false);
      return false;
    }
  };
  try {
    const found = await findPaymentOnChain(ctx.config, undefined, ours, ctx.requirement, firstSlot);
    if (found.kind === "paid") {
      const out = await runOnPaidRail(() => solanaRail(ctx.rail.config), ctx.routeHandler)(ctx.req);
      if (out.status >= 400) {
        await finish(undelivered, "reset");
        warn(`redeem: route answered ${out.status} fp=${fp(k)}; back to undelivered, client gets 502`, undefined, false);
        return jsonError(502, "settlement_unconfirmed");
      }
      if (!(await finish("settled", "delivered mark"))) warn(`redeem: delivered mark lost fp=${fp(k)}; delivering anyway (paid)`, undefined, false);
      replaySet(k, "settled");
      warn(`redeemed undelivered Solana payment fp=${fp(k)}; serving the paid response`, undefined, false);
      return deliverConfirmed(out, { success: true, transaction: found.signature, network: ctx.config.network, payer: ours.payer } as SettleResponse);
    }
    if (found.kind === "failed") {
      await finish("settle_failed", "failed mark");
      replaySet(k, "settle_failed");
      warn(`redeem: tx failed on-chain (finalized) fp=${fp(k)}; not charged, Base-only 402`, undefined, false);
      return ctx.reject(settleFailReason("transaction_failed"));
    }
    if (found.kind === "replay") {
      await finish("settled", "replay mark");
      replaySet(k, "settled");
      logSolanaReconcile({ status: 409, reason: "redeem_landed_before_first_request", key: k, ours, amount: ctx.requirement.amount, txid: found.signature });
      warn(`redeem: payment landed at/before the first request's start slot fp=${fp(k)}; client gets 409`, undefined, false);
      return jsonError(409, "duplicate_payment");
    }
    await finish(undelivered, "reset");
    logSolanaReconcile({ status: 502, reason: "redeem_not_found", key: k, ours, amount: ctx.requirement.amount });
    warn(`redeem: our payment not visible on-chain yet fp=${fp(k)}; back to undelivered, client gets 502`, undefined, false);
    return jsonError(502, "settlement_unconfirmed");
  } catch (err) {
    await finish(undelivered, "reset");
    warn(`redeem failed fp=${fp(k)}; back to undelivered, client gets 502`, err, false);
    return jsonError(502, "settlement_unconfirmed");
  }
}

/**
 * Serve a Solana-paid request through the Solana-only server.
 *   - null → caller serves main's exact Base-only 402 (rail unavailable,
 *     preflight failed, verify-phase rejection/throw/timeout/malformed, or a
 *     definitive settle failure);
 *   - 409 {"error":"duplicate_payment"} → replay of a payment already in
 *     flight / settled / unconfirmed (checked before verify), or (N1) a
 *     settle whose tx was confirmed before this request started;
 *   - 502/504 {"error":"settlement_unconfirmed"} → ambiguous settle not found on-chain either way;
 *   - the paid response → settled, or an ambiguous settle confirmed on-chain (Base-only 402 if it failed on-chain);
 *   - throws → the route handler threw (same as the Base path: Next 500).
 */
export async function handleSolanaPayment(
  req: NextRequest,
  routeHandler: AppRouteHandler,
  routes: RoutesConfig,
  atomicUsdc: string,
  config: SolanaRailConfig,
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
  let reconcile: { reason: string; ours: OurPayment | null } | null = null;
  const startedAt = Date.now();
  try {
    // N3: token-account check and rail init in parallel.
    // Odin 12:31 S1: the chain slot at request start (before verify/settle) orders any later on-chain match.
    // Odin 12:51 (d): the shared claim store's EVAL + self-test probe runs in parallel; failing → fail closed.
    const [ready, rail, startSlot, evalOk] = await Promise.all([solanaTokenAccountReady(config), getRail(config), readStartSlot(config), solanaReplayEvalOk()]);
    if (!ready || !rail || !evalOk) return reject(RAIL_REJECT.unavailable);
    // Odin 1:19/1:21: no request-start slot (both getSlot tries failed / timed out) → 503 + Retry-After with a FIXED
    // body, right after the rail-ready check: no PayAI verify/settle, no handler, no replay key. Nothing is charged
    // and no later on-chain match would be unorderable (no replay window, no wall-clock fallback).
    if (startSlot === undefined) {
      warn("no request-start slot (getSlot failed twice or timed out); client gets 503 before PayAI (nothing charged)", undefined, false);
      return noStartSlotResponse();
    }

    const requirement = await buildSolanaRequirement(rail, atomicUsdc);
    const received = decodePaymentSignatureHeader(req.headers.get("payment-signature")!.trim()) as PaymentPayload;
    const payload = stripBazaar(received);
    const check = validateSolanaPaymentPayload(payload, requirement);
    if (!check.ok) {
      warn(`rejected Solana payload before facilitator (${check.reason})`);
      return reject(RAIL_REJECT.invalidPayload);
    }

    // Replay guard: BEFORE verify.
    const k = await solanaPaymentKey(txOf(payload)!);
    const seen = replayGet(k);
    // With a shared store, only a DELIVERED / failed slot is final locally; in_flight / undelivered go to the shared
    // slot (in progress → 503, undelivered → redeem on retry, Odin 1:39 (3)).
    if (seen && (!shared || seen === "settled" || seen === "settle_failed")) {
      warn(`duplicate Solana payment rejected before verify fp=${fp(k)} state=${seen}; client gets 409`, undefined, false);
      return jsonError(409, "duplicate_payment");
    }
    // Odin 12:51 (d): atomic cross-instance claim (SET NX) BEFORE verify; store error → fail closed (Base-only 402,
    // nothing charged). A slot held by another request / instance → 409 (local cache remembers it).
    const ours = ourPayment(txOf(payload)!);
    let held: string | null;
    try {
      held = await sharedClaim(k, startSlot, startedAt);
    } catch (err) {
      warn("Solana claim store unavailable; payment not accepted (fail closed)", err);
      return reject(RAIL_REJECT.unavailable);
    }
    if (held !== null) {
      // claim() answers the held STATE; the redeem CAS needs the exact stored value (start slot, lease, owner).
      let raw: string | null = null;
      if (held !== "settled" && held !== "settle_failed") {
        try {
          raw = shared?.get ? await shared.get(k) : null;
        } catch (err) {
          warn("Solana claim store unavailable; payment not accepted (fail closed)", err);
          return reject(RAIL_REJECT.unavailable);
        }
        if (raw === null) return solanaInProgress(k); // expired / released in between: the buyer retries
      }
      const rec = raw !== null ? parseReplayValue(raw) : { state: held as ReplayState };
      const st = rec?.state ?? "in_flight";
      if (st === "settled" || st === "settle_failed") {
        replaySet(k, st);
        warn(`duplicate Solana payment rejected before verify (shared claim) fp=${fp(k)} state=${st}; client gets 409`, undefined, false);
        return jsonError(409, "duplicate_payment");
      }
      // Odin 1:39 (3): not delivered (or a request in progress) → redeem on retry, ledger-only (no verify, no settle).
      return await redeemUndelivered(k, raw!, rec, { req, routeHandler, rail, config, requirement, ours, reject });
    }
    key = k;
    replaySet(key, "in_flight");
    const att: Attempt = { handlerRan: false, handlerThrew: false };
    attempts.set(key, att);

    let entry = paidHandlers.get(routes as object);
    if (!entry || entry.rail !== rail) {
      // syncFacilitatorOnStart=false: rail.server was already initialized.
      const tracked: AppRouteHandler = async (r) => {
        const sig = r.headers.get("payment-signature");
        let a: Attempt | undefined;
        try {
          a = sig ? await attemptFor(decodePaymentSignatureHeader(sig.trim()) as PaymentPayload) : undefined;
        } catch {
          a = undefined;
        }
        if (a) a.handlerRan = true;
        try {
          // This server only verifies/settles Solana USDC to rail.config: the
          // handler's `priced` block (lib/paid-rail.ts) reports that rail.
          const out = await runOnPaidRail(() => solanaRail(rail.config), routeHandler)(r);
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
        handler: withX402(tracked, buildSolanaOnlyRoutes(rail.config, routes, atomicUsdc), rail.server, undefined, undefined, false),
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
      const ours = ourPayment(txOf(payload)!);
      if (!ours) {
        // Unparseable buyer slot in a payload PayAI accepted: cannot bind → fail open as on an RPC hiccup.
        warn(`could not read our payment from the payload fp=${fp(key)}; serving the paid response`, undefined, false);
      } else {
        // Odin 12:51 (b): slot ordering + S2 binding on the success path too. PayAI's signature is only a hint.
        const found = await findPaymentOnChain(config, att.settle.transaction, ours, requirement, startSlot);
        if (found.kind === "replay") {
          // OUR message landed before this request started: a replay of a payment already served (PayAI's cached
          // success); nothing new was charged → 409, no reconcile.
          replayWrite(key, "settled", startSlot);
          await flushShared();
          warn(`cross-instance replay: tx confirmed before this request (slot) fp=${fp(key)}; client gets 409`, undefined, false);
          return jsonError(409, "duplicate_payment");
        }
        if (found.kind === "failed" || (found.kind === "unknown" && (found.hintForeign || found.errSeen))) {
          // PayAI said success but the chain says otherwise: its signature is not OUR message (and ours is not in the
          // recent history), or OUR tx failed. No evidence we were paid → never deliver; a charge is possible → 502 +
          // reconcile (never a 402: it would invite a second payment).
          replayWrite(key, "settle_unconfirmed", startSlot);
          await flushShared();
          const reason = found.kind === "failed" || found.errSeen ? "settle_success_failed_on_chain" : "settle_success_unbound";
          warn(`settle success not bound on-chain fp=${fp(key)} reason=${reason}; client gets 502 settlement_unconfirmed`, undefined, false);
          logSolanaReconcile({ status: 502, reason, key, ours, amount: requirement.amount });
          return jsonError(502, "settlement_unconfirmed");
        }
        if (found.kind === "unknown") {
          // RPC down / not indexed within the deadline: fail open as before (PayAI confirmed the settle; never charge
          // without delivering on an RPC hiccup).
          warn(`could not bind the settled tx on-chain fp=${fp(key)}; serving the paid response`, undefined, false);
        }
        // "paid": OUR message, exact amount, slot > start slot → the normal paid response. Odin 1:21: if the tx we
        // found is not the one PayAI named, PAYMENT-RESPONSE carries the CHAIN result (tx id + payer from OUR message).
        if (found.kind === "paid" && found.signature !== att.settle.transaction) {
          res = withPaymentResponse(res, { success: true, transaction: found.signature, network: config.network, payer: ours.payer } as SettleResponse);
        }
      }
    } else if (att.settle?.outcome === "unconfirmed") {
      const ours = ourPayment(txOf(payload)!);
      if (att.settle.duplicate) {
        // Odin 12:31 S1 / 12:51 C1: PayAI says this payment was ALREADY settled or is in flight (ANY 409, incl. a
        // non-JSON 409, or a duplicate-shaped reason): a delivery may have happened elsewhere. Never look on-chain,
        // never deliver; main's 502 stands.
        reconcile = { reason: att.settle.raw === "duplicate_settlement" ? "duplicate_settlement" : "facilitator_duplicate", ours };
      } else if (att.paidRes && !att.handlerThrew) {
        // Ambiguous settle (timeout / transport / malformed / pending / success:false with a signature): the tx may
        // have landed. Look for OUR message on-chain (bounded, read-only) before answering.
        const found = ours ? await findPaymentOnChain(config, att.settle.transaction, ours, requirement, startSlot) : ({ kind: "unknown" } as const);
        if (found.kind === "paid") {
          replayWrite(key, "settled", startSlot);
          await flushShared();
          warn(`ambiguous settle confirmed on-chain fp=${fp(key)}; serving the paid response`, undefined, false);
          return deliverConfirmed(att.paidRes, { success: true, transaction: found.signature, network: config.network, payer: ours!.payer } as SettleResponse);
        }
        if (found.kind === "failed") {
          replayWrite(key, "settle_failed", startSlot);
          await flushShared();
          warn(`ambiguous settle: tx failed on-chain (finalized) fp=${fp(key)}; not charged, client gets the Base-only 402`, undefined, false);
          return reject(settleFailReason("transaction_failed"));
        }
        if (found.kind === "replay") {
          replayWrite(key, "settled", startSlot);
          await flushShared();
          warn(`ambiguous settle: tx landed before this request (slot) fp=${fp(key)}; client gets 409`, undefined, false);
          logSolanaReconcile({ status: 409, reason: "ambiguous_settle_landed_before_request", key, ours, amount: requirement.amount, txid: found.signature });
          return jsonError(409, "duplicate_payment");
        }
        reconcile = { reason: "ambiguous_settle_not_found", ours };
      } else {
        reconcile = { reason: "ambiguous_settle_handler_failed", ours };
      }
    }
    decision = decide(key, att, res, threw, thrown, startSlot);
    await flushShared();
    if (reconcile && decision.kind === "response" && (decision.res.status === 502 || decision.res.status === 504 || decision.res.status === 409)) {
      logSolanaReconcile({ status: decision.res.status, reason: reconcile.reason, key, ours: reconcile.ours, amount: requirement.amount });
    }
  } catch (err) {
    // Our own code threw before/around the facilitator: nothing was settled.
    if (key && !attempts.get(key)?.settle) replayRelease(key);
    await flushShared();
    warn("Solana payment path threw", err);
    return reject(RAIL_REJECT.error);
  } finally {
    if (key) attempts.delete(key);
  }
  if (decision.kind === "rethrow") throw decision.err;
  return decision.kind === "response" ? decision.res : reject(decision.reason);
}
