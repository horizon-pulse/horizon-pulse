/**
 * Premium request handler (both R1 /api/research/report/{tier} and R2 /api/seller-watch/{tier}).
 * Every check that can refuse a request runs BEFORE any 402 is issued or any payment is verified/settled.
 *
 *   flag off                                   -> 404 (every verb, every premium URL, incl. bare paths)
 *   bare path / unknown tier / any `tier` query -> 400, no 402 (N2, T3a.3)
 *   non-GET                                    -> 405
 *   missing/invalid q or target                -> 400
 *   PARALLEL_API_KEY absent (R1)               -> 503 uncharged, no 402
 *   async tier, async flag off                 -> 503 uncharged, no 402
 *   $10 projected > 50 s                       -> 503 uncharged, no 402 (v3.1)
 *   no payment                                 -> Base-only 402 for price(tier)
 *   paid: see lib/premium/payment.ts order; async tier (flag on) -> 503 uncharged after price binding, before
 *         verify (the async job path is a separate Class A and is not built)
 */
import { NextRequest, NextResponse } from "next/server";
import { hasCdpCredentials } from "@/lib/config";
import { legalBlock, R1_DESCRIPTION, R2_DESCRIPTION } from "./copy";
import {
  challenge,
  decodePayment,
  isBaseUsdcExact,
  jsonError,
  markNonceSettled,
  nonceUsed,
  paymentHeader,
  priceBindingError,
  settlePayment,
  verifyPayment,
  type Decoded,
} from "./payment";
import { parallelKeyPresent, ParallelError } from "./parallel";
import { newReconcileId, recordReconcile, requestFingerprint, type ReconcileOutcome } from "./reconcile";
import { runResearch } from "./research";
import { premiumAsyncEnabled, premiumEnabled, projectedSeconds, ROUTE_BASE, SETTLE_RESERVE_S, tierFor, WORK_BUDGET_S, type PremiumRoute, type Tier } from "./tiers";

export const Q_MAX_CHARS = 500;
const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });

export function bareRouteResponse(route: PremiumRoute): NextResponse {
  if (!premiumEnabled()) return notFound();
  return jsonError(400, {
    error: "tier_required",
    message: `Use a tier path: ${ROUTE_BASE[route]}/{tier}. There is no ?tier= parameter.`,
  });
}

function description(x: Tier) {
  return `${x.route === "research" ? R1_DESCRIPTION : R2_DESCRIPTION} Tier ${x.id} ${x.priceUsd}.`;
}

function validateInput(route: PremiumRoute, url: URL): { ok: true; input: string } | { ok: false; res: NextResponse } {
  if (route === "research") {
    const q = (url.searchParams.get("q") ?? "").trim();
    if (q.length < 3 || q.length > Q_MAX_CHARS) return { ok: false, res: jsonError(400, { error: "invalid_q", message: `q is required, 3-${Q_MAX_CHARS} characters.` }) };
    return { ok: true, input: q };
  }
  const target = (url.searchParams.get("target") ?? "").trim();
  let ok = false;
  try {
    const u = new URL(target);
    ok = u.protocol === "https:" && target.length <= 2048 && !u.username && !u.password;
  } catch {
    ok = false;
  }
  if (!ok) return { ok: false, res: jsonError(400, { error: "invalid_target", message: "target must be an https x402 URL." }) };
  return { ok: true, input: target };
}

function reconcileResponse(status: 409 | 502 | 504, outcome: ReconcileOutcome, x: Tier, req: NextRequest, d: Decoded, tx: string | null): NextResponse {
  const line = recordReconcile({
    reconcile_id: newReconcileId(),
    route: `${ROUTE_BASE[x.route]}/${x.id}`,
    tier: x.id,
    payer: d.from,
    nonce: d.nonce,
    amount: d.value,
    payTo: d.to,
    tx,
    fingerprint: requestFingerprint(req.method, new URL(req.url)),
    outcome,
  });
  const body =
    status === 409
      ? { status: "authorization_already_used", error: "authorization_already_used", reconcile_id: line.reconcile_id, message: "This payment authorization was already used. Nothing is delivered against it. If you were charged and not delivered, contact us with the reconcile_id.", ...legalBlock() }
      : { status: "settle_unconfirmed", reconcile_id: line.reconcile_id, message: "Payment settlement could not be confirmed. Do not retry with the same authorization. If you were charged, contact us with the reconcile_id for a refund.", ...legalBlock() };
  return jsonError(status, body);
}

