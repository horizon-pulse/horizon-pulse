/**
 * Premium request handler (R1 /api/research/report/{tier}, R2 /api/seller-watch/{tier}).
 * Refusals that need no payment run first (all uncharged, no 402):
 *   flag off -> 404 · tier query / unknown tier / bare -> 400 · non-GET -> 405 · bad q/target -> 400 ·
 *   no PARALLEL_API_KEY (R1) -> 503 · tier not live -> 503 · $10 projection > 50 s -> 503 · no payment -> Base-only 402
 * Paid request, in order (nothing below a failing step runs):
 *   decode -> Base USDC exact -> price/payTo binding -> local validAfter/validBefore (Sentinel LOW-1) ->
 *   local EIP-3009 signature (Sentinel MEDIUM-1: before ANY 409 / alert / write) -> CDP keys + store present ->
 *   [async: open-job limits, 429] -> shared atomic claim SET NX (Sentinel ITEM-5 / Odin C2):
 *       held inflight/job -> 503 payment_in_progress (no alert) · settled/conflict/redeemed -> 409 (no alert, no write)
 *       unconfirmed -> payer-proof redeem from the same request fingerprint (Sentinel item 4), else 409
 *   -> on-chain authorizationState (used -> 409 + ONE reconcile + HIGH, claim -> conflict) -> verify (8 s client)
 *   SYNC (Sentinel item 3): settle BEFORE Parallel. Settle may start only if t0 + elapsed + settle reserve +
 *        projected work fits in 55 s (Odin C1: clock anchored at request start); else release, uncharged 503.
 *        settle ok -> work -> 200 · work fails after settle -> 502 charged:true + reconcile + HIGH (redeemable)
 *        settle timeout -> 504 / ambiguous -> 502, settle_unconfirmed + reconcile + HIGH, never a 402
 *   ASYNC (Odin Q1): verify at accept -> 202 + status link + job token; settle after the first deliverable (jobs.ts).
 */
import { persistAlert } from "@/lib/alert-persist";
import { CLAIM_TTL_MS } from "./claim";
import { asyncBreakerOpen, settleAtAccept, currentBlock, newJobId, releaseOpen, reserveOpen, settleBlocked, SETTLE_BLOCK_REASON, SETTLE_BLOCK_S } from "./jobs";
import { after, NextRequest, NextResponse } from "next/server";
import { hasCdpCredentials } from "@/lib/config";
import { requestFingerprint } from "@/lib/request-fingerprint";
import { claimKey, parseClaim, tryClaim, moveClaim, newOwner, releaseClaim, type Claim, type Held } from "./claim";
import { legalBlock, R1_DESCRIPTION, R2_DESCRIPTION } from "./copy";
import { createJob, runJob, settleLanded } from "./jobs";
import {
  ASYNC_MIN_REMAINING_S,
  challenge,
  decodePayment,
  isBaseUsdcExact,
  jsonError,
  markNonceSettled,
  nonceUsed,
  PAYER_PROOF_HEADER,
  isSmartWalletSignature,
  SMART_WALLET_MESSAGE,
  SMART_WALLET_REASON,
  payerProofValid,
  paymentHeader,
  priceBindingError,
  redeemMessage,
  settlePayment,
  signatureValid,
  SYNC_MIN_REMAINING_S,
  verifyPayment,
  windowError,
  type Decoded,
} from "./payment";
import { ParallelError, parallelKeyPresent } from "./parallel";
import { captureAllowed, captureBody } from "./capture";
import { questionRefusal } from "./synthesis";
import type { CaptureSink } from "./research";
import { newReconcileId, recordReconcile, type ReconcileOutcome } from "./reconcile";
import { runResearch } from "./research";
import { premiumStore, type PremiumStore } from "./store";
import { asyncTierLive, premiumAsyncEnabled, premiumEnabled, projectedSeconds, ROUTE_BASE, SETTLE_RESERVE_S, tierFor, WORK_BUDGET_S, type PremiumRoute, type Tier } from "./tiers";

export const Q_MAX_CHARS = 500;
/** Odin C1: whole sync request must finish inside maxDuration 60 s. */
export const SYNC_HARD_LIMIT_S = 55;
const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });

let clock: () => number = () => Date.now();
/** Tests only. */
export function setPremiumClockForTests(f: (() => number) | null) {
  clock = f ?? (() => Date.now());
}

