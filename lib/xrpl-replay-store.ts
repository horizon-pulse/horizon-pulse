/**
 * XRPL duplicate-payment (replay) store: one interface, two adapters.
 *
 * Design (Odin fix 4): a payment slot key (sha256 of network|Account|Sequence
 * or TicketSequence, see xrpl-rail.ts) is CLAIMED atomically before verify.
 * `claim` = set-if-absent "in_flight" with TTL; it returns the existing state
 * when the key is already held, so two instances racing on the same signed
 * tx cannot both reach the facilitator. After settle the state is
 * overwritten (settled / settle_failed / settle_unconfirmed, same TTL); when
 * nothing was charged the key is released.
 *
 *   - UpstashReplayStore: Upstash Redis REST (`SET key val NX PX ttl`, `GET`,
 *     `SET … PX`, `DEL`). Shared across Vercel instances. Selected only when
 *     BOTH UPSTASH_REDIS_REST_URL (https) and UPSTASH_REDIS_REST_TOKEN are set.
 *     Keys are namespaced `hp:xrpl:replay:<key>`; values are the state only.
 *   - MemoryReplayStore: per-instance Map (the previous behaviour). Used when
 *     Upstash env is absent, TESTNET ONLY: xrpl:0 is refused without Upstash
 *     (getXrplRailConfig + replayStoreOkFor in xrpl-rail.ts). Cross-instance replays are then caught only by the
 *     ledger-close-time check (settledBeforeRequest) in xrpl-rail.ts.
 *
 * Delivered vs not delivered (Odin 11:34 AM ET 10/18): "settled" = the paid
 * response was DELIVERED (the only state a duplicate gets 409 for).
 * "settle_unconfirmed@<firstSeenMs>" = charged-or-unknown, NOT delivered: a
 * retry of the same payment may redeem it once the validated ledger shows it
 * closed to payTo after firstSeen. "redeeming@<firstSeenMs>@<leaseStartMs>" =
 * one request holds the redemption (lease). Transitions out of an undelivered
 * state go through `cas` (atomic compare-and-set: Upstash EVAL GET==expected →
 * SET PX; memory: synchronous), so only one request can claim delivery. Values
 * carry timestamps only (no payer data); keys and TTLs are unchanged.
 *
 * Delta 3 (Odin 11:56 AM ET 10/18, H1/M1/N3): the claim writes
 * `in_flight@<firstSeenMs>#<SUBMITTED_TX_HASH>:<LastLedgerSequence>` and every later value of the slot keeps
 * that `#hash:lls` suffix (public ledger data, no payer data). Every later lookup / never-landed proof uses ONLY
 * these stored values; a retry blob only locates the slot. A redemption lease and its delivered mark carry an
 * owner nonce (`!<hex>`) so the failure reset can be an atomic compare-and-set against exactly our own values
 * (casAny, one Lua script).
 *
 * Delta 4 (Odin 12:07 N6): a PROVEN never-landed submitted tx deletes the slot with an atomic compare-and-delete
 * (casDelete, one Lua script, against exactly the value the deleter owns), so the same Account+Sequence can be
 * re-signed and paid; settle_failed now only means "failed on the validated ledger" (sequence consumed).
 *
 * Store errors fail CLOSED on claim (the XRPL payment is not accepted; the
 * caller serves the Base-only 402, nothing is charged) and are logged on
 * set/release.
 */

export type ReplayState = "in_flight" | "settled" | "settle_failed" | "settle_unconfirmed" | "redeeming";
const STATES: readonly ReplayState[] = ["in_flight", "settled", "settle_failed", "settle_unconfirmed", "redeeming"];

/**
 * Parsed store value: state; for claimed/undelivered states when we first saw the payment and the redemption
 * lease start; the lease owner nonce; and the SUBMITTED tx hash + its LastLedgerSequence (set at claim time).
 */
export type ReplayRecord = { state: ReplayState; firstSeen?: number; lease?: number; owner?: string; hash?: string; lls?: number };

/**
 * `state[@firstSeen[@lease]][!owner][#HASH:LLS]` (ms since epoch / ledger index: integers; owner: 8-32 lowercase
 * hex; HASH: 64 uppercase hex). The bare forms `state`, `state@firstSeen`, `state@firstSeen@lease` stay valid.
 */
export function encodeReplayValue(r: ReplayRecord): string {
  let v: string = r.state;
  if (r.firstSeen !== undefined) {
    v += `@${Math.floor(r.firstSeen)}`;
    if (r.lease !== undefined) v += `@${Math.floor(r.lease)}`;
  }
  if (r.owner !== undefined && /^[0-9a-f]{8,32}$/.test(r.owner)) v += `!${r.owner}`;
  if (r.hash !== undefined && r.lls !== undefined && /^[0-9A-Fa-f]{64}$/.test(r.hash) && Number.isSafeInteger(r.lls) && r.lls > 0) {
    v += `#${r.hash.toUpperCase()}:${r.lls}`;
  }
  return v;
}

