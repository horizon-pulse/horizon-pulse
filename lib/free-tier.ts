/**
 * Free daily cap on the 7 pass-through routes (item 0 of
 * oversight/team-room/03-exchange/to-odin/2026-10-18-pulse-free-substitute-upgrade-spec.md;
 * Michael 11:44 PM ET 10/17; Odin 11:48 PM ET: fail = 402, OPT-IN; Michael 11:51-11:53 PM ET:
 * known payers get no free calls and no advert; ONE per-caller total across the 7 routes plus a
 * global daily budget, both config, numbers pending Michael).
 *
 * HP_FREE_TIER:
 *   off   (code default; anything other than "optin") -> nothing changes anywhere:
 *         402s, OPTIONS, llms.txt, openapi.json, /.well-known/x402, skill.md byte-identical.
 *   optin -> an unpaid GET that asks with ?free=1 or "X-HP-Free: 1" gets the route's
 *         normal answer free, up to HP_FREE_DAILY_CAP calls per caller per ET day IN TOTAL
 *         across the 7 routes and HP_FREE_GLOBAL_DAILY_CAP across everyone (code
 *         placeholders 3 and 300, PENDING MICHAEL; not final numbers). Plain unpaid
 *         requests still get today's 402, which (with the 402 body, OPTIONS and the
 *         discovery docs) plainly advertises the opt-in.
 *
 * Counting: ONE EVAL per opted-in request in the existing replay-store Upstash DB
 * (resolveSharedReplayStoreEnv: same credentials, no new token). Keys hold no IP:
 * hp:free:c:<ET day>:<sha256(ip|day) first 16 bytes hex>, hp:free:all:<day>,
 * both EXPIRE 26 h.
 *
 * Fail mode (decided): Upstash unconfigured, erroring, or slower than 300 ms, or no
 * caller IP -> the normal 402. Never unlimited free.
 *
 * Known-payer guard (Michael 11:51-11:53 PM ET: anyone who has paid us gets NO free calls
 * and must not see the free option). Always on with the tier; not switchable off.
 *   - On every settled paid call (any route) a marker hp:fp:paid:<sha256("hp-free-payer|"+ip)
 *     first 16 bytes hex> is SET for 30 days (while the tier is optin, or with
 *     HP_FREE_PAYER_MARK=on to pre-seed markers before launch). No IP and no wallet is stored.
 *   - A caller whose IP carries the marker gets today's 402 with NO free-tier advert
 *     (byte-identical to mode off), and an opt-in from that IP is refused inside the
 *     same EVAL (normal 402, no free headers).
 *   - Unpaid x402 requests carry no wallet; the wallet is only on paid requests, and those
 *     never touch the free counter (paid always wins). So "key on wallet" = paid requests
 *     are excluded outright; unpaid callers can only be told apart by IP.
 *   - Unsure (lookup failed, slow, over HP_FREE_ADVERT_LOOKUP_CAP per instance per day,
 *     no IP) -> no advert. Public docs/OPTIONS are not per-caller and stay advertised.
 */
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { PUBLIC_BASE_URL } from "./config";
import { resolveSharedReplayStoreEnv } from "./xrpl-replay-store";
import { readFileSync } from "node:fs";
import path from "node:path";

type Env = Record<string, string | undefined>;
type FetchFn = typeof fetch;

export const FREE_TIER_ROUTES = [
  "/api/pulse",
  "/api/gas",
  "/api/funding",
  "/api/bazaar-check",
  "/api/balance",
  "/api/chain/head",
  "/api/name/resolve",
] as const;
export type FreeTierRoute = (typeof FREE_TIER_ROUTES)[number];

/** Paid next step pointed to from each free answer (X-HP-Next + Link rel="next"). */
export const FREE_TIER_NEXT: Record<FreeTierRoute, string> = {
  "/api/pulse": "/api/signals",
  "/api/funding": "/api/signals",
  "/api/gas": "/api/tx-status",
  "/api/chain/head": "/api/tx-status",
  "/api/balance": "/api/tx-guard",
  "/api/name/resolve": "/api/tx-guard",
  "/api/bazaar-check": "/listing-fix",
};

