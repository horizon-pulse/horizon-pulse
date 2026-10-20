/**
 * Counsel D3 correction path: receipt log + supersede links.
 * Spec §16 D3: "A disputed verdict is re-checked (a new test payment within §3 caps, at our cost) and reissued with a
 * new id; the old id is marked `superseded_by:<new id>` in the verify endpoint and the receipt log. Old verdicts are
 * never silently edited."
 *
 * - Every delivered signed verdict gets an immutable receipt record (`dd:rcpt:<id>`, written once with setNx, never
 *   rewritten). It holds the sha256 of the canonical signed verdict, not the verdict body (D5: no paid values stored).
 * - A supersede is a SEPARATE write-once marker (`dd:superseded:<old id>` = new id, setNx) plus an append-only event in
 *   the receipt log (`dd:rcptlog`). The old record and the old signature are never touched.
 * - The new verdict carries `supersedes: <old id>` INSIDE the signed body, so the link is covered by the signature.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "@/lib/receipt-signer";
import type { PremiumStore } from "@/lib/premium/store";

export const RECEIPT_TTL_S = 3 * 365 * 24 * 3600; // retention for verify lookups (hashes + ids only, Odin round 6)
export const RECHECK_CTX_TTL_S = 90 * 24 * 3600; // plain URL + expected payTo, re-check window (Odin round 6)
export const rcptKeys = {
  rec: (id: string) => `dd:rcpt:${id}`,
  superseded: (id: string) => `dd:superseded:${id}`,
  recheckLock: (id: string) => `dd:recheck:${id}`,
  recheckPaid: (id: string) => `dd:recheckpaid:${id}`,
  recheckDay: (id: string, day: string) => `dd:recheckday:${id}:${day}`,
  log: () => "dd:rcptlog",
  ctx: (id: string) => `dd:rcptctx:${id}`,
  dispute: (id: string) => `dd:dispute:${id}`,
};
export const VERDICT_ID_RE = /^dd_[0-9a-f]{24}$/;

export type ReceiptRecord = {
  id: string; issued_at: string; resource_sha256: string; pass: boolean;
  verdict_sha256: string; kid: string | null; supersedes: string | null; origin: "buyer" | "recheck";
};

const sha256 = (x: string) => createHash("sha256").update(x).digest("hex");
export const verdictSha256 = (signed: Record<string, unknown>) => createHash("sha256").update(canonicalJson(signed)).digest("hex");

/** Write the immutable receipt record + a log event. Returns false if the store write failed (caller fails closed). */
export async function logReceipt(store: PremiumStore, signed: Record<string, unknown>, o: { expected_payTo: string | null; pass: boolean; origin: ReceiptRecord["origin"] }, nowMs: number): Promise<boolean> {
  const id = String(signed.id);
  const rec: ReceiptRecord = {
    id, issued_at: new Date(nowMs).toISOString(), resource_sha256: sha256(String(signed.resource)), pass: o.pass,
    verdict_sha256: verdictSha256(signed), kid: ((signed.sig as { kid?: string } | undefined)?.kid) ?? null,
    supersedes: typeof signed.supersedes === "string" ? signed.supersedes : null, origin: o.origin,
  };
  try {
    const created = await store.setNx(rcptKeys.rec(id), JSON.stringify(rec), RECEIPT_TTL_S * 1000);
    if (!created) { const ex = await store.get(rcptKeys.rec(id)); try { return !!ex && (JSON.parse(ex) as ReceiptRecord).verdict_sha256 === rec.verdict_sha256; } catch { return false; } } // idempotent: same signed verdict only (LOW-2 resume)
    // Odin round 6: plain URL + buyer's expected payTo live only in a separate 90-day entry (re-check input)
    await store.set(rcptKeys.ctx(id), JSON.stringify({ resource: String(signed.resource), expected_payTo: o.expected_payTo ?? null }), RECHECK_CTX_TTL_S);
    await store.zadd(rcptKeys.log(), nowMs, `issued:${id}${rec.supersedes ? `:supersedes:${rec.supersedes}` : ""}`, RECEIPT_TTL_S);
    return true;
  } catch { return false; }
}

export async function getReceipt(store: PremiumStore, id: string): Promise<ReceiptRecord | null> {
  const raw = await store.get(rcptKeys.rec(id));
  if (!raw) return null;
  try { return JSON.parse(raw) as ReceiptRecord; } catch { return null; }
}