/** Inverse of encodeReplayValue; null for anything unrecognised. */
export function parseReplayValue(raw: unknown): ReplayRecord | null {
  if (typeof raw !== "string") return null;
  const m = /^([a-z_]+)(?:@(\d{1,16}))?(?:@(\d{1,16}))?(?:!([0-9a-f]{8,32}))?(?:#([0-9A-F]{64}):(\d{1,12}))?$/.exec(raw);
  if (!m || !(STATES as readonly string[]).includes(m[1])) return null;
  const r: ReplayRecord = { state: m[1] as ReplayState };
  if (m[2] !== undefined) r.firstSeen = Number(m[2]);
  if (m[3] !== undefined) r.lease = Number(m[3]);
  if (m[4] !== undefined) r.owner = m[4];
  if (m[5] !== undefined) {
    r.hash = m[5];
    r.lls = Number(m[6]);
  }
  return r;
}

export interface ReplayStore {
  readonly kind: "memory" | "upstash";
  /**
   * Atomically claim `key` (set-if-absent) with `value` (default "in_flight"; the rail writes
   * `in_flight@firstSeen#hash:lls`). null = claimed by us; otherwise the state already held.
   */
  claim(key: string, ttlMs: number, value?: string): Promise<ReplayState | null>;
  /** Write a state (or an encoded value from encodeReplayValue). */
  set(key: string, state: ReplayState | string, ttlMs: number): Promise<void>;
  release(key: string): Promise<void>;
  /** Raw value (see encodeReplayValue) or null. */
  get?(key: string): Promise<string | null>;
  /** Atomic compare-and-set: write `next` (TTL ttlMs) only if the current value is exactly `expected`. */
  cas?(key: string, expected: string, next: string, ttlMs: number): Promise<boolean>;
  /** Atomic compare-and-set against several exact values (one Lua script on Upstash). */
  casAny?(key: string, expected: readonly string[], next: string, ttlMs: number): Promise<boolean>;
  /** Atomic compare-and-DELETE: remove the key only if its value is exactly `expected` (one Lua script on Upstash). */
  casDelete?(key: string, expected: string): Promise<boolean>;
  /**
   * Shared stores only: run a trivial server-side script (`EVAL "return 1" 0`) and throw unless it answers 1.
   * cas depends on EVAL; the rail treats a failing probe as the XRPL rail confirmed absent (Odin 11:44 (e)).
   */
  probeEval?(): Promise<void>;
  clear?(): void;
}

export class MemoryReplayStore implements ReplayStore {
  readonly kind = "memory" as const;
  private readonly m = new Map<string, { state: string; until: number }>();
  constructor(private readonly maxEntries = 50_000) {}

  private read(key: string): string | null {
    const e = this.m.get(key);
    if (!e) return null;
    if (Date.now() >= e.until) {
      this.m.delete(key);
      return null;
    }
    return e.state;
  }
  private put(key: string, state: string, ttlMs: number): void {
    this.m.delete(key);
    this.m.set(key, { state, until: Date.now() + ttlMs });
    if (this.m.size > this.maxEntries) {
      const now = Date.now();
      for (const [k, v] of this.m) if (now >= v.until) this.m.delete(k);
      for (const k of this.m.keys()) {
        if (this.m.size <= this.maxEntries) break;
        this.m.delete(k);
      }
    }
  }
  async claim(key: string, ttlMs: number, value = "in_flight"): Promise<ReplayState | null> {
    const cur = this.read(key);
    if (cur) return parseReplayValue(cur)?.state ?? "in_flight";
    this.put(key, value, ttlMs);
    return null;
  }
  async set(key: string, state: ReplayState | string, ttlMs: number): Promise<void> {
    this.put(key, state, ttlMs);
  }
  async get(key: string): Promise<string | null> {
    return this.read(key);
  }
  /** Synchronous body: atomic within one instance (memory store = testnet only). */
  async cas(key: string, expected: string, next: string, ttlMs: number): Promise<boolean> {
    if (this.read(key) !== expected) return false;
    this.put(key, next, ttlMs);
    return true;
  }
  async casAny(key: string, expected: readonly string[], next: string, ttlMs: number): Promise<boolean> {
    const cur = this.read(key);
    if (cur === null || !expected.includes(cur)) return false;
    this.put(key, next, ttlMs);
    return true;
  }
  async casDelete(key: string, expected: string): Promise<boolean> {
    if (this.read(key) !== expected) return false;
    this.m.delete(key);
    return true;
  }
  async release(key: string): Promise<void> {
    this.m.delete(key);
  }
  clear(): void {
    this.m.clear();
  }
  get size(): number {
    return this.m.size;
  }
}

type FetchFn = typeof fetch;

/** KEYS[1]; ARGV = expected, next, ttlMs. Returns 1 if swapped, else 0. */
export const CAS_SCRIPT =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3]) return 1 else return 0 end";

/** KEYS[1]; ARGV = next, ttlMs, expected1, expected2, ... Swaps (returns 1) only if the current value equals one of them. */
export const CAS_ANY_SCRIPT =
  "local cur = redis.call('GET', KEYS[1]) if not cur then return 0 end for i = 3, #ARGV do if cur == ARGV[i] then redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2]) return 1 end end return 0";

