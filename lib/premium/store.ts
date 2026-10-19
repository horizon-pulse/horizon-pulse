/**
 * Premium KV store (async scope §2). One small interface, two backends:
 *   - Upstash REST (the app's existing read-write creds via resolveSharedReplayStoreEnv; never
 *     KV_REST_API_READ_ONLY_TOKEN), prefix `hp:premium:` in production and `hp:premium:pv:` everywhere else
 *     (Preview resolves to the same Upstash, so Preview keys can never collide with prod job keys);
 *   - in-memory (tests only).
 * EVERY write carries a TTL: the write methods take it as a required argument (tests assert it on the wire).
 * No key is ever written outside the prefix. No SCAN/KEYS: jobs are found through the job-scoped index ZSETs only.
 */
import { resolveSharedReplayStoreEnv } from "@/lib/xrpl-replay-store";

export interface PremiumStore {
  readonly kind: "upstash" | "memory";
  get(key: string): Promise<string | null>;
  /** SET key value EX ttlS. */
  set(key: string, value: string, ttlS: number): Promise<void>;
  /** SET key value NX PX ttlMs → true when this call created it. */
  setNx(key: string, value: string, ttlMs: number): Promise<boolean>;
  del(...keys: string[]): Promise<void>;
  /** ZADD + EXPIRE ttlS on the set key. */
  zadd(key: string, score: number, member: string, ttlS: number): Promise<void>;
  zrem(key: string, member: string): Promise<void>;
  /** Members with score <= max, ascending, at most `limit`. */
  zrangeByScore(key: string, max: number, limit: number): Promise<string[]>;
  /** ZREMRANGEBYSCORE key -inf max, then ZCARD. */
  zcardAfterPrune(key: string, pruneMax: number): Promise<number>;
  /** Atomic compare-and-set: replace only if the current value is exactly `expected` (one Lua script). */
  cas(key: string, expected: string, next: string, ttlMs: number): Promise<boolean>;
  /** Atomic compare-and-delete against exactly `expected`. */
  casDel(key: string, expected: string): Promise<boolean>;
}

export const CAS_LUA = "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3]) return 1 else return 0 end";
export const CASDEL_LUA = "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) return 1 else return 0 end";

export type Env = Record<string, string | undefined>;
export const premiumPrefix = (env: Env = process.env) => (env.VERCEL_ENV === "production" ? "hp:premium:" : "hp:premium:pv:");

export const STORE_TIMEOUT_MS = 2_000;

export class StoreError extends Error {}

export class UpstashPremiumStore implements PremiumStore {
  readonly kind = "upstash" as const;
  constructor(
    private url: string,
    private token: string,
    private prefix: string,
    private f: typeof fetch = fetch,
  ) {}
  private k = (key: string) => `${this.prefix}${key}`;
  async pipe(cmds: (string | number)[][]): Promise<unknown[]> {
    let res: Response;
    try {
      res = await this.f(`${this.url.replace(/\/+$/, "")}/pipeline`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: JSON.stringify(cmds),
        signal: AbortSignal.timeout(STORE_TIMEOUT_MS),
        cache: "no-store",
      });
    } catch {
      throw new StoreError("store_unreachable");
    }
    if (!res.ok) throw new StoreError(`store_http_${res.status}`);
    const j = (await res.json().catch(() => null)) as { result?: unknown; error?: string }[] | null;
    if (!Array.isArray(j) || j.some((x) => x?.error)) throw new StoreError("store_error");
    return j.map((x) => x.result);
  }
  async get(key: string) {
    const [r] = await this.pipe([["GET", this.k(key)]]);
    return typeof r === "string" ? r : null;
  }
  async set(key: string, value: string, ttlS: number) {
    await this.pipe([["SET", this.k(key), value, "EX", Math.max(1, Math.ceil(ttlS))]]);
  }
  async setNx(key: string, value: string, ttlMs: number) {
    const [r] = await this.pipe([["SET", this.k(key), value, "NX", "PX", Math.max(1, Math.ceil(ttlMs))]]);
    return r === "OK";
  }
  async del(...keys: string[]) {
    if (keys.length) await this.pipe([["DEL", ...keys.map(this.k)]]);
  }
  async zadd(key: string, score: number, member: string, ttlS: number) {
    await this.pipe([
      ["ZADD", this.k(key), score, member],
      ["EXPIRE", this.k(key), Math.max(1, Math.ceil(ttlS))],
    ]);
  }
  async zrem(key: string, member: string) {
    await this.pipe([["ZREM", this.k(key), member]]);
  }
  async zrangeByScore(key: string, max: number, limit: number) {
    const [r] = await this.pipe([["ZRANGE", this.k(key), "-inf", max, "BYSCORE", "LIMIT", 0, limit]]);
    return Array.isArray(r) ? r.filter((x): x is string => typeof x === "string") : [];
  }
  async zcardAfterPrune(key: string, pruneMax: number) {
    const r = await this.pipe([
      ["ZREMRANGEBYSCORE", this.k(key), "-inf", pruneMax],
      ["ZCARD", this.k(key)],
    ]);
    return Number(r[1] ?? 0);
  }
  async cas(key: string, expected: string, next: string, ttlMs: number) {
    const [r] = await this.pipe([["EVAL", CAS_LUA, 1, this.k(key), expected, next, Math.max(1, Math.ceil(ttlMs))]]);
    return Number(r) === 1;
  }
  async casDel(key: string, expected: string) {
    const [r] = await this.pipe([["EVAL", CASDEL_LUA, 1, this.k(key), expected]]);
    return Number(r) === 1;
  }
}

