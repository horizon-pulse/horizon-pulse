/**
 * POST /api/seller-dd/single ($5, Base USDC). Odin C4 order:
 *   (1) buyer's $5 passes local checks + facilitator verify  (nothing reserved or paid before this)
 *   (2) only then reserve + make the capped test payment      (engine)
 *   (3) checks run                                            (engine)
 *   (4) settle the buyer's $5 on PASS only (signed verdict). No pass -> the authorization is never settled.
 * Buyer settle failure after our test pay -> loss absorbed under the $5/day cap + loss ledger; 3 settle failures in a UTC
 * day -> route fails closed (503 before any verify). Every response body carries the Counsel notice.
 */
import { randomBytes } from "node:crypto";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { NextRequest, NextResponse } from "next/server";
import { BASE_CAIP2, DEFAULT_PAY_TO, PUBLIC_BASE_URL, USDC_BASE, hasCdpCredentials } from "@/lib/config";
import { persistAlert } from "@/lib/alert-persist";
import { CLAIM_TTL_MS, claimKey, moveClaim, newOwner, parseClaim, releaseClaim, tryClaim } from "@/lib/premium/claim";
import { newReconcileId } from "@/lib/premium/reconcile";
import { BUYER_TERMS_URL } from "@/lib/premium/copy";
import {
  decodePayment, isBaseUsdcExact, isSmartWalletSignature, markNonceSettled, nonceUsed, paymentHeader, priceBindingError,
  PAYER_PROOF_HEADER, payerProofValid, redeemMessage, settlePayment, signatureValid, SYNC_MIN_REMAINING_S, verifyPayment, windowError,
} from "@/lib/premium/payment";
import { premiumStore, type PremiumStore } from "@/lib/premium/store";
import { receiptSignerReady, signReceipt } from "@/lib/receipt-signer";
import { requestFingerprint } from "@/lib/request-fingerprint";
import { ddKeys, recordLoss, recordSettleFailure, type NonceState, type Reservation, refundDeclineSlot, routeClosedBySettleFailures, takeDeclineSlot } from "./caps";
import { cdpContinuityDeps, defaultNetDeps, testPayLanded } from "./checks";
import { DD_AMOUNT, DD_DESCRIPTION, DD_NOTICE, DD_PATH, DD_TIER, SETTLE_FAIL_LIMIT, sellerDdEnabled, testPayEnabled } from "./config";
import { runSellerDd, type EngineDeps } from "./engine";
import { eqAddr, isEvmAddress, screenLists } from "./screen";
import { testerStatus } from "./testpay";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "PAYMENT-SIGNATURE, X-PAYMENT, Content-Type, Accept",
  "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Cache-Control": "no-store",
};
const SYNC_DEADLINE_MS = 45_000;

let clockFn: () => number = () => Date.now();
export function setSellerDdClockForTests(f: (() => number) | null) { clockFn = f ?? (() => Date.now()); }
let engineDepsOverride: Partial<EngineDeps> | null = null;
export function setSellerDdDepsForTests(d: Partial<EngineDeps> | null) { engineDepsOverride = d; }

export function ddRequirement() {
  // payTo is ALWAYS lib/config DEFAULT_PAY_TO (pinned by tests/payto-base-pin + tests/seller-dd-route full-string check).
  return { scheme: "exact", network: BASE_CAIP2, amount: DD_AMOUNT, asset: USDC_BASE, payTo: DEFAULT_PAY_TO, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } };
}
export function ddPaymentRequired(error?: string) {
  return {
    x402Version: 2 as const,
    ...(error ? { error } : {}),
    resource: { url: `${PUBLIC_BASE_URL}${DD_PATH}`, description: DD_DESCRIPTION, mimeType: "application/json", terms: BUYER_TERMS_URL },
    accepts: [ddRequirement()],
    notice: DD_NOTICE,
  };
}
function challenge(error?: string, status = 402): NextResponse {
  const body = ddPaymentRequired(error);
  return NextResponse.json(body, { status, headers: { ...CORS, "PAYMENT-REQUIRED": encodePaymentRequiredHeader(body as never) } });
}
function noCharge(status: number, reason: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json({ status: "no_charge", charged: false, reason, ...extra, notice: DD_NOTICE }, { status, headers: { ...CORS, ...headers } });
}
const notFound = () => new NextResponse("Not Found", { status: 404, headers: { "Cache-Control": "no-store" } });

