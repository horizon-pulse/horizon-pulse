/**
 * Odin re-review of B (10/18) + Counsel re-read batch 2, package check / opt-out deltas:
 *   HP_PACKAGE_DEEP_ENABLED (default off): deep 404 before payment; copy and OPTIONS follow
 *   one overall ~20 s deadline, sources in parallel, partial answers marked (no 50 s worst case)
 *   KEV failures negative-cached for 5 minutes
 *   verdict install / caution / block leads the answer
 *   Counsel: opt-out lookup 20/min; "verified by deps.dev"; Scorecard CDLA line verbatim
 * Offline: every source is a stub.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import * as pkgRoute from "@/app/api/package/check/route";
import { packageCheckHandler } from "@/app/api/package/check/handler";
import { darkDescription, darkPaymentOpts, PACKAGE_DEEP_FLAG, PACKAGE_DESCRIPTION_BASE, PACKAGE_DESCRIPTION_DEEP, PACKAGE_TIERS, packageTierEnabled, resetRateLimitsForTests } from "@/lib/dark-routes";
import { ROUTE_METADATA } from "@/lib/route-metadata";
import { BUILD_PROVENANCE_MEANING, checkPackage, kevCves, KEV_NEGATIVE_TTL_MS, KEV_URL, PACKAGE_DEADLINE_MS, PACKAGE_METHOD, packageVerdict, resetKevCacheForTests, SCORECARD_ATTRIBUTION, VERDICT_NOTE_BLOCK, VERDICT_NOTE_NO_KNOWN_ISSUES, VERDICT_NOTES, type Deps } from "@/lib/package-safety";
import { memoryCache, OPT_OUT_CHECK_GLOBAL_PER_MIN } from "@/lib/dark-checks-shared";

const ROOT = path.resolve(__dirname, "..");
const PKG = "https://horizonpulse.dev/api/package/check?ecosystem=npm&name=lodash";

beforeEach(() => {
  resetRateLimitsForTests();
  resetKevCacheForTests();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

type Src = "latest" | "full" | "downloads" | "osv" | "depsdev" | "kev";
/** Stub sources; `delay` per source in ms; a delayed source honours the abort signal like real fetch. */
function deps(o: { delay?: Partial<Record<Src, number>>; vulns?: unknown[]; kev?: unknown | "down"; depsdev?: unknown; latest?: unknown; deadlineMs?: number; now?: () => number } = {}): Deps & { calls: string[] } {
  const calls: string[] = [];
  const NOW = Date.parse("2026-10-18T12:00:00Z");
  const which = (u: string): Src => (u === KEV_URL ? "kev" : u.includes("api.deps.dev") ? "depsdev" : u.includes("api.osv.dev") ? "osv" : u.includes("/downloads/") ? "downloads" : u.endsWith("/latest") ? "latest" : "full");
  const body = (s: Src): Response => {
    if (s === "kev") return o.kev === "down" ? new Response("x", { status: 500 }) : Response.json(o.kev ?? { vulnerabilities: [] });
    if (s === "depsdev") return Response.json(o.depsdev ?? {});
    if (s === "osv") return Response.json({ vulns: o.vulns ?? [] });
    if (s === "downloads") return Response.json({ downloads: 50_000 });
    if (s === "latest") return o.latest === 404 ? new Response("{}", { status: 404 }) : Response.json(o.latest ?? { version: "1.0.0", license: "MIT", maintainers: [{ name: "a" }] });
    return Response.json({ time: { created: "2020-01-01T00:00:00Z", modified: "2026-10-01T00:00:00Z", "1.0.0": "2026-10-01T00:00:00Z" }, versions: { "1.0.0": {} } });
  };
  return {
    calls,
    now: o.now ?? (() => NOW),
    cache: memoryCache(() => NOW),
    deadlineMs: o.deadlineMs,
    fetch: (async (u: string | URL | Request, init?: RequestInit) => {
      const url = String(u);
      calls.push(url);
      const s = which(url);
      const ms = o.delay?.[s] ?? 0;
      if (ms) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, ms);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      }
      return body(s);
    }) as typeof fetch,
  };
}

