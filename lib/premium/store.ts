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
  /** Odin P5: atomically prune (score <= pruneMax) each zset, and add member to all only if every one is under its limit. */
  reserve(keys: string[], limits: number[], member: string, score: number, pruneMax: number, ttlS: number): Promise<boolean>;
  /** Atomic compare-and-delete against exactly `expected`. */
  casDel(key: string, expected: string): Promise<boolean>;
  /** Odin 10/19: atomic spend reservation (one Lua script): add `amount` to the float counter only if the total stays <= cap. */
  spendReserve(key: string, amount: number, cap: number, ttlS: number): Promise<boolean>;
  /** INCRBYFLOAT key delta (+ EXPIRE); used to refund / reconcile a reservation. */
  spendAdjust(key: string, delta: number, ttlS: number): Promise<void>;
  /**
   * Seller DD atomic caps (Odin 10/21 #3): ONE Lua script checks every counter against its cap and, only if all fit, adds
   * every amount. Returns 0 on success, or the 1-based index of the first counter that would overshoot (nothing written).
   */
  spendReserveMulti(keys: string[], amounts: number[], caps: number[], ttlS: number[], kinds?: CounterKind[]): Promise<number>;
  /**
   * Sentinel LOW-B: apply `deltas` to `keys` ONCE per `marker` in ONE Lua call (SET marker NX first; if it already exists
   * nothing happens and false is returned), then ZREM member from zkey and DEL delKeys. Safe to repeat.
   */
  adjustOnce(marker: string, markerTtlS: number, keys: string[], deltas: number[], ttlS: number[], kinds: CounterKind[], zkey: string, member: string, delKeys: string[]): Promise<boolean>;
}
/** Sentinel LOW-A: "int" = integer counter (micro-USD or a count; INCRBY), "float" = legacy float counter (INCRBYFLOAT). */
export type CounterKind = "int" | "float";
const fmtAmt = (a: number, k: CounterKind) => (k === "int" ? String(Math.trunc(a)) : a.toFixed(8));
const assertInt = (a: number[], k: CounterKind[]) => { a.forEach((x, i) => { if (k[i] === "int" && !Number.isSafeInteger(x)) throw new StoreError("non_integer_amount"); }); };

export const SPEND_RESERVE_LUA =
  "local cur = tonumber(redis.call('GET', KEYS[1]) or '0') local a = tonumber(ARGV[1]) if cur + a > tonumber(ARGV[2]) then return 0 end redis.call('INCRBYFLOAT', KEYS[1], ARGV[1]) redis.call('EXPIRE', KEYS[1], ARGV[3]) return 1";

/** ARGV: amounts[n], caps[n], ttls[n], kinds[n] ("int" -> INCRBY, exact compare; "float" -> INCRBYFLOAT, 1e-9 slack). */
export const SPEND_RESERVE_MULTI_LUA =
  "local n = #KEYS for i = 1, n do local cur = tonumber(redis.call('GET', KEYS[i]) or '0') local slack = 0 if ARGV[3 * n + i] == 'float' then slack = 1e-9 end if cur + tonumber(ARGV[i]) > tonumber(ARGV[n + i]) + slack then return i end end for i = 1, n do if ARGV[3 * n + i] == 'int' then redis.call('INCRBY', KEYS[i], ARGV[i]) else redis.call('INCRBYFLOAT', KEYS[i], ARGV[i]) end redis.call('EXPIRE', KEYS[i], ARGV[2 * n + i]) end return 0";
/** KEYS: marker, zkey, counters[n], dels[m]. ARGV: markerTtl, member, n, deltas[n], ttls[n], kinds[n]. */
export const ADJUST_ONCE_LUA =
  "if not redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[1]) then return 0 end local n = tonumber(ARGV[3]) for i = 1, n do local k = KEYS[2 + i] if ARGV[3 + 2 * n + i] == 'int' then redis.call('INCRBY', k, ARGV[3 + i]) else redis.call('INCRBYFLOAT', k, ARGV[3 + i]) end redis.call('EXPIRE', k, ARGV[3 + n + i]) end redis.call('ZREM', KEYS[2], ARGV[2]) for j = 3 + n, #KEYS do redis.call('DEL', KEYS[j]) end return 1";

export const CAS_LUA = "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3]) return 1 else return 0 end";
export const CASDEL_LUA = "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) return 1 else return 0 end";