function alertHigh(kind: string, detail: Record<string, unknown> = {}) {
  console.error(`[seller-dd][ALERT][HIGH] ${JSON.stringify({ kind, severity: "high", route: DD_PATH, ...detail })}`);
  persistAlert("premium", { kind, severity: "high", route: DD_PATH, payer: null });
}

export type DdBody = { resource: string; expected_payTo: string | null };
export function parseBody(raw: unknown): { ok: true; v: DdBody } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "body_must_be_json_object" };
  const o = raw as Record<string, unknown>;
  if (typeof o.resource !== "string" || o.resource.length > 2048) return { ok: false, reason: "resource_required" };
  try {
    const u = new URL(o.resource);
    if (u.protocol !== "https:" || u.username || u.password) return { ok: false, reason: "resource_must_be_https" };
  } catch {
    return { ok: false, reason: "resource_invalid_url" };
  }
  if (o.expected_payTo != null && !isEvmAddress(o.expected_payTo)) return { ok: false, reason: "expected_payTo_invalid" };
  return { ok: true, v: { resource: o.resource, expected_payTo: (o.expected_payTo as string | undefined) ?? null } };
}

export async function sellerDdHandler(req: NextRequest): Promise<NextResponse> {
  if (!sellerDdEnabled()) return notFound();
  if (req.method === "OPTIONS") return new NextResponse(null, { status: 204, headers: CORS });
  if (req.method === "GET") return challenge(); // unpaid probe / discovery: 402 only, nothing runs
  if (req.method !== "POST") return NextResponse.json({ error: "method_not_allowed", notice: DD_NOTICE }, { status: 405, headers: { ...CORS, Allow: "POST, GET, OPTIONS" } });

  // fingerprint BEFORE the body is consumed (it clones the request)
  let rq: string | null = null;
  try { rq = await requestFingerprint(req); } catch { rq = null; }
  let rawBody: unknown = null;
  try { rawBody = JSON.parse((await req.text()).slice(0, 8_192)); } catch { rawBody = null; }
  const header = paymentHeader(req);
  const b = parseBody(rawBody);
  if (!b.ok) return header ? noCharge(400, b.reason) : challenge(b.reason, 402);
  if (!header) return challenge();

  // B1 redeem path (delivery only: no verify, no settle, no test pay). Runs before the kill switch / route gates.
  if (req.headers.get(PAYER_PROOF_HEADER)) {
    const d0 = decodePayment(header);
    const st = premiumStore();
    if (!d0 || !d0.from || !d0.nonce || !st) return noCharge(d0 ? 503 : 402, d0 ? "store_unavailable" : "invalid_payment");
    if (!rq) return noCharge(503, "fingerprint_unavailable");
    return await redeemFlow(req, st, d0, rq);
  }

  // Kill switch / tester / signer / screen readiness: refused BEFORE the buyer's payment is touched.
  if (!testPayEnabled()) return noCharge(503, "test_pay_disabled", {}, { "Retry-After": "3600" });
  const lists = screenLists();
  if (!lists) return noCharge(503, "screen_list_unavailable");
  const tester = await testerStatus(process.env, lists);
  if (!tester.ok) { if (tester.code === "tester_address_mismatch") alertHigh("seller_dd_tester_address_mismatch"); return noCharge(503, "test_pay_unavailable"); }
  if (eqAddr(tester.address, DEFAULT_PAY_TO)) { alertHigh("seller_dd_tester_is_payto"); return noCharge(503, "test_pay_unavailable"); }
  if (!receiptSignerReady()) return noCharge(503, "signer_unavailable");

  const d = decodePayment(header);
  if (!d) return challenge("invalid_payment");
  if (!isBaseUsdcExact(d)) return challenge("rail_unavailable");
  const bind = priceBindingError(d, DD_TIER);
  if (bind) return challenge(bind);
  const win = windowError(d, Math.floor(clockFn() / 1000), SYNC_MIN_REMAINING_S);
  if (win) return challenge(win);
  if (isSmartWalletSignature(d)) return challenge("smart_wallet_unsupported");
  if (!(await signatureValid(d))) return challenge("invalid_signature");
  if (eqAddr(d.from, tester.address)) return challenge("payer_not_allowed"); // dd-tester never buys from us
  if (!hasCdpCredentials()) return noCharge(503, "settlement_unavailable");
  const store = premiumStore();
  if (!store) return noCharge(503, "store_unavailable");
  if (await routeClosedBySettleFailures(store, clockFn())) return noCharge(503, "route_paused_settle_failures", {}, { "Retry-After": "3600" });

  if (!rq) return noCharge(503, "fingerprint_unavailable");
  return await paidFlow(req, store, d, b.v, lists, rq);
}