/** Write-once supersede marker (old record untouched). false = already superseded by a different id or store failure. */
export async function markSuperseded(store: PremiumStore, oldId: string, newId: string, nowMs: number): Promise<boolean> {
  try {
    const ok = await store.setNx(rcptKeys.superseded(oldId), newId, RECEIPT_TTL_S * 1000);
    if (!ok) return (await store.get(rcptKeys.superseded(oldId))) === newId;
    await store.zadd(rcptKeys.log(), nowMs, `superseded:${oldId}:by:${newId}`, RECEIPT_TTL_S);
    return true;
  } catch { return false; }
}

/** Odin V2: verify exposes only these fields. No resource URL, no pass/fail (resource_sha256 = sha256 of the URL string). */
export type VerifyView = {
  id: string; status: "current" | "superseded"; superseded_by: string | null; supersedes: string | null;
  issued_at: string; verdict_sha256: string; kid: string | null; resource_sha256: string;
};
export async function verifyView(store: PremiumStore, id: string): Promise<VerifyView | null> {
  const rec = await getReceipt(store, id);
  if (!rec) return null;
  const by = await store.get(rcptKeys.superseded(id));
  return { id, status: by ? "superseded" : "current", superseded_by: by ?? null, supersedes: rec.supersedes, issued_at: rec.issued_at, verdict_sha256: rec.verdict_sha256, kid: rec.kid, resource_sha256: rec.resource_sha256 };
}

/** Per-IP verify rate limit (Odin round 5): ~60 per rolling minute. Store failure -> refuse (fail closed). */
export const VERIFY_RATE_PER_MIN = 60;
export async function verifyRateOk(store: PremiumStore, ip: string, nowMs: number): Promise<boolean> {
  try { return await store.reserve([`dd:vrl:${ip}`], [VERIFY_RATE_PER_MIN], `${nowMs}:${Math.random().toString(36).slice(2)}`, nowMs, nowMs - 60_000, 120); }
  catch { return false; }
}

export async function getRecheckContext(store: PremiumStore, id: string): Promise<{ resource: string; expected_payTo: string | null } | null> {
  const raw = await store.get(rcptKeys.ctx(id));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Counsel retention ruling (to-odin/2026-10-20-counsel-tokenized-stocks.md §d): the readable entry is deleted at 90 days
 * (store TTL = actual deletion), disputes must be raised within 90 days of the verdict, and an open dispute holds the
 * entry until it is resolved. Hold = re-write the entry with the 3-year TTL + an open-dispute marker; resolve = restore
 * the remaining part of the 90 days, or delete now if the window has passed.
 */
export const DISPUTE_WINDOW_MS = RECHECK_CTX_TTL_S * 1000;
export type DisputeResult = { ok: true; state: "open" | "resolved"; ctx_expires_at: string | null } | { ok: false; status: number; error: string };
export async function openDispute(store: PremiumStore, id: string, nowMs: number): Promise<DisputeResult> {
  const rec = await getReceipt(store, id);
  if (!rec) return { ok: false, status: 404, error: "unknown_verdict" };
  if (nowMs - Date.parse(rec.issued_at) > DISPUTE_WINDOW_MS) return { ok: false, status: 410, error: "dispute_window_expired" };
  const raw = await store.get(rcptKeys.ctx(id));
  if (!raw) return { ok: false, status: 410, error: "dispute_window_expired" };
  await store.set(rcptKeys.dispute(id), JSON.stringify({ opened_at: new Date(nowMs).toISOString() }), RECEIPT_TTL_S);
  await store.set(rcptKeys.ctx(id), raw, RECEIPT_TTL_S); // hold: not deleted at 90 days while the dispute is open
  await store.zadd(rcptKeys.log(), nowMs, `dispute_open:${id}:${nowMs}`, RECEIPT_TTL_S);
  return { ok: true, state: "open", ctx_expires_at: null };
}
export async function resolveDispute(store: PremiumStore, id: string, nowMs: number): Promise<DisputeResult> {
  const rec = await getReceipt(store, id);
  if (!rec) return { ok: false, status: 404, error: "unknown_verdict" };
  if (!(await store.get(rcptKeys.dispute(id)))) return { ok: false, status: 409, error: "no_open_dispute" };
  const left = Date.parse(rec.issued_at) + DISPUTE_WINDOW_MS - nowMs;
  const raw = await store.get(rcptKeys.ctx(id));
  if (raw && left > 1000) await store.set(rcptKeys.ctx(id), raw, Math.floor(left / 1000));
  else await store.del(rcptKeys.ctx(id)); // past 90 days -> deleted now
  await store.del(rcptKeys.dispute(id));
  await store.zadd(rcptKeys.log(), nowMs, `dispute_resolved:${id}:${nowMs}`, RECEIPT_TTL_S);
  return { ok: true, state: "resolved", ctx_expires_at: raw && left > 1000 ? new Date(nowMs + left).toISOString() : null };
}
