/**
 * Preview storage: review queue (30-day TTL), spend ledger, rate limits.
 *
 * Odin class A blocker 1: everything that enforces a limit lives in a SHARED
 * store so caps hold across cold starts, instances and concurrent requests.
 *   - Spend: worst-case cost is RESERVED atomically (INCRBYFLOAT on the day and
 *     month keys) BEFORE the LLM call; if either total crosses its cap the
 *     reservation is rolled back and the call is refused. After the call the
 *     reservation is reconciled to the real cost (INCRBYFLOAT of the delta).
 *   - Rate limits: `SET key 0 NX PX window` then `INCR` (INCR keeps the TTL), so a
 *     crash can never leave a counter without expiry.
 *   - Reports: `SET report json PX 30d` + a ZSET index (pruned on read). Reports,
 *     including any contact email, expire with the TTL.
 *
 * UpstashPreviewStore follows lib/xrpl-replay-store.ts (Upstash Redis REST, same
 * env resolution). MemoryPreviewStore is for TESTS ONLY: getPreviewStore() never
 * returns it, and returns null (endpoint fails closed) when no shared store is set.
 */
import { resolveSharedReplayStoreEnv } from "@/lib/xrpl-replay-store";
import { dayKey, monthKey } from "./cost";

export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_KEY_TTL_MS = 2 * 24 * 60 * 60 * 1000;
const MONTH_KEY_TTL_MS = 35 * 24 * 60 * 60 * 1000;

export type ReviewStatus = "pending_review" | "approved" | "rejected";
export type Contact = { email: string; consent: true; consentAt: number };
export type StoredReport = { id: string; createdAt: number; status: ReviewStatus; contact?: Contact; report: unknown };
export type SpendSlot = { day: string; month: string };
export type Reservation = { ok: boolean; slot: SpendSlot; usd: number; day: number; month: number };

export const spendSlot = (now = new Date()): SpendSlot => ({ day: dayKey(now), month: monthKey(now) });

export interface PreviewStore {
  readonly kind: "memory" | "upstash";
  putReport(r: StoredReport): Promise<void>;
  getReport(id: string): Promise<StoredReport | null>;
  listReports(status?: ReviewStatus): Promise<StoredReport[]>;
  setStatus(id: string, status: ReviewStatus): Promise<StoredReport | null>;
  /** Atomically add `usd` to the day+month totals; roll back and return ok=false if either cap is crossed. */
  reserveSpend(usd: number, caps: { dailyUsd: number; monthlyUsd: number }, now?: Date): Promise<Reservation>;
  /** Add `deltaUsd` (may be negative) to the totals of a previous reservation's slot. */
  adjustSpend(slot: SpendSlot, deltaUsd: number): Promise<void>;
  getSpend(now?: Date): Promise<{ day: number; month: number }>;
  /** Fixed-window counter with expiry; returns the count after increment. */
  hit(key: string, windowMs: number): Promise<number>;
}

/** TESTS ONLY (per-instance). Mirrors the Upstash semantics. */
export class MemoryPreviewStore implements PreviewStore {
  readonly kind = "memory" as const;
  private reports = new Map<string, StoredReport>();
  private spend = new Map<string, number>();
  private hits = new Map<string, { n: number; until: number }>();
  constructor(private readonly clock: () => number = Date.now) {}