export function bareRouteResponse(route: PremiumRoute): NextResponse {
  if (!premiumEnabled()) return notFound();
  return jsonError(400, { error: "tier_required", message: `Use a tier path: ${ROUTE_BASE[route]}/{tier}. There is no ?tier= parameter.` });
}

function description(x: Tier) {
  return `${x.route === "research" ? R1_DESCRIPTION : R2_DESCRIPTION} Tier ${x.id} ${x.priceUsd}.${x.route === "research" ? " Do not include personal data (private names, contact details, health or account information) in q." : ""}`;
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

const routePath = (x: Tier) => `${ROUTE_BASE[x.route]}/${x.id}`;

function reconcile(outcome: ReconcileOutcome, x: Tier, d: Decoded, rq: string, tx: string | null) {
  return recordReconcile({ reconcile_id: newReconcileId(), route: routePath(x), tier: x.id, payer: d.from, nonce: d.nonce, amount: d.value, payTo: d.to, tx, fingerprint: rq, outcome });
}

const conflictBody = (rc: string | null) => ({
  status: "authorization_already_used",
  error: "authorization_already_used",
  ...(rc ? { reconcile_id: rc } : {}),
  message: "This payment authorization was already used. Nothing is delivered against it. If you were charged and not delivered, contact us with the reconcile_id.",
  ...legalBlock(),
});
const unconfirmedBody = (rc: string, charged?: boolean, redeem?: string) => ({
  status: "settle_unconfirmed",
  reconcile_id: rc,
  ...(redeem ? { redeem_message: redeem, redeem_header: PAYER_PROOF_HEADER } : {}),
  ...(charged ? { charged: true } : {}),
  message:
    "Payment settlement could not be confirmed (or the result could not be produced after payment). Do not sign a new payment for this request. You can retry this exact request with the same payment plus a payer proof (see /premium-terms), or contact us with the reconcile_id for a refund.",
  ...legalBlock(),
});
/** Settle confirmed, result not produced: status says so (not settle_unconfirmed); same redeem fields + refund path. */
const deliveryFailedBody = (rc: string, tx: string | null, why: string, redeem: string) => ({
  status: "charged_not_delivered",
  error: "result_not_produced",
  reason: why,
  settled: true,
  tx,
  reconcile_id: rc,
  redeem_message: redeem,
  redeem_header: PAYER_PROOF_HEADER,
  charged: true,
  message:
    "Your payment settled, but the result could not be produced. Do not sign a new payment for this request. You can retry this exact request with the same payment plus a payer proof (see /premium-terms) at no extra charge, or contact us with the reconcile_id for a refund.",
  ...legalBlock(),
});
/** Non-secret failure code only: ParallelError messages are fixed codes; anything else becomes its class name. */
export function researchFailureCode(e: unknown): string {
  if (e instanceof ParallelError && /^[a-z0-9_]{1,40}$/.test(e.message)) return e.message;
  return e instanceof Error ? (/^[A-Za-z]{1,40}$/.test(e.name) ? e.name : "error") : "error";
}
/** Payer-proof header present + sync tier + the stored claim for this (from, nonce) is in the redeemable state. Fail-closed. */
async function redeemableWithProof(req: NextRequest, x: Tier, d: Decoded): Promise<boolean> {
  if (x.mode !== "sync" || !req.headers.get(PAYER_PROOF_HEADER) || !d.from || !d.nonce) return false;
  const store = premiumStore();
  if (!store) return false;
  const c = parseClaim(await store.get(claimKey(d.from, d.nonce)).catch(() => null));
  return c?.s === "unconfirmed" && typeof c.rc === "string" && c.rc.length > 0;
}
const inProgress = () => jsonError(503, { error: "payment_in_progress", charged: false, message: "This payment authorization is already being processed." }, { "Retry-After": "5" });

function okResponse(x: Tier, result: unknown, tx: string | null, header: string | null) {
  return NextResponse.json(
    { ...(result as object), paid: { tier: x.id, amount: x.amount, network: "eip155:8453", tx }, ...legalBlock() },
    { status: 200, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "PAYMENT-RESPONSE", "Cache-Control": "no-store", ...(header ? { "PAYMENT-RESPONSE": header } : {}) } },
  );
}

