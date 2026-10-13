/** /api/money-market-rates (Markets spec v2): free, pass-through, §5 status ladder. No network: fixtures recorded 2026-10-12. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { cacheablePayload, mmrCacheSizesForTests, moneyMarketRates, parseHolidayPage, parseQuery, rateStatus, resetMmrCachesForTests, type Deps } from "@/lib/money-market-rates";

const FX = path.join(__dirname, "fixtures", "mmr");
const NY = readFileSync(path.join(FX, "nyfed-holiday-2026-10-12.html"), "utf8");
const K8 = readFileSync(path.join(FX, "k8-2026-10-12.html"), "utf8");
const LATEST = JSON.parse(readFileSync(path.join(FX, "all-latest-2026-10-12.json"), "utf8"));

function deps(nowIso: string, over: Partial<Deps> = {}): Deps & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    now: () => new Date(nowIso),
    fetchText: async (u) => (u.includes("newyorkfed") ? NY : K8),
    fetchJson: async (u) => { urls.push(u); return LATEST; },
    ...over,
  };
}
beforeEach(() => resetMmrCachesForTests());

describe("params", () => {
  it("defaults and validation", () => {
    expect(parseQuery(new URLSearchParams(""))).toEqual({ ok: true, query: { kind: "latest", rates: ["SOFR", "EFFR", "OBFR", "TGCR", "BGCR"] } });
    expect(parseQuery(new URLSearchParams("rates=bgcr,sofr"))).toMatchObject({ ok: true, query: { rates: ["SOFR", "BGCR"] } });
    for (const q of ["foo=1", "rates=SOFRAI", "last=11", "last=0", "last=2&startDate=2026-10-01&endDate=2026-10-02", "startDate=2026-10-01", "startDate=2018-04-01&endDate=2018-04-03", "startDate=2026-09-01&endDate=2026-10-02", "startDate=2026-02-30&endDate=2026-03-02"])
      expect(parseQuery(new URLSearchParams(q)).ok, q).toBe(false);
    expect(parseQuery(new URLSearchParams("startDate=2026-09-01&endDate=2026-10-01")).ok).toBe(true);
  });
});

describe("holiday pages (live-read, both required)", () => {
  it("parses Columbus Day 2026 closed on both, Sunday->Monday, Saturday ignored", () => {
    const ny = parseHolidayPage(NY), k8 = parseHolidayPage(K8);
    expect(ny.has("2026-10-12") && k8.has("2026-10-12")).toBe(true);
    expect(ny.has("2026-11-26")).toBe(true);
    expect(ny.has("2026-07-04") || ny.has("2026-07-03")).toBe(false); // Sat Jul 4 2026: no weekday closure from it
    expect(ny.has("2027-07-05")).toBe(true); // Sun Jul 4 2027 -> Mon
  });
});

describe("response on Mon 2026-10-12 (holiday) 09:30 ET", () => {
  it("passes NY Fed values through unchanged, fresh, holiday calendar, terms", async () => {
    const r = await moneyMarketRates({ kind: "latest", rates: ["SOFR", "EFFR", "OBFR", "TGCR", "BGCR"] }, deps("2026-10-12T13:30:00Z"));
    expect(r.route).toBe("money-market-rates");
    expect(r.calendar.today_status).toBe("holiday, no publish");
    const sofr = r.rates[0];
    expect(sofr.status).toBe("fresh");
    expect(sofr.status_note).toContain("2026-10-13");
    expect(sofr.source_url).toBe("https://markets.newyorkfed.org/api/rates/all/latest.json");
    const raw = LATEST.refRates.find((x: { type: string }) => x.type === "SOFR");
    expect(sofr.observations[0]).toEqual(Object.fromEntries(Object.entries(raw).filter(([k]) => k !== "type")));
    expect(r.rates[1].observations[0]).toHaveProperty("targetRateTo", 4);
    expect(JSON.stringify(r)).not.toContain("SOFRAI");
    expect(JSON.stringify(r)).not.toMatch(/average30day|spread|stress/i);
    expect(r.terms.dtcc_notice).toBeDefined();
    expect(r.terms.credit).toContain("© 2026");
  });
  it("omits DTCC notice when neither SOFR nor BGCR", async () => {
    const r = await moneyMarketRates({ kind: "latest", rates: ["EFFR"] }, deps("2026-10-12T13:30:00Z"));
    expect(r.terms).not.toHaveProperty("dtcc_notice");
  });
});

describe("status ladder", () => {
  const closed = new Set(["2026-10-12"]);
  const base = { closed, releaseMin: 480, secured: true };
  it("Tue 10/13 before 08:00: prior print PENDING-not-yet-due", () => {
    expect(rateStatus({ ...base, latest: "2026-10-08", today: "2026-10-13", minutes: 470 }).status).toBe("PENDING-not-yet-due");
  });
  it("08:10 missing -> PENDING; 08:30 missing -> STALE; SOFRAI today -> no publish", () => {
    expect(rateStatus({ ...base, latest: "2026-10-08", today: "2026-10-13", minutes: 490 }).status).toBe("PENDING");
    expect(rateStatus({ ...base, latest: "2026-10-08", today: "2026-10-13", minutes: 510 }).status).toBe("STALE as-of 2026-10-08");
    expect(rateStatus({ ...base, latest: "2026-10-08", today: "2026-10-13", minutes: 510, sofraiToday: true }).status).toBe("no publish 2026-10-09");
    expect(rateStatus({ ...base, latest: "2026-10-09", today: "2026-10-13", minutes: 510 }).status).toBe("fresh");
  });
  it("disagreeing pages -> UNVERIFIED", () => {
    expect(rateStatus({ ...base, disagree: new Set(["2026-10-12"]), latest: "2026-10-08", today: "2026-10-12", minutes: 600 }).status).toBe("UNVERIFIED holiday status");
  });
});

describe("failure", () => {
  it("holiday pages unreadable -> UNVERIFIED, no stale call", async () => {
    const r = await moneyMarketRates({ kind: "latest", rates: ["SOFR"] }, deps("2026-10-13T14:00:00Z", { fetchText: async () => { throw new Error("x"); } }));
    expect(r.calendar.today_status).toBe("UNVERIFIED holiday status");
    expect(r.rates[0].status).toBe("UNVERIFIED holiday status");
  });
  it("two failed attempts -> unavailable, empty observations, never filled", async () => {
    const d = deps("2026-10-13T14:00:00Z", { fetchJson: async (u) => { d.urls.push(u); throw new Error("down"); } });
    const r = await moneyMarketRates({ kind: "latest", rates: ["OBFR"] }, d);
    expect(d.urls).toEqual(["https://markets.newyorkfed.org/api/rates/all/latest.json", "https://markets.newyorkfed.org/api/rates/unsecured/obfr/last/1.json"]);
    expect(r.rates[0]).toMatchObject({ status: "unavailable", observations: [] });
  });
  it("range search omits type=", async () => {
    const d = deps("2026-10-13T14:00:00Z");
    await moneyMarketRates({ kind: "range", rates: ["SOFR"], startDate: "2026-10-01", endDate: "2026-10-08" }, d);
    expect(d.urls[0]).toBe("https://markets.newyorkfed.org/api/rates/secured/sofr/search.json?startDate=2026-10-01&endDate=2026-10-08");
  });
});

describe("route", () => {
  it("bad params -> 400; no 402 / payment header ever", async () => {
    const { GET } = await import("@/app/api/money-market-rates/route");
    const res = await GET(new NextRequest("https://horizonpulse.dev/api/money-market-rates?bogus=1"));
    expect(res.status).toBe(400);
    expect(res.headers.get("payment-required")).toBeNull();
    expect(readFileSync(path.join(__dirname, "..", "app", "api", "money-market-rates", "route.ts"), "utf8")).not.toMatch(/withX402|x402-server|createX402/);
  });
});

describe("Class A 10/12 fixes: bounded cache + upstream budget", () => {
  const RANGE_ROWS = (d: string) => ({ refRates: ["SOFR", "EFFR", "OBFR", "TGCR", "BGCR"].map((type) => ({ type, effectiveDate: d, percentRate: 4.1 })) });
  it("200 one-day ranges stay bounded in cache entries and upstream fetches", async () => {
    const mod = await import("@/lib/money-market-rates");
    let t = Date.parse("2026-10-13T15:00:00Z");
    let fetches = 0;
    const d: Deps = { now: () => new Date(t), fetchText: async (u) => (u.includes("newyorkfed") ? NY : K8), fetchJson: async (u) => { fetches++; return RANGE_ROWS(/startDate=([\d-]+)/.exec(u)![1]); } };
    let ok = 0, limited = 0;
    for (let i = 0; i < 200; i++) {
      const day = new Date(Date.parse("2025-01-01T12:00:00Z") + i * 86_400_000).toISOString().slice(0, 10);
      try { await moneyMarketRates({ kind: "range", rates: ["SOFR", "EFFR", "OBFR", "TGCR", "BGCR"], startDate: day, endDate: day }, { ...d, clientIp: `10.0.0.${i % 50}` }); ok++; }
      catch (e) { expect(e).toBeInstanceOf(mod.MmrUpstreamLimited); limited++; }
    }
    expect(fetches).toBeLessThanOrEqual(mod.UPSTREAM_GLOBAL_PER_WINDOW);
    expect(limited).toBeGreaterThan(0);
    expect(ok).toBeGreaterThan(0);
    // across many windows the cache never exceeds its cap
    for (let i = 0; i < 400; i++) {
      t += mod.UPSTREAM_WINDOW_MS / 10;
      const day = new Date(Date.parse("2024-01-01T12:00:00Z") + i * 86_400_000).toISOString().slice(0, 10);
      try { await moneyMarketRates({ kind: "range", rates: ["SOFR"], startDate: day, endDate: day }, { ...d, clientIp: `ip${i}` }); } catch { /* limited */ }
      expect(mmrCacheSizesForTests().cache).toBeLessThanOrEqual(mod.CACHE_MAX_ENTRIES);
    }
    expect(mmrCacheSizesForTests().cache).toBe(mod.CACHE_MAX_ENTRIES);
    expect(mmrCacheSizesForTests().lastGood).toBeLessThanOrEqual(5);
    expect(mmrCacheSizesForTests().ipKeys).toBeLessThanOrEqual(mod.IP_KEYS_MAX);
  });

  it("per-IP limit trips before global; other IPs still served", async () => {
    const mod = await import("@/lib/money-market-rates");
    const d = deps("2026-10-13T15:00:00Z", { fetchJson: async (u) => RANGE_ROWS(/startDate=([\d-]+)/.exec(u)![1]) });
    let lim: unknown = null;
    for (let i = 0; i < 20 && !lim; i++) {
      const day = `2025-02-${String(i + 1).padStart(2, "0")}`;
      try { await moneyMarketRates({ kind: "range", rates: ["SOFR"], startDate: day, endDate: day }, { ...d, clientIp: "1.1.1.1" }); } catch (e) { lim = e; }
    }
    expect((lim as InstanceType<typeof mod.MmrUpstreamLimited>).scope).toBe("ip");
    const r = await moneyMarketRates({ kind: "range", rates: ["SOFR"], startDate: "2025-03-03", endDate: "2025-03-03" }, { ...d, clientIp: "2.2.2.2" });
    expect(r.rates[0].observations.length).toBe(1);
  });

  it("serves STALE from cache (may not be current) when the budget is spent", async () => {
    let t = Date.parse("2026-10-13T15:00:00Z");
    const d: Deps = { now: () => new Date(t), fetchText: async (u) => (u.includes("newyorkfed") ? NY : K8), fetchJson: async () => LATEST, clientIp: "9.9.9.9" };
    await moneyMarketRates({ kind: "latest", rates: ["SOFR"] }, d);
    t += 11 * 60_000; // cache expired
    for (let i = 0; i < 20; i++) { try { await moneyMarketRates({ kind: "range", rates: ["SOFR"], startDate: `2025-04-${String(i + 1).padStart(2, "0")}`, endDate: `2025-04-${String(i + 1).padStart(2, "0")}` }, d); } catch { /* spend */ } }
    const r = await moneyMarketRates({ kind: "latest", rates: ["SOFR"] }, d);
    expect(r.rates[0].status).toMatch(/^STALE as-of /);
    expect(r.rates[0].status_note).toContain("may not be current");
    expect(r.rates[0].observations.length).toBeGreaterThan(0);
  });

  it("never caches a bad latest.json payload", async () => {
    let n = 0;
    const bad = { refRates: [{ type: "SOFR", effectiveDate: "2026-10-08", percentRate: "4.1" }] };
    const d = deps("2026-10-13T15:00:00Z", { fetchJson: async () => { n++; return n <= 2 ? bad : LATEST; } });
    const r1 = await moneyMarketRates({ kind: "latest", rates: ["SOFR"] }, d);
    expect(r1.rates[0].status).toBe("unavailable");
    expect(cacheablePayload("https://markets.newyorkfed.org/api/rates/all/latest.json", bad)).toBe(false);
    const r2 = await moneyMarketRates({ kind: "latest", rates: ["SOFR"] }, d);
    expect(r2.rates[0].observations.length).toBeGreaterThan(0);
    expect(n).toBe(3);
  });

  it("route: 429 when limited with nothing cached; public max-age=60 and no s-maxage on 200", async () => {
    const mod = await import("@/lib/money-market-rates");
    const { GET } = await import("@/app/api/money-market-rates/route");
    const spy = vi.spyOn(mod, "moneyMarketRates");
    spy.mockRejectedValueOnce(new mod.MmrUpstreamLimited("global"));
    const res = await GET(new NextRequest("https://horizonpulse.dev/api/money-market-rates?startDate=2025-01-02&endDate=2025-01-02"));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    spy.mockResolvedValueOnce({} as never);
    const ok = await GET(new NextRequest("https://horizonpulse.dev/api/money-market-rates"));
    expect(ok.headers.get("cache-control")).toBe("public, max-age=60");
    spy.mockRestore();
  });
});

