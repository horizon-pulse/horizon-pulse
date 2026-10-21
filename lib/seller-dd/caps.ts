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
import type { PremiumStore } from "@/lib/premium/store";
import { DAILY_CAP_USD, LIFETIME_CAP_USD, PER_HOST_DAILY, SELLER_SETTLE_FAIL_LIMIT, SETTLE_FAIL_LIMIT } from "./config";

const DAY_TTL_S = 3 * 86_400;
const LIFE_TTL_S = 400 * 86_400;
const day = (now: number) => new Date(now).toISOString().slice(0, 10);

export const ddKeys = {
  idem: (requestId: string, seller: string) => `dd:idem:${requestId}:${seller.toLowerCase()}`,
  day: (now: number) => `dd:spend:${day(now)}`,
  life: () => "dd:spend:lifetime",
  host: (domain: string, now: number) => `dd:host:${domain}:${day(now)}`,
  ip: (ip: string, now: number) => `dd:ip:${ip}:${day(now)}`,
  res: (requestId: string) => `dd:res:${requestId}`,
  open: () => "dd:open",
  nonce: (nonce: string) => `dd:nonce:${nonce.toLowerCase()}`,
  loss: (now: number) => `dd:loss:${day(now)}`,
  lossUsd: (now: number) => `dd:lossusd:${day(now)}`,
  lossRec: (requestId: string) => `dd:lossrec:${requestId}`,
  settleFail: (now: number) => `dd:settlefail:${day(now)}`,
  settleClosed: (now: number) => `dd:settleclosed:${day(now)}`,
  sellerSettleFail: (domain: string, now: number) => `dd:settlefail:seller:${domain.toLowerCase()}:${day(now)}`,
  sellerSettleClosed: (domain: string, now: number) => `dd:settleclosed:seller:${domain.toLowerCase()}:${day(now)}`,
  verdict: (claimKey: string) => `dd:verdict:${claimKey}`,
  unconfirmed: () => "dd:unconfirmed",
  decline: (from: string, now: number) => `brief:declines:${from.toLowerCase()}:${day(now)}`,
};

export type Reservation = { request_id: string; seller: string; domain: string; ip: string; payTo: string; value_usd: number; nonce: string; validBefore: number; at: number };
export type ReserveResult = { ok: true } | { ok: false; code: "already_paid" | "daily_cap" | "lifetime_cap" | "host_cap" | "unsettled_cap" | "store_unavailable" };

/** Reserve every counter for one test pay, atomically per counter, in order; roll back earlier counters on a cap refusal. */
export async function reserveTestPay(store: PremiumStore, r: Reservation, now: number): Promise<ReserveResult> {
  const undo: (() => Promise<void>)[] = [];
  const rollback = async () => { for (const u of undo.reverse()) await u().catch(() => undefined); };
  try {
    if (!(await store.setNx(ddKeys.idem(r.request_id, r.seller), "1", DAY_TTL_S * 1000))) return { ok: false, code: "already_paid" };
    const steps: [string, number, number, number, ReserveResult & { ok: false }][] = [
      [ddKeys.day(now), r.value_usd, DAILY_CAP_USD, DAY_TTL_S, { ok: false, code: "daily_cap" }],
      [ddKeys.life(), r.value_usd, LIFETIME_CAP_USD, LIFE_TTL_S, { ok: false, code: "lifetime_cap" }],
      [ddKeys.host(r.domain, now), 1, PER_HOST_DAILY, DAY_TTL_S, { ok: false, code: "host_cap" }],
      [ddKeys.ip(r.ip, now), 1, PER_HOST_DAILY, DAY_TTL_S, { ok: false, code: "host_cap" }],
      // Odin C4: the test pay counts against the brief's global $3/day unsettled cap
      [unsettledKey(now), r.value_usd, UNSETTLED_DAILY_CAP_USD, 2 * 86_400, { ok: false, code: "unsettled_cap" }],
    ];
    for (const [k, amt, cap, ttl, refusal] of steps) {
      if (!(await store.spendReserve(k, amt, cap, ttl))) {
        await rollback();
        return refusal;
      }
      undo.push(() => store.spendAdjust(k, -amt, ttl));
    }
    await store.set(ddKeys.res(r.request_id), JSON.stringify(r), DAY_TTL_S);
    // L-5: nonce index so the on-chain watch can match every outbound transfer to a reservation (kept 40 days)
    await store.set(ddKeys.nonce(r.nonce), r.request_id, 40 * 86_400);
    await store.zadd(ddKeys.open(), r.validBefore, r.request_id, DAY_TTL_S);
    return { ok: true };
  } catch {
    // C3: store outage mid-reservation -> no signing. Counters already taken stay counted; the cron reconciles.
    return { ok: false, code: "store_unavailable" };
  }
}