describe("HP_PACKAGE_DEEP_ENABLED: deep off by default, 404 before any payment; copy and OPTIONS follow", () => {
  it("flag parsing: only exactly 'true' enables deep; base is always on", () => {
    for (const v of [undefined, "", "1", "TRUE", "yes", " true"]) expect(packageTierEnabled({ id: "deep" }, { [PACKAGE_DEEP_FLAG]: v })).toBe(false);
    expect(packageTierEnabled({ id: "deep" }, { [PACKAGE_DEEP_FLAG]: "true" })).toBe(true);
    expect(packageTierEnabled({ id: "base" }, {})).toBe(true);
  });
  it("route on, deep off: tier=deep is 404 on GET/POST/OPTIONS with no payment request; bad_tier lists base only; base still 402", async () => {
    vi.stubEnv("HP_PACKAGE_CHECK_ENABLED", "true");
    for (const res of [await pkgRoute.GET(new NextRequest(`${PKG}&tier=deep`)), await pkgRoute.POST(new NextRequest(`${PKG}&tier=deep`, { method: "POST", body: "{}" })), await pkgRoute.OPTIONS(new NextRequest(`${PKG}&tier=deep`))]) {
      expect(res.status).toBe(404);
      expect(res.headers.get("payment-required")).toBeNull();
    }
    const bad = await pkgRoute.GET(new NextRequest(`${PKG}&tier=nope`));
    expect(bad.status).toBe(400);
    expect((await bad.json()).tiers.map((t: { tier: string }) => t.tier)).toEqual(["base"]);
    const base = await pkgRoute.GET(new NextRequest(PKG));
    expect(base.status).toBe(402);
    const pr = decodePaymentRequiredHeader(base.headers.get("payment-required")!);
    expect(pr.accepts[0]!.amount).toBe(PACKAGE_TIERS[0]!.atomicStr);
    expect(pr.resource.description).toBe(PACKAGE_DESCRIPTION_BASE);
    const opt = await pkgRoute.OPTIONS(new NextRequest(PKG));
    expect(opt.status).not.toBe(404);
  });
  it("deep on: tier=deep is a 402 at the deep price with the deep copy", async () => {
    vi.stubEnv("HP_PACKAGE_CHECK_ENABLED", "true");
    vi.stubEnv(PACKAGE_DEEP_FLAG, "true");
    const res = await pkgRoute.GET(new NextRequest(`${PKG}&tier=deep`));
    expect(res.status).toBe(402);
    const pr = decodePaymentRequiredHeader(res.headers.get("payment-required")!);
    expect(pr.accepts[0]!.amount).toBe(PACKAGE_TIERS[1]!.atomicStr);
    expect(pr.resource.description).toBe(PACKAGE_DESCRIPTION_DEEP);
  });
  it("description, payment opts and the no-CDP fallback metadata follow the flag; base copy never names deep", () => {
    expect(darkDescription("/api/package/check", {})).toBe(PACKAGE_DESCRIPTION_BASE);
    expect(darkDescription("/api/package/check", { [PACKAGE_DEEP_FLAG]: "true" })).toBe(PACKAGE_DESCRIPTION_DEEP);
    expect(PACKAGE_DESCRIPTION_BASE).not.toMatch(/deep|tier=/i);
    expect(darkPaymentOpts("/api/package/check", PACKAGE_TIERS[0]!).description).toBe(PACKAGE_DESCRIPTION_BASE);
    expect(ROUTE_METADATA["/api/package/check"].description).toBe(PACKAGE_DESCRIPTION_BASE);
    vi.stubEnv(PACKAGE_DEEP_FLAG, "true");
    expect(ROUTE_METADATA["/api/package/check"].description).toBe(PACKAGE_DESCRIPTION_DEEP);
    for (const d of [PACKAGE_DESCRIPTION_BASE, PACKAGE_DESCRIPTION_DEEP]) expect(d.length).toBeLessThanOrEqual(500);
  });
  it("discovery surfaces never list the package route in either flag state", () => {
    for (const f of ["public/openapi.json", "public/llms.txt"]) expect(readFileSync(path.join(ROOT, f), "utf8")).not.toContain("/api/package/check");
  });
});

