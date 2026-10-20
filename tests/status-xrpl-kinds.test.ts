/** Sentinel 10/19 18:20 EDT: per-kind XRPL alert counts on /status (allowlist, counts only, ET day + last 24 h, 300 s cache). */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ALERT_STATUS_CACHE_S, cachedAlertSummary, flushAlertPersistForTests, persistAlert, readAlertSummary, resetAlertSummaryCacheForTests,
  setAlertPersistForTests, XRPL_ALERT_KINDS, XRPL_KIND_TTL_S, xrplKindKey, xrplKindOf,
} from "@/lib/alert-persist";
import { AlertCounts } from "@/components/AlertCounts";

const ENV = { UPSTASH_REDIS_REST_URL: "https://fake.example", UPSTASH_REDIS_REST_TOKEN: "tok", VERCEL_ENV: "production" };
function fakeUpstash() {
  const kv = new Map<string, number>(), ttl = new Map<string, number>();
  const f = vi.fn(async (_u: string, init: RequestInit) => {
    const cmds = JSON.parse(String(init.body)) as (string | number)[][];
    return new Response(JSON.stringify(cmds.map(([op, k, ...a]) => {
      const key = String(k);
      if (op === "INCR") { kv.set(key, (kv.get(key) ?? 0) + 1); return { result: kv.get(key) }; }
      if (op === "EXPIRE") { ttl.set(key, Number(a[0])); return { result: 1 }; }
      if (op === "MGET") return { result: [key, ...a].map((x) => (kv.has(String(x)) ? String(kv.get(String(x))) : null)) };
      return { result: "OK" };
    })), { status: 200 });
  });
  return { f, kv, ttl };
}
afterEach(() => {
  setAlertPersistForTests(null);
  resetAlertSummaryCacheForTests();
  vi.useRealTimers();
});

describe("/status XRPL alert kinds", () => {
  it("allowlist maps every other kind (incl. attacker-ish strings) to 'other'", () => {
    expect(XRPL_ALERT_KINDS).toEqual(["xrpl_check_failing", "xrpl_entry_dropped", "other"]);
    expect(xrplKindOf("xrpl_check_failing")).toBe("xrpl_check_failing");
    expect(xrplKindOf("xrpl_entry_dropped")).toBe("xrpl_entry_dropped");
    for (const k of ["xrpl_settle_hash_mismatch", "<script>", "rAddr123", undefined, 5]) expect(xrplKindOf(k)).toBe("other");
  });
  it("writes an hourly per-kind counter with a 3-day TTL; counts today (ET) and last 24 h", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // 01:30 ET on 10/19 = 05:30 UTC. An alert at 23:30 ET on 10/18 (03:30 UTC) is in last 24 h but not today ET.
    vi.setSystemTime(new Date("2026-10-19T03:30:00Z"));
    const u = fakeUpstash();
    setAlertPersistForTests({ fetch: u.f as never, env: ENV });
    persistAlert("xrpl", { kind: "xrpl_entry_dropped", reason: "payto_not_ready" });
    await flushAlertPersistForTests();
    vi.setSystemTime(new Date("2026-10-19T05:30:00Z"));
    persistAlert("xrpl", { kind: "xrpl_check_failing", check: "x", reason: "stale", payer: "rPEPPER1CfLvjUxw1aaaaaaaaaaaaaaa", route: "/api/pulse?x=1" });
    persistAlert("xrpl", { kind: "xrpl_check_failing", check: "x", reason: "stale" });
    persistAlert("xrpl", { kind: "xrpl_settle_hash_mismatch", severity: "high" });
    persistAlert("solana", { kind: "solana_reconcile" }); // never counted as an XRPL kind
    await flushAlertPersistForTests();
    expect(u.kv.get(xrplKindKey("xrpl_check_failing", "2026-10-19T05"))).toBe(2);
    expect(u.ttl.get(xrplKindKey("xrpl_check_failing", "2026-10-19T05"))).toBe(XRPL_KIND_TTL_S);
    expect([...u.kv.keys()].some((k) => k.includes("solana") && k.includes(":kind:"))).toBe(false);
    const s = await readAlertSummary(new Date("2026-10-19T05:30:00Z"));
    expect(s.xrplKinds).toEqual({
      todayEt: { xrpl_check_failing: 2, xrpl_entry_dropped: 0, other: 1 },
      last24h: { xrpl_check_failing: 2, xrpl_entry_dropped: 1, other: 1 },
    });
    const html = renderToStaticMarkup(AlertCounts({ a: s }));
    expect(html).toMatch(/data-hp-xrpl-kind="check_failing".*?>2<.*?>2</);
    expect(html).toMatch(/data-hp-xrpl-kind="entry_dropped".*?>0<.*?>1</);
    expect(html).toMatch(/data-hp-xrpl-kind="other".*?>1<.*?>1</);
    expect(html).not.toMatch(/rPEPPER|\/api\/|stale|payto_not_ready|mismatch|severity|reason/i); // no free text, route, payer
    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}|\d{2}:\d{2}|T\d{2}/); // no timestamps
  });
  it("not ok -> no kinds table; counts are clamped integers even if the store returns junk", async () => {
    const u = fakeUpstash();
    setAlertPersistForTests({ fetch: u.f as never, env: ENV });
    const now = new Date();
    u.kv.set(xrplKindKey("other", now.toISOString().slice(0, 13)), -5 as never);
    const s = await readAlertSummary(now);
    expect(s.xrplKinds!.last24h.other).toBe(0);
    const na = renderToStaticMarkup(AlertCounts({ a: { status: "unavailable", xrpl: null, solana: null } }));
    expect(na).not.toContain("data-hp-xrpl-kinds");
  });
  it("uses the existing 300 s /status cache: one Upstash read per window", async () => {
    resetAlertSummaryCacheForTests({ disableNextCache: true });
    const u = fakeUpstash();
    setAlertPersistForTests({ fetch: u.f as never, env: ENV });
    const t0 = 1_000_000;
    await cachedAlertSummary(t0);
    await cachedAlertSummary(t0 + 299_000);
    expect(u.f).toHaveBeenCalledTimes(1);
    expect(ALERT_STATUS_CACHE_S).toBe(300);
    await cachedAlertSummary(t0 + 301_000);
    expect(u.f).toHaveBeenCalledTimes(2);
  });
});