/** Sentinel item 4: one redeem of a settle_unconfirmed claim, same fingerprint, payer proof, settle confirmed on-chain. */
async function redeem(store: PremiumStore, req: NextRequest, x: Tier, d: Decoded, input: string, rq: string, raw: string, c: Claim, t0: number): Promise<NextResponse> {
  // Sentinel LOW-B: a mismatched redeem (other request, or missing / wrong payer proof) -> 409 WITHOUT the reconcile_id,
  // plus one deduped reconcile line + HIGH alert per claim (first mismatch only).
  const mismatch = async (why: string, error = "authorization_already_used") => {
    const key = `redeem-mismatch:${claimKey(d.from!, d.nonce!)}`;
    if (await store.setNx(key, why, CLAIM_TTL_MS.unconfirmed).catch(() => false)) reconcile("redeem_mismatch", x, d, rq, null);
    return jsonError(409, { ...conflictBody(null), error, message: `This payment authorization has an unconfirmed settle. To redeem it, retry the exact original request with ${PAYER_PROOF_HEADER}: an EIP-191 signature by the paying address over the redeem_message from the original response.` });
  };
  if (c.rq !== rq || !c.rc) return mismatch("fingerprint");
  const proof = req.headers.get(PAYER_PROOF_HEADER);
  if (!(await payerProofValid(d.from!, proof, redeemMessage(c.rc, rq, d.to!, d.value!)))) return mismatch(proof ? "bad_proof" : "no_proof", "payer_proof_required");
  const held: Held = { key: claimKey(d.from!, d.nonce!), raw, claim: c };
  const landed = c.job === "settled" ? "landed" : await settleLanded({ payer: d.from!, nonce: d.nonce!, block_at_accept: c.blk ?? null } as never);
  if (landed !== "landed") return jsonError(503, { error: "settle_not_confirmed_yet", reconcile_id: c.rc, charged: "unknown" }, { "Retry-After": "30" });
  const mine = await moveClaim(store, held, { s: "redeemed" });
  if (!mine) return inProgress();
  try {
    const result = await runResearch(x, input, t0 + SYNC_HARD_LIMIT_S * 1000, undefined, held.key);
    return okResponse(x, { ...(result as object), redeemed: { reconcile_id: c.rc } }, null, null);
  } catch {
    // Sentinel LOW-A: rotate the reconcile_id (new redeem_message) so the used proof cannot be replayed
    const line = reconcile("charged_not_delivered", x, d, rq, null);
    await moveClaim(store, mine, { s: "unconfirmed", rc: line.reconcile_id, job: "settled" }).catch(() => null);
    return jsonError(502, unconfirmedBody(line.reconcile_id, true, redeemMessage(line.reconcile_id, rq, d.to!, d.value!)));
  }
}