export const RESERVE_LUA =
  "local n = #KEYS for i = 1, n do redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', ARGV[3]) if redis.call('ZCARD', KEYS[i]) >= tonumber(ARGV[4 + i]) then return 0 end end for i = 1, n do redis.call('ZADD', KEYS[i], ARGV[2], ARGV[1]) redis.call('EXPIRE', KEYS[i], ARGV[4]) end return 1";

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
  async reserve(keys: string[], limits: number[], member: string, score: number, pruneMax: number, ttlS: number) {
    const [r] = await this.pipe([["EVAL", RESERVE_LUA, keys.length, ...keys.map(this.k), member, score, pruneMax, Math.max(1, Math.ceil(ttlS)), ...limits]]);
    return Number(r) === 1;
  }
  async spendReserve(key: string, amount: number, cap: number, ttlS: number) {
    const [r] = await this.pipe([["EVAL", SPEND_RESERVE_LUA, 1, this.k(key), amount.toFixed(8), cap.toFixed(8), Math.max(1, Math.ceil(ttlS))]]);
    return Number(r) === 1;
  }
  async spendReserveMulti(keys: string[], amounts: number[], caps: number[], ttlS: number[], kinds: CounterKind[] = keys.map(() => "float")) {
    assertInt(amounts, kinds); assertInt(caps, kinds);
    const [r] = await this.pipe([["EVAL", SPEND_RESERVE_MULTI_LUA, keys.length, ...keys.map(this.k), ...amounts.map((a, i) => fmtAmt(a, kinds[i]!)), ...caps.map((c, i) => fmtAmt(c, kinds[i]!)), ...ttlS.map((t) => Math.max(1, Math.ceil(t))), ...kinds]]);
    const n = Number(r);
    if (!Number.isInteger(n) || n < 0 || n > keys.length) throw new StoreError("store_error");
    return n;
  }
  async adjustOnce(marker: string, markerTtlS: number, keys: string[], deltas: number[], ttlS: number[], kinds: CounterKind[], zkey: string, member: string, delKeys: string[]) {
    assertInt(deltas, kinds);
    const [r] = await this.pipe([["EVAL", ADJUST_ONCE_LUA, 2 + keys.length + delKeys.length, this.k(marker), this.k(zkey), ...keys.map(this.k), ...delKeys.map(this.k), Math.max(1, Math.ceil(markerTtlS)), member, keys.length, ...deltas.map((d, i) => fmtAmt(d, kinds[i]!)), ...ttlS.map((t) => Math.max(1, Math.ceil(t))), ...kinds]]);
    return Number(r) === 1;
  }
  async spendAdjust(key: string, delta: number, ttlS: number) {
    await this.pipe([
      ["INCRBYFLOAT", this.k(key), delta.toFixed(8)],
      ["EXPIRE", this.k(key), Math.max(1, Math.ceil(ttlS))],
    ]);
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
  async reserve(keys: string[], limits: number[], member: string, score: number, pruneMax: number, ttlS: number) {
    // synchronous body = atomic (mirrors the single Lua call)
    for (let i = 0; i < keys.length; i++) {
      const m = this.z.get(keys[i]);
      if (m) for (const [k, sc] of m) if (sc <= pruneMax) m.delete(k);
      if ((m?.size ?? 0) >= limits[i]) return false;
    }
    for (const key of keys) {
      this.writes.push({ op: "zadd", key, ttlMs: ttlS * 1000 });
      const m = this.z.get(key) ?? new Map<string, number>();
      m.set(member, score);
      this.z.set(key, m);
    }
    return true;
  }
  async casDel(key: string, expected: string) {
    if (this.alive(key)?.v !== expected) return false;
    this.kv.delete(key);
    return true;
  }
  async spendReserve(key: string, amount: number, cap: number, ttlS: number) {
    const cur = Number(this.alive(key)?.v ?? "0");
    if (cur + amount > cap) return false;
    this.writes.push({ op: "spendReserve", key, ttlMs: ttlS * 1000 });
    this.kv.set(key, { v: String(cur + amount), exp: this.now() + ttlS * 1000 });
    return true;
  }
  async spendReserveMulti(keys: string[], amounts: number[], caps: number[], ttlS: number[], kinds: CounterKind[] = keys.map(() => "float")) {
    // synchronous body = atomic (mirrors the single Lua call)
    assertInt(amounts, kinds); assertInt(caps, kinds);
    for (let i = 0; i < keys.length; i++) if (Number(this.alive(keys[i])?.v ?? "0") + amounts[i] > caps[i] + (kinds[i] === "float" ? 1e-9 : 0)) return i + 1;
    for (let i = 0; i < keys.length; i++) {
      this.writes.push({ op: "spendReserve", key: keys[i], ttlMs: ttlS[i] * 1000 });
      this.kv.set(keys[i], { v: String(Number(this.alive(keys[i])?.v ?? "0") + amounts[i]), exp: this.now() + ttlS[i] * 1000 });
    }
    return 0;
  }
  async adjustOnce(marker: string, markerTtlS: number, keys: string[], deltas: number[], ttlS: number[], kinds: CounterKind[], zkey: string, member: string, delKeys: string[]) {
    assertInt(deltas, kinds);
    if (this.alive(marker)) return false;
    this.writes.push({ op: "set", key: marker, ttlMs: markerTtlS * 1000 });
    this.kv.set(marker, { v: "1", exp: this.now() + markerTtlS * 1000 });
    for (let i = 0; i < keys.length; i++) {
      this.writes.push({ op: "spendAdjust", key: keys[i]!, ttlMs: ttlS[i]! * 1000 });
      this.kv.set(keys[i]!, { v: String(Number(this.alive(keys[i]!)?.v ?? "0") + deltas[i]!), exp: this.now() + ttlS[i]! * 1000 });
    }
    this.z.get(zkey)?.delete(member);
    for (const k of delKeys) this.kv.delete(k);
    return true;
  }
  async spendAdjust(key: string, delta: number, ttlS: number) {
    const cur = Number(this.alive(key)?.v ?? "0");
    this.writes.push({ op: "spendAdjust", key, ttlMs: ttlS * 1000 });
    this.kv.set(key, { v: String(cur + delta), exp: this.now() + ttlS * 1000 });
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
