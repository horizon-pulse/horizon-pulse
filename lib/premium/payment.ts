/**
 * Premium Base-only payment path (spec §3, §3a, §4). Self-contained: it does NOT go through withX402 or the
 * Solana / XRPL / Polygon appenders in lib/x402-server.ts, so none of the 28 existing routes' flows change and no
 * non-Base accepts entry can ever be attached to a premium challenge.
 *
 * Order on a paid request (each step returns before the next; nothing below a failing step runs):
 *   1. decode PAYMENT-SIGNATURE / X-PAYMENT (undecodable -> Base-only 402 invalid_payment, zero calls)
 *   2. classify by the PARSED payload: scheme exact + eip155:8453 + Base USDC, else 402 rail_unavailable, zero
 *      store / facilitator / RPC calls (T3.1)
 *   3. price binding: accepted.amount AND authorization.value == price(tier of THIS path), payTo == pinned line-8
 *      string (full, case-insensitive hex compare), authorization.to == payTo; else 402 for the requested tier, no
 *      verify/settle (T3a.1/T3a.2)
 *   4. used nonce: local set of nonces this instance settled, then USDC authorizationState(from, nonce) on Base;
 *      used -> 409 authorization_already_used + reconcile + HIGH (T4.2/T4.3); RPC down -> uncharged 503
 *   5. facilitator verify (invalid -> 402; error -> 503, nothing settled)
 *   6. work (caller)  7. settle: timeout -> 504, any other non-success / error -> 502; both settle_unconfirmed +
 *      reconcile + HIGH, never a fresh 402 (T4.1)
 */
import { createFacilitatorConfig } from "@coinbase/x402";
import { FacilitatorTimeoutError, getFacilitatorResponseError, HTTPFacilitatorClient } from "@x402/core/server";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { NextRequest, NextResponse } from "next/server";
import { BASE_CAIP2, DEFAULT_PAY_TO, PUBLIC_BASE_URL, USDC_BASE } from "@/lib/config";
import { defaultRpcDeps, ethCall, type RpcDeps } from "@/lib/chain-rpc";
import { BUYER_TERMS_URL } from "./copy";
import { tierPath, type Tier } from "./tiers";

export const PREMIUM_CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "PAYMENT-SIGNATURE, X-PAYMENT, PAYMENT-REQUIRED, PAYMENT-RESPONSE, Content-Type, Accept",
  "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "no-store",
};

/** Settle budget reserved out of maxDuration 60 s (spec §5). */
export const PREMIUM_SETTLE_TIMEOUT_MS = 10_000;
/** Deliberately not imported from lib/x402-server (keeps the Solana/XRPL rail modules out of the premium import graph). */
export const PREMIUM_VERIFY_TIMEOUT_MS = 8_000;
export const NONCE_RPC_TIMEOUT_MS = 4_000;

export function requirementFor(x: Tier) {
  return {
    scheme: "exact",
    network: BASE_CAIP2,
    amount: x.amount,
    asset: USDC_BASE,
    payTo: DEFAULT_PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { name: "USD Coin", version: "2" },
  };
}

export function paymentRequired(x: Tier, description: string, error?: string) {
  return {
    x402Version: 2 as const,
    ...(error ? { error } : {}),
    resource: { url: `${PUBLIC_BASE_URL}${tierPath(x)}`, description, mimeType: "application/json", terms: BUYER_TERMS_URL },
    accepts: [requirementFor(x)],
  };
}

export function challenge(x: Tier, description: string, error?: string, status = 402): NextResponse {
  const body = paymentRequired(x, description, error);
  return NextResponse.json(body, { status, headers: { ...PREMIUM_CORS, "PAYMENT-REQUIRED": encodePaymentRequiredHeader(body as never) } });
}

export function jsonError(status: number, body: Record<string, unknown>, extra: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { ...PREMIUM_CORS, ...extra } });
}

export type Decoded = {
  raw: any;
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  from: string | null;
  to: string | null;
  value: string | null;
  nonce: string | null;
};

export function paymentHeader(req: NextRequest): string | null {
  const v = req.headers.get("payment-signature") || req.headers.get("x-payment");
  return v && v.trim() ? v.trim() : null;
}

export function decodePayment(header: string): Decoded | null {
  let raw: any;
  try {
    raw = decodePaymentSignatureHeader(header);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const acc = raw.accepted && typeof raw.accepted === "object" ? raw.accepted : {};
  const auth = raw.payload?.authorization && typeof raw.payload.authorization === "object" ? raw.payload.authorization : {};
  const s = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" || typeof v === "bigint" ? String(v) : "");
  return {
    raw,
    scheme: s(acc.scheme ?? raw.scheme),
    network: s(acc.network ?? raw.network),
    asset: s(acc.asset),
    amount: s(acc.amount),
    payTo: s(acc.payTo),
    from: s(auth.from) || null,
    to: s(auth.to) || null,
    value: s(auth.value) || null,
    nonce: s(auth.nonce) || null,
  };
}

const eqHex = (a: string | null, b: string) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) && a.toLowerCase() === b.toLowerCase();