/** PLACEHOLDERS pending Michael (11:53 PM ET 10/17): per caller per ET day, total across the 7 routes. */
export const DEFAULT_FREE_DAILY_CAP = 3;
/** PLACEHOLDER pending Michael: free answers per ET day across all callers. */
export const DEFAULT_FREE_GLOBAL_DAILY_CAP = 300;
export const FREE_TIER_TIMEOUT_MS = 300;
export const FREE_KEY_TTL_S = 26 * 3600;
export const FREE_QUERY_PARAM = "free";
export const FREE_HEADER = "X-HP-Free";
export const PAYER_MARK_TTL_S = 30 * 24 * 3600;
export const DEFAULT_ADVERT_LOOKUP_CAP = 2000;

export { freeTierMode, type FreeTierMode } from "./free-tier-mode";
import { freeTierMode as freeTierModeOf } from "./free-tier-mode";
import { after } from "next/server";

function intEnv(raw: string | undefined, dflt: number): number {
  const s = (raw ?? "").trim();
  if (!/^\d{1,7}$/.test(s)) return dflt;
  const n = Number(s);
  return n >= 1 ? n : dflt;
}

export function freeDailyCap(env: Env = process.env): number {
  return intEnv(env.HP_FREE_DAILY_CAP, DEFAULT_FREE_DAILY_CAP);
}

export function freeGlobalDailyCap(env: Env = process.env): number {
  return intEnv(env.HP_FREE_GLOBAL_DAILY_CAP, DEFAULT_FREE_GLOBAL_DAILY_CAP);
}

/** Known-payer guard: always on (Michael 11:53 PM ET). Kept as a function so call sites read plainly. */
export function payerGuardOn(_env: Env = process.env): boolean {
  return true;
}

/** Write payer markers while the tier is optin, or when pre-seeding before launch (HP_FREE_PAYER_MARK=on). */
export function payerMarkWriting(env: Env = process.env): boolean {
  return freeTierModeOf(env) === "optin" || (env.HP_FREE_PAYER_MARK ?? "").trim().toLowerCase() === "on";
}

export function advertLookupCap(env: Env = process.env): number {
  return intEnv(env.HP_FREE_ADVERT_LOOKUP_CAP, DEFAULT_ADVERT_LOOKUP_CAP);
}

export function payerMarkerKey(ip: string): string {
  return `hp:fp:paid:${createHash("sha256").update(`hp-free-payer|${ip}`).digest("hex").slice(0, 32)}`;
}

export function isFreeTierRoute(path: string): path is FreeTierRoute {
  return (FREE_TIER_ROUTES as readonly string[]).includes(path);
}

/** Path of a resource URL or path ("https://host/api/pulse?x" -> "/api/pulse"). */
export function routePathOf(resource: string): string {
  try {
    return new URL(resource, "https://x.invalid").pathname;
  } catch {
    return resource.split("?")[0];
  }
}

// ---------- the one copy source (every surface renders from here) ----------

export function freeTierRouteList(): string {
  const r = [...FREE_TIER_ROUTES];
  return `${r.slice(0, -1).join(", ")} and ${r[r.length - 1]}`;
}

/** One-line advert (402 header / OPTIONS header). */
export function freeTierShortCopy(env: Env = process.env): string {
  return `add ?free=1 (or the X-HP-Free: 1 header) for ${freeDailyCap(env)} free calls/day in total across ${FREE_TIER_ROUTES.length} routes`;
}

/** Full sentence used in llms.txt, openapi.json, /.well-known/x402, skill.md and the 402/OPTIONS body. */
export function freeTierCopy(env: Env = process.env): string {
  return (
    `Free tier (opt-in): add ?free=1 (or the X-HP-Free: 1 header) for ${freeDailyCap(env)} free calls/day ` +
    `per caller in total across ${freeTierRouteList()}, for callers that have not paid before. ` +
    `Without the opt-in, or once the day's free calls are used, the normal x402 402 and price apply. ` +
    `Free answers carry X-HP-Free-Remaining, X-HP-Free-Reset and X-HP-Next (the paid next step); ` +
    `free counts reset at midnight America/New_York.`
  );
}