describe("one overall deadline, sources in parallel, partial answers marked", () => {
  it("default deadline is 20 s and every per-source timeout fits inside it", () => {
    expect(PACKAGE_DEADLINE_MS).toBe(20_000);
    const src = readFileSync(path.join(ROOT, "lib/package-safety.ts"), "utf8");
    const t = Number(/const TIMEOUT = ([\d_]+)/.exec(src)![1]!.replace(/_/g, ""));
    const side = Number(/const SIDE_TIMEOUT = ([\d_]+)/.exec(src)![1]!.replace(/_/g, ""));
    expect(t).toBeLessThan(PACKAGE_DEADLINE_MS);
    expect(side).toBeLessThan(PACKAGE_DEADLINE_MS);
  });
  it("sources after the registry run in parallel: 4 slow sources (each 150 ms) finish in ~150 ms, not 600 ms", async () => {
    const d = deps({ delay: { downloads: 150, osv: 150, depsdev: 150, kev: 150 }, vulns: [{ id: "GHSA-a", aliases: ["CVE-2024-1111"] }] });
    const t0 = Date.now();
    const r = await checkPackage({ ecosystem: "npm", name: "lodash", version: null }, "base", d);
    const ms = Date.now() - t0;
    expect(r).toMatchObject({ ok: true, report: { partial: false } });
    expect(ms).toBeLessThan(450); // osv -> kev is the only chain (2 x 150)
  });
  it("the old 50 s worst case (every source slow) returns at the deadline: OSV late -> 503 not charged, no verdict", async () => {
    const d = deps({ deadlineMs: 300, delay: { downloads: 8_000, osv: 8_000, depsdev: 5_000 } });
    const t0 = Date.now();
    const r = await checkPackage({ ecosystem: "npm", name: "lodash", version: null }, "base", d);
    expect(Date.now() - t0).toBeLessThan(800);
    expect(r).toMatchObject({ ok: false, status: 503, code: "advisory_source_unavailable" });
    expect((r as { error: string }).error).toMatch(/OSV\.dev is unavailable .*no verdict was produced; not charged/);
  });
  it("OSV on time, downloads / deps.dev / KEV late: answers partial + caution (billed), late sources named", async () => {
    const d = deps({ deadlineMs: 300, delay: { downloads: 8_000, depsdev: 5_000, kev: 5_000 }, vulns: [{ id: "GHSA-a", aliases: ["CVE-2024-1111"] }] });
    const t0 = Date.now();
    const r = await checkPackage({ ecosystem: "npm", name: "lodash", version: null }, "base", d);
    expect(Date.now() - t0).toBeLessThan(800);
    if (!r.ok) throw new Error("expected ok");
    expect(r.report.partial).toBe(true);
    expect(r.report.missing).toEqual(expect.arrayContaining(["downloads", "deps.dev", "cisa-kev"]));
    expect(r.report.missing).not.toContain("osv");
    expect(r.report.partialNote).toMatch(/did not answer within 0.3 s/);
    expect(r.report.vulnerabilities).toMatchObject({ status: "ok", count: 1 });
    expect(r.report.verdict).toBe("caution");
    expect(r.report.verdictReasons).toEqual(expect.arrayContaining(["Partial answer: some sources did not answer in time"]));
  });
  it("registry slower than the deadline: 502 not charged (never a hang, never a 500)", async () => {
    const t0 = Date.now();
    const r = await checkPackage({ ecosystem: "npm", name: "lodash", version: null }, "base", deps({ deadlineMs: 200, delay: { latest: 10_000, full: 10_000 } }));
    expect(Date.now() - t0).toBeLessThan(700);
    expect(r).toMatchObject({ ok: false, status: 502 });
  });
  it("a source that ignores the abort signal still cannot hold the answer past the deadline", async () => {
    const d = deps({ deadlineMs: 200 });
    const inner = d.fetch;
    d.fetch = (async (u: string | URL | Request, init?: RequestInit) => (String(u).includes("api.deps.dev") ? new Promise<Response>(() => {}) : inner(u, init))) as typeof fetch;
    const t0 = Date.now();
    const r = await checkPackage({ ecosystem: "npm", name: "lodash", version: null }, "base", d);
    expect(Date.now() - t0).toBeLessThan(700);
    expect(r).toMatchObject({ ok: true, report: { partial: true, missing: expect.arrayContaining(["deps.dev"]) } });
    // and an OSV request that ignores the abort is a 503, also within the deadline
    const d2 = deps({ deadlineMs: 200 });
    const inner2 = d2.fetch;
    d2.fetch = (async (u: string | URL | Request, init?: RequestInit) => (String(u).includes("api.osv.dev") ? new Promise<Response>(() => {}) : inner2(u, init))) as typeof fetch;
    const t1 = Date.now();
    expect(await checkPackage({ ecosystem: "npm", name: "lodash", version: null }, "base", d2)).toMatchObject({ ok: false, status: 503 });
    expect(Date.now() - t1).toBeLessThan(700);
  });
  it("deep tier with OSV past the deadline: 503 not charged (deep needs vulnerability data)", async () => {
    const r = await checkPackage({ ecosystem: "npm", name: "lodash", version: null }, "deep", deps({ deadlineMs: 200, delay: { osv: 5_000 } }));
    expect(r).toMatchObject({ ok: false, status: 503, code: "advisory_source_unavailable" });
  });
});

