/** /api/money-market-rates (Markets spec v2): free, pass-through, §5 status ladder. No network: fixtures recorded 2026-10-12. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { moneyMarketRates, parseHolidayPage, parseQuery, rateStatus, resetMmrCachesForTests, type Deps } from "@/lib/money-market-rates";

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