/** Spec §3 (Odin build note): classify by parsed network/scheme/asset, never by header type. */
export function isBaseUsdcExact(d: Decoded): boolean {
  return d.scheme === "exact" && d.network === BASE_CAIP2 && eqHex(d.asset, USDC_BASE);
}

/** Spec §3a: amount bound to the request's own path tier; payTo pinned to the full line-8 string. */
export function priceBindingError(d: Decoded, x: Tier): string | null {
  if (d.amount !== x.amount || d.value !== x.amount) return "amount_mismatch";
  if (!eqHex(d.payTo, DEFAULT_PAY_TO) || !eqHex(d.to, DEFAULT_PAY_TO)) return "payto_mismatch";
  if (!d.from || !/^0x[0-9a-fA-F]{40}$/.test(d.from) || !d.nonce || !/^0x[0-9a-fA-F]{64}$/.test(d.nonce)) return "malformed_authorization";
  return null;
}

/* ---------- used-nonce check ---------- */
const settledNonces = new Set<string>();
const SETTLED_CAP = 10_000;
export function markNonceSettled(from: string, nonce: string) {
  if (settledNonces.size >= SETTLED_CAP) settledNonces.clear();
  settledNonces.add(`${from.toLowerCase()}:${nonce.toLowerCase()}`);
}
export function resetPremiumNoncesForTests() {
  settledNonces.clear();
}

let rpcDepsOverride: RpcDeps | null = null;
export function setPremiumRpcForTests(d: RpcDeps | null) {
  rpcDepsOverride = d;
}

/** USDC (FiatTokenV2) authorizationState(address authorizer, bytes32 nonce) selector. */
export const AUTHORIZATION_STATE_SELECTOR = "0xe94a0102";

export async function nonceUsed(from: string, nonce: string): Promise<"used" | "unused" | "unknown"> {
  if (settledNonces.has(`${from.toLowerCase()}:${nonce.toLowerCase()}`)) return "used";
  const deps = rpcDepsOverride ?? defaultRpcDeps();
  const data = AUTHORIZATION_STATE_SELECTOR + from.toLowerCase().replace(/^0x/, "").padStart(64, "0") + nonce.toLowerCase().replace(/^0x/, "");
  try {
    const r = await ethCall(deps, "base", USDC_BASE, data, deps.now() + NONCE_RPC_TIMEOUT_MS);
    if (r === null) return "unknown";
    return /^0x0*1$/.test(r) ? "used" : /^0x0*$/.test(r) ? "unused" : "unknown";
  } catch {
    return "unknown";
  }
}

/* ---------- facilitator ---------- */
let facilitator: HTTPFacilitatorClient | null = null;
function client(): HTTPFacilitatorClient {
  facilitator ??= new HTTPFacilitatorClient({
    ...createFacilitatorConfig(process.env.CDP_API_KEY_ID?.trim() || undefined, process.env.CDP_API_KEY_SECRET?.trim() || undefined),
    timeoutMs: PREMIUM_SETTLE_TIMEOUT_MS,
  });
  return facilitator;
}
export function resetPremiumFacilitatorForTests() {
  facilitator = null;
}

export type VerifyResult = { ok: true; payer: string | null } | { ok: false; kind: "invalid"; reason: string } | { ok: false; kind: "error" };
export async function verifyPayment(d: Decoded, x: Tier): Promise<VerifyResult> {
  try {
    const r: any = await client().verify(d.raw, requirementFor(x) as never);
    if (r?.isValid === true) return { ok: true, payer: typeof r.payer === "string" ? r.payer : d.from };
    return { ok: false, kind: "invalid", reason: String(r?.invalidReason ?? "invalid_payment").slice(0, 80) };
  } catch {
    return { ok: false, kind: "error" };
  }
}

export type SettleResult =
  | { ok: true; tx: string | null; payer: string | null; header: string }
  | { ok: false; kind: "timeout" | "ambiguous"; tx: string | null };
export async function settlePayment(d: Decoded, x: Tier): Promise<SettleResult> {
  try {
    const r: any = await client().settle(d.raw, requirementFor(x) as never);
    const tx = typeof r?.transaction === "string" && r.transaction ? r.transaction : null;
    if (r?.success === true && tx) return { ok: true, tx, payer: typeof r.payer === "string" ? r.payer : d.from, header: encodePaymentResponseHeader(r) };
    return { ok: false, kind: "ambiguous", tx };
  } catch (e) {
    const t = getFacilitatorResponseError(e);
    const isTimeout = t instanceof FacilitatorTimeoutError || (e instanceof Error && /abort|timeout/i.test(`${e.name} ${e.message}`));
    return { ok: false, kind: isTimeout ? "timeout" : "ambiguous", tx: null };
  }
}
