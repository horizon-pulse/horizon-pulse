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

export const RECEIPT_TTL_S = 3 * 365 * 24 * 3600; // retention for verify lookups
export const rcptKeys = {
  rec: (id: string) => `dd:rcpt:${id}`,
  superseded: (id: string) => `dd:superseded:${id}`,
  recheckLock: (id: string) => `dd:recheck:${id}`,
  log: () => "dd:rcptlog",
};
export const VERDICT_ID_RE = /^dd_[0-9a-f]{24}$/;

export type ReceiptRecord = {
  id: string; issued_at: string; resource: string; expected_payTo: string | null; pass: boolean;
  verdict_sha256: string; kid: string | null; supersedes: string | null; origin: "buyer" | "recheck";
};

export const verdictSha256 = (signed: Record<string, unknown>) => createHash("sha256").update(canonicalJson(signed)).digest("hex");

/** Write the immutable receipt record + a log event. Returns false if the store write failed (caller fails closed). */
export async function logReceipt(store: PremiumStore, signed: Record<string, unknown>, o: { expected_payTo: string | null; pass: boolean; origin: ReceiptRecord["origin"] }, nowMs: number): Promise<boolean> {
  const id = String(signed.id);
  const rec: ReceiptRecord = {
    id, issued_at: new Date(nowMs).toISOString(), resource: String(signed.resource), expected_payTo: o.expected_payTo ?? null, pass: o.pass,
    verdict_sha256: verdictSha256(signed), kid: ((signed.sig as { kid?: string } | undefined)?.kid) ?? null,
    supersedes: typeof signed.supersedes === "string" ? signed.supersedes : null, origin: o.origin,
  };
  try {
    const created = await store.setNx(rcptKeys.rec(id), JSON.stringify(rec), RECEIPT_TTL_S * 1000);
    if (!created) return (await store.get(rcptKeys.rec(id))) === JSON.stringify(rec); // idempotent same write only
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

export type VerifyView = {
  id: string; status: "current" | "superseded"; superseded_by: string | null; supersedes: string | null;
  issued_at: string; resource: string; pass: boolean; verdict_sha256: string; kid: string | null;
};
export async function verifyView(store: PremiumStore, id: string): Promise<VerifyView | null> {
  const rec = await getReceipt(store, id);
  if (!rec) return null;
  const by = await store.get(rcptKeys.superseded(id));
  return { id, status: by ? "superseded" : "current", superseded_by: by ?? null, supersedes: rec.supersedes, issued_at: rec.issued_at, resource: rec.resource, pass: rec.pass, verdict_sha256: rec.verdict_sha256, kid: rec.kid };
}
