/**
 * /api/cash-benchmark (DARK, HP_CASH_BENCHMARK_ENABLED). Upstream is faked; values are test values only.
 * Key rule (Counsel P1/P2, NY Fed reply 10/23): no raw NY Fed value ever appears in a paid body.
 * Counsel cash-benchmark ruling 10/23 option (1): 5 bp rounding, my_apy ~0 rejected, no idle_cost, no raw values.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { BOARD_POLICY_RATES, BOARD_PRATES_URL, policyOn, resetFedCachesForTests, type FedDeps } from "@/lib/fed-derived-inputs";
import { cashBenchmark, corridorOf, parseCashQuery, CASH_BENCHMARK_DESCRIPTION } from "@/lib/cash-benchmark";
import { cashBenchmarkHandler } from "@/app/api/cash-benchmark/handler";
import { CASH_BENCHMARK_TIERS, darkEnabled } from "@/lib/dark-routes";
const NOW = Date.parse("2026-10-23T18:00:00Z");
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
function pubDays(end: string, n: number): string[] {
  const out: string[] = [];
  for (let d = end; out.length < n; d = addDays(d, -1)) { const w = new Date(`${d}T00:00:00Z`).getUTCDay(); if (w !== 0 && w !== 6) out.push(d); }
  return out;
}
const DAYS = pubDays("2026-10-22", 280).filter((d) => d >= "2025-09-18");
/** SOFR = IORB - 0.03 + 0.01 * (i % 3); TGCR = SOFR - 0.02; p25/p75 = SOFR -0.02/+0.04; p99 = SOFR + 0.08. */
function rows(type: "SOFR" | "TGCR" | "EFFR") {
  return DAYS.map((d, i) => {
    const s = Math.round((policyOn(d)!.iorb - 0.03 + 0.01 * (i % 3)) * 100) / 100;
    const r = type === "TGCR" ? s - 0.02 : type === "EFFR" ? s - 0.01 : s;
    const f = (x: number) => Math.round(x * 100) / 100;
    return { effectiveDate: d, type, percentRate: f(r), percentPercentile1: f(r - 0.06), percentPercentile25: f(r - 0.02), percentPercentile75: f(r + 0.04), percentPercentile99: f(r + 0.08), volumeInBillions: 2000 + i, revisionIndicator: "" };
  });
}
type O = { boardValue?: string; boardEff?: string; sofrDown?: boolean; boardDown?: boolean };
function deps(o: O = {}): FedDeps & { urls: string[] } {
  const urls: string[] = [];
  const latest = BOARD_POLICY_RATES[BOARD_POLICY_RATES.length - 1]!;
  const [y, m, d] = latest.effective.split("-");
  return {
    urls,
    now: () => NOW,
    fetchJson: async (u: string) => {
      urls.push(u);
      if (u === BOARD_PRATES_URL) { if (o.boardDown) throw new Error("down"); return { Value: o.boardValue ?? latest.iorb.toFixed(2), ForDate: "10/26/2026", EffectiveDate: o.boardEff ?? `${m}/${d}/${y}`, LastUpdated: "10/23/2026" }; }
      if (u.includes("/sofr/")) { if (o.sofrDown) throw new Error("down"); return { refRates: rows("SOFR") }; }
      if (u.includes("/tgcr/")) return { refRates: rows("TGCR") };
      if (u.includes("/effr/")) return { refRates: rows("EFFR") };
      throw new Error(`unexpected ${u}`);
    },
  };
}
/** Every raw NY Fed number in the fake upstream, in every printed form. */
function rawStrings(): string[] {
  const s = new Set<string>();
  for (const t of ["SOFR", "EFFR"] as const) for (const r of rows(t)) for (const v of [r.percentRate, r.percentPercentile1, r.percentPercentile25, r.percentPercentile75, r.percentPercentile99]) { s.add(v.toFixed(2)); s.add(String(v)); }
  return [...s];
}
afterEach(() => { resetFedCachesForTests(); vi.unstubAllEnvs(); });
const q = (s: string) => parseCashQuery(new URLSearchParams(s));
const base = CASH_BENCHMARK_TIERS[0]!;

describe("parseCashQuery", () => {
  it("accepts a percent, or nothing", () => {
    expect(q("my_apy=4.10")).toEqual({ ok: true, q: { my_apy: 4.1 } });
    expect(q("")).toEqual({ ok: true, q: { my_apy: null } });
  });
  it("rejects 0 and anything within 0.05 of 0 (Counsel: no back-solve via my_apy=0)", () => {
    for (const v of ["0", "0.0", "0.05", "0.01", "-0.01"]) expect(q(`my_apy=${v}`).ok, v).toBe(false);
    expect(q("my_apy=0.06").ok).toBe(true);
  });
  it("rejects out-of-range, junk and unknown params", () => {
    for (const s of ["my_apy=101", "my_apy=-1", "my_apy=abc", "my_apy=1e2", "foo=1"]) expect(q(s).ok, s).toBe(false);
  });
});