describe("KEV: failures negative-cached for 5 minutes", () => {
  it("one failed fetch, then no refetch for 5 min, then a retry", async () => {
    let now = Date.parse("2026-10-18T12:00:00Z");
    const d = deps({ kev: "down", now: () => now });
    expect(await kevCves(d)).toBeNull();
    expect(await kevCves(d)).toBeNull();
    now += KEV_NEGATIVE_TTL_MS - 1;
    expect(await kevCves(d)).toBeNull();
    expect(d.calls.filter((u) => u === KEV_URL)).toHaveLength(1);
    now += 2;
    await kevCves(d);
    expect(d.calls.filter((u) => u === KEV_URL)).toHaveLength(2);
    expect(KEV_NEGATIVE_TTL_MS).toBe(300_000);
  });
  it("concurrent checks share one in-flight KEV fetch", async () => {
    const d = deps({ delay: { kev: 50 }, kev: { vulnerabilities: [{ cveID: "CVE-2024-1111" }] } });
    const [a, b] = await Promise.all([kevCves(d), kevCves(d)]);
    expect(a?.has("CVE-2024-1111")).toBe(true);
    expect(b).toBe(a);
    expect(d.calls.filter((u) => u === KEV_URL)).toHaveLength(1);
  });
  it("a check's own deadline does not abort the shared KEV fetch: it finishes and is cached (not negative-cached) for the next check", async () => {
    const kev = { vulnerabilities: [{ cveID: "CVE-2024-1111" }] };
    const r = await checkPackage({ ecosystem: "npm", name: "lodash", version: null }, "base", deps({ deadlineMs: 150, delay: { kev: 400 }, kev, vulns: [{ id: "GHSA-a", aliases: ["CVE-2024-1111"] }] }));
    expect(r).toMatchObject({ ok: true, report: { partial: true, missing: expect.arrayContaining(["cisa-kev"]) } });
    await new Promise((res) => setTimeout(res, 400));
    const d2 = deps({ kev: { vulnerabilities: [] } });
    expect((await kevCves(d2))?.has("CVE-2024-1111")).toBe(true);
    expect(d2.calls).toHaveLength(0);
  });
});

