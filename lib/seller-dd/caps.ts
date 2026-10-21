/**
 * Test-pay reservation lifecycle + loss ledger (spec §3 hard caps, Sentinel C3/C4, L-2). All counters live in the
 * premium store (hp:premium: / hp:premium:pv: prefix, TTL on every write). Every reservation is atomic (one Lua script
 * per counter) and happens BEFORE signing. Any store error -> fail closed (no signing). Partial reservations left by an
 * outage stay counted (conservative) until the cron reconciles them.
 *
 * Release happens ONLY on confirmed non-settlement: validBefore passed AND the nonce unused on-chain (two nodes agree).
 * A facilitator or seller error never releases.
 */
import { BRIEF_DECLINE_CAP, BRIEF_DECLINE_TTL_S, UNSETTLED_DAILY_CAP_USD, unsettledKey } from "@/lib/premium/handler";
import type { CounterKind, PremiumStore } from "@/lib/premium/store";
import { DAILY_CAP_USD, LIFETIME_CAP_USD, PER_HOST_DAILY, SETTLE_FAIL_LIMIT } from "./config";

const DAY_TTL_S = 3 * 86_400;
const LIFE_TTL_S = 400 * 86_400;
const day = (now: number) => new Date(now).toISOString().slice(0, 10);

export const ddKeys = {
  idem: (requestId: string, seller: string) => `dd:idem:${requestId}:${seller.toLowerCase()}`,
  /** Sentinel LOW-A: integer micro-USD (1 USD = 1_000_000). */
  day: (now: number) => `dd:spendu:${day(now)}`,
  life: () => "dd:spendu:lifetime",
  /** pre-LOW-A float-USD keys: read once to seed the micro keys, never written again */
  legacyDay: (now: number) => `dd:spend:${day(now)}`,
  legacyLife: () => "dd:spend:lifetime",
  released: (requestId: string) => `dd:released:${requestId}`,
  host: (domain: string, now: number) => `dd:host:${domain}:${day(now)}`,
  ip: (ip: string, now: number) => `dd:ip:${ip}:${day(now)}`,
  res: (requestId: string) => `dd:res:${requestId}`,
  open: () => "dd:open",
  nonce: (nonce: string) => `dd:nonce:${nonce.toLowerCase()}`,
  loss: (now: number) => `dd:loss:${day(now)}`,
  /** integer micro-USD (LOW-A). Name kept for callers; the pre-LOW-A float key was dd:lossusd:<day>. */
  lossUsd: (now: number) => `dd:lossu:${day(now)}`,
  lossRec: (requestId: string) => `dd:lossrec:${requestId}`,
  settleFail: (now: number) => `dd:settlefail:${day(now)}`,
  settleClosed: (now: number) => `dd:settleclosed:${day(now)}`,
  verdict: (claimKey: string) => `dd:verdict:${claimKey}`,
  unconfirmed: () => "dd:unconfirmed",
  decline: (from: string, now: number) => `brief:declines:${from.toLowerCase()}:${day(now)}`,
};

export type Reservation = { request_id: string; seller: string; domain: string; ip: string; payTo: string; value_usd: number; nonce: string; validBefore: number; at: number };
export type ReserveResult = { ok: true } | { ok: false; code: "already_paid" | "daily_cap" | "lifetime_cap" | "host_cap" | "unsettled_cap" | "store_unavailable" };

export const USD_MICRO = 1_000_000;
/** Reservation value in integer micro-USD (value_usd comes from an atomic USDC amount, so this is exact). */
export const microOf = (r: Reservation) => Math.round(r.value_usd * USD_MICRO);
type Step = [key: string, amount: number, cap: number, ttlS: number, kind: CounterKind, refusal: ReserveResult & { ok: false }];
/** The counters one test pay takes, in refusal-priority order (Odin 10/21 #3). Money in integer micro-USD (LOW-A). */
function capSteps(r: Reservation, now: number): Step[] {
  const m = microOf(r);
  return [
    [ddKeys.day(now), m, DAILY_CAP_USD * USD_MICRO, DAY_TTL_S, "int", { ok: false, code: "daily_cap" }],
    [ddKeys.life(), m, LIFETIME_CAP_USD * USD_MICRO, LIFE_TTL_S, "int", { ok: false, code: "lifetime_cap" }],
    [ddKeys.host(r.domain, now), 1, PER_HOST_DAILY, DAY_TTL_S, "int", { ok: false, code: "host_cap" }],
    [ddKeys.ip(r.ip, now), 1, PER_HOST_DAILY, DAY_TTL_S, "int", { ok: false, code: "host_cap" }],
    // Odin C4: the test pay counts against the brief's global $3/day unsettled cap. That key is OWNED by the brief and is a
    // float-USD counter there, so it stays float here (LOW-A exception, documented in the review note).
    [unsettledKey(now), r.value_usd, UNSETTLED_DAILY_CAP_USD, 2 * 86_400, "float", { ok: false, code: "unsettled_cap" }],
  ];
}