/** JSON block for the 402 / OPTIONS body of one free-tier route (mode optin only). */
export function freeTierBodyBlock(route: FreeTierRoute, env: Env = process.env) {
  return {
    optIn: "add ?free=1 to the query, or send the header X-HP-Free: 1",
    dailyLimitPerCaller: freeDailyCap(env),
    limitScope: "total per caller across all free-tier routes",
    example: `${PUBLIC_BASE_URL}${route}?free=1`,
    next: absNext(route),
    note: freeTierCopy(env),
  };
}

function absNext(route: FreeTierRoute): string {
  return `${PUBLIC_BASE_URL}${FREE_TIER_NEXT[route]}`;
}

// ---------- request side ----------

/** Did this request ask for the free tier (?free=1|true or X-HP-Free: 1|true)? */
export function wantsFree(req: Request): boolean {
  const yes = (v: string | null) => v !== null && ["1", "true"].includes(v.trim().toLowerCase());
  try {
    if (yes(new URL(req.url).searchParams.get(FREE_QUERY_PARAM))) return true;
  } catch {
    /* ignore */
  }
  return yes(req.headers.get(FREE_HEADER));
}

/**
 * Canonical caller IP: x-real-ip, else the first x-forwarded-for hop (Vercel sets
 * both to the client). Lowercased, brackets/ports/zone ids dropped, IPv4-mapped IPv6
 * folded to IPv4, IPv6 truncated to its /64 (one end-user allocation). null if unusable.
 */
export function normalizeCallerIp(headers: Headers): string | null {
  const raw = (headers.get("x-real-ip") ?? headers.get("x-forwarded-for")?.split(",")[0] ?? "").trim().toLowerCase();
  if (!raw) return null;
  let ip = raw;
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);
  if (bracket) ip = bracket[1];
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(":"));
  ip = ip.replace(/%.*$/, "");
  const mapped = /^(?:0{0,4}:){0,5}(?:0{0,4}:)?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip) ?? /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (mapped) ip = mapped[1];
  const kind = isIP(ip);
  if (kind === 4) return ip.split(".").map((o) => String(Number(o))).join(".");
  if (kind === 6) return ipv6Prefix64(ip);
  return null;
}

function ipv6Prefix64(ip: string): string | null {
  let parts: string[];
  if (ip.includes("::")) {
    const [a, b] = ip.split("::");
    const left = a ? a.split(":") : [];
    const right = b ? b.split(":") : [];
    if (right.length && right[right.length - 1].includes(".")) return null; // embedded IPv4 other than ::ffff: is not a client form we key
    parts = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  } else parts = ip.split(":");
  if (parts.length !== 8 || parts.some((h) => !/^[0-9a-f]{1,4}$/.test(h))) return null;
  const hex = parts.map((h) => parseInt(h, 16).toString(16));
  if (hex.slice(0, 4).every((h) => h === "0")) {
    // Not a routed end-user /64: hex-form IPv4-mapped -> IPv4, else the full address.
    if (hex.slice(4, 6).join(":") === "0:ffff") {
      const v = (parseInt(hex[6], 16) << 16) + parseInt(hex[7], 16);
      return [v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join(".");
    }
    return hex.join(":");
  }
  return `${hex.slice(0, 4).join(":")}::/64`;
}

/** America/New_York calendar date. */
export function etDay(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** Next midnight America/New_York as an ISO instant (handles EDT/EST). */
export function nextEtMidnight(now: Date): string {
  const [y, m, d] = etDay(now).split("-").map(Number);
  const hourIn = (t: number) =>
    Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hourCycle: "h23" }).format(new Date(t)));
  for (const h of [4, 5, 3, 6]) {
    const t = Date.UTC(y, m - 1, d + 1, h);
    if (hourIn(t) === 0 && etDay(new Date(t)) !== etDay(now)) return new Date(t).toISOString();
  }
  return new Date(Date.UTC(y, m - 1, d + 1, 5)).toISOString();
}

/** No raw IP in Redis: sha256(ip|day), first 16 bytes, hex (one total across the 7 routes). */
export function callerKey(ip: string, day: string): string {
  return createHash("sha256").update(`${ip}|${day}`).digest("hex").slice(0, 32);
}