export type NonceState = "used" | "unused" | "unknown";
/** C3 release: only when validBefore has passed AND the nonce is unused on-chain. Returns true when released. */
export async function releaseIfConfirmedUnused(store: PremiumStore, r: Reservation, nonceState: (nonce: string) => Promise<NonceState>, nowMs: number): Promise<boolean> {
  if (Math.floor(nowMs / 1000) <= r.validBefore) return false;
  if ((await nonceState(r.nonce)) !== "unused") return false;
  const at = r.at;
  await store.spendAdjust(ddKeys.day(at), -r.value_usd, DAY_TTL_S);
  await store.spendAdjust(ddKeys.life(), -r.value_usd, LIFE_TTL_S);
  await store.spendAdjust(unsettledKey(at), -r.value_usd, 2 * 86_400);
  await store.zrem(ddKeys.open(), r.request_id);
  await store.del(ddKeys.res(r.request_id));
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
  await store.spendAdjust(ddKeys.lossUsd(now), r.value_usd, 40 * 86_400);
  if (status === "unconfirmed") await store.set(ddKeys.lossRec(r.request_id), String(now), 40 * 86_400);
}
async function releaseLoss(store: PremiumStore, r: Reservation, nowMs: number): Promise<void> {
  const at = Number((await store.get(ddKeys.lossRec(r.request_id)).catch(() => null)) ?? NaN);
  if (!Number.isFinite(at)) return;
  await store.zadd(ddKeys.loss(at), nowMs, JSON.stringify({ request_id: r.request_id, value_usd: -r.value_usd, reason: "released_nonce_unused", nonce: r.nonce, status: "released" }), 40 * 86_400);
  await store.spendAdjust(ddKeys.lossUsd(at), -r.value_usd, 40 * 86_400);
  await store.del(ddKeys.lossRec(r.request_id));
}

/** Odin C4: settle failures per UTC day; >= SETTLE_FAIL_LIMIT -> route fails closed. Unreadable -> closed. */
/** B2: days on which a settle-failure counter WRITE failed: the route is closed for that UTC day on this instance. */
const writeFailedDays = new Set<string>();
const sellerWriteFailed = new Set<string>();
export function resetSettleFailureLatchForTests() { writeFailedDays.clear(); sellerWriteFailed.clear(); }
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

/**
 * Odin 10/21 #4: settle failures per seller (registrable domain) per UTC day. >= SELLER_SETTLE_FAIL_LIMIT -> that seller
 * is refused (no_charge, seller_paused_settle_failures) before the buyer's payment is verified. Unreadable -> refused.
 */
export async function sellerClosedBySettleFailures(store: PremiumStore, domain: string, now: number): Promise<boolean> {
  const d = domain.toLowerCase();
  if (sellerWriteFailed.has(`${d}|${day(now)}`)) return true;
  try {
    if (await store.get(ddKeys.sellerSettleClosed(d, now))) return true;
    const v = Number((await store.get(ddKeys.sellerSettleFail(d, now))) ?? 0);
    return !Number.isFinite(v) || v >= SELLER_SETTLE_FAIL_LIMIT;
  } catch {
    return true;
  }
}
/** Same B2 rule as the global counter: a failed write latches that seller closed for the day on this instance. */
export async function recordSellerSettleFailure(store: PremiumStore, domain: string, now: number): Promise<{ count: number; write_failed: boolean }> {
  const d = domain.toLowerCase();
  try {
    await store.spendAdjust(ddKeys.sellerSettleFail(d, now), 1, DAY_TTL_S);
  } catch {
    sellerWriteFailed.add(`${d}|${day(now)}`);
    await store.set(ddKeys.sellerSettleClosed(d, now), "1", DAY_TTL_S).catch(() => undefined);
    return { count: SELLER_SETTLE_FAIL_LIMIT, write_failed: true };
  }
  const v = Number((await store.get(ddKeys.sellerSettleFail(d, now)).catch(() => null)) ?? SELLER_SETTLE_FAIL_LIMIT);
  return { count: Number.isFinite(v) ? v : SELLER_SETTLE_FAIL_LIMIT, write_failed: false };
}

/** Odin C4: reuse the brief's per-payer decline cap; the buyer's request takes one slot, refunded only after settle succeeds. */
export async function takeDeclineSlot(store: PremiumStore, from: string, now: number): Promise<boolean> {
  return store.spendReserve(ddKeys.decline(from, now), 1, BRIEF_DECLINE_CAP, BRIEF_DECLINE_TTL_S);
}
export async function refundDeclineSlot(store: PremiumStore, from: string, now: number): Promise<void> {
  await store.spendAdjust(ddKeys.decline(from, now), -1, BRIEF_DECLINE_TTL_S).catch(() => undefined);
}
