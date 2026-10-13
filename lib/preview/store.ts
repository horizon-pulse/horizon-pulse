/**
 * Preview storage: review queue (30-day retention), spend ledger, rate limits.
 * Memory adapter here; reports are only ever readable by the review script, never
 * served to the submitter automatically (human review queue).
 * NOTE: Memory is per-instance. A shared store (e.g. the Upstash adapter pattern in
 * xrpl-replay-store.ts) is required before public launch; tracked in the PR body.
 */
import { dayKey, monthKey } from "./cost";

export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type ReviewStatus = "pending_review" | "approved" | "rejected";
export type StoredReport = { id: string; createdAt: number; status: ReviewStatus; report: unknown };

export interface PreviewStore {
  putReport(r: StoredReport): Promise<void>;
  listReports(status?: ReviewStatus): Promise<StoredReport[]>;
  addSpend(usd: number, now?: Date): Promise<void>;
  getSpend(now?: Date): Promise<{ day: number; month: number }>;
  /** Fixed-window counter; returns the count after increment. */
  hit(key: string, windowMs: number): Promise<number>;
  purgeExpired(now?: number): Promise<number>;
}

export class MemoryPreviewStore implements PreviewStore {
  private reports = new Map<string, StoredReport>();
  private spend = new Map<string, number>();
  private hits = new Map<string, { n: number; until: number }>();

  async putReport(r: StoredReport) {
    await this.purgeExpired();
    this.reports.set(r.id, r);
  }
  async listReports(status?: ReviewStatus) {
    await this.purgeExpired();
    return [...this.reports.values()].filter((r) => !status || r.status === status);
  }
  async addSpend(usd: number, now = new Date()) {
    for (const k of ["d:" + dayKey(now), "m:" + monthKey(now)]) this.spend.set(k, (this.spend.get(k) ?? 0) + usd);
  }
  async getSpend(now = new Date()) {
    return { day: this.spend.get("d:" + dayKey(now)) ?? 0, month: this.spend.get("m:" + monthKey(now)) ?? 0 };
  }
  async hit(key: string, windowMs: number) {
    const now = Date.now();
    const e = this.hits.get(key);
    if (!e || now >= e.until) {
      this.hits.set(key, { n: 1, until: now + windowMs });
      return 1;
    }
    e.n += 1;
    return e.n;
  }
  async purgeExpired(now = Date.now()) {
    let n = 0;
    for (const [id, r] of this.reports) if (now - r.createdAt >= RETENTION_MS) (this.reports.delete(id), n++);
    return n;
  }
}

let singleton: PreviewStore | null = null;
export function getPreviewStore(): PreviewStore {
  return (singleton ??= new MemoryPreviewStore());
}
export function setPreviewStoreForTests(s: PreviewStore | null) {
  singleton = s;
}
