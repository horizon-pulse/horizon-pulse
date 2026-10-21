/**
 * Free daily cap (lib/free-tier.ts, item 0): opt-in mode on the 7 pass-through routes.
 * Upstash is always a stub here (never the network).
 */
import { createHash, createHmac, hkdfSync } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import {
  callerKey,
  consumeFreeCall,
  DEFAULT_FREE_DAILY_CAP,
  DEFAULT_FREE_GLOBAL_DAILY_CAP,
  FREE_TIER_LUA,
  FREE_TIER_NEXT,
  FREE_TIER_ROUTES,
  freeDailyCap,
  freeEvalCommand,
  freeGlobalDailyCap,
  freeTierCopy,
  freeTierMode,
  markPayer,
  nextEtMidnight,
  FREE_PRICED,
  normalizeCallerIp,
  payerMarkerKey,
  payerMarkWriting,
  resetFreeTierState,
  shouldAdvertise,
  toFreeAnswer,
  TRUSTED_IP_HEADER,
  cappedMemoSize,
  freeIpMasterKey,
  FREE_IP_HKDF_INFO,
  FREE_IP_HKDF_SALT,
  payerMarkTtlS,
} from "@/lib/free-tier";
import { freeIpHmacKey, payerMarkTtlDays } from "@/lib/free-tier-mode";
import { freeTierPrivacySentences, NO_IP_SENTENCE, privacyLine, ROUTE_LOG_PRIVACY_LINE } from "@/lib/privacy-copy";
import { docRewrites as freeTierRewrites } from "@/lib/doc-rewrites"; // Sentinel L2: freeTierRewrites replaced by docRewrites
import { createX402GetHandler, discoveryOptionsResponse, pulseRouteConfig, signalsRouteConfig } from "@/lib/x402-server";
import { paymentOpts as pulseOpts } from "@/app/api/pulse/handler";
import { paymentOpts as signalsOpts } from "@/app/api/signals/handler";
import { LIVE_PAID_ROUTES } from "@/lib/live-catalog";
import { GET as wellKnown } from "@/app/.well-known/x402/route";
import { GET as skillMd } from "@/app/skill.md/route";
import { GET as freeLlms } from "@/app/free-tier/llms.txt/route";
import { GET as freeOpenapi } from "@/app/free-tier/openapi.json/route";
import { installFacilitatorMock } from "./helpers/facilitator-mock";
import { CDP_ENV } from "./helpers/capture";

/** Test-only HMAC key fixture (43+ chars). Not a real secret; production has none until Michael sets one. */
const TEST_KEY = "test-only-fixture-not-a-secret-0123456789abcdef";
const UP = { UPSTASH_REDIS_REST_URL: "https://example-upstash.test", UPSTASH_REDIS_REST_TOKEN: "t", HP_FREE_IP_HMAC_KEY: TEST_KEY };
const NOW = new Date("2026-10-18T03:30:00.000Z"); // 11:30 PM ET Sat 10/17
const ip = (v: string, h = "x-real-ip") => new Headers({ [h]: v });

/**
 * In-memory Upstash that runs a JS port of FREE_TIER_LUA (same branch order). The Lua
 * itself is checked statement by statement below and was run under a real Lua runtime
 * out of band (see the packet).
 */
function fakeUpstash(opts: { fail?: "throw" | "500" | "error" | "slow" } = {}) {
  const kv = new Map<string, number>();
  const calls: string[][] = [];
  const fn = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const cmd = JSON.parse(String(init?.body)) as string[];
    calls.push(cmd);
    if (opts.fail === "throw") throw new Error("ECONNREFUSED");
    if (opts.fail === "500") return new Response("{}", { status: 500 });
    if (opts.fail === "error") return new Response(JSON.stringify({ error: "ERR max requests limit exceeded" }), { status: 200 });
    if (opts.fail === "slow")
      return await new Promise<Response>((_, rej) => init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    if (cmd[0] === "EXISTS") return Response.json({ result: kv.has(cmd[1]) ? 1 : 0 });
    if (cmd[0] === "SET") {
      kv.set(cmd[1], 1);
      return Response.json({ result: "OK" });
    }
    const nk = Number(cmd[2]);
    const [k1, k2, k3] = cmd.slice(3, 3 + nk);
    const [cap, gcap] = cmd.slice(3 + nk);
    if (k3 && kv.has(k3)) return Response.json({ result: [0, 0, 0, 1] });
    const g = kv.get(k2) ?? 0;
    if (g >= Number(gcap)) return Response.json({ result: [0, 0, 1] });
    const n = (kv.get(k1) ?? 0) + 1;
    kv.set(k1, n);
    if (n > Number(cap)) return Response.json({ result: [0, 0, 0] });
    kv.set(k2, g + 1);
    return Response.json({ result: [1, Number(cap) - n, 0] });
  });
  return { fn, kv, calls };
}

function stubEnv(env: Record<string, string>) {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
}

