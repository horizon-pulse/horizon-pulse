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
import { VerifyError } from "@x402/core/types";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { NextRequest, NextResponse } from "next/server";
import { BASE_CAIP2, DEFAULT_PAY_TO, PUBLIC_BASE_URL, USDC_BASE } from "@/lib/config";
import { defaultRpcDeps, ethCall, type RpcDeps } from "@/lib/chain-rpc";
import { BUYER_TERMS_URL } from "./copy";
import { tierPath, type Tier } from "./tiers";
import { logPaidSettle } from "@/lib/route-log";
import { BRIEF_SERVICE_META, briefBazaarExtension } from "./bazaar";
import { sellerDdBazaarExtension } from "@/lib/seller-dd/bazaar";
import { EURC_BASE, EURC_EIP712, eurcActive, eurcAtomicFromUsdAtomic, eurcExtra, isEurcAsset } from "@/lib/eurc-config";

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

/** Async tiers advertise a 15-minute authorization window (async scope §1, Q1): verify at accept, settle after the first deliverable. */
export const ASYNC_MAX_TIMEOUT_S = 900;

export function requirementFor(x: Tier) {
  return {
    scheme: "exact",
    network: BASE_CAIP2,
    amount: x.amount,
    asset: USDC_BASE,
    payTo: DEFAULT_PAY_TO,
    maxTimeoutSeconds: x.mode === "async" ? ASYNC_MAX_TIMEOUT_S : 300,
    extra: { name: "USD Coin", version: "2" },
  };
}

/**
 * EURC on Base for premium (feat/eurc-premium-dd): ONLY the $1 brief and Seller DD, ONLY while eurcActive()
 * (HP_EURC_ENABLED exactly "true" + Base mainnet + rate at most 14 days old and not in the future). Every other premium
 * tier, and every tier while the flag is off, is USDC-only exactly as before.
 */
export const PREMIUM_EURC_TIERS: ReadonlySet<string> = new Set(["brief", "seller-dd"]);
export function premiumEurcOn(x: Tier): boolean {
  return PREMIUM_EURC_TIERS.has(x.id as string) && eurcActive();
}
export function eurcRequirementFor(x: Tier) {
  return {
    scheme: "exact",
    network: BASE_CAIP2,
    amount: eurcAtomicFromUsdAtomic(x.amount),
    asset: EURC_BASE,
    payTo: DEFAULT_PAY_TO,
    maxTimeoutSeconds: x.mode === "async" ? ASYNC_MAX_TIMEOUT_S : 300,
    extra: eurcExtra(),
  };
}
/** USDC first (unchanged), then EURC when on. */
export function acceptsFor(x: Tier) {
  return premiumEurcOn(x) ? [requirementFor(x), eurcRequirementFor(x)] : [requirementFor(x)];
}

export function paymentRequired(x: Tier, description: string, error?: string, message?: string, charged?: false) {
  return {
    x402Version: 2 as const,
    ...(charged === false ? { charged: false as const } : {}),
    ...(error ? { error } : {}),
    ...(message ? { message } : {}),
    resource: { url: `${PUBLIC_BASE_URL}${tierPath(x)}`, description, mimeType: "application/json", terms: BUYER_TERMS_URL, ...(x.id === "brief" ? BRIEF_SERVICE_META : {}) },
    accepts: acceptsFor(x),
    // Bazaar discovery: the brief only (the one live premium tier). Other tiers stay unlisted.
    ...(x.id === "brief" ? { extensions: briefBazaarExtension() } : {}),
  };
}

export function challenge(x: Tier, description: string, error?: string, status = 402, message?: string, charged?: false): NextResponse {
  const body = paymentRequired(x, description, error, message, charged);
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
  validAfter: string | null;
  validBefore: string | null;
  signature: string | null;
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
    validAfter: s(auth.validAfter) || null,
    validBefore: s(auth.validBefore) || null,
    signature: typeof raw.payload?.signature === "string" ? raw.payload.signature : null,
  };
}

const eqHex = (a: string | null, b: string) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) && a.toLowerCase() === b.toLowerCase();

/** Spec §3 (Odin build note): classify by parsed network/scheme/asset, never by header type. */
export function isBaseUsdcExact(d: Decoded): boolean {
  return d.scheme === "exact" && d.network === BASE_CAIP2 && eqHex(d.asset, USDC_BASE);
}

