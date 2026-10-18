/**
 * Dark routes follow-up (Odin 11:07 PM ET 10/17), still dark:
 *  1. The web-checks opt-out list is re-checked on EVERY redirect hop: an
 *     opted-out hop is refused (403) and nothing more is requested.
 *  2. Audit tiers full ($50) / history ($75) / deep ($100) are hard-disabled:
 *     404 before any payment even with HP_AUDIT_SECURITY_ENABLED=true, unless
 *     the separate HP_AUDIT_HIGH_TIERS_ENABLED is exactly "true" (default off).
 * Offline: every network source is a stub.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import * as auditRoute from "@/app/api/audit/security/route.audit";
import { auditHandler } from "@/app/api/audit/security/handler";
import { AUDIT_HIGH_TIERS_FLAG, AUDIT_HIGH_TIER_IDS, AUDIT_TIERS, auditTierEnabled, resetRateLimitsForTests } from "@/lib/dark-routes";
import { guardedGetWith, type GuardedGetDeps, type GuardedGetOpts, type guardedGet } from "@/lib/guarded-get";
import { runAudit, type AuditDeps } from "@/lib/audit-security";
import { scanInput } from "@/lib/injection-scan";
import { DISCLAIMER, isOptedOut, type SharedLimiter } from "@/lib/dark-checks-shared";
import { installFacilitatorMock } from "./helpers/facilitator-mock";
import { setCdp } from "./helpers/xrpl-env";

beforeEach(() => resetRateLimitsForTests());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const OPT = (h: string) => isOptedOut(h, ["optout.example"]);

/** Fake network: a map of URL -> response; records every URL requested and every URL DNS-checked. */
function fakeNet(routes: Record<string, () => Response>) {
  const fetched: string[] = [];
  const checked: string[] = [];
  const deps: GuardedGetDeps = {
    safeCheck: (async (raw: string) => {
      checked.push(raw);
      return { url: new URL(raw) };
    }) as unknown as GuardedGetDeps["safeCheck"],
    fetch: (async (u: string) => {
      fetched.push(u);
      const r = routes[u];
      return r ? r() : new Response("nf", { status: 404 });
    }) as unknown as GuardedGetDeps["fetch"],
  };
  return { deps, fetched, checked };
}
const redirect = (to: string, status = 302) => () => new Response(null, { status, headers: { location: to } });

describe("opt-out re-checked on every redirect hop (guardedGet)", () => {
  it("a redirect into an opted-out host is refused: no DNS check, no request to it, nothing after", async () => {
    const n = fakeNet({
      "https://example.com/": redirect("https://shop.optout.example/landing"),
      "https://shop.optout.example/landing": () => new Response("must not be fetched"),
    });
    const r = await guardedGetWith(n.deps, "https://example.com/", { maxRedirects: 5, optedOut: OPT });
    expect(r).toMatchObject({ ok: false, code: "opted_out" });
    expect((r as { error: string }).error).toContain("Redirect target shop.optout.example");
    expect(n.fetched).toEqual(["https://example.com/"]);
    expect(n.checked).toEqual(["https://example.com/"]);
  });
  it("checked on a later hop too (A -> B -> opted-out C): stops before C", async () => {
    const n = fakeNet({
      "https://a.example/": redirect("https://b.example/x", 301),
      "https://b.example/x": redirect("https://OPTOUT.example./y", 308),
      "https://optout.example./y": () => new Response("no"),
    });
    const r = await guardedGetWith(n.deps, "https://a.example/", { maxRedirects: 5, optedOut: OPT });
    expect(r).toMatchObject({ ok: false, code: "opted_out" });
    expect(n.fetched).toEqual(["https://a.example/", "https://b.example/x"]);
  });
  it("first URL opted out (subdomain match): zero DNS checks, zero requests", async () => {
    const n = fakeNet({});
    expect(await guardedGetWith(n.deps, "https://www.optout.example/", { optedOut: OPT })).toMatchObject({ ok: false, code: "opted_out" });
    expect(n.fetched).toEqual([]);
    expect(n.checked).toEqual([]);
  });
  it("redirects between non-opted-out hosts still follow normally", async () => {
    const n = fakeNet({ "https://example.com/": redirect("/home"), "https://example.com/home": () => new Response("hi") });
    const r = await guardedGetWith(n.deps, "https://example.com/", { optedOut: OPT });
    expect(r).toMatchObject({ ok: true, status: 200, body: "hi", finalUrl: "https://example.com/home" });
    expect(n.fetched).toEqual(["https://example.com/", "https://example.com/home"]);
  });
  it("default predicate is the web-checks list (HP_WEB_CHECKS_OPTOUT) when the caller passes none", async () => {
    vi.stubEnv("HP_WEB_CHECKS_OPTOUT", "envlisted.example");
    const n = fakeNet({ "https://example.com/": redirect("https://api.envlisted.example/") });
    expect(await guardedGetWith(n.deps, "https://example.com/")).toMatchObject({ ok: false, code: "opted_out" });
    expect(n.fetched).toEqual(["https://example.com/"]);
  });
});