beforeEach(() => {
  resetFreeTierState();
  vi.stubEnv("HP_FREE_IP_HMAC_KEY", TEST_KEY); // the tier is off without a key; tests below that need "no key" clear it
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("free tier: config", () => {
  it("mode is off unless HP_FREE_TIER=optin (the default-free mode does not exist)", () => {
    expect(freeTierMode({})).toBe("off");
    for (const v of ["", "off", "default", "on", "true", "1", "free"]) expect(freeTierMode({ HP_FREE_TIER: v })).toBe("off");
    expect(freeTierMode({ HP_FREE_TIER: " OptIn ", HP_FREE_IP_HMAC_KEY: TEST_KEY })).toBe("optin");
  });
  it("caps: placeholders 3 per caller (total, 7 routes) / 300 global pending Michael; config overrides; bad values fall back", () => {
    expect([DEFAULT_FREE_DAILY_CAP, DEFAULT_FREE_GLOBAL_DAILY_CAP]).toEqual([3, 300]);
    expect([freeDailyCap({}), freeGlobalDailyCap({})]).toEqual([3, 300]);
    expect(freeDailyCap({ HP_FREE_DAILY_CAP: "50" })).toBe(50);
    for (const bad of ["0", "-1", "abc", "1e3", "1.5", "99999999"]) expect(freeDailyCap({ HP_FREE_DAILY_CAP: bad })).toBe(3);
    expect(freeGlobalDailyCap({ HP_FREE_GLOBAL_DAILY_CAP: "7" })).toBe(7);
  });
  it("the 7 routes are live paid routes; every next step is a live paid route or /listing-fix", () => {
    expect([...FREE_TIER_ROUTES]).toEqual(["/api/pulse", "/api/gas", "/api/funding", "/api/bazaar-check", "/api/balance", "/api/chain/head", "/api/name/resolve"]);
    const live = new Set(LIVE_PAID_ROUTES.map((r) => r.path.split("?")[0]));
    for (const r of FREE_TIER_ROUTES) {
      expect(live.has(r), r).toBe(true);
      const n = FREE_TIER_NEXT[r];
      expect(n === "/listing-fix" ? existsSync("app/listing-fix") : live.has(n), n).toBe(true);
      expect(FREE_TIER_ROUTES as readonly string[]).not.toContain(n);
    }
  });
  it("doc rewrites only when optin", () => {
    expect(freeTierRewrites({})).toEqual([]);
    expect(freeTierRewrites({ HP_FREE_TIER: "off" })).toEqual([]);
    expect(freeTierRewrites({ HP_FREE_TIER: "optin", HP_FREE_IP_HMAC_KEY: TEST_KEY }).map((r) => r.source)).toEqual(["/llms.txt", "/openapi.json"]);
    expect(freeTierRewrites({ HP_FREE_TIER: "optin" })).toEqual([]); // no key -> off
  });
});

describe("free tier: caller key normalization", () => {
  it("IPv4 forms collapse to one canonical address", () => {
    for (const h of [ip("1.2.3.4"), ip(" 1.2.3.4 "), ip("1.2.3.4:5678"), ip("::ffff:1.2.3.4"), ip("::FFFF:1.2.3.4"), ip("0:0:0:0:0:ffff:1.2.3.4"), ip("::ffff:102:304")])
      expect(normalizeCallerIp(h)).toBe("1.2.3.4");
  });
  it("IPv6 keys on the /64; zero-prefix addresses key on the full address", () => {
    const a = normalizeCallerIp(ip("2001:DB8:1:2:aaaa::1"));
    expect(a).toBe("2001:db8:1:2::/64");
    expect(normalizeCallerIp(ip("[2001:db8:1:2::5]:443"))).toBe(a);
    expect(normalizeCallerIp(ip("2001:0db8:0001:0002:ffff:ffff:ffff:ffff"))).toBe(a);
    expect(normalizeCallerIp(ip("2001:db8:1:3::1"))).not.toBe(a);
    expect(normalizeCallerIp(ip("fe80::1%eth0"))).toBe("fe80:0:0:0::/64");
    expect(normalizeCallerIp(ip("::1"))).toBe("0:0:0:0:0:0:0:1");
    expect(normalizeCallerIp(ip("::2"))).not.toBe(normalizeCallerIp(ip("::1")));
  });
  it("only the platform IP (x-real-ip, Vercel ipAddress()) counts: spoofed x-forwarded-for / x-vercel-forwarded-for are ignored; none -> null", () => {
    expect(TRUSTED_IP_HEADER).toBe("x-real-ip");
    expect(normalizeCallerIp(new Headers({ "x-real-ip": "5.6.7.8", "x-vercel-forwarded-for": "1.2.3.4", "x-forwarded-for": "1.2.3.4" }))).toBe("5.6.7.8");
    expect(normalizeCallerIp(new Headers({ "x-vercel-forwarded-for": "1.2.3.4" }))).toBeNull();
    expect(normalizeCallerIp(new Headers({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" }))).toBeNull();
    expect(normalizeCallerIp(new Headers({ "x-vercel-forwarded-for": "1.2.3.4", "x-forwarded-for": "1.2.3.4" }))).toBeNull();
  });
  it("a list in x-real-ip (the platform sends one address) -> null, never a hop out of it", () => {
    expect(normalizeCallerIp(ip("203.0.113.77, 1.2.3.4"))).toBeNull();
    expect(normalizeCallerIp(ip("203.0.113.77,1.2.3.4, "))).toBeNull();
  });
  it("garbage or missing -> null", () => {
    for (const v of ["", "unknown", "1.2.3", "999.1.1.1", "not-an-ip", "1.2.3.4.5"]) expect(normalizeCallerIp(ip(v))).toBeNull();
    expect(normalizeCallerIp(new Headers())).toBeNull();
  });
  it("Redis keys never hold the IP: one keyed HMAC per ip|day (total across routes) + the payer marker", () => {
    const k = callerKey("1.2.3.4", "2026-10-17");
    expect(k).toMatch(/^[0-9a-f]{32}$/);
    expect(callerKey("1.2.3.4", "2026-10-18")).not.toBe(k);
    expect(callerKey("1.2.3.5", "2026-10-17")).not.toBe(k);
    const cmd = freeEvalCommand("1.2.3.4", "2026-10-17", { HP_FREE_IP_HMAC_KEY: TEST_KEY });
    expect(cmd.slice(0, 3)).toEqual(["EVAL", FREE_TIER_LUA, "3"]);
    expect(cmd.slice(3)).toEqual([`hp:free:c:2026-10-17:${k}`, "hp:free:all:2026-10-17", payerMarkerKey("1.2.3.4"), "3", "300", String(26 * 3600)]);
    expect(payerMarkerKey("1.2.3.4")).toMatch(/^hp:fp:paid:[0-9a-f]{32}$/);
    expect(cmd.join(" ")).not.toContain("1.2.3.4");
  });
  it("Lua: known payer refused first; global checked before the caller count; only allowed calls bump the global; both expire", () => {
    const l = FREE_TIER_LUA.split("\n");
    expect(l.shift()).toBe("if KEYS[3] and redis.call('EXISTS', KEYS[3]) == 1 then return {0, 0, 0, 1} end");
    expect(l[0]).toContain("redis.call('GET', KEYS[2])");
    expect(l[1]).toBe("if g >= tonumber(ARGV[2]) then return {0, 0, 1} end");
    expect(l[2]).toBe("local n = redis.call('INCR', KEYS[1])");
    expect(l[3]).toContain("redis.call('EXPIRE', KEYS[1], ARGV[3])");
    expect(l[4]).toBe("if n > tonumber(ARGV[1]) then return {0, 0, 0} end");
    expect(l[5]).toBe("local g2 = redis.call('INCR', KEYS[2])");
    expect(l[6]).toContain("redis.call('EXPIRE', KEYS[2], ARGV[3])");
  });
  it("reset = next midnight America/New_York (EDT and EST)", () => {
    expect(nextEtMidnight(NOW)).toBe("2026-10-18T04:00:00.000Z");
    expect(nextEtMidnight(new Date("2026-12-01T12:00:00Z"))).toBe("2026-12-02T05:00:00.000Z");
    expect(nextEtMidnight(new Date("2026-11-01T02:00:00Z"))).toBe("2026-11-01T04:00:00.000Z"); // 10 PM EDT 10/31 -> midnight EDT
    expect(nextEtMidnight(new Date("2026-11-01T12:00:00Z"))).toBe("2026-11-02T05:00:00.000Z"); // DST ended -> EST
  });
});

describe("free tier: counter (consumeFreeCall)", () => {
  const call = (f: ReturnType<typeof fakeUpstash>, env: Record<string, string> = UP, h = ip("1.2.3.4")) =>
    consumeFreeCall({ route: "/api/pulse", headers: h, env, fetchFn: f.fn as unknown as typeof fetch, now: NOW });

  it("cap edge (placeholder 3): calls 1..3 free (remaining 2..0), call 4 capped; one EVAL each", async () => {
    const f = fakeUpstash();
    for (let i = 1; i <= 3; i++) {
      const d = await call(f);
      expect(d).toEqual({ kind: "free", remaining: 3 - i, limit: 3, reset: "2026-10-18T04:00:00.000Z" });
    }
    expect(await call(f)).toMatchObject({ kind: "capped", global: false, limit: 3 });
    expect(f.fn).toHaveBeenCalledTimes(4);
    expect(await call(f, UP, ip("5.6.7.8"))).toMatchObject({ kind: "free", remaining: 2 }); // another caller unaffected
  });
  it("the per-caller cap is ONE total across the 7 routes", async () => {
    const f = fakeUpstash();
    const on = (route: (typeof FREE_TIER_ROUTES)[number]) =>
      consumeFreeCall({ route, headers: ip("1.2.3.4"), env: UP, fetchFn: f.fn as unknown as typeof fetch, now: NOW });
    expect(await on("/api/pulse")).toMatchObject({ kind: "free", remaining: 2 });
    expect(await on("/api/gas")).toMatchObject({ kind: "free", remaining: 1 });
    expect(await on("/api/name/resolve")).toMatchObject({ kind: "free", remaining: 0 });
    for (const r of FREE_TIER_ROUTES) expect(await on(r), r).toMatchObject({ kind: "capped", global: false });
  });
  it("known payer (marker present): no free call, nothing counted", async () => {
    const f = fakeUpstash();
    f.kv.set(payerMarkerKey("1.2.3.4"), 1);
    expect(await call(f)).toEqual({ kind: "known_payer" });
    expect([...f.kv.keys()].some((k) => k.startsWith("hp:free:"))).toBe(false);
    expect(await call(f, UP, ip("::ffff:1.2.3.4"))).toEqual({ kind: "known_payer" }); // same caller, other spelling
  });
  it("custom cap from env", async () => {
    const f = fakeUpstash();
    const env = { ...UP, HP_FREE_DAILY_CAP: "2" };
    expect(await call(f, env)).toMatchObject({ kind: "free", remaining: 1, limit: 2 });
    expect(await call(f, env)).toMatchObject({ kind: "free", remaining: 0 });
    expect(await call(f, env)).toMatchObject({ kind: "capped", limit: 2 });
  });
  it("global budget: refused once spent (no caller count consumed), then no more EVALs this ET day on this instance", async () => {
    const f = fakeUpstash();
    const env = { ...UP, HP_FREE_GLOBAL_DAILY_CAP: "3" };
    for (const a of ["1.1.1.1", "2.2.2.2", "3.3.3.3"]) expect(await call(f, env, ip(a))).toMatchObject({ kind: "free" });
    expect(await call(f, env, ip("4.4.4.4"))).toMatchObject({ kind: "capped", global: true });
    expect([...f.kv.entries()].filter(([k]) => k.startsWith("hp:free:c:")).length).toBe(3); // 4.4.4.4 never counted
    expect(await call(f, env, ip("5.5.5.5"))).toMatchObject({ kind: "capped", global: true });
    expect(f.fn).toHaveBeenCalledTimes(4);
    // next ET day: flag clears by date
    const tomorrow = await consumeFreeCall({ route: "/api/pulse", headers: ip("5.5.5.5"), env, fetchFn: f.fn as unknown as typeof fetch, now: new Date("2026-10-18T14:00:00Z") });
    expect(tomorrow).toMatchObject({ kind: "free" });
  });
  it("Upstash down / HTTP 500 / error reply / slow (>300 ms) / unconfigured / no caller IP -> unavailable (caller serves 402)", async () => {
    expect(await call(fakeUpstash({ fail: "throw" }))).toEqual({ kind: "unavailable", reason: "store_error" });
    expect(await call(fakeUpstash({ fail: "500" }))).toEqual({ kind: "unavailable", reason: "store_500" });
    expect(await call(fakeUpstash({ fail: "error" }))).toEqual({ kind: "unavailable", reason: "store_200" });
    const t0 = Date.now();
    expect(await call(fakeUpstash({ fail: "slow" }))).toEqual({ kind: "unavailable", reason: "store_timeout" });
    expect(Date.now() - t0).toBeLessThan(1500);
    const none = fakeUpstash();
    const K = { HP_FREE_IP_HMAC_KEY: TEST_KEY };
    expect(await call(none, K)).toEqual({ kind: "unavailable", reason: "store_unconfigured" });
    expect(await call(none, { ...K, UPSTASH_REDIS_REST_URL: UP.UPSTASH_REDIS_REST_URL })).toEqual({ kind: "unavailable", reason: "store_unconfigured" });
    expect(await call(none, { ...UP, HP_FREE_IP_HMAC_KEY: "" })).toEqual({ kind: "unavailable", reason: "hmac_key_unset" });
    expect(await call(none, UP, new Headers())).toEqual({ kind: "unavailable", reason: "no_caller_ip" });
    expect(none.fn).not.toHaveBeenCalled();
  });
  it("uses the existing replay-store credentials (Vercel KV names too); no other token", async () => {
    const f = fakeUpstash();
    await call(f, { KV_REST_API_URL: "https://kv.example.test", KV_REST_API_TOKEN: "kv", HP_FREE_IP_HMAC_KEY: TEST_KEY });
    const [url, init] = f.fn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://kv.example.test");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer kv");
    // the read-only token name is never consulted
    const g = fakeUpstash();
    expect(await call(g, { KV_REST_API_URL: "https://kv.example.test", KV_REST_API_READ_ONLY_TOKEN: "ro", HP_FREE_IP_HMAC_KEY: TEST_KEY })).toMatchObject({ kind: "unavailable" });
    expect(g.fn).not.toHaveBeenCalled();
  });
});

// ---------- wired through createX402GetHandler ----------

const PULSE = "https://horizonpulse.dev/api/pulse";
function pulseHandler() {
  const seen: { url: string; free: string | null }[] = [];
  const h = createX402GetHandler(
    async (req) => {
      seen.push({ url: req.url, free: req.headers.get("x-hp-free") });
      return NextResponse.json({ ok: true, v: 1 });
    },
    pulseRouteConfig(),
    pulseOpts,
  );
  return { h, seen };
}
const get = (url: string, headers: Record<string, string> = {}, method = "GET") =>
  new NextRequest(url, { method, headers: { accept: "application/json", "x-real-ip": "1.2.3.4", ...headers } });
const snap = async (r: Response) => ({ status: r.status, pr: r.headers.get("payment-required"), body: await r.text(), h: [...r.headers.keys()].sort() });

describe("free tier: wired (createX402GetHandler)", () => {
  it("mode off (default): ?free=1 and X-HP-Free are ignored, no EVAL, 402 byte-identical to a plain request", async () => {
    stubEnv(UP);
    const f = fakeUpstash();
    vi.stubGlobal("fetch", f.fn);
    for (const mode of [undefined, "off", "default"]) {
      if (mode) vi.stubEnv("HP_FREE_TIER", mode);
      const { h, seen } = pulseHandler();
      const plain = await snap(await h(get(PULSE)));
      expect(plain.status).toBe(402);
      expect(await snap(await h(get(`${PULSE}?free=1`)))).toEqual(plain);
      expect(await snap(await h(get(PULSE, { "X-HP-Free": "1" })))).toEqual(plain);
      expect(plain.body).not.toContain("freeTier");
      expect(plain.h).not.toContain("x-hp-free-tier");
      expect(seen).toEqual([]);
    }
    expect(f.fn).not.toHaveBeenCalled();
  });

  it("optin, plain unpaid GET from an unknown caller: still 402 with the same PAYMENT-REQUIRED; body + header advertise the opt-in", async () => {
    stubEnv(UP);
    const f = fakeUpstash();
    vi.stubGlobal("fetch", f.fn);
    const off = await snap(await pulseHandler().h(get(PULSE)));
    vi.stubEnv("HP_FREE_TIER", "optin");
    const res = await pulseHandler().h(get(PULSE));
    expect(res.status).toBe(402);
    expect(res.headers.get("payment-required")).toBe(off.pr);
    expect(res.headers.get("x-hp-free-tier")).toBe("add ?free=1 (or the X-HP-Free: 1 header) for 3 free calls/day in total across 7 routes");
    const j = await res.json();
    expect(j.freeTier).toEqual({
      optIn: "add ?free=1 to the query, or send the header X-HP-Free: 1",
      dailyLimitPerCaller: 3,
      limitScope: "total per caller across all free-tier routes",
      example: "https://horizonpulse.dev/api/pulse?free=1",
      next: "https://horizonpulse.dev/api/signals",
      note: freeTierCopy(),
    });
    const { freeTier: _ft, ...rest } = j;
    expect(rest).toEqual(JSON.parse(off.body)); // everything else unchanged
    expect(f.calls.map((c) => c[0])).toEqual(["EXISTS"]); // one payer lookup, no EVAL
  });

  it("known payer: plain 402 and opted-in 402 are byte-identical to mode off (no advert, no free headers)", async () => {
    stubEnv(UP);
    const f = fakeUpstash();
    vi.stubGlobal("fetch", f.fn);
    const off = await snap(await pulseHandler().h(get(PULSE)));
    vi.stubEnv("HP_FREE_TIER", "optin");
    f.kv.set(payerMarkerKey("1.2.3.4"), 1);
    const { h, seen } = pulseHandler();
    expect(await snap(await h(get(PULSE)))).toEqual(off);
    expect(await snap(await h(get(`${PULSE}?free=1`)))).toEqual(off);
    expect(await snap(await h(get(PULSE, { "X-HP-Free": "1" })))).toEqual(off);
    expect(seen).toEqual([]);
    // an unknown caller on the same instance still sees the advert
    expect((await h(get(PULSE, { "x-real-ip": "7.7.7.7" }))).headers.get("x-hp-free-tier")).toBeTruthy();
  });

  it("advert lookup in doubt (store down / slow / unconfigured / no IP / lookup cap) -> no advert", async () => {
    const off = await snap(await pulseHandler().h(get(PULSE)));
    const H = ip("1.2.3.4");
    for (const fail of ["throw", "slow", "500"] as const)
      expect(await shouldAdvertise({ headers: H, env: { ...UP, HP_FREE_TIER: "optin" }, fetchFn: fakeUpstash({ fail }).fn as unknown as typeof fetch }), fail).toBe(false);
    expect(await shouldAdvertise({ headers: H, env: { HP_FREE_TIER: "optin" }, fetchFn: fakeUpstash().fn as unknown as typeof fetch })).toBe(false);
    expect(await shouldAdvertise({ headers: new Headers(), env: UP, fetchFn: fakeUpstash().fn as unknown as typeof fetch })).toBe(false);
    resetFreeTierState();
    const f = fakeUpstash();
    const env = { ...UP, HP_FREE_ADVERT_LOOKUP_CAP: "2" };
    const r = [];
    for (let i = 0; i < 3; i++) r.push(await shouldAdvertise({ headers: H, env, fetchFn: f.fn as unknown as typeof fetch, now: NOW }));
    expect(r).toEqual([true, true, false]);
    expect(f.fn).toHaveBeenCalledTimes(2);
    // wired: store down -> the 402 is byte-identical to mode off
    stubEnv({ ...UP, HP_FREE_TIER: "optin" });
    vi.stubGlobal("fetch", fakeUpstash({ fail: "throw" }).fn);
    expect(await snap(await pulseHandler().h(get(PULSE)))).toEqual(off);
  });

  it("a settled paid call marks the caller as a known payer (hashed IP, 30 d); afterwards no advert and no free calls", async () => {
    stubEnv({ ...UP, ...CDP_ENV, HP_FREE_TIER: "optin" });
    const f = fakeUpstash();
    vi.stubGlobal("fetch", f.fn);
    installFacilitatorMock({
      verify: () => ({ isValid: true, payer: `0x${"11".repeat(20)}` }),
      settle: (_u, _p, r) => ({ success: true, transaction: `0x${"ab".repeat(32)}`, network: r.network, payer: `0x${"11".repeat(20)}` }),
    });
    const { h } = pulseHandler();
    const unpaid = await h(get(PULSE));
    expect(unpaid.headers.get("x-hp-free-tier")).toBeTruthy(); // unknown so far
    const { decodePaymentRequiredHeader, encodePaymentSignatureHeader } = await import("@x402/core/http");
    const a = decodePaymentRequiredHeader(unpaid.headers.get("payment-required")!).accepts[0];
    const payload = {
      x402Version: 2,
      accepted: a,
      payload: {
        signature: `0x${"cd".repeat(65)}`,
        authorization: { from: `0x${"11".repeat(20)}`, to: a.payTo, value: a.amount, validAfter: "0", validBefore: "9999999999", nonce: `0x${"00".repeat(32)}` },
      },
    };
    const paid = await h(get(`${PULSE}?free=1`, { "payment-signature": encodePaymentSignatureHeader(payload as never) }));
    expect(paid.status).toBe(200);
    expect(paid.headers.get("payment-response")).toBeTruthy(); // paid wins over ?free=1: charged as today
    expect(paid.headers.get("x-hp-free-remaining")).toBeNull();
    await new Promise((r) => setTimeout(r, 10));
    const set = f.calls.find((c) => c[0] === "SET")!;
    expect(set).toEqual(["SET", payerMarkerKey("1.2.3.4"), "1", "EX", String(14 * 86400)]);
    expect(f.calls.some((c) => c[0] === "EVAL")).toBe(false); // the paid call never touched the counter
    const after = await h(get(PULSE));
    expect(after.headers.get("x-hp-free-tier")).toBeNull();
    expect(await after.clone().text()).toBe("{}");
    const optIn = await h(get(`${PULSE}?free=1`));
    expect(optIn.status).toBe(402);
    expect(optIn.headers.get("x-hp-free-remaining")).toBeNull();
  });

  it("marker writing only while the tier is optin or pre-seeding is on", async () => {
    expect(payerMarkWriting({})).toBe(false);
    expect(payerMarkWriting({ HP_FREE_TIER: "optin", HP_FREE_IP_HMAC_KEY: TEST_KEY })).toBe(true);
    expect(payerMarkWriting({ HP_FREE_PAYER_MARK: "on", HP_FREE_IP_HMAC_KEY: TEST_KEY })).toBe(true);
    expect(payerMarkWriting({ HP_FREE_TIER: "optin" })).toBe(false); // no key -> never
    expect(payerMarkWriting({ HP_FREE_PAYER_MARK: "on" })).toBe(false);
    const f = fakeUpstash();
    expect(await markPayer({ headers: ip("1.2.3.4"), env: UP, fetchFn: f.fn as unknown as typeof fetch })).toBe(false);
    expect(f.fn).not.toHaveBeenCalled();
    expect(await markPayer({ headers: ip("1.2.3.4"), env: { ...UP, HP_FREE_PAYER_MARK: "on" }, fetchFn: f.fn as unknown as typeof fetch })).toBe(true);
    expect(f.kv.has(payerMarkerKey("1.2.3.4"))).toBe(true);
  });

  it("optin + CDP: the CDP 402 '{}' body gains only freeTier; PAYMENT-REQUIRED unchanged", async () => {
    stubEnv({ ...UP, ...CDP_ENV });
    installFacilitatorMock();
    vi.stubGlobal("fetch", fakeUpstash().fn);
    const off = await pulseHandler().h(get(PULSE));
    expect(await off.clone().text()).toBe("{}");
    vi.stubEnv("HP_FREE_TIER", "optin");
    const on = await pulseHandler().h(get(PULSE));
    expect(on.status).toBe(402);
    expect(on.headers.get("payment-required")).toBe(off.headers.get("payment-required"));
    expect(Object.keys(await on.json())).toEqual(["freeTier"]);
  });

  it("optin + ?free=1: free 200 with the handler's own body, X-HP-Free-* and X-HP-Next; marker stripped; no settle", async () => {
    stubEnv({ ...UP, HP_FREE_TIER: "optin" });
    const f = fakeUpstash();
    vi.stubGlobal("fetch", f.fn);
    const { h, seen } = pulseHandler();
    const res = await h(get(`${PULSE}?free=1&x=2`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, v: 1, priced: FREE_PRICED, charged: false });
    expect(res.headers.get("x-hp-charged")).toBe("free, not charged");
    expect(res.headers.get("x-hp-free-limit")).toBe("3");
    expect(res.headers.get("x-hp-free-remaining")).toBe("2");
    expect(res.headers.get("x-hp-free-reset")).toMatch(/^\d{4}-\d{2}-\d{2}T0[45]:00:00\.000Z$/);
    expect(res.headers.get("x-hp-next")).toBe("https://horizonpulse.dev/api/signals");
    expect(res.headers.get("link")).toBe('<https://horizonpulse.dev/api/signals>; rel="next"');
    expect(res.headers.get("payment-response")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(seen).toEqual([{ url: `${PULSE}?x=2`, free: null }]);
    expect(f.fn).toHaveBeenCalledTimes(1);
    // header opt-in works too and the handler never sees it
    const r2 = await h(get(PULSE, { "X-HP-Free": "1" }));
    expect(r2.status).toBe(200);
    expect(r2.headers.get("x-hp-free-remaining")).toBe("1");
    expect(seen[1]).toEqual({ url: PULSE, free: null });
  });

  it("free answer says 'free, not charged' in place of the route price; charged:false; non-JSON bytes kept", async () => {
    stubEnv({ ...UP, HP_FREE_TIER: "optin" });
    vi.stubGlobal("fetch", fakeUpstash().fn);
    const priced = { amountUsd: "$0.005", amountAtomic: "5000", network: "base" };
    const h = createX402GetHandler(async () => NextResponse.json({ ok: true, priced, charged: true, data: 1 }), pulseRouteConfig(), pulseOpts);
    const res = await h(get(`${PULSE}?free=1`));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("0.005");
    expect(text).not.toContain("5000");
    const j = JSON.parse(text);
    expect(j).toEqual({ ok: true, priced: FREE_PRICED, charged: false, data: 1 });
    expect(Object.keys(j)).toEqual(["ok", "priced", "charged", "data"]); // same positions
    expect(j.priced.note).toBe("free, not charged");
    expect(res.headers.get("content-length")).toBeNull();
    // the real price block shape from pricedBlock() is replaced too
    const real = await toFreeAnswer(NextResponse.json({ priced: { route: "/api/pulse", usd: 0.005 } }), "/api/pulse", { remaining: 1, limit: 3, reset: "x" });
    expect((await real.json()).priced).toEqual(FREE_PRICED);
    const txt = await toFreeAnswer(new Response("plain", { headers: { "content-type": "text/plain" } }), "/api/pulse", { remaining: 1, limit: 3, reset: "x" });
    expect(await txt.text()).toBe("plain");
    expect(txt.headers.get("x-hp-charged")).toBe("free, not charged");
    const arr = await toFreeAnswer(NextResponse.json([1, 2]), "/api/pulse", { remaining: 1, limit: 3, reset: "x" });
    expect(await arr.json()).toEqual([1, 2]);
  });

  it("no platform IP (only client-settable x-forwarded-for / x-vercel-forwarded-for, or a list in x-real-ip): 402 byte-identical to mode off, no free, no store call", async () => {
    stubEnv(UP);
    const f = fakeUpstash();
    vi.stubGlobal("fetch", f.fn);
    const bare = (url: string, headers: Record<string, string> = {}) => new NextRequest(url, { headers: { accept: "application/json", ...headers } });
    const off = await snap(await pulseHandler().h(bare(PULSE)));
    vi.stubEnv("HP_FREE_TIER", "optin");
    const { h, seen } = pulseHandler();
    const spoof = { "x-vercel-forwarded-for": "1.2.3.4", "x-forwarded-for": "1.2.3.4" };
    expect(await snap(await h(bare(PULSE, spoof)))).toEqual(off);
    expect(await snap(await h(bare(`${PULSE}?free=1`, { "x-real-ip": "203.0.113.9, 1.2.3.4" })))).toEqual(off);
    expect(await snap(await h(bare(`${PULSE}?free=1`, spoof)))).toEqual(off);
    expect(await snap(await h(bare(PULSE, { ...spoof, "X-HP-Free": "1" })))).toEqual(off);
    expect(await snap(await h(bare(`${PULSE}?free=1`)))).toEqual(off);
    expect(seen).toEqual([]);
    expect(f.fn).not.toHaveBeenCalled();
  });

  it("spoofed x-forwarded-for / x-vercel-forwarded-for cannot mint a new caller: the counter follows the platform IP", async () => {
    stubEnv({ ...UP, HP_FREE_TIER: "optin", HP_FREE_DAILY_CAP: "2" });
    vi.stubGlobal("fetch", fakeUpstash().fn);
    const { h, seen } = pulseHandler();
    const r1 = await h(get(`${PULSE}?free=1`, { "x-vercel-forwarded-for": "9.9.9.1", "x-forwarded-for": "9.9.9.1" }));
    const r2 = await h(get(`${PULSE}?free=1`, { "x-vercel-forwarded-for": "9.9.9.2", "x-forwarded-for": "9.9.9.2" }));
    const r3 = await h(get(`${PULSE}?free=1`, { "x-vercel-forwarded-for": "9.9.9.3", "x-forwarded-for": "9.9.9.3" }));
    expect([r1.status, r2.status, r3.status]).toEqual([200, 200, 402]);
    expect([r1, r2, r3].map((r) => r.headers.get("x-hp-free-remaining"))).toEqual(["1", "0", "0"]);
    expect(seen.length).toBe(2);
  });

  it("known-payer guard keys on the platform IP: spoofed x-forwarded-for / x-vercel-forwarded-for do not escape it", async () => {
    stubEnv(UP);
    const f = fakeUpstash();
    vi.stubGlobal("fetch", f.fn);
    const off = await snap(await pulseHandler().h(get(PULSE)));
    vi.stubEnv("HP_FREE_TIER", "optin");
    f.kv.set(payerMarkerKey("1.2.3.4"), 1);
    const { h, seen } = pulseHandler();
    const spoof = { "x-vercel-forwarded-for": "7.7.7.7", "x-forwarded-for": "7.7.7.7" };
    expect(await snap(await h(get(`${PULSE}?free=1`, spoof)))).toEqual(off);
    expect(await snap(await h(get(PULSE, spoof)))).toEqual(off);
    expect(seen).toEqual([]);
  });

  it("every free route points at its paid next step", async () => {
    stubEnv({ ...UP, HP_FREE_TIER: "optin", HP_FREE_DAILY_CAP: "10" });
    vi.stubGlobal("fetch", fakeUpstash().fn);
    for (const r of FREE_TIER_ROUTES) {
      const opts = { ...pulseOpts, resource: `https://horizonpulse.dev${r}` };
      const h = createX402GetHandler(async () => NextResponse.json({ ok: true }), pulseRouteConfig(), opts);
      const res = await h(get(`https://horizonpulse.dev${r}?free=1`));
      expect(res.status, r).toBe(200);
      expect(res.headers.get("x-hp-next"), r).toBe(`https://horizonpulse.dev${FREE_TIER_NEXT[r]}`);
    }
  });

  it("optin, daily limit reached: today's 402 + X-HP-Free-Remaining: 0 (+ global budget variant)", async () => {
    stubEnv({ ...UP, HP_FREE_TIER: "optin", HP_FREE_DAILY_CAP: "1" });
    vi.stubGlobal("fetch", fakeUpstash().fn);
    const { h, seen } = pulseHandler();
    expect((await h(get(`${PULSE}?free=1`))).status).toBe(200);
    const capped = await h(get(`${PULSE}?free=1`));
    expect(capped.status).toBe(402);
    expect(capped.headers.get("payment-required")).toBeTruthy();
    expect(capped.headers.get("x-hp-free-remaining")).toBe("0");
    expect(capped.headers.get("x-hp-free-status")).toBe("daily_limit_reached");
    expect(seen.length).toBe(1);

    resetFreeTierState();
    vi.stubEnv("HP_FREE_GLOBAL_DAILY_CAP", "1");
    vi.stubGlobal("fetch", fakeUpstash().fn);
    const g = pulseHandler();
    expect((await g.h(get(`${PULSE}?free=1`, { "x-real-ip": "9.9.9.9" }))).status).toBe(200);
    const spent = await g.h(get(`${PULSE}?free=1`, { "x-real-ip": "8.8.8.8" }));
    expect(spent.status).toBe(402);
    expect(spent.headers.get("x-hp-free-status")).toBe("global_budget_spent");
  });

  it("optin, Upstash down / slow / unconfigured: normal 402, never a free answer", async () => {
    for (const env of [{ ...UP, fail: "throw" }, { ...UP, fail: "slow" }, { ...UP, fail: "500" }, { fail: "none" }] as const) {
      vi.unstubAllEnvs();
      resetFreeTierState();
      stubEnv({ HP_FREE_TIER: "optin", HP_FREE_IP_HMAC_KEY: TEST_KEY });
      if ("UPSTASH_REDIS_REST_URL" in env) stubEnv(UP);
      vi.stubGlobal("fetch", fakeUpstash({ fail: env.fail === "none" ? undefined : env.fail }).fn);
      const { h, seen } = pulseHandler();
      const res = await h(get(`${PULSE}?free=1`));
      expect(res.status, env.fail).toBe(402);
      expect(res.headers.get("payment-required")).toBeTruthy();
      // Odin C-M1: store in doubt -> shouldAdvertise (also in doubt) says no -> no advert, no status header
      expect(res.headers.get("x-hp-free-status")).toBeNull();
      expect(res.headers.get("x-hp-free-tier")).toBeNull();
      expect(seen).toEqual([]);
    }
  });

  it("optin: paid requests, HEAD, and non-free routes never touch the counter", async () => {
    stubEnv({ ...UP, HP_FREE_TIER: "optin" });
    const f = fakeUpstash();
    vi.stubGlobal("fetch", f.fn);
    const { h, seen } = pulseHandler();
    const paid = await h(get(`${PULSE}?free=1`, { "payment-signature": "e30=" }));
    expect(paid.status).not.toBe(200);
    expect(paid.headers.get("x-hp-free-tier")).toBeNull(); // not an unpaid 402: no advert
    const head = await h(get(`${PULSE}?free=1`, {}, "HEAD"));
    expect(head.status).toBe(402);
    const sig = createX402GetHandler(async () => NextResponse.json({ ok: true }), signalsRouteConfig(), signalsOpts);
    const s = await sig(get("https://horizonpulse.dev/api/signals?free=1"));
    expect(s.status).toBe(402);
    expect(s.headers.get("x-hp-free-tier")).toBeNull();
    expect(await s.text()).not.toContain("freeTier");
    expect(f.calls.some((c) => c[0] === "EVAL")).toBe(false);
    expect(seen).toEqual([]);
  });

  it("OPTIONS: unchanged when off; advertises the opt-in when on (free-tier routes only)", async () => {
    const off = await snap(await discoveryOptionsResponse(pulseOpts));
    vi.stubEnv("HP_FREE_TIER", "optin");
    const on = await discoveryOptionsResponse(pulseOpts);
    expect(on.status).toBe(200);
    expect(on.headers.get("payment-required")).toBe(off.pr);
    expect(on.headers.get("x-hp-free-tier")).toContain("?free=1");
    const j = await on.json();
    expect(j.freeTier.note).toBe(freeTierCopy());
    const { freeTier: _f, ...rest } = j;
    expect(rest).toEqual(JSON.parse(off.body));
    const sig = await discoveryOptionsResponse(signalsOpts);
    expect(sig.headers.get("x-hp-free-tier")).toBeNull();
    expect(await sig.text()).not.toContain("freeTier");
  });
});

describe("free tier: discovery copy follows the mode exactly", () => {
  const llmsFile = readFileSync("public/llms.txt", "utf8");
  const openapiFile = readFileSync("public/openapi.json", "utf8");

  it("off: /.well-known/x402 and skill.md byte-identical to the unflagged output; free-tier doc routes 404", async () => {
    const wk = await wellKnown().text();
    const sk = await skillMd().text();
    vi.stubEnv("HP_FREE_TIER", "off");
    expect(await wellKnown().text()).toBe(wk);
    expect(await skillMd().text()).toBe(sk);
    for (const s of [wk, sk]) expect(s).not.toMatch(/free=1|X-HP-Free|free calls/);
    expect(llmsFile).not.toMatch(/free=1|X-HP-Free/);
    expect(openapiFile).not.toMatch(/x-free-tier|free=1/);
    expect(freeLlms().status).toBe(404);
    expect(freeOpenapi().status).toBe(404);
  });

  it("optin: every surface carries the same copy sentence (cap, opt-in, all 7 routes)", async () => {
    vi.stubEnv("HP_FREE_TIER", "optin");
    const copy = freeTierCopy();
    expect(copy).toContain("add ?free=1 (or the X-HP-Free: 1 header) for 3 free calls/day per caller in total across");
    expect(copy).toContain("for callers that have not paid before");
    for (const r of FREE_TIER_ROUTES) expect(copy).toContain(r);

    const wkRes = wellKnown();
    const wk = await wkRes.json();
    expect(wk.instructions.endsWith(` ${copy}`)).toBe(true);
    expect(wk.freeTier.dailyLimitPerCaller).toBe(3);
    expect(wk.freeTier.routes).toEqual(FREE_TIER_ROUTES.map((r) => `https://horizonpulse.dev${r}`));
    expect(wk.resources.length).toBeGreaterThan(20); // resources untouched

    const sk = await skillMd().text();
    expect(sk).toContain(`## Free tier (opt-in)\n\n${copy}\n`);

    const llms = await freeLlms().text();
    expect(llms).toContain(`## Free tier (opt-in)\n\n${copy}\n`);
    expect(llms.indexOf("## Free tier (opt-in)")).toBeLessThan(llms.indexOf("## Live paid routes"));
    expect(llms.replace(/## Free tier \(opt-in\)[\s\S]*?(?=## Live paid routes)/, "")).toBe(llmsFile); // original otherwise intact
    for (const r of FREE_TIER_ROUTES) expect(llms).toContain(`\`GET ${r}?free=1\``);

    const oa = await freeOpenapi().json();
    expect(oa["x-free-tier"].note).toBe(copy);
    expect(oa.info.description.endsWith(copy)).toBe(true);
    for (const r of FREE_TIER_ROUTES) expect(oa.paths[r].get["x-free-tier"], r).toMatchObject({ dailyLimitPerCaller: 3, next: FREE_TIER_NEXT[r] });
    const orig = JSON.parse(openapiFile);
    expect(Object.keys(oa.paths)).toEqual(Object.keys(orig.paths));
    expect(oa.paths["/api/signals"]).toEqual(orig.paths["/api/signals"]);

    // 402 body and OPTIONS carry the same sentence
    stubEnv(UP);
    vi.stubGlobal("fetch", fakeUpstash().fn);
    expect((await (await pulseHandler().h(get(PULSE))).json()).freeTier.note).toBe(copy);
    expect((await (await discoveryOptionsResponse(pulseOpts)).json()).freeTier.note).toBe(copy);
  });

  it("optin with a custom cap: the number changes everywhere at once", async () => {
    stubEnv({ HP_FREE_TIER: "optin", HP_FREE_DAILY_CAP: "50" });
    const s = "for 50 free calls/day";
    expect(freeTierCopy()).toContain(s);
    expect((await wellKnown().json()).instructions).toContain(s);
    expect(await skillMd().text()).toContain(s);
    expect(await freeLlms().text()).toContain(s);
    expect((await freeOpenapi().json())["x-free-tier"].dailyLimitPerCaller).toBe(50);
    expect((await discoveryOptionsResponse(pulseOpts)).headers.get("x-hp-free-tier")).toContain(s);
  });
});


// ---------- 10/18 batch: Counsel B (keyed hashes), Odin C-M1 (budget order), C-L1 (memo), C-L2 (GET-only) ----------

const full = async (r: Response) => ({ status: r.status, body: await r.text(), h: [...r.headers.entries()].filter(([k]) => k !== "date").sort() });

describe("free tier: HMAC secret rule (HP_FREE_IP_HMAC_KEY, any string of 43+ chars)", () => {
  const k43 = "x".repeat(43);
  it("missing, empty or 42 chars -> off; any 43+ char string (not only base64) -> optin", () => {
    for (const key of [undefined, "", "a".repeat(42), " ".repeat(42)]) {
      expect(freeIpHmacKey({ HP_FREE_IP_HMAC_KEY: key }), String(key?.length)).toBeNull();
      expect(freeTierMode({ HP_FREE_TIER: "optin", HP_FREE_IP_HMAC_KEY: key })).toBe("off");
      expect(payerMarkWriting({ HP_FREE_TIER: "optin", HP_FREE_PAYER_MARK: "on", HP_FREE_IP_HMAC_KEY: key })).toBe(false);
    }
    for (const key of [k43, "correct horse battery staple!? correct horse #1", "pässwörd-€-🔑-".padEnd(43, "~"), "AAAA/+==".repeat(6)]) {
      expect(key.length).toBeGreaterThanOrEqual(43);
      expect(freeTierMode({ HP_FREE_TIER: "optin", HP_FREE_IP_HMAC_KEY: key })).toBe("optin");
    }
  });
  it("missing or short key with HP_FREE_TIER=optin: every surface byte-identical to mode off, zero store calls", async () => {
    stubEnv(UP);
    vi.stubEnv("HP_FREE_IP_HMAC_KEY", "");
    const f = fakeUpstash();
    vi.stubGlobal("fetch", f.fn);
    const off = {
      plain: await full(await pulseHandler().h(get(PULSE))),
      options: await full(await discoveryOptionsResponse(pulseOpts)),
      wk: await (await wellKnown()).text(),
      skill: await (await skillMd()).text(),
      privacy: privacyLine(),
    };
    for (const key of ["", "short", "y".repeat(42)]) {
      vi.stubEnv("HP_FREE_TIER", "optin");
      vi.stubEnv("HP_FREE_IP_HMAC_KEY", key);
      const { h, seen } = pulseHandler();
      expect(await full(await h(get(PULSE))), key).toEqual(off.plain);
      expect(await full(await h(get(`${PULSE}?free=1`)))).toEqual(off.plain);
      expect(await full(await h(get(PULSE, { "X-HP-Free": "1" })))).toEqual(off.plain);
      expect(await full(await discoveryOptionsResponse(pulseOpts))).toEqual(off.options);
      expect(await (await wellKnown()).text()).toBe(off.wk);
      expect(await (await skillMd()).text()).toBe(off.skill);
      expect(freeTierRewrites()).toEqual([]);
      expect(privacyLine()).toBe(ROUTE_LOG_PRIVACY_LINE);
      expect(seen).toEqual([]);
    }
    expect(f.fn).not.toHaveBeenCalled();
    expect(await markPayer({ headers: ip("1.2.3.4"), env: { ...UP, HP_FREE_IP_HMAC_KEY: "", HP_FREE_PAYER_MARK: "on" }, fetchFn: f.fn as unknown as typeof fetch })).toBe(false);
    expect(() => callerKey("1.2.3.4", "2026-10-18", { HP_FREE_IP_HMAC_KEY: "z".repeat(42) })).toThrow("hmac_key_unset");
    expect(() => payerMarkerKey("1.2.3.4", {})).toThrow("hmac_key_unset");
  });
  it("43-char key: free tier works (free answer)", async () => {
    stubEnv({ ...UP, HP_FREE_TIER: "optin", HP_FREE_IP_HMAC_KEY: k43 });
    vi.stubGlobal("fetch", fakeUpstash().fn);
    expect((await pulseHandler().h(get(`${PULSE}?free=1`))).status).toBe(200);
  });
  it("master = HKDF-SHA256(raw string); day key = HMAC(master, day); counter = HMAC(dayKey, ip); marker = HMAC(HMAC(master, label), ip)", () => {
    const env = { HP_FREE_IP_HMAC_KEY: TEST_KEY };
    const master = Buffer.from(hkdfSync("sha256", Buffer.from(TEST_KEY, "utf8"), FREE_IP_HKDF_SALT, FREE_IP_HKDF_INFO, 32));
    expect(freeIpMasterKey(env).equals(master)).toBe(true);
    const dayKey = createHmac("sha256", master).update("hp-free-counter-day|2026-10-18").digest();
    expect(callerKey("1.2.3.4", "2026-10-18", env)).toBe(createHmac("sha256", dayKey).update("1.2.3.4").digest("hex").slice(0, 32));
    const mk = createHmac("sha256", master).update("hp-free-payer-marker").digest();
    expect(payerMarkerKey("1.2.3.4", env)).toBe(`hp:fp:paid:${createHmac("sha256", mk).update("1.2.3.4").digest("hex").slice(0, 32)}`);
    // never the old unkeyed hashes
    expect(callerKey("1.2.3.4", "2026-10-18", env)).not.toBe(createHash("sha256").update("1.2.3.4|2026-10-18").digest("hex").slice(0, 32));
    expect(payerMarkerKey("1.2.3.4", env)).not.toBe(`hp:fp:paid:${createHash("sha256").update("hp-free-payer|1.2.3.4").digest("hex").slice(0, 32)}`);
    // a different secret gives different keys; the raw string is used as set (no trimming)
    const other = { HP_FREE_IP_HMAC_KEY: `${TEST_KEY} ` };
    expect(callerKey("1.2.3.4", "2026-10-18", other)).not.toBe(callerKey("1.2.3.4", "2026-10-18", env));
    // per-day counter keys differ across days; the marker key does not (it must persist)
    expect(callerKey("1.2.3.4", "2026-10-19", env)).not.toBe(callerKey("1.2.3.4", "2026-10-18", env));
  });
  it("marker TTL: default 14 d, HP_FREE_PAYER_MARK_TTL_DAYS 1-30, junk -> 14; privacy sentence follows", () => {
    expect(payerMarkTtlDays({})).toBe(14);
    expect(payerMarkTtlS({})).toBe(14 * 86400);
    expect(payerMarkTtlDays({ HP_FREE_PAYER_MARK_TTL_DAYS: "30" })).toBe(30);
    for (const v of ["0", "31", "-1", "abc", "1.5", "100"]) expect(payerMarkTtlDays({ HP_FREE_PAYER_MARK_TTL_DAYS: v }), v).toBe(14);
    expect(freeTierPrivacySentences(14)).toContain("for 14 days after a paid call");
    expect(freeTierPrivacySentences(1)).toContain("for 1 day after a paid call");
  });
});

describe("free tier: privacy line ships only with the flag (Counsel ruling B wording)", () => {
  const B =
    "For free-tier calls we log the timestamp, route and outcome. We do not store IP addresses in readable form, and we do not store user agents, headers or request content. To run the opt-in free tier we keep a keyed one-way hash of the caller's IP address (for IPv6, its /64 network): one to count free calls per day, deleted after about 26 hours, and, for 14 days after a paid call, one marking that IP as a previous payer so it is not offered free calls. These hashes are not linked to wallet addresses, transaction hashes or receipt IDs.";
  it("off (default), or optin without a key: today's Counsel line, byte-identical", () => {
    expect(privacyLine({})).toBe(ROUTE_LOG_PRIVACY_LINE);
    expect(privacyLine({ HP_FREE_TIER: "optin" })).toBe(ROUTE_LOG_PRIVACY_LINE);
    expect(privacyLine({ HP_FREE_PAYER_MARK: "on" })).toBe(ROUTE_LOG_PRIVACY_LINE);
  });
  it("optin + key, or marker pre-seeding + key: Counsel's B sentences replace the no-IP sentence (word for word)", () => {
    for (const env of [{ HP_FREE_TIER: "optin", HP_FREE_IP_HMAC_KEY: TEST_KEY }, { HP_FREE_PAYER_MARK: "on", HP_FREE_IP_HMAC_KEY: TEST_KEY }]) {
      const line = privacyLine(env);
      expect(line).toBe(ROUTE_LOG_PRIVACY_LINE.replace(NO_IP_SENTENCE, B));
      expect(line).not.toContain("We do not store IP addresses,");
    }
    expect(ROUTE_LOG_PRIVACY_LINE).toContain(NO_IP_SENTENCE);
  });
});

describe("free tier: budget-order fix (Odin C-M1): known payers and no-IP callers never see the advert", () => {
  async function offBaseline(headers: Record<string, string> = {}) {
    stubEnv(UP);
    vi.stubEnv("HP_FREE_TIER", "");
    vi.stubGlobal("fetch", fakeUpstash().fn);
    return full(await pulseHandler().h(get(PULSE, headers)));
  }
  /** optin with the per-instance global flag set (one EVAL said global budget spent). */
  async function withGlobalFlag(f: ReturnType<typeof fakeUpstash>) {
    stubEnv({ ...UP, HP_FREE_TIER: "optin", HP_FREE_GLOBAL_DAILY_CAP: "1" });
    vi.stubGlobal("fetch", f.fn);
    const { h } = pulseHandler();
    expect((await h(get(`${PULSE}?free=1`, { "x-real-ip": "9.9.9.1" }))).status).toBe(200);
    const spent = await h(get(`${PULSE}?free=1`, { "x-real-ip": "9.9.9.2" }));
    expect(spent.headers.get("x-hp-free-status")).toBe("global_budget_spent"); // EVAL-verified: advert OK
  }
  it("known payer + global budget spent: opted-in and plain 402 byte-identical to off, no EVAL", async () => {
    const off = await offBaseline();
    const f = fakeUpstash();
    await withGlobalFlag(f);
    f.kv.set(payerMarkerKey("1.2.3.4"), 1);
    const evals = () => f.calls.filter((c) => c[0] === "EVAL").length;
    const before = evals();
    const { h, seen } = pulseHandler();
    expect(await full(await h(get(`${PULSE}?free=1`)))).toEqual(off);
    expect(await full(await h(get(PULSE)))).toEqual(off);
    expect(await full(await h(get(PULSE, { "X-HP-Free": "1" })))).toEqual(off);
    expect(evals()).toBe(before);
    expect(seen).toEqual([]);
  });
  it("no IP + global budget spent: byte-identical to off, zero store calls", async () => {
    const bare = (url: string, headers: Record<string, string> = {}) => new NextRequest(url, { headers: { accept: "application/json", ...headers } });
    stubEnv(UP);
    vi.stubEnv("HP_FREE_TIER", "");
    vi.stubGlobal("fetch", fakeUpstash().fn);
    const off = await full(await pulseHandler().h(bare(PULSE)));
    const f = fakeUpstash();
    await withGlobalFlag(f);
    const n = f.fn.mock.calls.length;
    const { h } = pulseHandler();
    for (const req of [bare(`${PULSE}?free=1`), bare(PULSE, { "X-HP-Free": "1" }), bare(`${PULSE}?free=1`, { "x-forwarded-for": "7.7.7.7" }), bare(PULSE)])
      expect(await full(await h(req))).toEqual(off);
    expect(f.fn.mock.calls.length).toBe(n);
  });
  it("unknown caller + global budget spent (memo, unverified): advert only after the payer EXISTS says no marker", async () => {
    const f = fakeUpstash();
    await withGlobalFlag(f);
    const n = f.calls.length;
    const r = await pulseHandler().h(get(`${PULSE}?free=1`, { "x-real-ip": "5.5.5.5" }));
    expect(r.status).toBe(402);
    expect(r.headers.get("x-hp-free-status")).toBe("global_budget_spent");
    expect(f.calls.slice(n).map((c) => c[0])).toEqual(["EXISTS"]);
  });
  it("known payer + store down: byte-identical to off (no 'unavailable' advert)", async () => {
    const off = await offBaseline();
    for (const fail of ["throw", "500", "slow"] as const) {
      resetFreeTierState();
      stubEnv({ ...UP, HP_FREE_TIER: "optin" });
      vi.stubGlobal("fetch", fakeUpstash({ fail }).fn);
      const { h } = pulseHandler();
      expect(await full(await h(get(`${PULSE}?free=1`))), fail).toEqual(off);
      expect(await full(await h(get(PULSE))), fail).toEqual(off);
    }
  });
});

describe("free tier: capped-today memo (Odin C-L1)", () => {
  it("a capped caller costs one EVAL, then none for the rest of the ET day on this instance; resets next ET day", async () => {
    const f = fakeUpstash();
    const env = { ...UP, HP_FREE_DAILY_CAP: "1" };
    const now = new Date("2026-10-18T15:00:00Z");
    const c = (n: Date = now) => consumeFreeCall({ route: "/api/gas", headers: ip("6.6.6.6"), env, fetchFn: f.fn as unknown as typeof fetch, now: n });
    expect(await c()).toMatchObject({ kind: "free" });
    expect(await c()).toMatchObject({ kind: "capped", global: false, verified: true });
    expect(cappedMemoSize()).toBe(1);
    for (let i = 0; i < 5; i++) expect(await c()).toMatchObject({ kind: "capped", global: false, verified: false });
    expect(f.fn).toHaveBeenCalledTimes(2);
    // other callers are unaffected
    expect(await consumeFreeCall({ route: "/api/gas", headers: ip("6.6.6.7"), env, fetchFn: f.fn as unknown as typeof fetch, now })).toMatchObject({ kind: "free" });
    // next ET day (04:30 UTC 10/19 = 00:30 EDT): memo no longer applies
    expect(await c(new Date("2026-10-19T04:30:00Z"))).toMatchObject({ kind: "free" });
  });
  it("no-IP callers never touch the memo or the store", async () => {
    const f = fakeUpstash();
    expect(await consumeFreeCall({ route: "/api/gas", headers: new Headers(), env: UP, fetchFn: f.fn as unknown as typeof fetch })).toEqual({ kind: "unavailable", reason: "no_caller_ip" });
    expect(cappedMemoSize()).toBe(0);
    expect(f.fn).not.toHaveBeenCalled();
  });
  it("memo hit for a caller who has since paid: no advert (payer EXISTS decides)", async () => {
    stubEnv({ ...UP, HP_FREE_TIER: "optin", HP_FREE_DAILY_CAP: "1" });
    const f = fakeUpstash();
    vi.stubGlobal("fetch", f.fn);
    const { h } = pulseHandler();
    expect((await h(get(`${PULSE}?free=1`))).status).toBe(200);
    expect((await h(get(`${PULSE}?free=1`))).headers.get("x-hp-free-status")).toBe("daily_limit_reached");
    f.kv.set(payerMarkerKey("1.2.3.4"), 1); // paid on another instance
    stubEnv(UP);
    vi.stubEnv("HP_FREE_TIER", "");
    const off = await full(await pulseHandler().h(get(PULSE)));
    vi.stubEnv("HP_FREE_TIER", "optin");
    expect(await full(await h(get(`${PULSE}?free=1`)))).toEqual(off);
  });
});

describe("free tier: the 7 routes are GET-only (Odin C-L2: stripFreeMarker rebuilds GET requests without a body)", () => {
  it("no route module of a free-tier route exports POST/PUT/PATCH/DELETE; each exports GET", () => {
    for (const r of FREE_TIER_ROUTES) {
      const src = readFileSync(path.join(process.cwd(), "app", ...r.split("/").filter(Boolean), "route.ts"), "utf8");
      expect(src, r).toMatch(/^export (const|async function|function) GET\b/m);
      expect(src, r).not.toMatch(/^export\s+(const|let|var|async\s+function|function)\s+(POST|PUT|PATCH|DELETE)\b/m);
      expect(src, r).not.toMatch(/^export\s*\{[^}]*\b(POST|PUT|PATCH|DELETE)\b/m);
    }
  });
});