/** EURC exact on Base for a tier where premium EURC is on (same parsed-payload classification rule as USDC). */
export function isBaseEurcExact(d: Decoded, x: Tier): boolean {
  return premiumEurcOn(x) && d.scheme === "exact" && d.network === BASE_CAIP2 && isEurcAsset(d.asset) && eqHex(d.asset, EURC_BASE);
}
/** Accepted rail for this tier, or null (-> 402 rail_unavailable, zero store / facilitator / RPC calls). */
export function paidRail(d: Decoded, x: Tier): "usdc" | "eurc" | null {
  if (isBaseUsdcExact(d)) return "usdc";
  if (isBaseEurcExact(d, x)) return "eurc";
  return null;
}
/** The requirement the payment is verified / settled / price-bound against: chosen by the PARSED asset. */
export function requirementForPaid(d: Decoded, x: Tier) {
  return paidRail(d, x) === "eurc" ? eurcRequirementFor(x) : requirementFor(x);
}
/** Token contract for the paid asset (authorizationState / AuthorizationUsed live on the token itself). */
export function assetContractFor(d: Pick<Decoded, "asset">): string {
  return isEurcAsset(d.asset) ? EURC_BASE : USDC_BASE;
}

/** Spec §3a: amount bound to the request's own path tier; payTo pinned to the full line-8 string. */
export function priceBindingError(d: Decoded, x: Tier): string | null {
  // Bound to the amount of the requirement for the PAID asset (USDC: tier amount; EURC: fixed-rate EURC amount).
  const amount = requirementForPaid(d, x).amount;
  if (d.amount !== amount || d.value !== amount) return "amount_mismatch";
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

export async function nonceUsed(from: string, nonce: string, token: string = USDC_BASE): Promise<"used" | "unused" | "unknown"> {
  if (settledNonces.has(`${from.toLowerCase()}:${nonce.toLowerCase()}`)) return "used";
  if (!eqHex(token, USDC_BASE) && !eqHex(token, EURC_BASE)) return "unknown";
  const deps = rpcDepsOverride ?? defaultRpcDeps();
  const data = AUTHORIZATION_STATE_SELECTOR + from.toLowerCase().replace(/^0x/, "").padStart(64, "0") + nonce.toLowerCase().replace(/^0x/, "");
  try {
    const r = await ethCall(deps, "base", token, data, deps.now() + NONCE_RPC_TIMEOUT_MS);
    if (r === null) return "unknown";
    return /^0x0*1$/.test(r) ? "used" : /^0x0*$/.test(r) ? "unused" : "unknown";
  } catch {
    return "unknown";
  }
}

/* ---------- facilitator ---------- */
let settleClient: HTTPFacilitatorClient | null = null;
let verifyClient: HTTPFacilitatorClient | null = null;
const mk = (timeoutMs: number) =>
  new HTTPFacilitatorClient({
    ...createFacilitatorConfig(process.env.CDP_API_KEY_ID?.trim() || undefined, process.env.CDP_API_KEY_SECRET?.trim() || undefined),
    timeoutMs,
  });
/** Odin C1: verify gets its own 8 s client; settle keeps the 10 s reserve. */
export function premiumVerifyClient(): HTTPFacilitatorClient {
  return (verifyClient ??= mk(PREMIUM_VERIFY_TIMEOUT_MS));
}
function client(): HTTPFacilitatorClient {
  return (settleClient ??= mk(PREMIUM_SETTLE_TIMEOUT_MS));
}
export function resetPremiumFacilitatorForTests() {
  settleClient = null;
  verifyClient = null;
}

/** Odin C4: only a bare reason code ever reaches the client; any facilitator free text becomes invalid_payment. */
export function reasonCode(v: unknown): string {
  return typeof v === "string" && /^[a-z0-9_]{1,64}$/.test(v) ? v : "invalid_payment";
}

/** Non-secret facilitator error summary for logs: operation + HTTP status (or error class). Never the body or headers. */
export function facilitatorErrorSummary(op: "verify" | "settle", e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  const status = /\((\d{3})\)/.exec(m)?.[1] ?? null;
  const kind = e instanceof Error ? e.name : typeof e;
  return `[premium][facilitator] ${op} error ${status ? `http_${status}` : kind}${status === "401" || status === "403" ? " (CDP credentials rejected: check CDP_API_KEY_ID / CDP_API_KEY_SECRET for this environment)" : ""}`;
}

/** VerifyError (thrown by HTTPFacilitatorClient.verify on a non-2xx with a verify body) that carries an invalidReason. Duck-typed by name too, in case of dual ESM/CJS copies. */
export function isVerifyRejection(e: unknown): e is { invalidReason: string } {
  if (!(e instanceof VerifyError) && !(e instanceof Error && e.name === "VerifyError")) return false;
  const r = (e as { invalidReason?: unknown }).invalidReason;
  return typeof r === "string" && r.length > 0;
}

export type VerifyResult = { ok: true; payer: string | null } | { ok: false; kind: "invalid"; reason: string } | { ok: false; kind: "error" };
export async function verifyPayment(d: Decoded, x: Tier): Promise<VerifyResult> {
  try {
    const r: any = await premiumVerifyClient().verify(d.raw, requirementForPaid(d, x) as never);
    if (r?.isValid === true) return { ok: true, payer: typeof r.payer === "string" ? r.payer : d.from };
    return { ok: false, kind: "invalid", reason: reasonCode(r?.invalidReason) };
  } catch (e) {
    // A facilitator rejection of the payment itself (non-2xx with invalidReason) is a payer-side invalid, not an outage.
    if (isVerifyRejection(e)) return { ok: false, kind: "invalid", reason: reasonCode(e.invalidReason) };
    console.error(facilitatorErrorSummary("verify", e));
    return { ok: false, kind: "error" };
  }
}

export type SettleResult =
  | { ok: true; tx: string | null; payer: string | null; header: string }
  | { ok: false; kind: "timeout" | "ambiguous"; tx: string | null };
/**
 * Bazaar indexing from any buyer (beat-14 plan move 1): CDP indexes a route from the extensions.bazaar block in the
 * SETTLED payment payload. Many buyers send a payload without it, so for the two discoverable tiers (the $1 brief and
 * Seller DD) we attach our own server-side block when the payload has none. A payload that already carries
 * extensions.bazaar is passed through untouched; every other tier is untouched. Returns a shallow copy (d.raw is not
 * mutated). Discovery metadata only: amount, payTo, signature and authorization are not modified.
 */
export function bazaarExtensionFor(x: Tier): Record<string, unknown> | null {
  if (x.id === "brief") return briefBazaarExtension() as Record<string, unknown>;
  if ((x.id as string) === "seller-dd") return sellerDdBazaarExtension() as Record<string, unknown>;
  return null;
}
export function withServerBazaarExtension(raw: any, x: Tier): any {
  const ext = bazaarExtensionFor(x);
  if (!ext || !raw || typeof raw !== "object" || raw.x402Version !== 2) return raw;
  const cur = raw.extensions && typeof raw.extensions === "object" && !Array.isArray(raw.extensions) ? raw.extensions : null;
  if (cur && cur.bazaar !== undefined && cur.bazaar !== null) return raw;
  return { ...raw, extensions: { ...(cur ?? {}), bazaar: ext.bazaar } };
}

export async function settlePayment(d: Decoded, x: Tier, routePath: string = tierPath(x)): Promise<SettleResult> {
  try {
    const req = requirementForPaid(d, x);
    const r: any = await client().settle(withServerBazaarExtension(d.raw, x), req as never);
    const tx = typeof r?.transaction === "string" && r.transaction ? r.transaction : null;
    if (r?.success === true && tx) {
      const payer = typeof r.payer === "string" ? r.payer : d.from;
      // Route tag at payment: record which route was paid (fire-and-forget, after the settle succeeded).
      logPaidSettle({ route: routePath, method: "POST", rail: typeof r.network === "string" ? r.network : BASE_CAIP2, amountAtomic: req.amount, tx, payer, ...(req.asset === EURC_BASE ? { asset: EURC_BASE } : {}) });
      return { ok: true, tx, payer, header: encodePaymentResponseHeader(r) };
    }
    return { ok: false, kind: "ambiguous", tx };
  } catch (e) {
    console.error(facilitatorErrorSummary("settle", e));
    const t = getFacilitatorResponseError(e);
    const isTimeout = t instanceof FacilitatorTimeoutError || (e instanceof Error && /abort|timeout/i.test(`${e.name} ${e.message}`));
    return { ok: false, kind: isTimeout ? "timeout" : "ambiguous", tx: null };
  }
}

/* ---------- Sentinel LOW-1: local authorization window ---------- */
/** validAfter <= now and validBefore >= now + minRemainingS (sync: the whole request; async: first deliverable + settle). */
export function windowError(d: Decoded, nowS: number, minRemainingS: number): string | null {
  const a = d.validAfter !== null && /^\d{1,20}$/.test(d.validAfter) ? Number(d.validAfter) : NaN;
  const b = d.validBefore !== null && /^\d{1,20}$/.test(d.validBefore) ? Number(d.validBefore) : NaN;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return "malformed_authorization";
  if (a > nowS) return "authorization_not_yet_valid";
  if (b < nowS + minRemainingS) return "authorization_window_too_short";
  // Sentinel delta-3 LOW-1: bound how long a live authorization stays outstanding (and the time to a confirmed strike)
  if (b > nowS + MAX_VALID_BEFORE_S) return "authorization_window_too_long";
  return null;
}
export const SYNC_MIN_REMAINING_S = 120;
export const MAX_VALID_BEFORE_S = 3600;
export const ASYNC_MIN_REMAINING_S = 11 * 60;

/* ---------- Sentinel MEDIUM-1: local EIP-3009 signature check before any 409 / alert / write ---------- */
export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;
export const USDC_BASE_DOMAIN = { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC_BASE } as const;
export const EURC_BASE_DOMAIN = { name: EURC_EIP712.name, version: EURC_EIP712.version, chainId: 8453, verifyingContract: EURC_BASE as `0x${string}` } as const;

/**
 * True only when the signature recovers to authorization.from under the Base USDC EIP-712 domain.
 * EOA signatures only: ERC-1271 / ERC-6492 smart-wallet signatures do not recover locally and are refused here
 * (402 invalid_signature) before any write. Documented limitation for Odin.
 */
export const SMART_WALLET_REASON = "smart_wallet_unsupported";
export const SMART_WALLET_MESSAGE = "Premium accepts payments signed by a regular wallet key (EOA) only at launch. Smart-wallet signatures (ERC-1271 / ERC-6492) are not supported yet; nothing was charged for this request. See /premium-terms.";
/** EOA signatures are exactly 65 bytes; any other well-formed hex signature is a smart-wallet (ERC-1271 / ERC-6492) signature. */
export function isSmartWalletSignature(d: Decoded): boolean {
  return typeof d.signature === "string" && /^0x(?:[0-9a-fA-F]{2})+$/.test(d.signature) && d.signature.length > 132;
}
export async function signatureValid(d: Decoded): Promise<boolean> {
  if (!d.signature || !/^0x[0-9a-fA-F]{130}$/.test(d.signature) || !d.from || !d.to || !d.value || !d.nonce || !d.validAfter || !d.validBefore) return false;
  try {
    const { recoverTypedDataAddress } = await import("viem");
    const who = await recoverTypedDataAddress({
      domain: isEurcAsset(d.asset) ? EURC_BASE_DOMAIN : USDC_BASE_DOMAIN, // EIP-712 domain of the PAID token
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: { from: d.from as `0x${string}`, to: d.to as `0x${string}`, value: BigInt(d.value), validAfter: BigInt(d.validAfter), validBefore: BigInt(d.validBefore), nonce: d.nonce as `0x${string}` },
      signature: d.signature as `0x${string}`,
    });
    return who.toLowerCase() === d.from.toLowerCase();
  } catch {
    return false;
  }
}

/* ---------- Sentinel item 4: payer-proof-bound redeem after a 504/502 ---------- */
export const PAYER_PROOF_HEADER = "x-hp-payer-proof";
export function redeemMessage(reconcileId: string, fingerprint: string, to: string, value: string): string {
  return `Horizon Pulse premium redeem\nreconcile_id: ${reconcileId}\nrequest: ${fingerprint}\nto: ${to.toLowerCase()}\nvalue: ${value}`;
}
/** EIP-191 personal_sign by authorization.from over redeemMessage (EOA only). */
export async function payerProofValid(from: string, proof: string | null, msg: string): Promise<boolean> {
  if (!proof || !/^0x[0-9a-fA-F]{130}$/.test(proof)) return false;
  try {
    const { verifyMessage } = await import("viem");
    return await verifyMessage({ address: from as `0x${string}`, message: msg, signature: proof as `0x${string}` });
  } catch {
    return false;
  }
}