/**
 * Lua: KEYS[1]=per-caller counter, KEYS[2]=global counter, KEYS[3]=payer marker (guard on
 * only; numkeys 3, else 2); ARGV[1]=per-caller cap, ARGV[2]=global cap, ARGV[3]=ttl.
 * Returns {allowed(1|0), remaining, globalExhausted(1|0), knownPayer(1|0)}. A known payer
 * is refused before anything is counted.
 * Global is checked first (a refused call never consumes the caller's count), and only
 * allowed calls increment the global count.
 */
export const FREE_TIER_LUA = [
  "if KEYS[3] and redis.call('EXISTS', KEYS[3]) == 1 then return {0, 0, 0, 1} end",
  "local g = tonumber(redis.call('GET', KEYS[2]) or '0')",
  "if g >= tonumber(ARGV[2]) then return {0, 0, 1} end",
  "local n = redis.call('INCR', KEYS[1])",
  "if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[3]) end",
  "if n > tonumber(ARGV[1]) then return {0, 0, 0} end",
  "local g2 = redis.call('INCR', KEYS[2])",
  "if g2 == 1 then redis.call('EXPIRE', KEYS[2], ARGV[3]) end",
  "return {1, tonumber(ARGV[1]) - n, 0}",
].join("\n");

export function freeEvalCommand(ip: string, day: string, env: Env = process.env): string[] {
  return [
    "EVAL",
    FREE_TIER_LUA,
    payerGuardOn(env) ? "3" : "2",
    `hp:free:c:${day}:${callerKey(ip, day)}`,
    `hp:free:all:${day}`,
    ...(payerGuardOn(env) ? [payerMarkerKey(ip)] : []),
    String(freeDailyCap(env)),
    String(freeGlobalDailyCap(env)),
    String(FREE_KEY_TTL_S),
  ];
}

export type FreeDecision =
  | { kind: "free"; remaining: number; limit: number; reset: string }
  | { kind: "capped"; limit: number; reset: string; global: boolean }
  | { kind: "known_payer" }
  | { kind: "unavailable"; reason: string };

/** Per-instance "global budget spent today" flag: skips the EVAL for the rest of the ET day. */
const globalFlag = { day: "" };
/** Per-instance advert lookups today (quota guard). */
const lookups = { day: "", n: 0 };

/** Test hook. */
export function resetFreeTierState(): void {
  globalFlag.day = "";
  lookups.day = "";
  lookups.n = 0;
}

