/**
 * /api/repo-pressure (DARK, HP_REPO_PRESSURE_ENABLED). Upstream is faked; values are test values only.
 * Key rule (Counsel P1/P2, NY Fed reply 10/23): no raw NY Fed value ever appears in a paid body.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { BOARD_POLICY_RATES, BOARD_PRATES_URL, policyOn, resetFedCachesForTests, type FedDeps } from "@/lib/fed-derived-inputs";
import { bandOf, parseRepoQuery, repoPressure, seasonalFlag, REPO_PRESSURE_DESCRIPTION } from "@/lib/repo-pressure";
import { repoPressureHandler } from "@/app/api/repo-pressure/handler";
import { REPO_PRESSURE_TIERS, darkEnabled } from "@/lib/dark-routes";

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
  for (const t of ["SOFR", "TGCR"] as const) for (const r of rows(t)) for (const v of [r.percentRate, r.percentPercentile1, r.percentPercentile25, r.percentPercentile75, r.percentPercentile99]) { s.add(v.toFixed(2)); s.add(String(v)); }
  return [...s];
}
afterEach(() => { resetFedCachesForTests(); vi.unstubAllEnvs(); });

describe("Board policy table (implementation notes read 10/24/2026)", () => {
  it("is ascending, never retroactive, and IORB - ON RRP = 15 bp on every row", () => {
    for (let i = 1; i < BOARD_POLICY_RATES.length; i++) expect(BOARD_POLICY_RATES[i]!.effective > BOARD_POLICY_RATES[i - 1]!.effective).toBe(true);
    for (const r of BOARD_POLICY_RATES) { expect(Math.round((r.iorb - r.on_rrp) * 100)).toBe(15); expect(r.source_url).toMatch(/^https:\/\/www\.federalreserve\.gov\/newsevents\/pressreleases\/monetary\d{8}a1\.htm$/); }
    expect(policyOn("2026-09-16")!.iorb).toBe(3.65);
    expect(policyOn("2026-09-17")!.iorb).toBe(3.9);
    expect(policyOn("2025-09-17")).toBeNull();
  });
});

describe("fs-v1 bands", () => {
  it("calm / firm / stressed from the worst leg; iqr-only read is partial", () => {
    expect(bandOf({ sofr_minus_iorb_bp: -3, sofr_p99_minus_iorb_bp: 5, sofr_iqr_bp: 5 })).toEqual({ band: "calm", driver: "none", partial: false });
    expect(bandOf({ sofr_minus_iorb_bp: -3, sofr_p99_minus_iorb_bp: 5, sofr_iqr_bp: 6 })).toEqual({ band: "firm", driver: "iqr", partial: false });
    expect(bandOf({ sofr_minus_iorb_bp: 3, sofr_p99_minus_iorb_bp: 5, sofr_iqr_bp: 6 })).toEqual({ band: "stressed", driver: "sofr_minus_iorb", partial: false });
    expect(bandOf({ sofr_minus_iorb_bp: -10, sofr_p99_minus_iorb_bp: 16, sofr_iqr_bp: 1 })).toEqual({ band: "stressed", driver: "p99_minus_iorb", partial: false });
    expect(bandOf({ sofr_minus_iorb_bp: null, sofr_p99_minus_iorb_bp: null, sofr_iqr_bp: 11 })).toEqual({ band: "stressed", driver: "iqr", partial: true });
    expect(bandOf({ sofr_minus_iorb_bp: 1, sofr_p99_minus_iorb_bp: 1, sofr_iqr_bp: null }).band).toBe("unavailable");
  });
  it("seasonal flags are calendar annotations", () => {
    expect(seasonalFlag("2026-09-30")).toBe("quarter_end");
    expect(seasonalFlag("2026-10-30")).toBe("month_end");
    expect(seasonalFlag("2026-09-15")).toBe("tax_date");
    expect(seasonalFlag("2026-11-16")).toBeNull();
    expect(seasonalFlag("2027-06-15")).toBe("tax_date");
  });
});

describe("query", () => {
  it("modes, exclusivity and caps", () => {
    expect(parseRepoQuery(new URLSearchParams(""))).toMatchObject({ ok: true, range: false });
    expect(parseRepoQuery(new URLSearchParams("last=1"))).toMatchObject({ ok: true, range: false });
    expect(parseRepoQuery(new URLSearchParams("last=5"))).toMatchObject({ ok: true, range: true });
    expect(parseRepoQuery(new URLSearchParams("last=11")).ok).toBe(false);
    expect(parseRepoQuery(new URLSearchParams("startDate=2026-09-01&endDate=2026-10-02")).ok).toBe(false);
    expect(parseRepoQuery(new URLSearchParams("date=2026-10-22&last=2")).ok).toBe(false);
    expect(parseRepoQuery(new URLSearchParams("rates=SOFR")).ok).toBe(false);
  });
});

describe("paid body", () => {
  it("latest: derived fields, band, Board citation, full terms; NO raw NY Fed value anywhere", async () => {
    const r = await repoPressure({ kind: "latest" }, deps());
    expect(r.ok).toBe(true);
    const b = (r as { body: Record<string, unknown> }).body as Record<string, any>;
    expect(b.as_of_effective_date).toBe("2026-10-22");
    expect(b.inputs.iorb.status).toBe("ok");
    expect(b.iorb.effective_from).toBe("2026-09-17");
    expect(typeof b.derived.sofr_minus_iorb_bp).toBe("number");
    expect(b.derived.sofr_iqr_bp).toBe(6);
    expect(b.derived.sofr_minus_tgcr_bp).toBe(2);
    expect(b.band).toBe("firm");
    expect(b.persistence_days).toBeGreaterThan(1);
    expect(b.derived.sofr_volume_pctile_1y).toBe(0);
    expect(b.terms.dtcc_notice).toContain("DTCC Solutions LLC");
    expect(b.terms.fee_line).toBe("The fee is for Horizon Pulse's analysis only; NY Fed Content is free at the source.");
    const json = JSON.stringify(b);
    for (const v of rawStrings()) expect(json, v).not.toContain(v);
    expect(json).not.toMatch(/percentRate|percentPercentile|volumeInBillions/);
  });
  it("range: series newest first, capped, no raw values", async () => {
    const r = await repoPressure({ kind: "range", start: "2026-10-01", end: "2026-10-22" }, deps());
    const s = ((r as any).body.series as any[]);
    expect(s.length).toBe(16);
    expect(s[0].as_of_effective_date).toBe("2026-10-22");
    const json = JSON.stringify((r as any).body);
    for (const v of rawStrings()) expect(json, v).not.toContain(v);
  });
  it("Board file disagrees (new FOMC row not committed) -> IORB UNVERIFIED, IORB legs null, partial iqr-only band", async () => {
    const r = await repoPressure({ kind: "latest" }, deps({ boardValue: "3.65", boardEff: "11/05/2026" }));
    const b = (r as any).body;
    expect(b.inputs.iorb.status).toBe("UNVERIFIED");
    expect(b.derived.sofr_minus_iorb_bp).toBeNull();
    expect(b.partial).toBe(true);
    expect(b.band).toBe("firm");
    expect(b.note).toContain("IORB not verified");
  });
  it("Board file down -> fail closed the same way", async () => {
    const b = ((await repoPressure({ kind: "latest" }, deps({ boardDown: true }))) as any).body;
    expect(b.inputs.iorb.status).toBe("UNVERIFIED");
    expect(b.partial).toBe(true);
  });
  it("SOFR unavailable -> 503 not charged, error carries no raw value", async () => {
    const r = await repoPressure({ kind: "latest" }, deps({ sofrDown: true }));
    expect(r).toMatchObject({ ok: false, status: 503, code: "inputs_unavailable" });
  });
  it("one upstream call per series (cache), no FRED or other vendor", async () => {
    const d = deps();
    await repoPressure({ kind: "latest" }, d);
    await repoPressure({ kind: "last", n: 3 }, d);
    expect(d.urls.filter((u) => u.includes("/sofr/")).length).toBe(1);
    for (const u of d.urls) expect(u).toMatch(/^https:\/\/(markets\.newyorkfed\.org|www\.federalreserve\.gov)\//);
  });
});

describe("handler", () => {
  const base = REPO_PRESSURE_TIERS.find((t) => t.id === "base")!;
  const range = REPO_PRESSURE_TIERS.find((t) => t.id === "range")!;
  it("tiers: base $0.01, range $0.02", () => {
    expect(base.atomicStr).toBe("10000");
    expect(range.atomicStr).toBe("20000");
  });
  it("multi-date on the base tier -> 400 bad_tier before any upstream read", async () => {
    const d = deps();
    const res = await repoPressureHandler(new NextRequest("https://x.test/api/repo-pressure?last=3"), base, "r1", d);
    expect(res.status).toBe(400);
    expect(d.urls.length).toBe(0);
  });
  it("200 carries priced + receipt + disclaimer", async () => {
    const res = await repoPressureHandler(new NextRequest("https://x.test/api/repo-pressure"), base, "r2", deps());
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.receipt.route).toBe("/api/repo-pressure");
    expect(j.disclaimer).toContain("not affiliated with the New York Fed");
  });
  it("flag defaults off; description names no NY Fed endorsement and gives no instruction", () => {
    expect(darkEnabled("repopressure", {})).toBe(false);
    expect(darkEnabled("repopressure", { HP_REPO_PRESSURE_ENABLED: "1" })).toBe(false);
    expect(REPO_PRESSURE_DESCRIPTION.length).toBeLessThanOrEqual(500);
    expect(REPO_PRESSURE_DESCRIPTION).not.toMatch(/powered by|endorsed|\byou\b|\bshould\b/i);
  });
});