/** KEYS[1]; ARGV[1] = expected. Deletes (returns 1) only if the current value equals it exactly. */
export const CAS_DELETE_SCRIPT = "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) return 1 else return 0 end";

/** The trivial script probeEval runs: no keys, no data, answers 1. */
export const EVAL_PROBE_SCRIPT = "return 1";

export class UpstashReplayStore implements ReplayStore {
  readonly kind = "upstash" as const;
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly fetchFn: FetchFn = fetch,
    private readonly timeoutMs = 1500,
    private readonly prefix = "hp:xrpl:replay:",
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

  async claim(key: string, ttlMs: number, value = "in_flight"): Promise<ReplayState | null> {
    const k = this.prefix + key;
    const r = await this.cmd(["SET", k, value, "NX", "PX", Math.max(1, Math.floor(ttlMs))]);
    if (r === "OK") return null;
    const cur = await this.cmd(["GET", k]);
    // Held but unreadable/expired between calls: treat as in_flight (never a second settle).
    return parseReplayValue(cur)?.state ?? "in_flight";
  }
  async set(key: string, state: ReplayState | string, ttlMs: number): Promise<void> {
    await this.cmd(["SET", this.prefix + key, state, "PX", Math.max(1, Math.floor(ttlMs))]);
  }
  async get(key: string): Promise<string | null> {
    const v = await this.cmd(["GET", this.prefix + key]);
    return typeof v === "string" ? v : null;
  }
  /** Atomic on the server: one Lua script (GET == expected → SET PX). */
  async cas(key: string, expected: string, next: string, ttlMs: number): Promise<boolean> {
    const r = await this.cmd(["EVAL", CAS_SCRIPT, 1, this.prefix + key, expected, next, Math.max(1, Math.floor(ttlMs))]);
    return r === 1 || r === "1";
  }
  /** Atomic on the server: one Lua script (GET in expected → SET PX). */
  async casAny(key: string, expected: readonly string[], next: string, ttlMs: number): Promise<boolean> {
    if (expected.length === 0) return false;
    const r = await this.cmd(["EVAL", CAS_ANY_SCRIPT, 1, this.prefix + key, next, Math.max(1, Math.floor(ttlMs)), ...expected]);
    return r === 1 || r === "1";
  }
  /** Atomic on the server: one Lua script (GET == expected → DEL). */
  async casDelete(key: string, expected: string): Promise<boolean> {
    const r = await this.cmd(["EVAL", CAS_DELETE_SCRIPT, 1, this.prefix + key, expected]);
    return r === 1 || r === "1";
  }
  async probeEval(): Promise<void> {
    const r = await this.cmd(["EVAL", EVAL_PROBE_SCRIPT, 0]);
    if (r !== 1 && r !== "1") throw new Error("upstash EVAL probe: unexpected result");
  }
  async release(key: string): Promise<void> {
    await this.cmd(["DEL", this.prefix + key]);
  }
}

type Env = Record<string, string | undefined>;

/**
 * Shared replay-store credentials, or null. Never throws.
 *   1. UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (both set);
 *   2. only when NEITHER UPSTASH_REDIS_REST_* var is set: the Vercel
 *      Marketplace Upstash names KV_REST_API_URL + KV_REST_API_TOKEN
 *      (the read-write token). KV_REST_API_READ_ONLY_TOKEN is NEVER read:
 *      claim needs SET NX.
 * Fail closed: a half-set pair (either family), or a non-https URL → null,
 * with no mixing across the two families.
 */
export function resolveSharedReplayStoreEnv(env: Env): { url: string; token: string; source: "upstash" | "vercel_kv" } | null {
  const uUrl = (env.UPSTASH_REDIS_REST_URL ?? "").trim();
  const uTok = (env.UPSTASH_REDIS_REST_TOKEN ?? "").trim();
  let url: string, token: string, source: "upstash" | "vercel_kv";
  if (uUrl || uTok) {
    if (!uUrl || !uTok) return null;
    [url, token, source] = [uUrl, uTok, "upstash"];
  } else {
    const kUrl = (env.KV_REST_API_URL ?? "").trim();
    const kTok = (env.KV_REST_API_TOKEN ?? "").trim();
    if (!kUrl || !kTok) return null;
    [url, token, source] = [kUrl, kTok, "vercel_kv"];
  }
  if (!/^https:\/\//.test(url)) return null;
  return { url, token, source };
}

/** Upstash when resolveSharedReplayStoreEnv finds credentials, else in-memory (testnet only; xrpl:0 refuses it). Never throws. */
export function createReplayStore(env: Env = process.env, fetchFn?: FetchFn): ReplayStore {
  const c = resolveSharedReplayStoreEnv(env);
  if (c) {
    try {
      return new UpstashReplayStore(c.url, c.token, fetchFn);
    } catch {
      /* bad URL → memory */
    }
  }
  return new MemoryReplayStore();
}
