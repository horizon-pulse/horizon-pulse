/**
 * Machine-readable rejection reasons for the Solana / XRPL / Polygon rails
 * (Odin 1b, 2026-10-13; @lowkey_builds "opaque rejections").
 *
 * Base already puts the facilitator's reason in the PAYMENT-REQUIRED header's
 * `error` field on a refused payment (x402 core). The other rails used to fall
 * back to the plain unpaid Base-only 402 with NO reason, so a buyer could not
 * tell "no funds" from "broken". Now each rail reports a reason code through an
 * onReject callback and the fallback 402 carries it the same way Base does:
 * PAYMENT-REQUIRED.error = <code>. Nothing else changes: same status, same
 * body, same accepts; nothing is charged and no handler body is served.
 * Unpaid 402s never pass through here (byte-identical, golden-tested).
 *
 * Codes are plain /^[a-z0-9_]+$/ (<= 80 chars); anything else from a
 * facilitator becomes the generic fallback, so no free text ever leaks.
 * Odin F1: a code that contains "0x" or a run of >= 16 hex characters is also
 * refused (falls back to our own code), so a facilitator can never put an EVM
 * address, tx hash or other identifier into the buyer-visible reason.
 */
import { NextResponse } from "next/server";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentRequiredHeader } from "@x402/core/http";

/** Our own codes (facilitator codes such as insufficient_funds pass through). */
export const RAIL_REJECT = {
  /**
   * Payload doesn't match the advertised requirement (amount, payTo, asset, network, version, shape).
   * Also used for XRPL "no payment slot" (signed tx has neither Sequence nor TicketSequence): Odin F4.
   */
  invalidPayload: "invalid_payload",
  /** Rail not ready on our side (facilitator / replay store / receiving account unavailable). Retry later or pay on Base.
   *  Includes a failed XRPL replay-store claim (fail closed, nothing charged): Odin F4. */
  unavailable: "rail_unavailable",
  /** Our rail code threw before anything was charged. */
  error: "rail_error",
  /** Verify refused without a usable reason code. */
  verifyFailed: "verification_failed",
  /** Definitive settle failure without a usable reason code (nothing landed). */
  settleFailed: "settlement_failed",
} as const;

/**
 * Internal, never buyer-visible, never derived from a facilitator: set ONLY by our own local payload checks (Sentinel
 * LOW on delta6). The Solana reject 402 re-offers Solana on this flag, not on the reason TEXT, so a facilitator that
 * passes through "invalid_payload" can never steer which rails our 402 lists.
 */
export type RejectMeta = { readonly reofferSolana?: true };
export type OnReject = (reason: string, meta?: RejectMeta) => void;

/** Hex-run threshold: 16 lowercase hex chars in a row (shortest real ids we care about are far longer). */
const HEX_RUN = /[0-9a-f]{16,}/;

export function sanitizeReason(v: unknown): string | null {
  if (typeof v !== "string" || v.length === 0 || v.length > 80 || !/^[a-z0-9_]+$/.test(v)) return null;
  if (v.includes("0x") || HEX_RUN.test(v)) return null; // Odin F1: no addresses / hashes / long hex ids
  return v;
}

/** Definitive settle failure: the rail's sanitized code, unless it is a placeholder. */
export function settleFailReason(code: string): string {
  return sanitizeReason(code) && code !== "unknown" && code !== "unrecognized" ? code : RAIL_REJECT.settleFailed;
}

/** Reason from a rail server's 402: PAYMENT-REQUIRED.error (verify), else PAYMENT-RESPONSE.errorReason (settle). */
export function reasonFromRailResponse(res: Response | null | undefined, fallback: string): string {
  if (!res) return fallback;
  try {
    const pr = decodePaymentRequiredHeader(res.headers.get("payment-required") ?? "");
    const r = sanitizeReason(pr.error);
    if (r) return r;
  } catch {
    /* none */
  }
  try {
    const ps = decodePaymentResponseHeader(res.headers.get("payment-response") ?? "") as { errorReason?: unknown };
    const r = sanitizeReason(ps.errorReason);
    if (r) return r;
  } catch {
    /* none */
  }
  return fallback;
}

/**
 * Same 402 with PAYMENT-REQUIRED.error = reason. Not a 402, no header, or no
 * reason → returned unchanged (same object).
 */
export async function withRejectReason(res: NextResponse, reason: string | null): Promise<NextResponse> {
  const code = sanitizeReason(reason);
  const header = res.headers.get("payment-required");
  if (!code || res.status !== 402 || !header) return res;
  let encoded: string;
  try {
    const pr = decodePaymentRequiredHeader(header);
    encoded = encodePaymentRequiredHeader({ ...pr, error: code });
  } catch {
    return res;
  }
  const headers = new Headers(res.headers);
  headers.set("PAYMENT-REQUIRED", encoded);
  const body = await res.arrayBuffer();
  return new NextResponse(body, { status: res.status, statusText: res.statusText, headers });
}
