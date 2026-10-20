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
import { legalBlock, BRIEF_DESCRIPTION, BRIEF_CLAIMS_PER_TYPE, R1_DESCRIPTION, R2_DESCRIPTION } from "./copy";
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
import { briefPassTier, runResearch } from "./research";
import { classifyQuestion, BRIEF_TYPE_VALUES, BRIEF_EXAMPLES, withTypePrefix } from "./source-index";
import { CONTRACT_URL } from "./contract";
import { premiumStore, type PremiumStore } from "./store";
import { asyncTierLive, routeHasAllowedTier, tierAllowed, premiumAsyncEnabled, premiumEnabled, projectedSeconds, ROUTE_BASE, SETTLE_RESERVE_S, tierFor, WORK_BUDGET_S, type PremiumRoute, type Tier } from "./tiers";

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
  if (!premiumEnabled() || !routeHasAllowedTier(route)) return notFound();
  return jsonError(400, { error: "tier_required", message: `Use a tier path: ${ROUTE_BASE[route]}/{tier}. There is no ?tier= parameter.` });
}

function description(x: Tier) {
  if (x.id === "brief") return `${BRIEF_DESCRIPTION} ${BRIEF_CLAIMS_PER_TYPE} No personal data in q.`;
  return `${x.route === "research" ? R1_DESCRIPTION : R2_DESCRIPTION} Tier ${x.id} ${x.priceUsd}.${x.route === "research" ? " Do not include personal data (private names, contact details, health or account information) in q." : ""}`;
}

