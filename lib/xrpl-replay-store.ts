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
 * Store errors fail CLOSED on claim (the XRPL payment is not accepted; the
 * caller serves the Base-only 402, nothing is charged) and are logged on
 * set/release.
 */

export type ReplayState = "in_flight" | "settled" | "settle_failed" | "settle_unconfirmed";
const STATES: readonly ReplayState[] = ["in_flight", "settled", "settle_failed", "settle_unconfirmed"];

export interface ReplayStore {
  readonly kind: "memory" | "upstash";
  /** Atomically claim `key` as in_flight. null = claimed by us; otherwise the state already held. */
  claim(key: string, ttlMs: number): Promise<ReplayState | null>;
  set(key: string, state: ReplayState, ttlMs: number): Promise<void>;
  release(key: string): Promise<void>;
  clear?(): void;
}

export class MemoryReplayStore implements ReplayStore {
  readonly kind = "memory" as const;
  private readonly m = new Map<string, { state: ReplayState; until: number }>();
  constructor(private readonly maxEntries = 50_000) {}

  private get(key: string): ReplayState | null {
    const e = this.m.get(key);
    if (!e) return null;
    if (Date.now() >= e.until) {
      this.m.delete(key);
      return null;
    }
    return e.state;
  }
  private put(key: string, state: ReplayState, ttlMs: number): void {
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
  async claim(key: string, ttlMs: number): Promise<ReplayState | null> {
    const cur = this.get(key);
    if (cur) return cur;
    this.put(key, "in_flight", ttlMs);
    return null;
  }
  async set(key: string, state: ReplayState, ttlMs: number): Promise<void> {
    this.put(key, state, ttlMs);
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

  async claim(key: string, ttlMs: number): Promise<ReplayState | null> {
    const k = this.prefix + key;
    const r = await this.cmd(["SET", k, "in_flight", "NX", "PX", Math.max(1, Math.floor(ttlMs))]);
    if (r === "OK") return null;
    const cur = await this.cmd(["GET", k]);
    // Held but unreadable/expired between calls: treat as in_flight (never a second settle).
    return typeof cur === "string" && (STATES as readonly string[]).includes(cur) ? (cur as ReplayState) : "in_flight";
  }
  async set(key: string, state: ReplayState, ttlMs: number): Promise<void> {
    await this.cmd(["SET", this.prefix + key, state, "PX", Math.max(1, Math.floor(ttlMs))]);
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