async function upstash(cmd: string[], env: Env, fetchFn: FetchFn | undefined, timeoutMs: number): Promise<unknown> {
  const c = resolveSharedReplayStoreEnv(env);
  if (!c) throw new Error("store_unconfigured");
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await (fetchFn ?? fetch)(c.url.replace(/\/+$/, ""), {
      method: "POST",
      headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(cmd),
      signal: ctl.signal,
      cache: "no-store",
    });
    const body = (await res.json().catch(() => null)) as { result?: unknown; error?: unknown } | null;
    if (!res.ok || !body || body.error !== undefined) throw new Error(`store_${res.status}`);
    return body.result;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Should this unpaid 402 advertise the free tier? Guard off -> yes. Guard on -> only when
 * the caller's IP has no payer marker; any doubt (no IP, store down/slow, lookup cap) -> no.
 * One EXISTS (one Upstash command), bounded by HP_FREE_ADVERT_LOOKUP_CAP per instance per day.
 */
export async function shouldAdvertise(opts: { headers: Headers; env?: Env; fetchFn?: FetchFn; now?: Date }): Promise<boolean> {
  const env = opts.env ?? process.env;
  if (!payerGuardOn(env)) return true;
  try {
    const ip = normalizeCallerIp(opts.headers);
    if (!ip || !resolveSharedReplayStoreEnv(env)) return false;
    const day = etDay(opts.now ?? new Date());
    if (lookups.day !== day) {
      lookups.day = day;
      lookups.n = 0;
    }
    if (lookups.n >= advertLookupCap(env)) return false;
    lookups.n++;
    return Number(await upstash(["EXISTS", payerMarkerKey(ip)], env, opts.fetchFn, FREE_TIER_TIMEOUT_MS)) === 0;
  } catch {
    return false;
  }
}

/** Mark the caller's IP as a known payer for 30 days. Never throws. */
export async function markPayer(opts: { headers: Headers; env?: Env; fetchFn?: FetchFn }): Promise<boolean> {
  const env = opts.env ?? process.env;
  try {
    if (!payerMarkWriting(env)) return false;
    const ip = normalizeCallerIp(opts.headers);
    if (!ip) return false;
    await upstash(["SET", payerMarkerKey(ip), "1", "EX", String(PAYER_MARK_TTL_S)], env, opts.fetchFn, 1500);
    return true;
  } catch {
    return false;
  }
}

/** Fire-and-forget markPayer after the response (next/server after(); detached promise outside a request scope). */
export function scheduleMarkPayer(headers: Headers): void {
  try {
    if (!payerMarkWriting()) return;
    const h = new Headers(headers);
    const task = () => markPayer({ headers: h }).then(() => undefined);
    try {
      after(task);
    } catch {
      void task();
    }
  } catch {
    /* never affect the request */
  }
}

/** One EVAL. Never throws; any failure -> {kind:"unavailable"} (caller serves the normal 402). */
export async function consumeFreeCall(opts: {
  route: FreeTierRoute;
  headers: Headers;
  env?: Env;
  fetchFn?: FetchFn;
  now?: Date;
}): Promise<FreeDecision> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  const day = etDay(now);
  const limit = freeDailyCap(env);
  const reset = nextEtMidnight(now);
  try {
    if (globalFlag.day === day) return { kind: "capped", limit, reset, global: true };
    const ip = normalizeCallerIp(opts.headers);
    if (!ip) return { kind: "unavailable", reason: "no_caller_ip" };
    const c = resolveSharedReplayStoreEnv(env);
    if (!c) return { kind: "unavailable", reason: "store_unconfigured" };
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), FREE_TIER_TIMEOUT_MS);
    try {
      const res = await (opts.fetchFn ?? fetch)(c.url.replace(/\/+$/, ""), {
        method: "POST",
        headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(freeEvalCommand(ip, day, env)),
        signal: ctl.signal,
        cache: "no-store",
      });
      const body = (await res.json().catch(() => null)) as { result?: unknown; error?: unknown } | null;
      if (!res.ok || !body || body.error !== undefined || !Array.isArray(body.result)) return { kind: "unavailable", reason: `store_${res.status}` };
      const [allowed, remaining, globalOut, knownPayer] = body.result.map(Number);
      if (knownPayer === 1) return { kind: "known_payer" };
      if (allowed === 1 && Number.isFinite(remaining)) return { kind: "free", remaining: Math.max(0, remaining), limit, reset };
      if (globalOut === 1) {
        globalFlag.day = day;
        return { kind: "capped", limit, reset, global: true };
      }
      if (allowed === 0) return { kind: "capped", limit, reset, global: false };
      return { kind: "unavailable", reason: "store_bad_result" };
    } finally {
      clearTimeout(t);
    }
  } catch (e) {
    return { kind: "unavailable", reason: e instanceof Error && e.name === "AbortError" ? "store_timeout" : "store_error" };
  }
}

/** Request for the route handler with the opt-in marker removed (handlers never see ?free / X-HP-Free). */
export function stripFreeMarker<R extends Request>(req: R, make: (url: string, init: { method: string; headers: Headers }) => R): R {
  const u = new URL(req.url);
  u.searchParams.delete(FREE_QUERY_PARAM);
  const h = new Headers(req.headers);
  h.delete(FREE_HEADER);
  return make(u.toString(), { method: req.method, headers: h });
}

/** Headers on a free answer. */
export function freeAnswerHeaders(route: FreeTierRoute, d: { remaining: number; limit: number; reset: string }): Record<string, string> {
  const next = absNext(route);
  return {
    "X-HP-Free-Limit": String(d.limit),
    "X-HP-Free-Remaining": String(d.remaining),
    "X-HP-Free-Reset": d.reset,
    "X-HP-Next": next,
    Link: `<${next}>; rel="next"`,
    "Cache-Control": "no-store",
  };
}

/**
 * Mode optin only: a copy of an unpaid 402 / OPTIONS response for a free-tier route
 * that advertises the opt-in (X-HP-Free-Tier header + "freeTier" key in a JSON object
 * body). Status and every other header (PAYMENT-REQUIRED included) unchanged.
 * Non-JSON or non-object bodies keep their bytes and only gain the header.
 */