async function paidFlow(req: NextRequest, store: PremiumStore, d: NonNullable<ReturnType<typeof decodePayment>>, body: DdBody, lists: NonNullable<ReturnType<typeof screenLists>>, rq: string): Promise<NextResponse> {
  const now = clockFn();
  const got = await tryClaim(store, d.from!, d.nonce!, { s: "inflight", o: newOwner(), rq, at: now, tier: "seller-dd" }).catch(() => null);
  if (!got) return noCharge(503, "store_unavailable");
  if (!got.ok) return noCharge(409, "authorization_already_used_or_in_progress");
  const held = got.held;

  const used = await nonceUsed(d.from!, d.nonce!);
  if (used !== "unused") { await releaseClaim(store, held).catch(() => undefined); return noCharge(used === "used" ? 409 : 503, used === "used" ? "authorization_already_used" : "nonce_check_unavailable"); }

  // (1) buyer verify
  const ver = await verifyPayment(d, DD_TIER);
  if (!ver.ok) { await releaseClaim(store, held).catch(() => undefined); return ver.kind === "invalid" ? challenge(ver.reason) : noCharge(503, "facilitator_unavailable"); }

  // Odin C4: the request takes one of the buyer's decline slots (refunded only after settle succeeds)
  const slot = await takeDeclineSlot(store, d.from!, now).catch(() => null);
  if (slot === null) { await releaseClaim(store, held).catch(() => undefined); return noCharge(503, "store_unavailable"); }
  if (!slot) { await releaseClaim(store, held).catch(() => undefined); return noCharge(429, "too_many_no_charge_requests", {}, { "Retry-After": "3600" }); }

  // (2)+(3) checks + test pay
  const requestId = randomBytes(12).toString("hex");
  const deps: EngineDeps = {
    net: defaultNetDeps(),
    continuity: cdpContinuityDeps(),
    store,
    lists,
    env: process.env,
    now: clockFn,
    ...(engineDepsOverride ?? {}),
  };
  const out = await runSellerDd({ resource: body.resource, expected_payTo: body.expected_payTo, request_id: requestId, deadline: now + SYNC_DEADLINE_MS }, deps);

  let sig: ReturnType<typeof signReceipt> | null = null;
  if (out.pass) { try { sig = signReceipt("seller-dd", out.verdict); } catch { sig = null; } }
  if (!out.pass || !sig) {
    // unpaid: check names + results only (no evidence, excerpt, history or payTo facts leave without a charge)
    await moveClaim(store, held, { s: "declined" }).catch(() => null);
    return noCharge(422, out.pass ? "signing_failed" : out.reason ?? "no_charge", { checks_evidenced: out.checks_evidenced, checks: (out.verdict.checks as { name: string; result: string }[]).map((c) => ({ name: c.name, result: c.result })) });
  }

  // (4) settle buyer on PASS only. Cache the signed verdict BEFORE settle, keyed by buyer+nonce (claim key), so a
  // settle_unconfirmed can be redeemed with exactly this verdict. Cache write fails -> no settle (fail closed).
  const signedVerdict = { ...out.verdict, sig };
  const cached = await store.set(ddKeys.verdict(held.key), JSON.stringify({ rq, from: d.from!.toLowerCase(), verdict: signedVerdict, reservation: out.reservation, validBefore: Number(d.validBefore) }), Math.ceil(CLAIM_TTL_MS.unconfirmed / 1000)).then(() => true, () => false);
  if (!cached) {
    await moveClaim(store, held, { s: "declined" }).catch(() => null);
    if (out.reservation) await recordLoss(store, out.reservation, "verdict_cache_unavailable", clockFn()).catch(() => undefined);
    return noCharge(503, "store_unavailable");
  }
  const s = await settlePayment(d, DD_TIER);
  if (!s.ok) {
    // Odin #6/B1: settle_unconfirmed, never re-settle, never ask for a new authorization; timeouts/ambiguous count toward
    // the 3/day kill switch (B2: a failed counter write closes the route). Loss is written only once the buyer nonce is
    // confirmed unused after validBefore (redeem or cron), never here.
    const f = await recordSettleFailure(store, clockFn());
    if (f.write_failed) alertHigh("seller_dd_settle_counter_write_failed");
    if (f.count >= SETTLE_FAIL_LIMIT) alertHigh("seller_dd_route_closed_settle_failures", { count: f.count });
    const rc = newReconcileId();
    await moveClaim(store, held, { s: "unconfirmed", rc }).catch(() => null);
    await store.zadd(ddKeys.unconfirmed(), Number(d.validBefore), held.key, Math.ceil(CLAIM_TTL_MS.unconfirmed / 1000)).catch(() => undefined);
    return NextResponse.json(
      { status: "settle_unconfirmed", charged: "unknown", reason: `buyer_settle_${s.kind}`, reconcile_id: rc, redeem_message: redeemMessage(rc, rq, d.to!, d.value!), redeem_header: PAYER_PROOF_HEADER,
        message: "Your payment's settlement could not be confirmed. Do not sign a new payment. Resend this exact request with the same payment header plus the redeem header (personal_sign of redeem_message by the paying wallet): if the payment landed on-chain the signed verdict is delivered; if it did not land it is closed as not charged.", notice: DD_NOTICE },
      { status: s.kind === "timeout" ? 504 : 502, headers: CORS },
    );
  }
  markNonceSettled(d.from!, d.nonce!);
  await refundDeclineSlot(store, d.from!, clockFn());
  await moveClaim(store, held, { s: "settled" }).catch(() => null);
  return NextResponse.json({ status: "delivered", charged: true, tx: s.tx, ...signedVerdict }, { status: 200, headers: { ...CORS, "PAYMENT-RESPONSE": s.header } });
}