export async function premiumHandler(req: NextRequest, route: PremiumRoute, seg: string | undefined): Promise<NextResponse> {
  if (!premiumEnabled()) return notFound();
  const url = new URL(req.url);
  if (url.searchParams.has("tier")) return jsonError(400, { error: "tier_query_not_supported", message: "Tier is a path segment only; remove ?tier=." });
  const x = tierFor(route, seg);
  if (!x) return jsonError(400, { error: "unknown_tier", message: `Unknown tier. Use ${ROUTE_BASE[route]}/{tier}.` });
  if (req.method !== "GET") return jsonError(405, { error: "method_not_allowed" }, { Allow: "GET, OPTIONS" });
  const v = validateInput(route, url);
  if (!v.ok) return v.res;

  // Refusals that must happen before any 402 / verify / settle (uncharged).
  if (x.route === "research" && !parallelKeyPresent()) return jsonError(503, { error: "premium_provider_unavailable", charged: false });
  if (x.mode === "async" && !premiumAsyncEnabled()) return jsonError(503, { error: "tier_not_available", charged: false, message: "This tier needs the async job path, which is not live yet." });
  if (x.id === "extended" && projectedSeconds(x, v.input) > WORK_BUDGET_S)
    return jsonError(503, { error: "time_budget_exceeded", charged: false, message: "This question projects past the extended tier's time budget. Split it into fewer sub-questions." });

  const header = paymentHeader(req);
  if (!header) return challenge(x, description(x));

  const d = decodePayment(header);
  if (!d) return challenge(x, description(x), "invalid_payment");
  if (!isBaseUsdcExact(d)) return challenge(x, description(x), "rail_unavailable");
  const bind = priceBindingError(d, x);
  if (bind) return challenge(x, description(x), bind);
  if (x.mode === "async") return jsonError(503, { error: "tier_not_available", charged: false, message: "Async job path not live; nothing was verified or settled." });
  if (!hasCdpCredentials()) return jsonError(503, { error: "settlement_unavailable", charged: false });

  const used = await nonceUsed(d.from!, d.nonce!);
  if (used === "used") return reconcileResponse(409, "authorization_already_used", x, req, d, null);
  if (used === "unknown") return jsonError(503, { error: "nonce_check_unavailable", charged: false }, { "Retry-After": "2" });

  const ver = await verifyPayment(d, x);
  if (!ver.ok) return ver.kind === "invalid" ? challenge(x, description(x), ver.reason) : jsonError(503, { error: "facilitator_unavailable", charged: false }, { "Retry-After": "1" });

  // Work first, charge only on success (charged only on 200).
  const deadline = Date.now() + (WORK_BUDGET_S - 2) * 1000;
  let result: unknown;
  try {
    result = await runResearch(x, v.input, deadline);
  } catch (e) {
    return jsonError(502, { error: e instanceof ParallelError ? "upstream_error" : "internal_error", charged: false });
  }

  const s = await settlePayment(d, x);
  if (!s.ok) return reconcileResponse(s.kind === "timeout" ? 504 : 502, s.kind === "timeout" ? "settle_timeout" : "settle_ambiguous", x, req, d, s.tx);
  markNonceSettled(d.from!, d.nonce!);
  return NextResponse.json(
    { ...(result as object), paid: { tier: x.id, amount: x.amount, network: "eip155:8453", tx: s.tx }, ...legalBlock() },
    { status: 200, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "PAYMENT-RESPONSE", "Cache-Control": "no-store", "PAYMENT-RESPONSE": s.header } },
  );
}

export function premiumOptions(route: PremiumRoute, seg: string | undefined): NextResponse {
  if (!premiumEnabled()) return notFound();
  const x = tierFor(route, seg);
  if (!x) return jsonError(400, { error: "unknown_tier" });
  if (x.mode === "async" && !premiumAsyncEnabled()) return jsonError(503, { error: "tier_not_available", charged: false });
  const res = challenge(x, description(x), undefined, 200);
  res.headers.set("Allow", "GET, OPTIONS");
  return res;
}

export { SETTLE_RESERVE_S };