/** LOW-A migration: seed each micro key once (SET NX) from the old float-USD key, rounded UP, so no prior spend is lost. */
async function seedMicroFromLegacy(store: PremiumStore, now: number): Promise<void> {
  for (const [nk, ok, ttl] of [[ddKeys.day(now), ddKeys.legacyDay(now), DAY_TTL_S], [ddKeys.life(), ddKeys.legacyLife(), LIFE_TTL_S]] as const) {
    if ((await store.get(nk)) !== null) continue;
    const old = Number((await store.get(ok)) ?? 0);
    if (!Number.isFinite(old)) throw new Error("legacy_unparseable");
    await store.setNx(nk, String(Math.max(0, Math.ceil(old * USD_MICRO - 1e-6))), ttl * 1000);
  }
}

/**
 * Reserve every counter for one test pay in ONE atomic Lua call (Odin 10/21 #3): either all counters fit under their caps
 * and are all incremented, or none is touched. Concurrent callers can never overshoot a cap. Happens BEFORE signing.
 * If a bookkeeping write AFTER the reserve fails, nothing has been signed yet, so the reservation is released
 * (releaseUnsigned) and the caller gets store_unavailable (no signing).
 */
export async function reserveTestPay(store: PremiumStore, r: Reservation, now: number): Promise<ReserveResult> {
  const idemKey = ddKeys.idem(r.request_id, r.seller);
  let idemTaken = false, reserved = false;
  try {
    if (!(await store.setNx(idemKey, "1", DAY_TTL_S * 1000))) return { ok: false, code: "already_paid" };
    idemTaken = true;
    await seedMicroFromLegacy(store, now);
    const steps = capSteps(r, now);
    const failed = await store.spendReserveMulti(steps.map((x) => x[0]), steps.map((x) => x[1]), steps.map((x) => x[2]), steps.map((x) => x[3]), steps.map((x) => x[4]));
    if (failed !== 0) {
      await store.del(idemKey).catch(() => undefined);
      return steps[failed - 1]![5];
    }
    reserved = true;
    await store.set(ddKeys.res(r.request_id), JSON.stringify(r), DAY_TTL_S);
    // L-5: nonce index so the on-chain watch can match every outbound transfer to a reservation (kept 40 days)
    await store.set(ddKeys.nonce(r.nonce), r.request_id, 40 * 86_400);
    await store.zadd(ddKeys.open(), r.validBefore, r.request_id, DAY_TTL_S);
    return { ok: true };
  } catch {
    // C3: store outage -> no signing. Nothing is signed yet, so release what we took (best effort; if the release also
    // fails, the counters stay counted, which is conservative).
    if (reserved) await releaseUnsigned(store, r, now).catch(() => undefined);
    else if (idemTaken) await store.del(idemKey).catch(() => undefined);
    return { ok: false, code: "store_unavailable" };
  }
}

/**
 * Release a reservation whose authorization was NEVER signed (signing refused/failed, or a bookkeeping write failed after
 * the reserve). Safe because no signature exists, so nothing can settle. Never call after a signature was produced; that
 * path waits for releaseIfConfirmedUnused (validBefore passed AND nonce unused on-chain).
 */
export async function releaseUnsigned(store: PremiumStore, r: Reservation, now: number): Promise<boolean> {
  // Sentinel MEDIUM-1: seed first, or a release on an unseeded day would create the micro key below the legacy spend
  await seedMicroFromLegacy(store, now);
  // Sentinel LOW-B: ONE Lua call, once per reservation id (marker dd:released:<id>); a retry cannot double-refund.
  const steps = capSteps(r, now);
  return store.adjustOnce(ddKeys.released(r.request_id), DAY_TTL_S, steps.map((x) => x[0]), steps.map((x) => -x[1]), steps.map((x) => x[3]), steps.map((x) => x[4]), ddKeys.open(), r.request_id, [ddKeys.res(r.request_id), ddKeys.nonce(r.nonce), ddKeys.idem(r.request_id, r.seller)]);
}

export type NonceState = "used" | "unused" | "unknown";
/** C3 release: only when validBefore has passed AND the nonce is unused on-chain. Returns true when released. */
export async function releaseIfConfirmedUnused(store: PremiumStore, r: Reservation, nonceState: (nonce: string) => Promise<NonceState>, nowMs: number): Promise<boolean> {
  if (Math.floor(nowMs / 1000) <= r.validBefore) return false;
  if ((await nonceState(r.nonce)) !== "unused") return false;
  const at = r.at;
  await seedMicroFromLegacy(store, at); // Sentinel MEDIUM-1 (same reason as releaseUnsigned)
  // LOW-B: same once-per-reservation marker as releaseUnsigned, so the two release paths can never both refund.
  const released = await store.adjustOnce(ddKeys.released(r.request_id), DAY_TTL_S, [ddKeys.day(at), ddKeys.life(), unsettledKey(at)], [-microOf(r), -microOf(r), -r.value_usd], [DAY_TTL_S, LIFE_TTL_S, 2 * 86_400], ["int", "int", "float"], ddKeys.open(), r.request_id, [ddKeys.res(r.request_id)]);
  if (!released) { await store.zrem(ddKeys.open(), r.request_id).catch(() => undefined); return false; }
  await releaseLoss(store, r, nowMs);
  return true;
}

