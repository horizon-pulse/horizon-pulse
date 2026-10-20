/** Odin 9:09 AM AST 10/19: rail alerts also persisted (best-effort) to Upstash; /status shows counts. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ALERT_LIST_CAP, ALERT_STATUS_CACHE_S, ALERT_WRITE_CAP_PER_DAY, alertEntry, alertWriteStats, stripQuery, cachedAlertSummary, countKey, flushAlertPersistForTests, listKey, persistAlert, readAlertSummary,
  resetAlertSummaryCacheForTests, setAlertPersistForTests, truncateAddress,
} from "@/lib/alert-persist";
import { AlertCounts } from "@/components/AlertCounts";
import { setXrplAlertHook } from "@/lib/xrpl-rail";
import { __solanaReconcileForTests, setSolanaAlertHook } from "@/lib/solana-rail";

const ENV = { UPSTASH_REDIS_REST_URL: "https://fake.example", UPSTASH_REDIS_REST_TOKEN: "tok", VERCEL_ENV: "production" };

/** Tiny in-memory Upstash pipeline fake. */
function fakeUpstash() {
  const lists = new Map<string, string[]>(), kv = new Map<string, number>(), ttl = new Map<string, number>();
  const calls: unknown[][][] = [];
  const f = vi.fn(async (_url: string, init: RequestInit) => {
    const cmds = JSON.parse(String(init.body)) as (string | number)[][];
    calls.push(cmds);
    const out = cmds.map(([op, k, ...a]) => {
      const key = String(k);
      if (op === "LPUSH") { const l = lists.get(key) ?? []; l.unshift(String(a[0])); lists.set(key, l); return { result: l.length }; }
      if (op === "LTRIM") { lists.set(key, (lists.get(key) ?? []).slice(Number(a[0]), Number(a[1]) + 1)); return { result: "OK" }; }
      if (op === "INCR") { kv.set(key, (kv.get(key) ?? 0) + 1); return { result: kv.get(key) }; }
      if (op === "EXPIRE") { ttl.set(key, Number(a[0])); return { result: 1 }; }
      if (op === "MGET") return { result: [key, ...a].map((x) => (kv.has(String(x)) ? String(kv.get(String(x))) : null)) };
      if (op === "LINDEX") return { result: (lists.get(key) ?? [])[Number(a[0])] ?? null };
      return { error: "ERR" };
    });
    return new Response(JSON.stringify(out), { status: 200 });
  });
  return { f, lists, kv, ttl, calls };
}

afterEach(() => {
  setAlertPersistForTests(null);
  resetAlertSummaryCacheForTests();
  setXrplAlertHook(null);
  setSolanaAlertHook(null);
  vi.restoreAllMocks();
});

const today = () => new Date().toISOString().slice(0, 10);