export async function withFreeTierAdvert(res: Response, route: FreeTierRoute, extra: Record<string, string> = {}, env: Env = process.env): Promise<Response> {
  const headers = new Headers(res.headers);
  headers.set("X-HP-Free-Tier", freeTierShortCopy(env));
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  const text = await res.text();
  let body = text;
  if ((headers.get("content-type") ?? "").includes("json")) {
    try {
      const j = JSON.parse(text) as unknown;
      if (j && typeof j === "object" && !Array.isArray(j)) body = JSON.stringify({ ...(j as object), freeTier: freeTierBodyBlock(route, env) });
    } catch {
      /* keep bytes */
    }
  }
  headers.delete("content-length");
  return new Response(body, { status: res.status, statusText: res.statusText, headers });
}

// ---------- discovery docs (mode optin only; off -> callers return the original bytes) ----------

/** llms.txt with a "## Free tier (opt-in)" section inserted before "## Live paid routes". */
export function llmsWithFreeTier(original: string, env: Env = process.env): string {
  const lines = FREE_TIER_ROUTES.map((r) => `- \`GET ${r}?free=1\` (paid next step: \`${FREE_TIER_NEXT[r]}\`)`);
  const section = `## Free tier (opt-in)\n\n${freeTierCopy(env)}\n\n${lines.join("\n")}\n\n`;
  const marker = "## Live paid routes";
  const i = original.indexOf(marker);
  return i >= 0 ? original.slice(0, i) + section + original.slice(i) : `${original.replace(/\n*$/, "\n\n")}${section}`;
}

type OpenApiDoc = { info?: { description?: string }; paths?: Record<string, Record<string, Record<string, unknown>>>; [k: string]: unknown };

/** openapi.json with x-free-tier (top level and on each free-tier GET) and the copy in info.description. */
export function openApiWithFreeTier(doc: OpenApiDoc, env: Env = process.env): OpenApiDoc {
  const out = JSON.parse(JSON.stringify(doc)) as OpenApiDoc;
  out["x-free-tier"] = { routes: [...FREE_TIER_ROUTES], dailyLimitPerCaller: freeDailyCap(env), limitScope: "total per caller across all free-tier routes", optIn: { query: "free=1", header: "X-HP-Free: 1" }, note: freeTierCopy(env) };
  if (out.info) out.info.description = `${out.info.description ?? ""}\n\n${freeTierCopy(env)}`.trim();
  for (const r of FREE_TIER_ROUTES) {
    const op = out.paths?.[r]?.get;
    if (op) op["x-free-tier"] = { dailyLimitPerCaller: freeDailyCap(env), limitScope: "total per caller across all free-tier routes", optIn: { query: "free=1", header: "X-HP-Free: 1" }, next: FREE_TIER_NEXT[r] };
  }
  return out;
}

/** skill.md with a "## Free tier (opt-in)" section appended. */
export function skillWithFreeTier(md: string, env: Env = process.env): string {
  const lines = FREE_TIER_ROUTES.map((r) => `- \`GET ${r}?free=1\` -> paid next step \`${FREE_TIER_NEXT[r]}\``);
  return `${md.replace(/\n*$/, "\n")}\n## Free tier (opt-in)\n\n${freeTierCopy(env)}\n\n${lines.join("\n")}\n`;
}

/** /.well-known/x402 body additions (mode optin only). */
export function wellKnownFreeTier<T extends { instructions: string }>(doc: T, env: Env = process.env): T & { freeTier: object } {
  return {
    ...doc,
    instructions: `${doc.instructions} ${freeTierCopy(env)}`,
    freeTier: { routes: FREE_TIER_ROUTES.map((r) => `${PUBLIC_BASE_URL}${r}`), dailyLimitPerCaller: freeDailyCap(env), limitScope: "total per caller across all free-tier routes", optIn: { query: "free=1", header: "X-HP-Free: 1" }, note: freeTierCopy(env) },
  };
}

/** The shipped static doc (public/<name>), read at build time by the force-static free-tier routes. */
export function readPublicDoc(name: "llms.txt" | "openapi.json"): string {
  return readFileSync(path.join(process.cwd(), "public", name), "utf8");
}
