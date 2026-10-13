/**
 * Enforced model-spend cap for /api/discourse/split (plan v2, Odin PASS).
 *
 * One atomic Lua EVAL reserves the worst-case cost on BOTH the UTC day and
 * UTC month counters, or reserves nothing if either would cross its cap.
 * After the call the reservation is reconciled to the usage-based cost
 * (delta may be negative). Redis unreachable -> throws -> caller fails closed.
 */
import { resolveSharedReplayStoreEnv } from "@/lib/xrpl-replay-store";

type Env = Record<string, string | undefined>;
type FetchFn = typeof fetch;

/** Caps: $1/day, $15/month. Env vars can only LOWER them (Math.min(env, default)), never raise. */
export const DEFAULT_DAILY_CAP_USD = 1;
export const DEFAULT_MONTHLY_CAP_USD = 15;

function capFrom(raw: string | undefined, dflt: number): number {
  const n = raw === undefined || raw.trim() === "" ? dflt : Number(raw);
  if (!Number.isFinite(n) || n < 0) return dflt;
  return Math.min(n, dflt);
}

export function spendCaps(env: Env = process.env): { dailyUsd: number; monthlyUsd: number } {
  return {
    dailyUsd: capFrom(env.DISCOURSE_DAILY_USD_CAP, DEFAULT_DAILY_CAP_USD),
    monthlyUsd: capFrom(env.DISCOURSE_MONTHLY_USD_CAP, DEFAULT_MONTHLY_CAP_USD),
  };
}

export function spendKeys(now: Date): { day: string; month: string } {
  const iso = now.toISOString();
  return { day: `hp:discourse:spend:d:${iso.slice(0, 10)}`, month: `hp:discourse:spend:m:${iso.slice(0, 7)}` };
}

export const DAY_TTL_S = 2 * 86_400;
export const MONTH_TTL_S = 35 * 86_400;

/**
 * KEYS[1]=day KEYS[2]=month; ARGV: amount, dayCap, monthCap, dayTtl, monthTtl.
 * Returns 1 if reserved, 0 if refused (nothing changed). Atomic in Redis.
 */
export const RESERVE_LUA = `
local amt = tonumber(ARGV[1])
local d = tonumber(redis.call('GET', KEYS[1]) or '0')
local m = tonumber(redis.call('GET', KEYS[2]) or '0')
if d + amt > tonumber(ARGV[2]) or m + amt > tonumber(ARGV[3]) then return 0 end
redis.call('INCRBYFLOAT', KEYS[1], ARGV[1])
redis.call('INCRBYFLOAT', KEYS[2], ARGV[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[5]))
return 1
`.trim();

/** KEYS[1]=day KEYS[2]=month; ARGV[1]=delta (may be negative). */
export const ADJUST_LUA = `
redis.call('INCRBYFLOAT', KEYS[1], ARGV[1])
redis.call('INCRBYFLOAT', KEYS[2], ARGV[1])
return 1
`.trim();

export interface SpendStore {
  /** true = reserved; false = cap reached. Throws if the store is unreachable. */
  reserve(usd: number, now: Date): Promise<boolean>;
  adjust(deltaUsd: number, now: Date): Promise<void>;
}

const fmt = (n: number) => n.toFixed(8);

export class UpstashSpendStore implements SpendStore {
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly caps: { dailyUsd: number; monthlyUsd: number },
    private readonly fetchFn: FetchFn = fetch,
    private readonly timeoutMs = 1500,
  ) {
    if (!/^https:\/\//.test(url)) throw new Error("spend store URL must be https");
  }

  private async cmd(args: string[]): Promise<unknown> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(this.url.replace(/\/+$/, ""), {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(args),
        signal: ctl.signal,
        cache: "no-store",
      });
      const body = (await res.json().catch(() => null)) as { result?: unknown; error?: unknown } | null;
      if (!res.ok || !body || body.error !== undefined) throw new Error(`spend_store ${res.status}`);
      return body.result;
    } finally {
      clearTimeout(t);
    }
  }

  async reserve(usd: number, now: Date): Promise<boolean> {
    const k = spendKeys(now);
    const r = await this.cmd(["EVAL", RESERVE_LUA, "2", k.day, k.month, fmt(usd), fmt(this.caps.dailyUsd), fmt(this.caps.monthlyUsd), String(DAY_TTL_S), String(MONTH_TTL_S)]);
    return Number(r) === 1;
  }

  async adjust(deltaUsd: number, now: Date): Promise<void> {
    if (deltaUsd === 0) return;
    const k = spendKeys(now);
    await this.cmd(["EVAL", ADJUST_LUA, "2", k.day, k.month, fmt(deltaUsd)]);
  }
}

/** Test-only store with the same semantics as RESERVE_LUA (single-threaded JS = atomic). */
export class MemorySpendStore implements SpendStore {
  readonly v = new Map<string, number>();
  constructor(private readonly caps: { dailyUsd: number; monthlyUsd: number }) {}
  async reserve(usd: number, now: Date): Promise<boolean> {
    const k = spendKeys(now);
    const d = this.v.get(k.day) ?? 0, m = this.v.get(k.month) ?? 0;
    if (d + usd > this.caps.dailyUsd || m + usd > this.caps.monthlyUsd) return false;
    this.v.set(k.day, d + usd);
    this.v.set(k.month, m + usd);
    return true;
  }
  async adjust(delta: number, now: Date): Promise<void> {
    const k = spendKeys(now);
    this.v.set(k.day, (this.v.get(k.day) ?? 0) + delta);
    this.v.set(k.month, (this.v.get(k.month) ?? 0) + delta);
  }
}

/** Shared Redis only; no in-memory fallback in production (null -> fail closed). */
export function createSpendStore(env: Env = process.env, fetchFn?: FetchFn): SpendStore | null {
  const c = resolveSharedReplayStoreEnv(env);
  if (!c) return null;
  try {
    return new UpstashSpendStore(c.url, c.token, spendCaps(env), fetchFn);
  } catch {
    return null;
  }
}