describe("cashBenchmark body", () => {
  it("every bp field is a multiple of 5; no idle_cost; corridor present", async () => {
    const r = await cashBenchmark({ my_apy: 4.12 }, deps());
    if (!r.ok) throw new Error("not ok");
    const d = r.body.derived as Record<string, unknown>;
    for (const [k, v] of Object.entries(d)) if (k.endsWith("_bp") && v !== null) expect(Math.abs((v as number) % 5), k).toBe(0);
    expect(JSON.stringify(r.body)).not.toMatch(/idle/);
    expect(d.my_apy_vs_corridor).toBe("above_iorb");
    expect(typeof d.sofr_level_pctile_1y).toBe("number");
    expect((r.body.terms as Record<string, string>).derived_label).toContain("modified (rounded to 5 bp)");
    expect((r.body.terms as Record<string, string>).board_credit).toBe("Source: Board of Governors of the Federal Reserve System (federalreserve.gov); public domain unless otherwise indicated.");
  });
  it("never contains a raw NY Fed value (any printed form)", async () => {
    for (const apy of [null, 4.12, 3.8]) {
      resetFedCachesForTests();
      const r = await cashBenchmark({ my_apy: apy }, deps());
      if (!r.ok) throw new Error("not ok");
      const body = JSON.stringify({ ...r.body, input: null });
      for (const s of rawStrings()) expect(body.includes(`:${s},`) || body.includes(`:${s}}`) || body.includes(` ${s} `), s).toBe(false);
    }
  });
  it("never fetches NY Fed RRP operation results; IORB/ON RRP come from the Board table", async () => {
    const d = deps();
    await cashBenchmark({ my_apy: 4 }, d);
    expect(d.urls.some((u) => /rp\/|reverserepo|repo\/all/i.test(u))).toBe(false);
  });
  it("Board UNVERIFIED -> corridor/IORB fields null, still 200", async () => {
    const r = await cashBenchmark({ my_apy: 4 }, deps({ boardValue: "9.99" }));
    if (!r.ok) throw new Error("not ok");
    const d = r.body.derived as Record<string, unknown>;
    expect(d.my_apy_minus_iorb_bp).toBeNull();
    expect(d.my_apy_vs_corridor).toBeNull();
    expect((r.body.status as Record<string, string>).board).toBe("UNVERIFIED");
  });
  it("corridorOf boundaries", () => {
    const p = policyOn("2026-10-22")!;
    expect(corridorOf(p.on_rrp - 0.01, p.on_rrp, p.iorb)).toBe("below_floor");
    expect(corridorOf(p.on_rrp, p.on_rrp, p.iorb)).toBe("inside_corridor");
    expect(corridorOf(p.iorb + 0.01, p.on_rrp, p.iorb)).toBe("above_iorb");
    expect(BOARD_POLICY_RATES.length).toBeGreaterThan(0);
  });
});

describe("handler + flag", () => {
  it("200 carries priced + receipt; 400 for my_apy=0 and 503 for SOFR down are not charged", async () => {
    const ok = await cashBenchmarkHandler(new NextRequest("https://x.test/api/cash-benchmark?my_apy=4.1"), base, "r1", deps());
    expect(ok.status).toBe(200);
    const j = await ok.json();
    expect(j.priced).toBeTruthy(); expect(j.receipt.route).toBe("/api/cash-benchmark");
    const z = await cashBenchmarkHandler(new NextRequest("https://x.test/api/cash-benchmark?my_apy=0"), base, "r2", deps());
    expect(z.status).toBe(400); expect((await z.json()).charged).toBe(false);
    resetFedCachesForTests();
    const down = await cashBenchmarkHandler(new NextRequest("https://x.test/api/cash-benchmark"), base, "r3", deps({ sofrDown: true }));
    expect(down.status).toBe(503); expect((await down.json()).charged).toBe(false);
    expect(BOARD_PRATES_URL).toMatch(/^https:\/\/www\.federalreserve\.gov\//);
  });
  it("is off unless the flag is exactly 'true'; price $0.005; description names no forbidden claims", () => {
    expect(darkEnabled("cashbenchmark", {})).toBe(false);
    expect(darkEnabled("cashbenchmark", { HP_CASH_BENCHMARK_ENABLED: "1" })).toBe(false);
    expect(darkEnabled("cashbenchmark", { HP_CASH_BENCHMARK_ENABLED: "true" })).toBe(true);
    expect(base.atomicStr).toBe("5000");
    expect(CASH_BENCHMARK_DESCRIPTION).not.toMatch(/best|recommend(?!ation of)|move your/i);
  });
});