function validateInput(route: PremiumRoute, url: URL): { ok: true; input: string } | { ok: false; res: NextResponse } {
  if (route === "research") {
    const q = (url.searchParams.get("q") ?? "").trim();
    if (q.length < 3 || q.length > Q_MAX_CHARS) return { ok: false, res: jsonError(400, { error: "invalid_q", message: `q is required, 3-${Q_MAX_CHARS} characters.` }) };
    // Round 7: optional type= bypasses phrase classification; bound into the paid input so it is part of what is signed.
    const type = url.searchParams.get("type");
    if (type !== null && !BRIEF_TYPE_VALUES.includes(type))
      return { ok: false, res: jsonError(400, { error: "invalid_type", charged: false, message: `type must be one of ${BRIEF_TYPE_VALUES.join(", ")}. Nothing was charged.` }) };
    return { ok: true, input: withTypePrefix(q, type) };
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
    // Sentinel M4 / Odin ruling (4): a brief redeem serves ONLY the cached passing brief stored for this payment at pass
    // time (bound to claim key + fingerprint + payer). Never re-run research or the model; never a non-passing brief.
    if (x.id === "brief") {
      const cached = await loadPassedBrief(store, held.key, rq, d.from!);
      if (!cached) throw new Error("no_cached_brief");
      return okResponse(x, { ...cached, redeemed: { reconcile_id: c.rc } }, null, null);
    }
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
  if (!premiumEnabled() || !routeHasAllowedTier(route)) return notFound();
  { const y = tierFor(route, seg); if (y && !tierAllowed(y)) return notFound(); }
  const url = new URL(req.url);
  if (url.searchParams.has("tier")) return jsonError(400, { error: "tier_query_not_supported", message: "Tier is a path segment only; remove ?tier=." });
  const x0 = tierFor(route, seg);
  const x = x0 && tierAllowed(x0) ? x0 : null;
  if (x0 && !x) return notFound();
  if (!x) return jsonError(400, { error: "unknown_tier", message: `Unknown tier. Use ${ROUTE_BASE[route]}/{tier}.` });
  if (req.method !== "GET") return jsonError(405, { error: "method_not_allowed" }, { Allow: "GET, OPTIONS" });
  // Odin 10:16 (bare-GET fix): an unpaid GET with no q returns the brief's unpaid 402 + Bazaar block, so the catalog URL
  // probes like every other route. Nothing is classified, verified or settled. A PAID call without a valid q still falls
  // through to validateInput below: 400 before verify, never settled.
  if (x.id === "brief" && !url.searchParams.has("q") && !paymentHeader(req)) return challenge(x, description(x));
  const v = validateInput(route, url);
  if (!v.ok) return v.res;

  if (x.route === "research") {
    const refused = questionRefusal(v.input);
    if (refused)
      return jsonError(400, { error: "question_not_supported", reason: refused, charged: false, message: "We do not compile information about private individuals or health data. Nothing was charged. Do not include personal data in questions." });
    // Odin ruling (c): the verified brief accepts only question types the curated source index can confirm; refused
    // before any 402 / payment step, so nothing is authorised or charged.
    if (x.id === "brief") {
      const c = classifyQuestion(v.input);
      if (!c.ok) return jsonError(422, { error: "question_type_not_supported", reason: c.reason, charged: false, message: c.message, examples: BRIEF_EXAMPLES, contract: CONTRACT_URL });
      // Sentinel M2 / Odin ruling (2): global daily cap on unsettled (pre-settle) Parallel + LLM spend, all payers.
      // Checked BEFORE any 402, so nobody signs an authorization we cannot serve. Fails closed.
      if (!(await unsettledBudgetOpen(premiumStore())) && (await capTripped(premiumStore(), "pre_402"), true))
        return jsonError(503, { error: "daily_research_budget_exhausted", reason: "global_unsettled_cap", charged: false, message: "Verified briefs are paused until the next UTC day. Do not sign a payment. Nothing was charged for this request." }, { "Retry-After": "3600" });
    }
  }
  if (x.route === "research" && !parallelKeyPresent()) return jsonError(503, { error: "premium_provider_unavailable", charged: false, message: "Nothing was charged for this request." });
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
  if (!hasCdpCredentials()) return jsonError(503, { error: "settlement_unavailable", charged: false, message: "Nothing was charged for this request." });
  const store = premiumStore();
  if (!store) return jsonError(503, { error: "store_unavailable", charged: false, message: "Nothing was charged for this request." });

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
      if (c.s === "declined") return jsonError(409, { error: "brief_declined", charged: false, message: "This payment authorization was already used for a brief that did not pass verification; it was never settled. Sign a new payment to ask again." });
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
      return jsonError(503, { error: "nonce_check_unavailable", charged: false, message: "Nothing was charged for this request." }, { "Retry-After": "2" });
    }

    const ver = await verifyPayment(d, x);
    if (!ver.ok) {
      await releaseClaim(store, held);
      return ver.kind === "invalid" ? challenge(x, description(x), ver.reason, 402, undefined, false) : jsonError(503, { error: "facilitator_unavailable", charged: false, message: "Nothing was charged for this request." }, { "Retry-After": "1" });
    }

    if (x.mode === "async") {
      const blk = await currentBlock();
      if (blk === null) {
        // Sentinel LOW-D: no recorded block -> settle resolution could never be bounded; refuse before any settle
        await releaseClaim(store, held);
        return jsonError(503, { error: "chain_unavailable", charged: false, message: "Nothing was charged for this request." }, { "Retry-After": "5" });
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

    // Hardened $1 brief (Michael 10/19): CHARGE ONLY ON PASS. Research runs after verify and BEFORE settle; a brief that
    // does not pass briefPassTier() is never settled (the claim moves to "declined", nothing is charged, the signed
    // authorization simply expires). Only a passing brief is settled; settle failures keep the existing unconfirmed/redeem
    // path. A per-payer daily cap on declined briefs bounds unpaid research cost.
    if (x.id === "brief") return await chargeOnPass(store, req, x, d, v.input, rq, held, t0);

    // Odin C1 + Sentinel item 3: settle before work, only if settle + projected work still fit the hard limit.
    const elapsed = (clock() - t0) / 1000;
    if (elapsed + SETTLE_RESERVE_S + projectedSeconds(x, v.input) > SYNC_HARD_LIMIT_S) {
      await releaseClaim(store, held);
      return jsonError(503, { error: "time_budget_exceeded", charged: false, message: "Nothing was charged for this request." }, { "Retry-After": "5" });
    }
    const blk = await currentBlock(); // Odin P1: bounds the redeem's AuthorizationUsed log search
    if (blk === null) {
      // Sentinel LOW-D: no block number -> a failed settle could never be redeemed; refuse before settle (uncharged)
      await releaseClaim(store, held);
      return jsonError(503, { error: "chain_unavailable", charged: false, message: "Nothing was charged for this request." }, { "Retry-After": "5" });
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
    return jsonError(503, { error: "store_unavailable", charged: false, message: "Nothing was charged for this request." }, { "Retry-After": "2" });
  } finally {
    if (jobId && !accepted) await releaseOpen(store, d.from!, jobId).catch(() => undefined);
  }
}

export const BRIEF_DECLINE_CAP = 5;
export const BRIEF_DECLINE_TTL_S = 86_400;
/** Odin ruling (2) 10/20: global cap on UNSETTLED research spend (Parallel + LLM) across all payers, USD per UTC day. */
export const UNSETTLED_DAILY_CAP_USD = 3;
/** Conservative per-brief estimate of Parallel search + extract + one model call (measured ~$0.03 + $0.002). */
export const BRIEF_RUN_COST_USD = 0.05;
const UNSETTLED_TTL_S = 2 * 86_400;
export const unsettledKey = (now: number) => `brief:unsettled:${new Date(now).toISOString().slice(0, 10)}`;
/** Sentinel delta LOW-2 / Odin 7:27 AM: alert when the $3/day cap trips (default WARN; level via HP_BRIEF_CAP_ALERT_LEVEL).
 * Once per UTC day (setNx-deduped); persisted to hp:alerts, which the ops daily files to to-odin. Never blocks the response. */
export const CAP_ALERT_KIND = "premium_brief_unsettled_cap_tripped";
async function capTripped(store: PremiumStore | null, where: "pre_402" | "reserve") {
  const level = (process.env.HP_BRIEF_CAP_ALERT_LEVEL ?? "warn").toLowerCase() === "high" ? "high" : "warn";
  try {
    if (store && !(await store.setNx(`brief:capalert:${new Date(clock()).toISOString().slice(0, 10)}`, "1", 2 * 86_400_000).catch(() => true))) return;
  } catch { /* alert anyway */ }
  // Odin 7:50 AM: a distinct, fixed log token so a log-based check can match it without reading hp:alerts.
  console.error(`[premium] brief_cap_tripped level=${level} where=${where} cap_usd=${UNSETTLED_DAILY_CAP_USD}`);
  console.error(`[premium][ALERT][${level.toUpperCase()}] ${JSON.stringify({ kind: CAP_ALERT_KIND, severity: level, route: "/api/research/report/brief", where, cap_usd: UNSETTLED_DAILY_CAP_USD })}`);
  persistAlert("premium", { kind: CAP_ALERT_KIND, severity: level, route: "/api/research/report/brief", payer: null });
}
async function unsettledBudgetOpen(store: PremiumStore | null): Promise<boolean> {
  if (!store) return false;
  try {
    const v = Number((await store.get(unsettledKey(clock()))) ?? 0);
    return Number.isFinite(v) && v + BRIEF_RUN_COST_USD <= UNSETTLED_DAILY_CAP_USD + 1e-9;
  } catch {
    return false;
  }
}
/** Passing brief cached for the redeem path, bound to claim key + request fingerprint + payer; TTL = unconfirmed claim. */
const passedKey = (claim: string) => `brief:passed:${claim}`;
async function storePassedBrief(store: PremiumStore, claim: string, rq: string, from: string, brief: unknown) {
  await store.set(passedKey(claim), JSON.stringify({ rq, from: from.toLowerCase(), brief }), Math.ceil(CLAIM_TTL_MS.unconfirmed / 1000));
}
async function loadPassedBrief(store: PremiumStore, claim: string, rq: string, from: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await store.get(passedKey(claim));
    const o = raw ? JSON.parse(raw) : null;
    if (!o || o.rq !== rq || o.from !== from.toLowerCase() || !o.brief || briefGate(o.brief) === null) return null;
    return o.brief;
  } catch {
    return null;
  }
}
/** Our own outages (provider/RPC down, not configured): 503 before settle, authorization and decline slot NOT consumed. */
const OUTAGE = /^(not_configured|upstream_unreachable|upstream_unavailable|upstream_bad_json|upstream_5\d\d|upstream_429|chain_unavailable)$/;
const declineKey = (from: string) => `brief:declines:${from.toLowerCase()}:${new Date(clock()).toISOString().slice(0, 10)}`;
async function chargeOnPass(store: PremiumStore, req: NextRequest, x: Tier, d: Decoded, input: string, rq: string, held: Held, t0: number): Promise<NextResponse> {
  const elapsed = (clock() - t0) / 1000;
  if (elapsed + SETTLE_RESERVE_S + projectedSeconds(x, input) > SYNC_HARD_LIMIT_S) {
    await releaseClaim(store, held);
    return jsonError(503, { error: "time_budget_exceeded", charged: false, message: "Nothing was charged for this request." }, { "Retry-After": "5" });
  }
  // Sentinel LOW-7: read the block BEFORE research, so an RPC outage costs neither research nor the buyer's slot.
  const blk = await currentBlock();
  if (blk === null) {
    await releaseClaim(store, held);
    return jsonError(503, { error: "chain_unavailable", reason: "chain_unavailable", charged: false, message: "Nothing was charged for this request." }, { "Retry-After": "5" });
  }
  // Odin ruling (2): reserve this run against the global unsettled cap (atomic, fails closed). Released only on settle.
  const uk = unsettledKey(clock());
  if (!(await store.spendReserve(uk, BRIEF_RUN_COST_USD, UNSETTLED_DAILY_CAP_USD, UNSETTLED_TTL_S).catch(() => false))) {
    await capTripped(store, "reserve");
    await releaseClaim(store, held);
    return jsonError(503, { error: "daily_research_budget_exhausted", reason: "global_unsettled_cap", charged: false, message: "Verified briefs are paused until the next UTC day. Nothing was charged for this request." }, { "Retry-After": "3600" });
  }
  // Reserve one "decline" slot up front (atomic, capped). Odin ruling (3): refunded only after settle SUCCEEDS.
  const dk = declineKey(d.from!);
  let slot: boolean;
  try {
    slot = await store.spendReserve(dk, 1, BRIEF_DECLINE_CAP, BRIEF_DECLINE_TTL_S);
  } catch {
    await store.spendAdjust(uk, -BRIEF_RUN_COST_USD, UNSETTLED_TTL_S).catch(() => undefined);
    await releaseClaim(store, held);
    return jsonError(503, { error: "store_unavailable", reason: "decline_cap_unavailable", charged: false, message: "Nothing was charged for this request." }, { "Retry-After": "2" });
  }
  if (!slot) {
    await store.spendAdjust(uk, -BRIEF_RUN_COST_USD, UNSETTLED_TTL_S).catch(() => undefined);
    await releaseClaim(store, held);
    return jsonError(429, { error: "too_many_unverified_briefs", charged: false, message: `${BRIEF_DECLINE_CAP} briefs from this address did not pass verification today; nothing was charged for them. Retry tomorrow.` }, { "Retry-After": "3600" });
  }
  let result: unknown = null;
  let why = "not_verified";
  try {
    result = await runResearch(x, input, t0 + (SYNC_HARD_LIMIT_S - SETTLE_RESERVE_S) * 1000, undefined, held.key);
  } catch (e) {
    why = researchFailureCode(e);
  }
  if (!result && OUTAGE.test(why)) {
    // Sentinel LOW-7: our outage, not the buyer's: authorization reusable, decline slot returned (spend stays counted).
    await store.spendAdjust(dk, -1, BRIEF_DECLINE_TTL_S).catch(() => undefined);
    await releaseClaim(store, held);
    console.error(`[premium] brief provider outage, not charged: ${why} (tier ${x.id})`); // fixed code only
    return jsonError(503, { error: "research_provider_unavailable", reason: why, charged: false, message: "Our research provider is unavailable. Nothing was charged and your payment authorization was not used; you may retry it." }, { "Retry-After": "30" });
  }
  const tier = result ? briefGate(result) : null;
  if (!tier) {
    await moveClaim(store, held, { s: "declined" }).catch(() => null);
    console.error(`[premium] brief declined, not charged: ${why} (tier ${x.id})`); // fixed code only
    // Sentinel M1 / Odin ruling (1): reason CODES only. No claims, quotes, URLs or answer leave unpaid.
    const codes = ((result as any)?.contract?.fail_reasons ?? []).map(String).filter((r: string) => /^[a-z0-9_:]{1,60}$/.test(r));
    return jsonError(422, {
      error: "brief_not_verified",
      charged: false,
      reason: codes.length ? codes.join(",") : why,
      contract: "https://horizonpulse.dev/contracts/brief-verified",
      message: "This brief did not meet the published contract (at least 2 independently confirmed claims, every quote verbatim at its URL), so we did not charge you. Your payment authorization was not settled and will expire. See /contracts/brief-verified.",
    });
  }
  const delivered = { ...(result as object), verification: { pass_tier: tier, charged_on_pass: true } };
  // Odin ruling (4): cache the passing brief BEFORE settle, bound to this claim, so a redeem serves exactly this brief.
  // Sentinel delta LOW-1: if the redeem cache cannot be written, fail closed BEFORE settle: never take money for a
  // brief we could not hand over on the redeem path. Authorization reusable; decline slot returned; spend stays counted.
  if (!(await storePassedBrief(store, held.key, rq, d.from!, delivered).then(() => true, () => false))) {
    await store.spendAdjust(dk, -1, BRIEF_DECLINE_TTL_S).catch(() => undefined);
    await releaseClaim(store, held);
    return jsonError(503, { error: "store_unavailable", reason: "brief_cache_unavailable", charged: false, message: "Nothing was charged for this request." }, { "Retry-After": "2" });
  }
  const s = await settlePayment(d, x);
  if (!s.ok) {
    // Odin ruling (3): a pass whose settle fails (e.g. authorization cancelled, funds moved) COUNTS as a decline: slot kept.
    const line = reconcile(s.kind === "timeout" ? "settle_timeout" : "settle_ambiguous", x, d, rq, s.tx);
    await moveClaim(store, held, { s: "unconfirmed", rc: line.reconcile_id, blk }).catch(() => null);
    return jsonError(s.kind === "timeout" ? 504 : 502, unconfirmedBody(line.reconcile_id, false, redeemMessage(line.reconcile_id, rq, d.to!, d.value!)));
  }
  markNonceSettled(d.from!, d.nonce!);
  await store.spendAdjust(dk, -1, BRIEF_DECLINE_TTL_S).catch(() => undefined);
  await store.spendAdjust(uk, -BRIEF_RUN_COST_USD, UNSETTLED_TTL_S).catch(() => undefined);
  await moveClaim(store, held, { s: "settled" }).catch(() => null);
  return okResponse(x, delivered, s.tx, s.header);
}

export function premiumOptions(route: PremiumRoute, seg: string | undefined): NextResponse {
  if (!premiumEnabled() || !routeHasAllowedTier(route)) return notFound();
  const x = tierFor(route, seg);
  if (x && !tierAllowed(x)) return notFound();
  if (!x) return jsonError(400, { error: "unknown_tier" });
  if (x.mode === "async" && !(premiumAsyncEnabled() && asyncTierLive(x))) return jsonError(503, { error: "tier_not_available", charged: false });
  const res = challenge(x, description(x), undefined, 200);
  res.headers.set("Allow", "GET, OPTIONS");
  return res;
}

export { SETTLE_RESERVE_S };

/** Test seam: settle/redeem flow tests stub the contract gate; production always uses briefPassTier (the contract). */
let briefGate: (b: unknown) => ReturnType<typeof briefPassTier> = briefPassTier;
export function setBriefGateForTests(fn: ((b: unknown) => ReturnType<typeof briefPassTier>) | null) {
  briefGate = fn ?? briefPassTier;
}
