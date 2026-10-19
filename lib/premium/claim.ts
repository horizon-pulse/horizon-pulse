/**
 * Shared atomic payment claim (Sentinel ITEM-5 / MEDIUM-1, Odin C2), same shape as the Solana shared claim v4 and the
 * XRPL claim store: one key per authorization, `claim:<from>:<nonce>` (lower-case), SET NX before verify, every
 * later transition an exact-value CAS by the owner, release a compare-and-delete.
 *
 *   inflight     a request owns it (verify / settle / work in progress)       -> others: 503 payment_in_progress, no alert
 *   job          an async job owns it (verified, settle after first deliverable) -> others: 503 payment_in_progress
 *   settled      settle succeeded                                              -> others: 409, no alert, no write
 *   unconfirmed  settle timed out / ambiguous (504/502); holds rq + reconcile id -> others: 409 unless a payer-proof
 *                redeem from the SAME request fingerprint (Sentinel item 4)
 *   conflict     authorization found already used on-chain                     -> 409, no alert, no write (dedupe)
 *   redeemed     the one allowed redeem happened                               -> 409
 */
import { randomBytes } from "node:crypto";
import type { PremiumStore } from "./store";

export type ClaimState = "inflight" | "job" | "settled" | "unconfirmed" | "conflict" | "redeemed";
export type Claim = { s: ClaimState; o: string; rq: string; at: number; rc?: string; job?: string; tier?: string; blk?: number | null };

export const CLAIM_TTL_MS: Record<ClaimState, number> = {
  inflight: 120_000,
  job: 20 * 60_000,
  settled: 48 * 3600_000,
  unconfirmed: 30 * 86_400_000,
  conflict: 48 * 3600_000,
  redeemed: 48 * 3600_000,
};

export const claimKey = (from: string, nonce: string) => `claim:${from.toLowerCase()}:${nonce.toLowerCase()}`;
export const newOwner = () => randomBytes(12).toString("hex");

export function parseClaim(raw: string | null): Claim | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as Claim;
    return c && typeof c.s === "string" && typeof c.o === "string" ? c : null;
  } catch {
    return null;
  }
}

export type Held = { key: string; raw: string; claim: Claim };

export async function tryClaim(store: PremiumStore, from: string, nonce: string, c: Claim): Promise<{ ok: true; held: Held } | { ok: false; existing: Claim | null; raw: string | null }> {
  const key = claimKey(from, nonce);
  const raw = JSON.stringify(c);
  if (await store.setNx(key, raw, CLAIM_TTL_MS[c.s])) return { ok: true, held: { key, raw, claim: c } };
  const cur = await store.get(key);
  return { ok: false, existing: parseClaim(cur), raw: cur };
}

/** Owner CAS to a new state. Returns the new holder, or null if the value changed underneath (lost ownership). */
export async function moveClaim(store: PremiumStore, h: Held, patch: Partial<Claim> & { s: ClaimState }): Promise<Held | null> {
  const next: Claim = { ...h.claim, ...patch, at: Date.now() };
  const raw = JSON.stringify(next);
  return (await store.cas(h.key, h.raw, raw, CLAIM_TTL_MS[next.s])) ? { key: h.key, raw, claim: next } : null;
}

export async function releaseClaim(store: PremiumStore, h: Held): Promise<void> {
  try {
    await store.casDel(h.key, h.raw);
  } catch {
    /* TTL covers it */
  }
}