describe("Class A 10/12 re-review fixes", () => {
  const page = (years: number[], rows: [string, string[]][]) =>
    `<table><tr><th>Holiday</th>${years.map((y) => `<th>${y}</th>`).join("")}</tr>${rows.map(([n, ds]) => `<tr><td>${n}</td>${ds.map((d) => `<td>${d}</td>`).join("")}</tr>`).join("")}</table>`;

  it("empty range (weekend) = fresh, observations [], cached, no retry", async () => {
    const urls: string[] = [];
    const d = deps("2026-10-13T15:00:00Z", { fetchJson: async (u) => { urls.push(u); return { refRates: [] }; } });
    const q = { kind: "range" as const, rates: ["SOFR" as const], startDate: "2026-10-10", endDate: "2026-10-11" };
    const r = await moneyMarketRates(q, d);
    expect(r.rates[0]).toMatchObject({ status: "fresh", status_note: "no publications in range", observations: [] });
    expect(urls.length).toBe(1);
    await moneyMarketRates(q, d);
    expect(urls.length).toBe(1); // served from cache
  });

  it("disagreement only inside years both pages cover; outside = not verified", async () => {
    const { mmrHolidayForTests, rateStatus: rs } = await import("@/lib/money-market-rates");
    const yrsNy = [2026, 2027, 2028, 2029], yrsK8 = [2026, 2027, 2028, 2029, 2030];
    const ny = page(yrsNy, [["New Year", ["January 1", "January 1", "January 1", "January 1"]], ["Columbus", ["October 12", "October 11", "October 9", "October 8"]]]);
    const k8 = page(yrsK8, [["New Year", ["January 1", "January 1", "January 1", "January 1", "January 1"]], ["Columbus", ["October 12", "October 11", "October 9", "October 8", "October 14"]], ["Extra", ["", "March 3", "", "", ""]]]);
    const d = deps("2026-10-13T15:00:00Z", { fetchText: async (u) => (u.includes("newyorkfed") ? ny : k8) });
    await moneyMarketRates({ kind: "latest", rates: ["SOFR"] }, d);
    const h = mmrHolidayForTests()!;
    expect([...h.years].sort()).toEqual([2026, 2027, 2028, 2029]);
    expect(h.disagree.has("2027-03-03")).toBe(true); // both cover 2027, only K.8 closes it
    expect(h.disagree.has("2030-10-14")).toBe(false); // only K.8 covers 2030: not a conflict
    expect(h.closedBoth.has("2030-10-14")).toBe(false);
    const st = rs({ latest: "2030-10-11", today: "2030-10-15", minutes: 600, closed: h.closedBoth, disagree: h.disagree, coveredYears: h.years, releaseMin: 480, secured: true });
    expect(st.status).toBe("UNVERIFIED holiday status");
    expect(st.status_note).toContain("not verified");
    expect(st.status_note).not.toContain("disagree");
  });

  it("holiday read when limited: no slot half-taken, retried after ~1 min (not 6h)", async () => {
    const mod = await import("@/lib/money-market-rates");
    let t = Date.parse("2026-10-13T15:00:00Z");
    let texts = 0;
    const base: Deps = { now: () => new Date(t), clientIp: "7.7.7.7", fetchText: async (u) => { texts++; return u.includes("newyorkfed") ? NY : K8; }, fetchJson: async (u) => RANGE(u) };
    mod.mmrSpendSlotsForTests("7.7.7.7", mod.UPSTREAM_PER_IP_PER_WINDOW - 1, t); // 1 slot left; holidays need 2
    texts = 0;
    const r1 = await moneyMarketRates({ kind: "latest", rates: ["SOFR"] }, base);
    expect(texts).toBe(0); // 1 slot left: neither page fetched, nothing half-taken
    expect(r1.calendar.holiday_checked_at).toBeNull();
    t += 30_000;
    await moneyMarketRates({ kind: "latest", rates: ["SOFR"] }, base);
    expect(texts).toBe(0); // inside the ~1 min back-off
    t += mod.UPSTREAM_WINDOW_MS + mod.HOLIDAY_LIMITED_RETRY_MS;
    const r3 = await moneyMarketRates({ kind: "latest", rates: ["SOFR"] }, base);
    expect(texts).toBe(2);
    expect(r3.calendar.holiday_checked_at).not.toBeNull();
  });

  it("only some rates limited -> per-rate rate_limited, not a whole-request 429", async () => {
    const mod = await import("@/lib/money-market-rates");
    const d = deps("2026-10-13T15:00:00Z", { fetchJson: async (u) => RANGE(u), clientIp: "3.3.3.3" });
    await moneyMarketRates({ kind: "latest", rates: ["SOFR"] }, d); // holiday read (2 slots) + 1
    // per-IP budget 15: 3 used; 10 one-rate ranges -> 13 used; then a 5-rate range has 2 slots left
    for (let i = 0; i < 10; i++) await moneyMarketRates({ kind: "range", rates: ["SOFR"], startDate: `2025-05-${String(i + 1).padStart(2, "0")}`, endDate: `2025-05-${String(i + 1).padStart(2, "0")}` }, d);
    const r = await moneyMarketRates({ kind: "range", rates: ["SOFR", "EFFR", "OBFR", "TGCR", "BGCR"], startDate: "2025-06-02", endDate: "2025-06-02" }, d);
    const st = r.rates.map((x) => x.status);
    expect(st.filter((x) => x === "fresh").length).toBe(2);
    expect(st.filter((x) => x === "rate_limited").length).toBe(3);
    await expect(moneyMarketRates({ kind: "range", rates: ["SOFR"], startDate: "2025-06-03", endDate: "2025-06-03" }, d)).rejects.toBeInstanceOf(mod.MmrUpstreamLimited);
  });
});
const RANGE = (u: string) => {
  const m = /\/(sofr|effr|obfr|tgcr|bgcr)\/search\.json\?startDate=([\d-]+)/.exec(u);
  if (!m) return LATEST;
  return { refRates: [{ type: m[1].toUpperCase(), effectiveDate: m[2], percentRate: 4.1 }] };
};

