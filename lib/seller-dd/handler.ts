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
import { moveClaim, newOwner, releaseClaim, tryClaim } from "@/lib/premium/claim";
import { BUYER_TERMS_URL } from "@/lib/premium/copy";
import {
  decodePayment, isBaseUsdcExact, isSmartWalletSignature, markNonceSettled, nonceUsed, paymentHeader, priceBindingError,
  settlePayment, signatureValid, SYNC_MIN_REMAINING_S, verifyPayment, windowError,
} from "@/lib/premium/payment";
import { premiumStore, type PremiumStore } from "@/lib/premium/store";
import { receiptSignerReady, signReceipt } from "@/lib/receipt-signer";
import { requestFingerprint } from "@/lib/request-fingerprint";
import { recordLoss, recordSettleFailure, refundDeclineSlot, routeClosedBySettleFailures, takeDeclineSlot } from "./caps";
import { cdpContinuityDeps, defaultNetDeps } from "./checks";
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

  let rawBody: unknown = null;
  try { rawBody = JSON.parse((await req.text()).slice(0, 8_192)); } catch { rawBody = null; }
  const header = paymentHeader(req);
  const b = parseBody(rawBody);
  if (!b.ok) return header ? noCharge(400, b.reason) : challenge(b.reason, 402);
  if (!header) return challenge();

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

  return await paidFlow(req, store, d, b.v, lists);
}

async function paidFlow(req: NextRequest, store: PremiumStore, d: NonNullable<ReturnType<typeof decodePayment>>, body: DdBody, lists: NonNullable<ReturnType<typeof screenLists>>): Promise<NextResponse> {
  const now = clockFn();
  let rq: string;
  try { rq = await requestFingerprint(req); } catch { rq = randomBytes(8).toString("hex"); }
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

  // (4) settle buyer on PASS only
  const s = await settlePayment(d, DD_TIER);
  if (!s.ok) {
    const n = await recordSettleFailure(store, clockFn()).catch(() => SETTLE_FAIL_LIMIT);
    if (n >= SETTLE_FAIL_LIMIT) alertHigh("seller_dd_route_closed_settle_failures", { count: n });
    await moveClaim(store, held, { s: "declined" }).catch(() => null);
    // Odin C4: our test pay is absorbed under the $5/day cap and recorded in the loss ledger
    if (out.reservation) await recordLoss(store, out.reservation, `buyer_settle_${s.kind}`, clockFn()).catch(() => undefined);
    return noCharge(502, `buyer_settle_${s.kind}`, { message: "The verdict was not delivered because your payment did not settle. If your wallet shows a charge for this request, contact horizonpulse.co@proton.me with the time of the request." });
  }
  markNonceSettled(d.from!, d.nonce!);
  await refundDeclineSlot(store, d.from!, clockFn());
  await moveClaim(store, held, { s: "settled" }).catch(() => null);
  const signed = { ...out.verdict, sig };
  return NextResponse.json({ status: "delivered", charged: true, tx: s.tx, ...signed }, { status: 200, headers: { ...CORS, "PAYMENT-RESPONSE": s.header } });
}