describe("verdict: no_known_issues / caution / block, leading the answer (Counsel wording 10/18)", () => {
  const base = { exists: true, versionExists: null, requestedVersion: null, malicious: [], kevHits: [], signals: [], partial: false };
  it("rules", () => {
    expect(packageVerdict(base)).toEqual({ verdict: "no_known_issues", reasons: [] });
    expect(packageVerdict({ ...base, signals: [{ signal: "Package does not exist in the registry (possible hallucinated or typo name)", level: "warn" }], exists: false }).verdict).toBe("block");
    expect(packageVerdict({ ...base, requestedVersion: "9.9.9", versionExists: false }).verdict).toBe("block");
    expect(packageVerdict({ ...base, malicious: ["MAL-2025-1"] }).verdict).toBe("block");
    expect(packageVerdict({ ...base, kevHits: ["CVE-2024-1111"] }).verdict).toBe("block");
    expect(packageVerdict({ ...base, signals: [{ signal: "x", level: "caution" }] })).toEqual({ verdict: "caution", reasons: ["x"] });
    expect(packageVerdict({ ...base, signals: [{ signal: "typo", level: "warn" }] }).verdict).toBe("caution");
    expect(packageVerdict({ ...base, signals: [{ signal: "fyi", level: "info" }] }).verdict).toBe("no_known_issues");
    expect(packageVerdict({ ...base, partial: true }).verdict).toBe("caution");
  });
  it("Counsel's exact notes; the value 'install' is gone", () => {
    expect(VERDICT_NOTE_NO_KNOWN_ISSUES).toBe("No known issues found in the sources checked (OSV, CISA KEV, deps.dev) at the time of the check. This is not a security review or a guarantee the package is safe; review it before installing.");
    expect(VERDICT_NOTE_BLOCK).toBe("Recommendation not to install, based on the reasons listed in verdictReasons. This is not a determination that the package is malicious or unsafe; review the listed reasons.");
    expect(PACKAGE_METHOD).toContain("block is a recommendation based on the listed reasons, not a determination.");
    expect(PACKAGE_METHOD).not.toContain("listed records");
    expect(Object.keys(VERDICT_NOTES).sort()).toEqual(["block", "caution", "no_known_issues"]);
    const src = readFileSync(path.join(ROOT, "lib/package-safety.ts"), "utf8");
    expect(src).not.toMatch(/verdict: "install"|"install" \| "caution"/);
    for (const d of [PACKAGE_DESCRIPTION_BASE, PACKAGE_DESCRIPTION_DEEP, PACKAGE_METHOD]) expect(d).toContain("no_known_issues, caution or block");
  });
  it("end to end: clean, popular, old package -> no_known_issues; hallucinated name -> block; MAL record -> block; KEV hit -> block; audit-ci clean", async () => {
    const ok = await checkPackage({ ecosystem: "npm", name: "lodash", version: null }, "base", deps());
    expect(ok).toMatchObject({ ok: true, report: { verdict: "no_known_issues", verdictReasons: [], verdictNote: VERDICT_NOTE_NO_KNOWN_ISSUES, partial: false } });
    expect(await checkPackage({ ecosystem: "npm", name: "surely-not-a-real-pkg-xyz", version: null }, "base", deps({ latest: 404 }))).toMatchObject({ ok: true, report: { verdict: "block", verdictNote: VERDICT_NOTE_BLOCK } });
    expect(await checkPackage({ ecosystem: "npm", name: "lodash", version: null }, "base", deps({ vulns: [{ id: "MAL-2025-9" }] }))).toMatchObject({ ok: true, report: { verdict: "block" } });
    resetKevCacheForTests();
    expect(await checkPackage({ ecosystem: "npm", name: "lodash", version: null }, "base", deps({ vulns: [{ id: "GHSA-a", aliases: ["CVE-2024-7777"] }], kev: { vulnerabilities: [{ cveID: "CVE-2024-7777" }] } }))).toMatchObject({ ok: true, report: { verdict: "block" } });
    expect(await checkPackage({ ecosystem: "npm", name: "audit-ci", version: null }, "base", deps())).toMatchObject({ ok: true, report: { verdict: "no_known_issues" } });
  });
  it("the HTTP answer's first key is verdict", async () => {
    const res = await packageCheckHandler(new NextRequest(PKG), PACKAGE_TIERS[0]!, "hpr_t", deps());
    const text = await res.text();
    expect(text.startsWith('{"verdict":"no_known_issues"')).toBe(true);
    expect(JSON.parse(text)).toMatchObject({ source: "package-check", partial: false });
  });
});