export async function premiumHandler(req: NextRequest, route: PremiumRoute, seg: string | undefined): Promise<NextResponse> {
  const t0 = clock();
  if (!premiumEnabled()) return notFound();
  const url = new URL(req.url);
  if (url.searchParams.has("tier")) return jsonError(400, { error: "tier_query_not_supported", message: "Tier is a path segment only; remove ?tier=." });
  const x = tierFor(route, seg);
  if (!x) return jsonError(400, { error: "unknown_tier", message: `Unknown tier. Use ${ROUTE_BASE[route]}/{tier}.` });
  if (req.method !== "GET") return jsonError(405, { error: "method_not_allowed" }, { Allow: "GET, OPTIONS" });
  const v = validateInput(route, url);
  if (!v.ok) return v.res;

  if (x.route === "research") {
    const refused = questionRefusal(v.input);
    if (refused)
      return jsonError(400, { error: "question_not_supported", reason: refused, charged: false, message: "We do not compile information about private individuals or health data. Nothing was charged. Do not include personal data in questions." });
  }
  if (x.route === "research" && !parallelKeyPresent()) return jsonError(503, { error: "premium_provider_unavailable", charged: false });
  if (x.mode === "async" && !(premiumAsyncEnabled() && asyncTierLive(x))) return jsonError(503, { error: "tier_not_available", charged: false, message: "This tier is not live yet." });
  if (x.id === "extended" && projectedSeconds(x, v.input) > WORK_BUDGET_S)
    return jsonError(503, { error: "time_budget_exceeded", charged: false, message: "This question projects past the extended tier's time budget. Split it into fewer sub-questions." });

  const header = paymentHeader(req);
  if (!header) return challenge(x, description(x));

  const d = decodePayment(header);
  if (!d) return challenge(x, description(x), "invalid_payment");
  if (!isBaseUsdcExact(d)) return challenge(x, description(x), "rail_unavailable");
  const bind = priceBindingError(d, x);
  if (bind) return challenge(x, description(x), bind);
  const win = windowError(d, Math.floor(clock() / 1000), x.mode === "async" ? ASYNC_MIN_REMAINING_S : SYNC_MIN_REMAINING_S);
  // Odin 10/19: a redeem of an unconfirmed / charged_not_delivered claim happens after the original authorization's window
  // has (nearly) run out. With a payer proof and a redeemable stored claim, skip the window check: redeem() itself checks
  // the fingerprint, the proof and the on-chain landing, and never settles again. Every other case keeps the check.
  if (win && !(await redeemableWithProof(req, x, d))) return challenge(x, description(x), win);
  if (isSmartWalletSignature(d)) return challenge(x, description(x), SMART_WALLET_REASON, 402, SMART_WALLET_MESSAGE);
  if (!(await signatureValid(d))) return challenge(x, description(x), "invalid_signature");
  if (!hasCdpCredentials()) return jsonError(503, { error: "settlement_unavailable", charged: false });
  const store = premiumStore();
  if (!store) return jsonError(503, { error: "store_unavailable", charged: false });

  let jobId: string | null = null;
  let settleFirst = false;
  let accepted = false;
  try {
    const rq = await requestFingerprint(req);
    if (x.mode === "async") {
      if (await settleBlocked(store, d.from!))
        return jsonError(429, { error: SETTLE_BLOCK_REASON, charged: false, message: "Two payments from this address failed to settle in the last 24 hours. New report and watch jobs from it are paused for 24 hours; nothing was charged for this request. Retry after the Retry-After time, or use the $1, $5 or $10 tiers. See /premium-terms. If an earlier payment was charged but not delivered, see the refund terms at /premium-terms." }, { "Retry-After": String(SETTLE_BLOCK_S) });
      // Odin ruling on e2caa71: breaker tripped -> no 503; settle right after verify, before the work, + HIGH alert
      settleFirst = await asyncBreakerOpen(store);
      jobId = newJobId();
      if (!(await reserveOpen(store, d.from!, jobId))) {
        jobId = null;
        return jsonError(429, { error: "too_many_open_jobs", charged: false }, { "Retry-After": "300" });
      }
    }
    const claim: Claim = { s: x.mode === "async" ? "job" : "inflight", o: newOwner(), rq, at: clock(), tier: x.id };
    const got = await tryClaim(store, d.from!, d.nonce!, claim);
    if (!got.ok) {
      const c = got.existing;
      if (!c || c.s === "inflight" || c.s === "job") return inProgress();
      if (c.s === "unconfirmed" && x.mode === "sync") return redeem(store, req, x, d, v.input, rq, got.raw!, c, t0);
      if (c.s === "unconfirmed") return jsonError(409, conflictBody(null)); // LOW-B: never echo the reconcile_id
      return jsonError(409, conflictBody(c.rc ?? null));
    }
    let held = got.held;

    const used = await nonceUsed(d.from!, d.nonce!);
    if (used === "used") {
      const line = reconcile("authorization_already_used", x, d, rq, null);
      await moveClaim(store, held, { s: "conflict", rc: line.reconcile_id }).catch(() => null);
      return jsonError(409, conflictBody(line.reconcile_id));
    }
    if (used === "unknown") {
      await releaseClaim(store, held);
      return jsonError(503, { error: "nonce_check_unavailable", charged: false }, { "Retry-After": "2" });
    }

    const ver = await verifyPayment(d, x);
    if (!ver.ok) {
      await releaseClaim(store, held);
      return ver.kind === "invalid" ? challenge(x, description(x), ver.reason, 402, undefined, false) : jsonError(503, { error: "facilitator_unavailable", charged: false }, { "Retry-After": "1" });
    }

    if (x.mode === "async") {
      const blk = await currentBlock();
      if (blk === null) {
        // Sentinel LOW-D: no recorded block -> settle resolution could never be bounded; refuse before any settle
        await releaseClaim(store, held);
        return jsonError(503, { error: "chain_unavailable", charged: false }, { "Retry-After": "5" });
      }
      const { job, token } = await createJob(store, x, d, rq, v.input, held, jobId!, settleFirst, blk);
      accepted = true;
      if (settleFirst) {
        console.error(`[premium][ALERT][HIGH] ${JSON.stringify({ kind: "premium_async_settle_first", severity: "high", route: routePath(x), tier: x.id, job_id: job.id })}`);
        persistAlert("premium", { kind: "premium_async_settle_first", severity: "high", route: routePath(x), payer: d.from });
        await settleAtAccept(store, job, x);
      }
      after(() => runJob(store, job.id, clock() + (SYNC_HARD_LIMIT_S - 5) * 1000 - (clock() - t0)).then(() => undefined, () => undefined));
      return NextResponse.json(
        { job_id: job.id, status: job.status, ...(job.reconcile_id ? { reconcile_id: job.reconcile_id } : {}), status_url: `/api/premium/job/${job.id}`, job_token: token, charged: job.charged, message: job.settle_first
            ? "Accepted. Poll status_url with header Authorization: Bearer <job_token>. Payments are temporarily settled when verified, before the job runs; if the job then fails, see the refund terms at /premium-terms. The token is shown once."
            : "Accepted. Poll status_url with header Authorization: Bearer <job_token>. You are charged only after the first deliverable is built; the token is shown once.", ...legalBlock() },
        { status: 202, headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" } },
      );
    }

    // Odin C1 + Sentinel item 3: settle before work, only if settle + projected work still fit the hard limit.
    const elapsed = (clock() - t0) / 1000;
    if (elapsed + SETTLE_RESERVE_S + projectedSeconds(x, v.input) > SYNC_HARD_LIMIT_S) {
      await releaseClaim(store, held);
      return jsonError(503, { error: "time_budget_exceeded", charged: false }, { "Retry-After": "5" });
    }
    const blk = await currentBlock(); // Odin P1: bounds the redeem's AuthorizationUsed log search
    if (blk === null) {
      // Sentinel LOW-D: no block number -> a failed settle could never be redeemed; refuse before settle (uncharged)
      await releaseClaim(store, held);
      return jsonError(503, { error: "chain_unavailable", charged: false }, { "Retry-After": "5" });
    }
    const s = await settlePayment(d, x);
    if (!s.ok) {
      const line = reconcile(s.kind === "timeout" ? "settle_timeout" : "settle_ambiguous", x, d, rq, s.tx);
      await moveClaim(store, held, { s: "unconfirmed", rc: line.reconcile_id, blk }).catch(() => null);
      return jsonError(s.kind === "timeout" ? 504 : 502, unconfirmedBody(line.reconcile_id, false, redeemMessage(line.reconcile_id, rq, d.to!, d.value!)));
    }
    markNonceSettled(d.from!, d.nonce!);
    held = (await moveClaim(store, held, { s: "settled" }).catch(() => null)) ?? held;
    try {
      const sink: CaptureSink = {};
      const result = await runResearch(x, v.input, t0 + SYNC_HARD_LIMIT_S * 1000, sink, held.key);
      const cap = captureAllowed(req.headers) ? captureBody(sink) : null;
      return okResponse(x, cap ? { ...(result as object), debug_capture: cap } : result, s.tx, s.header);
    } catch (e) {
      // The settle SUCCEEDED; the work after it failed. Say so (settled + tx + PAYMENT-RESPONSE) instead of reading as an
      // unconfirmed settle, and log a non-secret failure code (ParallelError codes like upstream_401 / not_configured).
      const why = researchFailureCode(e);
      console.error(`[premium] research failed after confirmed settle: ${why} (tier ${x.id})`);
      const line = reconcile("charged_not_delivered", x, d, rq, s.tx);
      // settled for certain: mark redeemable (job:"settled" tells redeem the settle is confirmed)
      await moveClaim(store, held, { s: "unconfirmed", rc: line.reconcile_id, job: "settled" }).catch(() => null);
      return jsonError(
        502,
        { ...deliveryFailedBody(line.reconcile_id, s.tx, why, redeemMessage(line.reconcile_id, rq, d.to!, d.value!)) },
        { "PAYMENT-RESPONSE": s.header, "Access-Control-Expose-Headers": "PAYMENT-RESPONSE" },
      );
    }
  } catch {
    return jsonError(503, { error: "store_unavailable", charged: false }, { "Retry-After": "2" });
  } finally {
    if (jobId && !accepted) await releaseOpen(store, d.from!, jobId).catch(() => undefined);
  }
}

export function premiumOptions(route: PremiumRoute, seg: string | undefined): NextResponse {
  if (!premiumEnabled()) return notFound();
  const x = tierFor(route, seg);
  if (!x) return jsonError(400, { error: "unknown_tier" });
  if (x.mode === "async" && !(premiumAsyncEnabled() && asyncTierLive(x))) return jsonError(503, { error: "tier_not_available", charged: false });
  const res = challenge(x, description(x), undefined, 200);
  res.headers.set("Allow", "GET, OPTIONS");
  return res;
}

export { SETTLE_RESERVE_S };