describe("Class A 10/12 third review: failed holiday reads + stale empty range", () => {
  for (const kind of ["fetch error", "empty page", "malformed page"] as const) {
    it(`holiday read ${kind} retries after 10 min, not before`, async () => {
      const mod = await import("@/lib/money-market-rates");
      let t = Date.parse("2026-10-13T15:00:00Z");
      let texts = 0, broken = true;
      const d: Deps = {
        now: () => new Date(t), fetchJson: async () => LATEST,
        fetchText: async (u) => {
          texts++;
          if (broken) { if (kind === "fetch error") throw new Error("timeout"); return kind === "empty page" ? "" : "<table><tr><td>garbage</td></tr>"; }
          return u.includes("newyorkfed") ? NY : K8;
        },
      };
      const r1 = await moneyMarketRates({ kind: "latest", rates: ["SOFR"] }, d);
      expect(texts).toBe(2);
      expect(r1.calendar.holiday_checked_at).toBeNull();
      broken = false;
      t += mod.HOLIDAY_FAILED_RETRY_MS - 1000;
      await moneyMarketRates({ kind: "latest", rates: ["SOFR"] }, d);
      expect(texts).toBe(2); // not before 10 min
      t += 1000;
      const r3 = await moneyMarketRates({ kind: "latest", rates: ["SOFR"] }, d);
      expect(texts).toBe(4);
      expect(r3.calendar.holiday_checked_at).not.toBeNull();
    });
  }

  it("failed refresh with a good cached read still retries after 10 min (not 6h)", async () => {
    const mod = await import("@/lib/money-market-rates");
    let t = Date.parse("2026-10-13T15:00:00Z");
    let texts = 0, broken = false;
    const d: Deps = { now: () => new Date(t), fetchJson: async () => LATEST, fetchText: async (u) => { texts++; if (broken) throw new Error("x"); return u.includes("newyorkfed") ? NY : K8; } };
    await moneyMarketRates({ kind: "latest", rates: ["SOFR"] }, d);
    broken = true; t += mod.HOLIDAY_REFRESH_MS;
    await moneyMarketRates({ kind: "latest", rates: ["SOFR"] }, d);
    expect(texts).toBe(4);
    broken = false; t += mod.HOLIDAY_FAILED_RETRY_MS - 1000;
    await moneyMarketRates({ kind: "latest", rates: ["SOFR"] }, d);
    expect(texts).toBe(4);
    t += 1000;
    await moneyMarketRates({ kind: "latest", rates: ["SOFR"] }, d);
    expect(texts).toBe(6);
  });

  it("expired cached empty range served under the limit = STALE, may not be current", async () => {
    const mod = await import("@/lib/money-market-rates");
    let t = Date.parse("2026-10-13T15:00:00Z");
    const d: Deps = { now: () => new Date(t), clientIp: "5.5.5.5", fetchText: async (u) => (u.includes("newyorkfed") ? NY : K8), fetchJson: async () => ({ refRates: [] }) };
    const q = { kind: "range" as const, rates: ["SOFR" as const], startDate: "2026-10-10", endDate: "2026-10-11" };
    expect((await moneyMarketRates(q, d)).rates[0].status).toBe("fresh");
    t += 11 * 60_000;
    mod.mmrSpendSlotsForTests("5.5.5.5", mod.UPSTREAM_PER_IP_PER_WINDOW, t);
    const r = await moneyMarketRates(q, d);
    expect(r.rates[0].status).toMatch(/^STALE as-of 2026-10-13T11:00:00-04:00$/);
    expect(r.rates[0].status_note).toContain("may not be current");
    expect(r.rates[0].observations).toEqual([]);
  });
});

describe("served_at (spec v2: actual serve time)", () => {
  it("is read after the upstream fetch, never before retrieved_at, and moves on a cache hit", async () => {
    let t = Date.parse("2026-10-13T09:04:51-04:00");
    const d: Deps = {
      now: () => new Date(t),
      fetchText: async (u) => (u.includes("newyorkfed") ? NY : K8),
      fetchJson: async () => { t += 1000; return LATEST; }, // fetch takes 1 s
    };
    const a = await moneyMarketRates({ kind: "latest", rates: ["SOFR"] }, d);
    expect(Date.parse(a.served_at)).toBeGreaterThanOrEqual(Date.parse(a.retrieved_at));
    t = Date.parse("2026-10-13T09:05:12-04:00"); // 21 s later: server-side cache hit, no new fetch
    const b = await moneyMarketRates({ kind: "latest", rates: ["SOFR"] }, d);
    expect(b.retrieved_at).toBe(a.retrieved_at);
    expect(b.served_at).toBe("2026-10-13T09:05:12-04:00");
  });
});