describe("audit: an opted-out redirect hop stops the whole check with 403, not charged", () => {
  const allowAll: SharedLimiter = async () => ({ ok: true, retryAfter: 0 });
  const safeOk = async () => ({ ok: true }) as never;
  function auditDeps(net: ReturnType<typeof fakeNet>): AuditDeps {
    const get = ((url: string, opts?: GuardedGetOpts) => guardedGetWith(net.deps, url, opts)) as unknown as typeof guardedGet;
    return { get, tls: async () => ({ ok: false, error: "stub" }), dns: { resolve: async () => [] }, ct: async () => ({ ok: false, error: "stub" }), now: () => Date.now() };
  }
  it("runAudit passes the handler's opt-out predicate to every GET and refuses on a hop into an opted-out host", async () => {
    const net = fakeNet({ "https://example.com/": redirect("https://victim.optout.example/") });
    const r = await runAudit("example.com", "standard", auditDeps(net), OPT);
    expect(r).toMatchObject({ ok: false, status: 403, code: "redirect_target_opted_out" });
    expect(net.fetched.some((u) => u.includes("optout.example"))).toBe(false);
  });
  it("security.txt redirecting into an opted-out host is refused the same way", async () => {
    const net = fakeNet({ "https://example.com/": () => new Response("ok"), "https://example.com/.well-known/security.txt": redirect("https://optout.example/security.txt") });
    expect(await runAudit("example.com", "standard", auditDeps(net), OPT)).toMatchObject({ ok: false, status: 403, code: "redirect_target_opted_out" });
    expect(net.fetched.some((u) => u.includes("optout.example"))).toBe(false);
  });
  it("handler: 403 body carries charged:false, the receipt id and the disclaimer", async () => {
    const net = fakeNet({ "https://example.com/": redirect("https://optout.example/") });
    const res = await auditHandler(new NextRequest("https://horizonpulse.dev/api/audit/security?target=example.com"), AUDIT_TIERS[0]!, "hpr_r", auditDeps(net), { limiter: allowAll, optedOut: OPT, safeCheck: safeOk });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, code: "redirect_target_opted_out", charged: false, receiptId: "hpr_r", disclaimer: DISCLAIMER });
  });
});