  async putReport(r: StoredReport) {
    this.reports.set(r.id, structuredClone(r));
  }
  async getReport(id: string) {
    const r = this.reports.get(id);
    if (!r) return null;
    if (this.clock() - r.createdAt >= RETENTION_MS) {
      this.reports.delete(id);
      return null;
    }
    return structuredClone(r);
  }
  async listReports(status?: ReviewStatus) {
    const out: StoredReport[] = [];
    for (const id of [...this.reports.keys()]) {
      const r = await this.getReport(id);
      if (r && (!status || r.status === status)) out.push(r);
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }
  async setStatus(id: string, status: ReviewStatus) {
    const r = this.reports.get(id);
    if (!r || !(await this.getReport(id))) return null;
    r.status = status;
    return structuredClone(r);
  }
  private incr(k: string, by: number) {
    const v = (this.spend.get(k) ?? 0) + by;
    this.spend.set(k, v);
    return v;
  }
  async reserveSpend(usd: number, caps: { dailyUsd: number; monthlyUsd: number }, now = new Date()) {
    const slot = spendSlot(now);
    const day = this.incr("d:" + slot.day, usd);
    const month = this.incr("m:" + slot.month, usd);
    if (day > caps.dailyUsd || month > caps.monthlyUsd) {
      await this.adjustSpend(slot, -usd);
      return { ok: false, slot, usd, day, month };
    }
    return { ok: true, slot, usd, day, month };
  }
  async adjustSpend(slot: SpendSlot, deltaUsd: number) {
    this.incr("d:" + slot.day, deltaUsd);
    this.incr("m:" + slot.month, deltaUsd);
  }
  async getSpend(now = new Date()) {
    const s = spendSlot(now);
    return { day: this.spend.get("d:" + s.day) ?? 0, month: this.spend.get("m:" + s.month) ?? 0 };
  }
  async hit(key: string, windowMs: number) {
    const now = this.clock();
    const e = this.hits.get(key);
    if (!e || now >= e.until) {
      this.hits.set(key, { n: 1, until: now + windowMs });
      return 1;
    }
    return ++e.n;
  }
}

type FetchFn = typeof fetch;

export class UpstashPreviewStore implements PreviewStore {
  readonly kind = "upstash" as const;
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly fetchFn: FetchFn = fetch,
    private readonly timeoutMs = 1500,
    private readonly prefix = "hp:preview:",
  ) {
    if (!/^https:\/\//.test(url)) throw new Error("UPSTASH_REDIS_REST_URL must be https");
  }

  private async cmd(args: (string | number)[]): Promise<unknown> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(this.url.replace(/\/+$/, ""), {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(args.map(String)),
        signal: ctl.signal,
        cache: "no-store",
      });
      const body = (await res.json().catch(() => null)) as { result?: unknown; error?: unknown } | null;
      if (!res.ok || !body || body.error !== undefined) throw new Error(`upstash ${res.status}`);
      return body.result;
    } finally {
      clearTimeout(t);
    }
  }
  private k = (s: string) => this.prefix + s;
  private idx = () => this.k("queue");

  async putReport(r: StoredReport) {
    const ttl = Math.max(1, r.createdAt + RETENTION_MS - Date.now());
    await this.cmd(["SET", this.k("report:" + r.id), JSON.stringify(r), "PX", ttl]);
    await this.cmd(["ZADD", this.idx(), r.createdAt, r.id]);
  }
  async getReport(id: string) {
    const v = await this.cmd(["GET", this.k("report:" + id)]);
    if (typeof v !== "string") return null;
    try {
      return JSON.parse(v) as StoredReport;
    } catch {
      return null;
    }
  }
  async listReports(status?: ReviewStatus) {
    await this.cmd(["ZREMRANGEBYSCORE", this.idx(), "-inf", Date.now() - RETENTION_MS]);
    const ids = (await this.cmd(["ZRANGE", this.idx(), 0, -1])) as string[] | null;
    const out: StoredReport[] = [];
    for (const id of ids ?? []) {
      const r = await this.getReport(id);
      if (r && (!status || r.status === status)) out.push(r);
    }
    return out;
  }
  async setStatus(id: string, status: ReviewStatus) {
    const r = await this.getReport(id);
    if (!r) return null;
    r.status = status;
    // KEEPTTL: approving never extends the 30-day retention.
    await this.cmd(["SET", this.k("report:" + id), JSON.stringify(r), "KEEPTTL", "XX"]);
    return r;
  }
  private async incrSlot(slot: SpendSlot, by: number) {
    const dk = this.k("spend:d:" + slot.day);
    const mk = this.k("spend:m:" + slot.month);
    const day = Number(await this.cmd(["INCRBYFLOAT", dk, by]));
    await this.cmd(["PEXPIRE", dk, DAY_KEY_TTL_MS]);
    const month = Number(await this.cmd(["INCRBYFLOAT", mk, by]));
    await this.cmd(["PEXPIRE", mk, MONTH_KEY_TTL_MS]);
    return { day, month };
  }
  async reserveSpend(usd: number, caps: { dailyUsd: number; monthlyUsd: number }, now = new Date()) {
    const slot = spendSlot(now);
    const { day, month } = await this.incrSlot(slot, usd);
    if (!Number.isFinite(day) || !Number.isFinite(month) || day > caps.dailyUsd || month > caps.monthlyUsd) {
      await this.incrSlot(slot, -usd);
      return { ok: false, slot, usd, day, month };
    }
    return { ok: true, slot, usd, day, month };
  }
  async adjustSpend(slot: SpendSlot, deltaUsd: number) {
    if (deltaUsd !== 0) await this.incrSlot(slot, deltaUsd);
  }
  async getSpend(now = new Date()) {
    const s = spendSlot(now);
    const d = await this.cmd(["GET", this.k("spend:d:" + s.day)]);
    const m = await this.cmd(["GET", this.k("spend:m:" + s.month)]);
    return { day: Number(d ?? 0) || 0, month: Number(m ?? 0) || 0 };
  }
  async hit(key: string, windowMs: number) {
    const k = this.k("rl:" + key);
    await this.cmd(["SET", k, "0", "NX", "PX", Math.max(1, Math.floor(windowMs))]);
    return Number(await this.cmd(["INCR", k]));
  }
}

type Env = Record<string, string | undefined>;
let override: PreviewStore | null | undefined;

/** Shared store or null. NEVER falls back to memory: callers must fail closed on null. */
export function getPreviewStore(env: Env = process.env, fetchFn?: FetchFn): PreviewStore | null {
  if (override !== undefined) return override;
  const c = resolveSharedReplayStoreEnv(env);
  if (!c) return null;
  try {
    return new UpstashPreviewStore(c.url, c.token, fetchFn);
  } catch {
    return null;
  }
}
export function setPreviewStoreForTests(s: PreviewStore | null | undefined) {
  override = s;
}