/** Cron reconcile: every open reservation past validBefore is checked; used -> closed (spend kept), unused -> released. */
export async function reconcileOpen(store: PremiumStore, nonceState: (nonce: string) => Promise<NonceState>, nowMs: number, limit = 50) {
  const ids = await store.zrangeByScore(ddKeys.open(), Math.floor(nowMs / 1000) - 1, limit);
  let released = 0, settled = 0, unknown = 0;
  for (const id of ids) {
    const raw = await store.get(ddKeys.res(id)).catch(() => null);
    if (!raw) { await store.zrem(ddKeys.open(), id).catch(() => undefined); continue; }
    const r = JSON.parse(raw) as Reservation;
    const st = await nonceState(r.nonce);
    if (st === "unused" && (await releaseIfConfirmedUnused(store, r, async () => st, nowMs))) released++;
    else if (st === "used") { await store.zrem(ddKeys.open(), id); settled++; }
    else unknown++;
  }
  return { checked: ids.length, released, settled, unknown };
}

/** C3 loss ledger: every test pay that ends in no_charge (or an absorbed buyer-settle failure) is an unrecovered loss. */
/**
 * INFO-2 (Sentinel): every entry carries status "confirmed" (our nonce read used) or "unconfirmed". An unconfirmed loss whose
 * reservation the cron later releases (nonce unused after validBefore) gets a "released" entry and is taken off the day's total.
 */
export type LossStatus = "confirmed" | "unconfirmed";
export async function recordLoss(store: PremiumStore, r: Reservation, reason: string, now: number, status: LossStatus = "confirmed"): Promise<void> {
  await store.zadd(ddKeys.loss(now), now, JSON.stringify({ request_id: r.request_id, value_usd: r.value_usd, reason, nonce: r.nonce, status }), 40 * 86_400);
  await store.spendAdjust(ddKeys.lossUsd(now), microOf(r), 40 * 86_400);
  if (status === "unconfirmed") await store.set(ddKeys.lossRec(r.request_id), String(now), 40 * 86_400);
}
async function releaseLoss(store: PremiumStore, r: Reservation, nowMs: number): Promise<void> {
  const at = Number((await store.get(ddKeys.lossRec(r.request_id)).catch(() => null)) ?? NaN);
  if (!Number.isFinite(at)) return;
  await store.zadd(ddKeys.loss(at), nowMs, JSON.stringify({ request_id: r.request_id, value_usd: -r.value_usd, reason: "released_nonce_unused", nonce: r.nonce, status: "released" }), 40 * 86_400);
  await store.spendAdjust(ddKeys.lossUsd(at), -microOf(r), 40 * 86_400);
  await store.del(ddKeys.lossRec(r.request_id));
}

/** Odin C4: settle failures per UTC day; >= SETTLE_FAIL_LIMIT -> route fails closed. Unreadable -> closed. */
/** B2: days on which a settle-failure counter WRITE failed: the route is closed for that UTC day on this instance. */
const writeFailedDays = new Set<string>();
export function resetSettleFailureLatchForTests() { writeFailedDays.clear(); }
export async function routeClosedBySettleFailures(store: PremiumStore, now: number): Promise<boolean> {
  if (writeFailedDays.has(day(now))) return true;
  try {
    if (await store.get(ddKeys.settleClosed(now))) return true;
    const v = Number((await store.get(ddKeys.settleFail(now))) ?? 0);
    return !Number.isFinite(v) || v >= SETTLE_FAIL_LIMIT;
  } catch {
    return true;
  }
}
/**
 * B2 (Odin): a failed counter write must never leave the route open. On a write error the day is latched closed on this
 * instance, a best-effort closed marker is written, and the caller treats it as the limit (HIGH alert).
 */
export async function recordSettleFailure(store: PremiumStore, now: number): Promise<{ count: number; write_failed: boolean }> {
  try {
    await store.spendAdjust(ddKeys.settleFail(now), 1, DAY_TTL_S);
  } catch {
    writeFailedDays.add(day(now));
    await store.set(ddKeys.settleClosed(now), "1", DAY_TTL_S).catch(() => undefined);
    return { count: SETTLE_FAIL_LIMIT, write_failed: true };
  }
  const v = Number((await store.get(ddKeys.settleFail(now)).catch(() => null)) ?? SETTLE_FAIL_LIMIT);
  return { count: Number.isFinite(v) ? v : SETTLE_FAIL_LIMIT, write_failed: false };
}

/** Odin C4: reuse the brief's per-payer decline cap; the buyer's request takes one slot, refunded only after settle succeeds. */
export async function takeDeclineSlot(store: PremiumStore, from: string, now: number): Promise<boolean> {
  return store.spendReserve(ddKeys.decline(from, now), 1, BRIEF_DECLINE_CAP, BRIEF_DECLINE_TTL_S);
}
export async function refundDeclineSlot(store: PremiumStore, from: string, now: number): Promise<void> {
  await store.spendAdjust(ddKeys.decline(from, now), -1, BRIEF_DECLINE_TTL_S).catch(() => undefined);
}