describe("alert persistence", () => {
  it("an XRPL alert writes the list and the daily counter (with ~35 d TTL); console.error kept", async () => {
    const u = fakeUpstash();
    setAlertPersistForTests({ fetch: u.f as never, env: ENV });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    setXrplAlertHook(null);
    // emit through the real rail hook path
    const { __emitXrplAlertForTests } = await import("@/lib/xrpl-rail");
    __emitXrplAlertForTests({ kind: "xrpl_redeem_fingerprint_mismatch", severity: "high" });
    await flushAlertPersistForTests();
    expect(err).toHaveBeenCalledWith(expect.stringContaining("[xrpl-rail][ALERT][HIGH]"));
    const l = u.lists.get(listKey("xrpl"))!;
    expect(l).toHaveLength(1);
    expect(JSON.parse(l[0])).toMatchObject({ code: "xrpl_redeem_fingerprint_mismatch", severity: "high", route: null, payer: null });
    expect(u.kv.get(countKey("xrpl", today()))).toBe(1);
    expect(u.ttl.get(countKey("xrpl", today()))).toBe(35 * 86400);
  });

  it("a SOLANA_RECONCILE alert lands in hp:alerts:solana with the payer truncated, no full address / signature / tx", async () => {
    const u = fakeUpstash();
    setAlertPersistForTests({ fetch: u.f as never, env: ENV });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const payer = "FC5VNJ3x3DpYkYrvK4LQonJdFv6wWwXSm59JhWQN8BAa";
    __solanaReconcileForTests({ status: 502, reason: "settle_ambiguous", key: "k".repeat(64), amount: "1000", ours: { payer, signature: "S".repeat(88) }, txid: "T".repeat(88) } as never);
    await flushAlertPersistForTests();
    const raw = u.lists.get(listKey("solana"))![0];
    const e = JSON.parse(raw);
    expect(e.code).toBe("solana_reconcile");
    expect(e.payer).toBe("FC5VNJ…8BAa");
    expect(raw).not.toContain(payer);
    expect(raw).not.toMatch(/S{20}|T{20}|k{20}|EPjFW|BjY98/);
    expect(Object.keys(e).sort()).toEqual(["code", "payer", "route", "severity", "ts"]);
  });

  it("LTRIM keeps the cap at 500", async () => {
    const u = fakeUpstash();
    setAlertPersistForTests({ fetch: u.f as never, env: ENV });
    u.lists.set(listKey("xrpl"), Array.from({ length: ALERT_LIST_CAP + 20 }, (_, i) => `old${i}`));
    for (let i = 0; i < 3; i++) persistAlert("xrpl", { kind: "xrpl_entry_dropped" });
    await flushAlertPersistForTests();
    expect(u.lists.get(listKey("xrpl"))).toHaveLength(ALERT_LIST_CAP);
    expect(u.calls.every((c) => c.some((x) => x[0] === "LTRIM" && x[2] === 0 && x[3] === ALERT_LIST_CAP - 1))).toBe(true);
  });

  it("LOW-1: warn_rate is never persisted (either rail, through the real emit path)", async () => {
    const u = fakeUpstash();
    setAlertPersistForTests({ fetch: u.f as never, env: ENV });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { __emitXrplAlertForTests } = await import("@/lib/xrpl-rail");
    __emitXrplAlertForTests({ kind: "warn_rate", count: 99, windowMs: 300000, threshold: 10 });
    persistAlert("solana", { kind: "warn_rate", count: 99, windowMs: 300000, threshold: 10 });
    await flushAlertPersistForTests();
    expect(u.f).not.toHaveBeenCalled();
    expect(alertWriteStats().skippedKind).toBe(2);
    expect(alertWriteStats().written).toBe(0);
  });

  it("LOW-1: hard cap of 50 writes per UTC day per instance; past it only the in-memory count grows; resets next UTC day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-19T23:00:00Z"));
      const u = fakeUpstash();
      setAlertPersistForTests({ fetch: u.f as never, env: ENV });
      expect(ALERT_WRITE_CAP_PER_DAY).toBe(50);
      for (let i = 0; i < 40; i++) persistAlert("xrpl", { kind: "xrpl_entry_dropped" });
      for (let i = 0; i < 30; i++) persistAlert("solana", { kind: "solana_claim_write_failed", severity: "low" });
      await flushAlertPersistForTests();
      expect(u.f).toHaveBeenCalledTimes(50);
      expect(alertWriteStats()).toMatchObject({ day: "2026-10-19", written: 50, overCap: { xrpl: 0, solana: 20 } });
      expect((u.kv.get(countKey("xrpl", "2026-10-19")) ?? 0) + (u.kv.get(countKey("solana", "2026-10-19")) ?? 0)).toBe(50);
      persistAlert("xrpl", { kind: "xrpl_entry_dropped" });
      expect(alertWriteStats().overCap.xrpl).toBe(1);
      expect(u.f).toHaveBeenCalledTimes(50);
      vi.setSystemTime(new Date("2026-10-20T00:00:01Z"));
      persistAlert("xrpl", { kind: "xrpl_entry_dropped" });
      await flushAlertPersistForTests();
      expect(u.f).toHaveBeenCalledTimes(51);
      expect(alertWriteStats()).toMatchObject({ day: "2026-10-20", written: 1, overCap: { xrpl: 0, solana: 0 } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("LOW-2: VERCEL_ENV must be exactly 'production' (unset, preview, ' production', 'Production' = no write, no read)", async () => {
    const u = fakeUpstash();
    const creds = { UPSTASH_REDIS_REST_URL: "https://fake.example", UPSTASH_REDIS_REST_TOKEN: "tok" };
    for (const ve of [undefined, "", "preview", "development", " production", "production ", "Production"]) {
      setAlertPersistForTests({ fetch: u.f as never, env: { ...creds, ...(ve === undefined ? {} : { VERCEL_ENV: ve }) } });
      persistAlert("xrpl", { kind: "xrpl_entry_dropped" });
      expect(await readAlertSummary()).toEqual({ status: "not_applicable", xrpl: null, solana: null });
    }
    await flushAlertPersistForTests();
    expect(u.f).not.toHaveBeenCalled();
    setAlertPersistForTests({ fetch: u.f as never, env: { ...creds, VERCEL_ENV: "production" } });
    persistAlert("xrpl", { kind: "xrpl_entry_dropped" });
    await flushAlertPersistForTests();
    expect(u.f).toHaveBeenCalledTimes(1);
  });

  it("(c) route is stored as pathname only: query string and fragment stripped", async () => {
    expect(stripQuery("/api/pulse?wallet=0xabc&token=x")).toBe("/api/pulse");
    expect(stripQuery("/api/x#frag")).toBe("/api/x");
    expect(stripQuery("/api/plain")).toBe("/api/plain");
    expect(alertEntry({ kind: "k", route: "?only=query" }).route).toBeNull();
    const u = fakeUpstash();
    setAlertPersistForTests({ fetch: u.f as never, env: ENV });
    persistAlert("solana", { kind: "solana_reconcile", route: "/api/market/quote?symbol=SOL&key=secret#x" });
    await flushAlertPersistForTests();
    const raw = u.lists.get(listKey("solana"))![0];
    expect(JSON.parse(raw).route).toBe("/api/market/quote");
    expect(raw).not.toMatch(/symbol|secret|\?|#/);
  });

  it("Upstash error, throw, or hang: never throws, never blocks (returns synchronously), abort at 500 ms", async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      const hang = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_r, rej) => init.signal!.addEventListener("abort", () => { aborted = true; rej(new Error("aborted")); })));
      setAlertPersistForTests({ fetch: hang as never, env: ENV });
      const t0 = Date.now();
      expect(() => persistAlert("solana", { kind: "solana_claim_write_failed", severity: "low" })).not.toThrow();
      expect(Date.now() - t0).toBe(0);
      await vi.advanceTimersByTimeAsync(500);
      await flushAlertPersistForTests();
      expect(aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    setAlertPersistForTests({ fetch: (async () => { throw new Error("boom https://secret token"); }) as never, env: ENV });
    expect(() => persistAlert("xrpl", { kind: "x" })).not.toThrow();
    setAlertPersistForTests({ fetch: (async () => new Response("nope", { status: 500 })) as never, env: ENV });
    expect(() => persistAlert("xrpl", { kind: "x" })).not.toThrow();
    setAlertPersistForTests({ fetch: (() => { throw new Error("sync"); }) as never, env: ENV });
    expect(() => persistAlert("xrpl", { kind: "x" })).not.toThrow();
    await flushAlertPersistForTests();
    expect(await readAlertSummary()).toEqual({ status: "unavailable", xrpl: null, solana: null });
  });

  it("entries never hold a full address; truncateAddress keeps first 6 + last 4 only", () => {
    const base = "0x54e163e9b8edda194d83f46add921bfa5fc5f4e0";
    expect(truncateAddress(base)).toBe("0x54e1…f4e0");
    expect(truncateAddress("short")).toBeNull();
    const e = JSON.stringify(alertEntry({ kind: "k", severity: "high", payer: base, payTo: base, blob: "AB".repeat(200), reason: "x" }));
    expect(e).not.toContain(base);
    expect(e).not.toContain("ABAB");
  });

  it("skips previews (VERCEL_ENV != production) and never reads KV_REST_API_READ_ONLY_TOKEN", async () => {
    const u = fakeUpstash();
    setAlertPersistForTests({ fetch: u.f as never, env: { ...ENV, VERCEL_ENV: "preview" } });
    persistAlert("xrpl", { kind: "x" });
    expect(await readAlertSummary()).toEqual({ status: "not_applicable", xrpl: null, solana: null });
    setAlertPersistForTests({ fetch: u.f as never, env: { KV_REST_API_URL: "https://fake.example", KV_REST_API_READ_ONLY_TOKEN: "ro", VERCEL_ENV: "production" } });
    persistAlert("xrpl", { kind: "x" });
    await flushAlertPersistForTests();
    expect(u.f).not.toHaveBeenCalled();
  });

  it("/status: counts only (today / 7 d); markup has no alert code, timestamp, route, payer or secret", async () => {
    const u = fakeUpstash();
    setAlertPersistForTests({ fetch: u.f as never, env: ENV });
    persistAlert("xrpl", { kind: "xrpl_settle_hash_mismatch", severity: "high", route: "/api/pulse" });
    persistAlert("xrpl", { kind: "xrpl_redeem_fingerprint_mismatch", severity: "high" });
    persistAlert("solana", { kind: "solana_reconcile", payer: "FC5VNJ3x3DpYkYrvK4LQonJdFv6wWwXSm59JhWQN8BAa" });
    await flushAlertPersistForTests();
    const old = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    u.kv.set(countKey("xrpl", old), 4);
    const s = await readAlertSummary();
    expect(s).toEqual({ status: "ok", xrpl: { today: 2, last7d: 6 }, solana: { today: 1, last7d: 1 }, xrplKinds: { todayEt: expect.any(Object), last24h: { xrpl_check_failing: 0, xrpl_entry_dropped: 0, other: 2 } } });
    const html = renderToStaticMarkup(AlertCounts({ a: s }));
    expect(html).toContain('data-hp-alerts="ok"');
    expect(html).toMatch(/data-hp-alert-rail="XRPL".*?>2<.*?>6</);
    expect(html).not.toMatch(/xrpl_|solana_|reconcile|mismatch|severity|high/i); // no alert code
    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}|\d{2}:\d{2}|UTC \d|T\d{2}:/); // no timestamp
    expect(html).not.toMatch(/\/api\/|route/i); // no route
    expect(html).not.toMatch(/fake\.example|tok|FC5VNJ|8BAa/);
    const na = renderToStaticMarkup(AlertCounts({ a: { status: "not_applicable", xrpl: null, solana: null } }));
    expect(na).toContain("not recorded on this deployment");
  });

  it("cached read: repeated /status renders within the 300 s TTL make exactly ONE Upstash fetch; refetch after TTL", async () => {
    const u = fakeUpstash();
    setAlertPersistForTests({ fetch: u.f as never, env: ENV });
    resetAlertSummaryCacheForTests({ disableNextCache: true });
    expect(ALERT_STATUS_CACHE_S).toBeGreaterThanOrEqual(300);
    const t0 = 1_800_000_000_000;
    const rs = await Promise.all(Array.from({ length: 50 }, (_, i) => cachedAlertSummary(t0 + i * 1000))); // concurrent + spread over 49 s
    for (let i = 0; i < 20; i++) await cachedAlertSummary(t0 + 299_000);
    expect(u.f).toHaveBeenCalledTimes(1);
    expect(rs.every((r) => r.status === "ok")).toBe(true);
    await cachedAlertSummary(t0 + 300_000);
    expect(u.f).toHaveBeenCalledTimes(2);
  });

  it("cached read: the real page path (Next cache unavailable outside a request) still makes one fetch per TTL, never throws", async () => {
    const u = fakeUpstash();
    setAlertPersistForTests({ fetch: u.f as never, env: ENV });
    const t0 = 1_800_000_000_000;
    for (let i = 0; i < 30; i++) expect((await cachedAlertSummary(t0 + i)).status).toBe("ok");
    expect(u.f).toHaveBeenCalledTimes(1);
    setAlertPersistForTests({ fetch: (async () => { throw new Error("boom token"); }) as never, env: ENV });
    resetAlertSummaryCacheForTests({ disableNextCache: true });
    await expect(cachedAlertSummary(t0)).resolves.toEqual({ status: "unavailable", xrpl: null, solana: null });
  });
});