describe("Counsel re-read batch 2 deltas", () => {
  it("opt-out lookup global limit is 20/min", () => {
    expect(OPT_OUT_CHECK_GLOBAL_PER_MIN).toBe(20);
  });
  it("'verified' is deps.dev's finding: method text and the provenance meaning say so; no claim that we verified", () => {
    expect(PACKAGE_METHOD).toContain("build provenance as verified by deps.dev");
    expect(BUILD_PROVENANCE_MEANING).toContain("verified by deps.dev (not by Horizon Pulse)");
    const src = readFileSync(path.join(ROOT, "lib/package-safety.ts"), "utf8");
    expect(src).not.toMatch(/verified by (us|Horizon Pulse)(?! *\))/i);
    expect(src).toContain("was not verified by deps.dev");
  });
  it("Scorecard CDLA line verbatim, appended wherever a score is shown", () => {
    expect(SCORECARD_ATTRIBUTION).toBe(" OpenSSF Scorecard score from the OpenSSF Scorecard project (via deps.dev), data licensed under CDLA-Permissive-2.0: https://cdla.dev/permissive-2-0/");
  });
});

describe("OSV unavailable is never billed (Odin 10:05 AM ET 10/18)", () => {
  const PAYER = `0x${"22".repeat(20)}`;
  /** Live-route test: real handler + defaultDeps with a stubbed global fetch; facilitator mocked at the prototype. */
  function stubSources(o: { osv: "down" | "up"; others: "down" | "up"; registry?: "down" | "up" }) {
    const seen: string[] = [];
    vi.stubGlobal("fetch", (async (u: string | URL | Request) => {
      const url = String(u instanceof Request ? u.url : u);
      seen.push(url);
      if (o.registry === "down" && url.startsWith("https://registry.npmjs.org/")) return new Response("x", { status: 503 });
      if (url.startsWith("https://api.osv.dev/")) return o.osv === "down" ? new Response("x", { status: 500 }) : Response.json({ vulns: [] });
      if (url.endsWith("/latest")) return Response.json({ version: "1.0.0", license: "MIT", maintainers: [{ name: "a" }] });
      if (url.startsWith("https://registry.npmjs.org/")) return Response.json({ time: { created: "2020-01-01T00:00:00Z", modified: "2026-10-01T00:00:00Z" }, versions: { "1.0.0": {} } });
      if (o.others === "down") return new Response("x", { status: 503 });
      if (url.startsWith("https://api.npmjs.org/downloads/")) return Response.json({ downloads: 50_000 });
      if (url.startsWith("https://api.deps.dev/")) return Response.json({});
      return new Response("x", { status: 404 });
    }) as typeof fetch);
    return seen;
  }
  async function paidCall(url: string = PKG) {
    const { installFacilitatorMock } = await import("./helpers/facilitator-mock");
    const { setCdp } = await import("./helpers/xrpl-env");
    const { encodePaymentSignatureHeader } = await import("@x402/core/http");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const calls = installFacilitatorMock({
      verify: () => ({ isValid: true, payer: PAYER }),
      settle: (_u, _p, r) => ({ success: true, transaction: `0x${"ab".repeat(32)}`, network: r.network, payer: PAYER }),
    });
    setCdp(true);
    vi.stubEnv("HP_PACKAGE_CHECK_ENABLED", "true");
    const unpaid = await pkgRoute.GET(new NextRequest(url));
    expect(unpaid.status).toBe(402);
    const accept = decodePaymentRequiredHeader(unpaid.headers.get("payment-required")!).accepts[0]! as unknown as Record<string, unknown>;
    const payload = { x402Version: 2, accepted: accept, payload: { signature: `0x${"cd".repeat(65)}`, authorization: { from: PAYER, to: accept.payTo, value: accept.amount, validAfter: "0", validBefore: "9999999999", nonce: `0x${"00".repeat(32)}` } } };
    const res = await pkgRoute.GET(new NextRequest(url, { headers: { "payment-signature": encodePaymentSignatureHeader(payload as never), "x-real-ip": "198.51.100.20" } }));
    return { res, calls };
  }
  it("checkPackage: OSV error -> 503 advisory_source_unavailable on base and deep, no verdict", async () => {
    for (const tier of ["base", "deep"] as const) {
      const d = deps();
      const inner = d.fetch;
      d.fetch = (async (u: string | URL | Request, init?: RequestInit) => (String(u).includes("api.osv.dev") ? new Response("x", { status: 500 }) : inner(u, init))) as typeof fetch;
      const r = await checkPackage({ ecosystem: "npm", name: "lodash", version: null }, tier, d);
      expect(r).toMatchObject({ ok: false, status: 503, code: "advisory_source_unavailable" });
      expect(JSON.stringify(r)).not.toMatch(/"verdict"|no_known_issues/);
    }
  });
  it("paid route: OSV down -> 503, charged:false, unavailable message, receipt id, disclaimer, NO settle", async () => {
    const seen = stubSources({ osv: "down", others: "up" });
    const { res, calls } = await paidCall();
    expect(res.status).toBe(503);
    const b = await res.json();
    expect(b).toMatchObject({ ok: false, code: "advisory_source_unavailable", charged: false });
    expect(b.error).toMatch(/OSV\.dev is unavailable .*not charged/);
    expect(b.verdict).toBeUndefined();
    expect(b.receiptId).toMatch(/^hpr_/);
    expect(typeof b.disclaimer).toBe("string");
    expect(calls.filter((c) => c.op === "verify")).toHaveLength(1);
    expect(calls.filter((c) => c.op === "settle")).toHaveLength(0);
    expect(seen.some((u) => u.startsWith("https://api.osv.dev/"))).toBe(true);
  });
  it("paid route: every refusal is uncharged and never settles - 400 bad input, 502 registry down, 503 OSV down (Counsel PASS a4518ba)", async () => {
    const cases = [
      { name: "400 bad input", url: "https://horizonpulse.dev/api/package/check?ecosystem=npm&name=", src: { osv: "up", others: "up" }, status: 400, code: null },
      { name: "502 registry down", url: PKG, src: { osv: "up", others: "up", registry: "down" }, status: 502, code: "registry_unavailable" },
      { name: "503 OSV down", url: PKG, src: { osv: "down", others: "up" }, status: 503, code: "advisory_source_unavailable" },
    ] as const;
    for (const c of cases) {
      vi.restoreAllMocks();
      stubSources(c.src);
      const { res, calls } = await paidCall(c.url);
      expect(res.status, c.name).toBe(c.status);
      const b = await res.json();
      expect(b, c.name).toMatchObject({ charged: false });
      if (c.code) expect(b.code, c.name).toBe(c.code);
      expect(b.verdict, c.name).toBeUndefined();
      expect(b.receiptId, c.name).toMatch(/^hpr_/);
      expect(calls.filter((x) => x.op === "verify"), c.name).toHaveLength(1);
      expect(calls.filter((x) => x.op === "settle"), c.name).toHaveLength(0);
      expect(res.headers.get("payment-response"), c.name).toBeNull();
    }
  });
  it("paid route: OSV up, downloads / deps.dev / KEV down -> 200 with a verdict, billed (one settle)", async () => {
    stubSources({ osv: "up", others: "down" });
    const { res, calls } = await paidCall();
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b).toMatchObject({ source: "package-check", vulnerabilities: { status: "ok" }, provenance: { status: "unavailable" }, downloadsSource: "unavailable" });
    expect(["no_known_issues", "caution", "block"]).toContain(b.verdict);
    expect(calls.filter((c) => c.op === "settle")).toHaveLength(1);
  });
});