let buyerNonceOverride: ((from: string, nonce: string) => Promise<NonceState>) | null = null;
export function setSellerDdBuyerNonceForTests(f: typeof buyerNonceOverride) { buyerNonceOverride = f; }
export async function buyerNonceState(from: string, nonce: string): Promise<NonceState> {
  if (buyerNonceOverride) return buyerNonceOverride(from, nonce);
  return (await testPayLanded(from, nonce, Date.now() + 10_000)).state;
}

/** Close an unconfirmed claim as not charged (nonce unused after validBefore): loss written exactly once (setNx). */
async function closeNotCharged(store: PremiumStore, ck: string, cached: { reservation?: Reservation | null } | null) {
  if (await store.setNx(`dd:closed:${ck}`, "1", CLAIM_TTL_MS.unconfirmed).catch(() => false)) {
    if (cached?.reservation) await recordLoss(store, cached.reservation, "buyer_settle_not_landed", clockFn()).catch(() => undefined);
  }
  await store.zrem(ddKeys.unconfirmed(), ck).catch(() => undefined);
}

async function redeemFlow(req: NextRequest, store: PremiumStore, d: NonNullable<ReturnType<typeof decodePayment>>, rq: string): Promise<NextResponse> {
  const ck = claimKey(d.from!, d.nonce!);
  const raw = await store.get(ck).catch(() => null);
  const c = parseClaim(raw);
  if (!c || c.s !== "unconfirmed" || !c.rc) return noCharge(409, "nothing_to_redeem");
    const vraw = await store.get(ddKeys.verdict(ck)).catch(() => null);
  const v = vraw ? (JSON.parse(vraw) as { rq: string; from: string; verdict: Record<string, unknown>; reservation: Reservation | null; validBefore: number }) : null;
  if (!v || v.from !== d.from!.toLowerCase()) return noCharge(409, "nothing_to_redeem");
  if (rq !== c.rq || rq !== v.rq) return noCharge(409, "redeem_request_mismatch");
  if (!(await payerProofValid(d.from!, req.headers.get(PAYER_PROOF_HEADER), redeemMessage(c.rc, rq, d.to!, d.value!)))) return noCharge(401, "invalid_payer_proof");
  const state = await buyerNonceState(d.from!, d.nonce!);
  if (state === "used") {
    // landed: deliver the cached signed verdict; never settle again
    markNonceSettled(d.from!, d.nonce!);
    await store.cas(ck, raw!, JSON.stringify({ ...c, s: "redeemed" }), CLAIM_TTL_MS.redeemed).catch(() => false);
    await store.zrem(ddKeys.unconfirmed(), ck).catch(() => undefined);
    await refundDeclineSlot(store, d.from!, clockFn());
    return NextResponse.json({ status: "delivered", charged: true, redeemed: true, ...v.verdict }, { status: 200, headers: CORS });
  }
  if (state === "unused" && Math.floor(clockFn() / 1000) > v.validBefore) {
    await closeNotCharged(store, ck, v);
    await store.cas(ck, raw!, JSON.stringify({ ...c, s: "declined" }), CLAIM_TTL_MS.declined).catch(() => false);
    return noCharge(410, "payment_did_not_land", { message: "Your payment did not settle on-chain and its authorization has expired. Nothing was charged; the verdict is not delivered." });
  }
  return NextResponse.json({ status: "settle_unconfirmed", charged: "unknown", reason: state === "unused" ? "authorization_still_open" : "nonce_check_unavailable", notice: DD_NOTICE }, { status: 409, headers: { ...CORS, "Retry-After": "60" } });
}

/** Cron (C3 + B1 d): unconfirmed claims past validBefore -> used: left for redeem; unused: closed not charged, loss once. */
export async function reconcileUnconfirmed(store: PremiumStore, nowMs: number, limit = 50) {
  const keys = await store.zrangeByScore(ddKeys.unconfirmed(), Math.floor(nowMs / 1000) - 1, limit);
  let closed = 0, landed = 0, unknown = 0;
  for (const ck of keys) {
    const m = /^claim:(0x[0-9a-f]{40}):(0x[0-9a-f]{64})$/.exec(ck);
    if (!m) { await store.zrem(ddKeys.unconfirmed(), ck).catch(() => undefined); continue; }
    const st = await buyerNonceState(m[1]!, m[2]!);
    const vraw = await store.get(ddKeys.verdict(ck)).catch(() => null);
    if (st === "unused") { await closeNotCharged(store, ck, vraw ? JSON.parse(vraw) : null); closed++; }
    else if (st === "used") { await store.zrem(ddKeys.unconfirmed(), ck).catch(() => undefined); landed++; }
    else unknown++;
  }
  return { checked: keys.length, closed_not_charged: closed, landed, unknown };
}