/** Test backend. Records every write with its TTL so tests can assert "no write without a TTL". */
export class MemoryPremiumStore implements PremiumStore {
  readonly kind = "memory" as const;
  now: () => number = () => Date.now();
  kv = new Map<string, { v: string; exp: number }>();
  z = new Map<string, Map<string, number>>();
  writes: { op: string; key: string; ttlMs: number | null }[] = [];
  private alive(key: string) {
    const e = this.kv.get(key);
    if (e && e.exp <= this.now()) this.kv.delete(key);
    return this.kv.get(key) ?? null;
  }
  async get(key: string) {
    return this.alive(key)?.v ?? null;
  }
  async set(key: string, value: string, ttlS: number) {
    this.writes.push({ op: "set", key, ttlMs: ttlS * 1000 });
    this.kv.set(key, { v: value, exp: this.now() + ttlS * 1000 });
  }
  async setNx(key: string, value: string, ttlMs: number) {
    this.writes.push({ op: "setNx", key, ttlMs });
    if (this.alive(key)) return false;
    this.kv.set(key, { v: value, exp: this.now() + ttlMs });
    return true;
  }
  async del(...keys: string[]) {
    for (const k of keys) this.kv.delete(k);
  }
  async zadd(key: string, score: number, member: string, ttlS: number) {
    this.writes.push({ op: "zadd", key, ttlMs: ttlS * 1000 });
    const m = this.z.get(key) ?? new Map();
    m.set(member, score);
    this.z.set(key, m);
  }
  async zrem(key: string, member: string) {
    this.z.get(key)?.delete(member);
  }
  async zrangeByScore(key: string, max: number, limit: number) {
    return [...(this.z.get(key) ?? new Map<string, number>()).entries()].filter(([, s]) => s <= max).sort((a, b) => a[1] - b[1]).slice(0, limit).map(([m]) => m);
  }
  async zcardAfterPrune(key: string, pruneMax: number) {
    const m = this.z.get(key);
    if (!m) return 0;
    for (const [k, s] of m) if (s <= pruneMax) m.delete(k);
    return m.size;
  }
  async cas(key: string, expected: string, next: string, ttlMs: number) {
    this.writes.push({ op: "cas", key, ttlMs });
    if (this.alive(key)?.v !== expected) return false;
    this.kv.set(key, { v: next, exp: this.now() + ttlMs });
    return true;
  }
  async casDel(key: string, expected: string) {
    if (this.alive(key)?.v !== expected) return false;
    this.kv.delete(key);
    return true;
  }
}

let override: PremiumStore | null | undefined;
/** Tests only: install a store (null = "no store configured"). */
export function setPremiumStoreForTests(s: PremiumStore | null | undefined) {
  override = s;
}

/** The store, or null when no read-write Upstash creds are configured (callers fail closed: uncharged 503). */
export function premiumStore(env: Env = process.env): PremiumStore | null {
  if (override !== undefined) return override;
  if (env.VITEST) return null;
  const c = resolveSharedReplayStoreEnv(env);
  return c ? new UpstashPremiumStore(c.url, c.token, premiumPrefix(env)) : null;
}