describe("Odin Class A delta on dd634d8 (10/18)", () => {
  /** npm packument over DOC_CAP: streamed past 6 MB so getJson reports truncated. */
  function oversized(per: "404" | "200" | "500") {
    const d = deps();
    const inner = d.fetch;
    d.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
      const url = String(u);
      if (url === "https://registry.npmjs.org/lodash") {
        d.calls.push(url);
        const chunk = new TextEncoder().encode(`{"x":"${"a".repeat(1_000_000)}`);
        let n = 0;
        return new Response(new ReadableStream({ pull(c) { if (n++ < 8) c.enqueue(chunk); else c.close(); } }), { headers: { "content-type": "application/json" } });
      }
      if (url.startsWith("https://registry.npmjs.org/lodash/") && !url.endsWith("/latest")) {
        d.calls.push(url);
        return per === "404" ? new Response("{}", { status: 404 }) : per === "500" ? new Response("x", { status: 500 }) : Response.json({ name: "lodash", version: "4.17.21" });
      }
      return inner(u, init);
    }) as typeof fetch;
    return d;
  }
  it("MEDIUM: oversized packument + never-published version (lodash@99.0.0) -> per-version lookup 404 -> block", async () => {
    const d = oversized("404");
    const r = await checkPackage({ ecosystem: "npm", name: "lodash", version: "99.0.0" }, "base", d);
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(d.calls).toContain("https://registry.npmjs.org/lodash/99.0.0");
    expect(r.report).toMatchObject({ verdict: "block", versionExists: false });
    expect(r.report.verdictReasons).toEqual(expect.arrayContaining(["Version 99.0.0 is not published"]));
  });
  it("oversized packument + published version -> versionExists true (not block); a 5xx on the lookup is 502 not charged", async () => {
    const ok = await checkPackage({ ecosystem: "npm", name: "lodash", version: "4.17.21" }, "base", oversized("200"));
    expect(ok).toMatchObject({ ok: true, report: { versionExists: true } });
    expect((ok as unknown as { report: { verdict: string } }).report.verdict).not.toBe("block");
    expect(await checkPackage({ ecosystem: "npm", name: "lodash", version: "4.17.21" }, "base", oversized("500"))).toMatchObject({ ok: false, status: 502, code: "registry_unavailable" });
  });
  it("normal-size packument: no extra per-version request", async () => {
    const d = deps();
    await checkPackage({ ecosystem: "npm", name: "lodash", version: "9.9.9" }, "base", d);
    expect(d.calls.filter((u) => /registry\.npmjs\.org\/lodash\/9\.9\.9/.test(u))).toHaveLength(0);
  });
  it("LOW: two checks share one KEV fetch; the first times out -> it is partial, the second still gets KEV data (not an unflagged null)", async () => {
    const vulns = [{ id: "GHSA-k", aliases: ["CVE-2024-7777"] }];
    const kev = { vulnerabilities: [{ cveID: "CVE-2024-7777" }] };
    const a = deps({ deadlineMs: 100, delay: { kev: 300 }, vulns, kev });
    const b = deps({ deadlineMs: 5_000, delay: { kev: 300 }, vulns, kev });
    b.fetch = a.fetch; // same upstream: the second check joins the first one's in-flight KEV promise
    const [ra, rb] = await Promise.all([
      checkPackage({ ecosystem: "npm", name: "lodash", version: null }, "base", a),
      new Promise((r) => setTimeout(r, 10)).then(() => checkPackage({ ecosystem: "npm", name: "lodash", version: null }, "base", b)),
    ]);
    if (!ra.ok || !rb.ok) throw new Error("expected ok");
    expect(ra.report).toMatchObject({ partial: true, missing: expect.arrayContaining(["cisa-kev"]) });
    expect(rb.report).toMatchObject({ partial: false, verdict: "block" });
    expect(rb.report.missing).toBeUndefined();
    expect(a.calls.filter((u) => u === KEV_URL)).toHaveLength(1);
  });
  it("LOW: a MAL- id that appears only as an alias -> block", async () => {
    const r = await checkPackage({ ecosystem: "npm", name: "lodash", version: null }, "base", deps({ vulns: [{ id: "GHSA-mmmm", aliases: ["CVE-2024-1", "CVE-2024-2", "CVE-2024-3", "CVE-2024-4", "CVE-2024-5", "MAL-2026-1234"] }] }));
    if (!r.ok) throw new Error("expected ok");
    expect(r.report.verdict).toBe("block");
    expect(JSON.stringify(r.report.verdictReasons)).toContain("MAL-2026-1234");
  });
  it("copy: descriptions say registry or OSV.dev down is not charged (<= 500 chars)", () => {
    for (const d of [PACKAGE_DESCRIPTION_BASE, PACKAGE_DESCRIPTION_DEEP]) {
      expect(d).toContain("Bad input, registry or OSV.dev down: not charged.");
      expect(d.length).toBeLessThanOrEqual(500);
    }
    expect(PACKAGE_METHOD).toMatch(/if OSV\.dev cannot answer .*not charged/);
  });
});