describe("injection scan URL mode: opted-out first URL or redirect hop -> 403", () => {
  it("maps the guard's opted_out to 403 target_opted_out", async () => {
    const net = fakeNet({ "https://example.com/p": redirect("https://cdn.optout.example/p") });
    const get = ((url: string, opts?: GuardedGetOpts) => guardedGetWith(net.deps, url, { ...opts, optedOut: OPT })) as unknown as typeof guardedGet;
    expect(await scanInput({ url: "https://example.com/p" }, get)).toMatchObject({ ok: false, status: 403, code: "target_opted_out" });
    expect(net.fetched).toEqual(["https://example.com/p"]);
  });
  it("real guardedGet: an env-listed first URL is refused before any DNS lookup or request", async () => {
    vi.stubEnv("HP_WEB_CHECKS_OPTOUT", "listed.example");
    const f = vi.fn(async () => new Response("no"));
    vi.stubGlobal("fetch", f);
    expect(await scanInput({ url: "https://www.listed.example/" })).toMatchObject({ ok: false, status: 403, code: "target_opted_out" });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("audit tiers full/history/deep hard-disabled behind a separate default-off flag", () => {
  const URL0 = "https://horizonpulse.dev/api/audit/security?target=example.com";
  it("flag name and tier set", () => {
    expect(AUDIT_HIGH_TIERS_FLAG).toBe("HP_AUDIT_HIGH_TIERS_ENABLED");
    expect(AUDIT_HIGH_TIER_IDS).toEqual(["full", "history", "deep"]);
    expect(AUDIT_TIERS.filter((t) => AUDIT_HIGH_TIER_IDS.includes(t.id)).map((t) => t.atomic)).toEqual([50_000_000, 75_000_000, 100_000_000]);
    expect(AUDIT_TIERS.filter((t) => auditTierEnabled(t, {})).map((t) => t.id)).toEqual(["quick", "standard", "extended", "report"]);
  });
  it("route enabled, high-tier flag unset or not exactly 'true': 404 on GET/POST/OPTIONS, no 402 challenge", async () => {
    vi.stubEnv("HP_AUDIT_SECURITY_ENABLED", "true");
    for (const v of [undefined, "", "1", "TRUE", "yes", " true"]) {
      if (v === undefined) vi.stubEnv(AUDIT_HIGH_TIERS_FLAG, undefined as unknown as string);
      else vi.stubEnv(AUDIT_HIGH_TIERS_FLAG, v);
      for (const id of AUDIT_HIGH_TIER_IDS) {
        for (const verb of ["GET", "POST", "OPTIONS"] as const) {
          const res = await auditRoute[verb](new NextRequest(`${URL0}&tier=${id}`, { method: verb }));
          expect(res.status, `${verb} ${id} flag=${JSON.stringify(v)}`).toBe(404);
          expect(res.headers.get("payment-required")).toBeNull();
        }
      }
    }
  });
  it("lower tiers are unaffected: quick/standard/extended/report still 402 at their prices", async () => {
    vi.stubEnv("HP_AUDIT_SECURITY_ENABLED", "true");
    for (const t of AUDIT_TIERS.slice(0, 4)) {
      const res = await auditRoute.GET(new NextRequest(`${URL0}&tier=${t.id}`));
      expect(res.status).toBe(402);
      expect(decodePaymentRequiredHeader(res.headers.get("payment-required")!).accepts[0]!.amount).toBe(t.atomicStr);
    }
  });
  it("only HP_AUDIT_HIGH_TIERS_ENABLED=true re-enables them (402 at $50/$75/$100); audit flag off still 404s everything", async () => {
    vi.stubEnv(AUDIT_HIGH_TIERS_FLAG, "true");
    expect((await auditRoute.GET(new NextRequest(`${URL0}&tier=deep`))).status).toBe(404);
    vi.stubEnv("HP_AUDIT_SECURITY_ENABLED", "true");
    for (const id of AUDIT_HIGH_TIER_IDS) {
      const res = await auditRoute.GET(new NextRequest(`${URL0}&tier=${id}`));
      expect(res.status).toBe(402);
      expect(decodePaymentRequiredHeader(res.headers.get("payment-required")!).accepts[0]!.amount).toBe(AUDIT_TIERS.find((t) => t.id === id)!.atomicStr);
    }
  });
  it("a payment presented for a disabled tier is never verified or settled (404 first)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls = installFacilitatorMock({ verify: () => ({ isValid: true, payer: `0x${"22".repeat(20)}` }), settle: (_u, _p, r) => ({ success: true, transaction: `0x${"ab".repeat(32)}`, network: r.network, payer: `0x${"22".repeat(20)}` }) });
    setCdp(true);
    vi.stubEnv("HP_AUDIT_SECURITY_ENABLED", "true");
    const accept = { scheme: "exact", network: "eip155:8453", amount: "100000000", payTo: `0x${"11".repeat(20)}`, asset: `0x${"33".repeat(20)}`, maxTimeoutSeconds: 300, extra: {} };
    const sig = encodePaymentSignatureHeader({ x402Version: 2, accepted: accept, payload: { signature: `0x${"cd".repeat(65)}` } } as unknown as PaymentPayload);
    const res = await auditRoute.GET(new NextRequest(`${URL0}&tier=deep`, { headers: { "payment-signature": sig } }));
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });
  it("handler defense in depth: a disabled tier reaching the handler is 404 before any check", async () => {
    const get = vi.fn();
    const deps = { get, tls: vi.fn(), dns: { resolve: vi.fn() }, ct: vi.fn(), now: () => Date.now() } as unknown as AuditDeps;
    const limiter = vi.fn(async () => ({ ok: true, retryAfter: 0 })) as unknown as SharedLimiter;
    const res = await auditHandler(new NextRequest(URL0), AUDIT_TIERS[6]!, "hpr_x", deps, { limiter, optedOut: () => false, safeCheck: (async () => ({ ok: true })) as never });
    expect(res.status).toBe(404);
    expect(get).not.toHaveBeenCalled();
    expect(limiter).not.toHaveBeenCalled();
  });
});
