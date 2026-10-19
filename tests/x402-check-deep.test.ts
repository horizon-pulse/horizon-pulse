/**
 * /api/x402-check/deep (branch feat/x402-check-deep, Michael approved $0.03 at 3:37 PM ET 10/19 via Odin).
 * Network fully mocked: nothing leaves the box, nothing is signed or paid. Addresses are dummies.
 */
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { assertSafePublicUrl } from "@/lib/fetch-url";
import { guardedGet, guardedGetWith, type GuardedGetOk, type GuardedGetErr } from "@/lib/guarded-get";
import { checkX402Endpoint, type X402CheckResult } from "@/lib/x402-check";
import {
  checkX402Deep,
  collectEvmAddresses,
  collectPayTos,
  corsChecks,
  defaultDeepDeps,
  headerChecks,
  lookalike,
  X402_CHECK_DEEP_METHODOLOGY,
  type DeepDeps,
} from "@/lib/x402-check-deep";
import { X402_CHECK_DEEP_PRICE_ATOMIC, X402_CHECK_DEEP_PRICE_USD, X402_CHECK_PRICE_ATOMIC, X402_CHECK_PRICE_USD } from "@/lib/config";
import { x402CheckDeepHandler, paymentOpts as deepOpts } from "@/app/api/x402-check/deep/handler";
import { paymentOpts as baseOpts } from "@/app/api/x402-check/handler";

const PAY = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
const LOOK = `0xabcd${"9".repeat(32)}ef01`; // same first 4 / last 4 (after 0x), different middle
const OTHER = "0x1111111111111111111111111111111111111111";
const SOL_PAY = "So1anaPayTo1111111111111111111111111111111";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ORIGIN = "https://seller.example";
const URL_ = `${ORIGIN}/api/thing`;

function baseResult(over: Partial<X402CheckResult> = {}): X402CheckResult {
  return {
    ok: true,
    target: URL_,
    finalUrl: URL_,
    method: "GET",
    httpStatus: 402,
    isX402: true,
    x402Version: 2,
    challengeSource: "header",
    resource: { url: URL_, description: "d", mimeType: "application/json" },
    accepts: [
      { scheme: "exact", network: "eip155:8453", asset: USDC, assetLabel: "USDC (Base)", amountAtomic: "10000", amountUsd: "$0.01", payTo: PAY, payToType: "eoa", payToDelegate: null, maxTimeoutSeconds: 300 },
      { scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", assetLabel: "USDC (Solana)", amountAtomic: "10000", amountUsd: "$0.01", payTo: SOL_PAY, payToType: null, payToDelegate: null, maxTimeoutSeconds: 300 },
    ],
    discovery: { present: true, method: "GET", hasInputSchema: true, hasOutputExample: true },
    checks: [{ id: "status_402", level: "pass", message: "Unpaid request returned HTTP 402." }],
    summary: { pass: 1, warn: 0, fail: 0 },
    elapsedMs: 5,
    methodology: {} as X402CheckResult["methodology"],
    ...over,
  };
}

const ok = (body: string, status = 200, headers: Record<string, string> = {}): GuardedGetOk => ({ ok: true, status, headers: new Headers(headers), body, bytes: body.length, truncated: false, finalUrl: "", hops: [] });
const notFound = ok("not found", 404);

const SEC_HEADERS = {
  "strict-transport-security": "max-age=63072000",
  "x-content-type-options": "nosniff",
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE",
};

type Site = Partial<Record<"page" | "wk" | "oa" | "llms", GuardedGetOk | GuardedGetErr>>;
function deps(site: Site, opts: { base?: X402CheckResult; cdp?: unknown; tlsOk?: boolean } = {}): DeepDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    base: async () => opts.base ?? baseResult(),
    get: async (u) => {
      calls.push(u);
      if (u.endsWith("/.well-known/x402")) return site.wk ?? notFound;
      if (u.endsWith("/openapi.json")) return site.oa ?? notFound;
      if (u.endsWith("/llms.txt")) return site.llms ?? notFound;
      return site.page ?? ok("{}", 402, SEC_HEADERS);
    },
    tls: async () =>
      opts.tlsOk === false
        ? { ok: true, protocol: "TLSv1.3", authorized: false, authorizationError: "CERT_HAS_EXPIRED", validFrom: "", validTo: "", daysLeft: -3, issuer: "x", subject: "seller.example", san: [] }
        : { ok: true, protocol: "TLSv1.3", authorized: true, authorizationError: null, validFrom: "", validTo: "", daysLeft: 60, issuer: "x", subject: "seller.example", san: [] },
    bazaar: {
      fetch: (async (u: string) => {
        calls.push(String(u));
        return new Response(JSON.stringify(opts.cdp ?? { resources: [] }), { status: 200 });
      }) as unknown as typeof fetch,
      assertSafe: async (u: string) => ({ url: new URL(u) }),
      now: () => Date.now(),
    },
    now: () => Date.now(),
  };
}

const wkBody = (urls: string[], extra: Record<string, unknown> = {}) => JSON.stringify({ version: 1, resources: urls.map((u) => `GET ${u}`), ...extra });
const ids = (r: Awaited<ReturnType<typeof checkX402Deep>>) => (r.ok ? r.checks.map((c) => `${c.id}:${c.level}`) : []);

describe("pricing and isolation", () => {
  it("deep is $0.03 / 30000; /api/x402-check stays $0.01 / 10000 with its own resource", () => {
    expect(X402_CHECK_DEEP_PRICE_USD).toBe("$0.03");
    expect(X402_CHECK_DEEP_PRICE_ATOMIC).toBe("30000");
    expect(X402_CHECK_PRICE_USD).toBe("$0.01");
    expect(X402_CHECK_PRICE_ATOMIC).toBe("10000");
    expect(deepOpts.resource).toBe("/api/x402-check/deep");
    expect(baseOpts.resource).toBe("/api/x402-check");
    expect(baseOpts.maxAmountRequired).toBe("10000");
  });
  it("default deps reuse the shared SSRF-guarded GET and the real x402-check", () => {
    const d = defaultDeepDeps();
    expect(d.get).toBe(guardedGet);
    expect(d.base).toBe(checkX402Endpoint);
  });
});

describe("lookalike", () => {
  it("flags same leading and trailing characters with a different middle", () => {
    const l = lookalike(PAY, LOOK);
    expect(l.lookalike).toBe(true);
    expect(l.prefixMatch).toBeGreaterThanOrEqual(3);
    expect(l.suffixMatch).toBeGreaterThanOrEqual(3);
  });
  it("EVM checksum casing is the same address, not a lookalike", () => {
    expect(lookalike(PAY, PAY.toLowerCase()).lookalike).toBe(false);
  });
  it("unrelated addresses are not lookalikes", () => {
    expect(lookalike(PAY, OTHER).lookalike).toBe(false);
  });
  it("6 matching in total (prefix-heavy) is flagged; base58 compared case-sensitively", () => {
    expect(lookalike("0xabcdef1111111111111111111111111111111112", "0xabcdef2222222222222222222222222222222223").lookalike).toBe(true);
    expect(lookalike("ABCxyz", "abcxyz").lookalike).toBe(false);
  });
});

describe("address extraction", () => {
  it("collects payTo values at any depth and 0x addresses from text minus USDC contracts", () => {
    expect([...collectPayTos({ a: [{ payTo: PAY }, { nested: { pay_to: SOL_PAY } }], payTo: "short" })]).toEqual([PAY, SOL_PAY]);
    expect([...collectEvmAddresses(`pay ${PAY} with ${USDC}`)]).toEqual([PAY]);
  });
});

describe("headers and CORS", () => {
  it("passes HSTS + nosniff; warns without them", () => {
    expect(headerChecks(new Headers(SEC_HEADERS), true).checks.map((c) => `${c.id}:${c.level}`)).toEqual(expect.arrayContaining(["hsts:pass", "nosniff:pass"]));
    expect(headerChecks(new Headers(), true).checks.map((c) => `${c.id}:${c.level}`)).toEqual(expect.arrayContaining(["hsts:warn", "nosniff:warn"]));
    expect(headerChecks(new Headers({ "strict-transport-security": "max-age=60" }), true).checks[0]!.level).toBe("warn");
  });
  it("CORS: PAYMENT-REQUIRED must be exposed for v2; * with credentials warns", () => {
    expect(corsChecks(new Headers(SEC_HEADERS), 2).checks.map((c) => c.level)).toEqual(["pass"]);
    expect(corsChecks(new Headers({ "access-control-allow-origin": "*" }), 2).checks.map((c) => c.id)).toContain("cors_expose");
    expect(corsChecks(new Headers({ "access-control-allow-origin": "*", "access-control-allow-credentials": "true" }), 1).checks[0]!.level).toBe("warn");
    expect(corsChecks(new Headers(), 2).checks[0]!.level).toBe("info");
  });
});

describe("checkX402Deep (mocked)", () => {
  it("consistent seller: payTo matches published, no lookalike, listed, Bazaar consistent", async () => {
    const cdp = { resources: [{ resource: URL_, accepts: [{ network: "eip155:8453", payTo: PAY, amount: "10000" }, { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", payTo: SOL_PAY, amount: "10000" }] }] };
    const d = deps({ wk: ok(wkBody([URL_], { payTo: PAY })), llms: ok(`Pay ${PAY} on Base, ${SOL_PAY} on Solana`) }, { cdp });
    const r = await checkX402Deep({ url: URL_ }, d);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tier).toBe("deep");
    expect(r.payToReports.map((p) => p.published)).toEqual(["match", "match"]);
    expect(r.payToReports.every((p) => p.lookalikes.length === 0)).toBe(true);
    expect(r.drift.wellKnown).toBe("listed");
    expect(r.drift.bazaar.status).toBe("consistent");
    expect(r.summary.fail).toBe(0);
    expect(r.methodology).toBe(X402_CHECK_DEEP_METHODOLOGY);
    expect(r.baseChecks[0]!.id).toBe("status_402");
    expect(d.calls.some((u) => u.includes("PAYMENT") || u.includes("payment-signature"))).toBe(false);
  });

  it("lookalike payTo vs an address the payee publishes is a fail", async () => {
    const r = await checkX402Deep({ url: URL_ }, deps({ llms: ok(`Our only payout address: ${LOOK}`) }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const base = r.payToReports.find((p) => p.payTo === PAY)!;
    expect(base.published).toBe("not_published");
    expect(base.lookalikes.map((l) => l.address)).toEqual([LOOK]);
    expect(ids(r)).toEqual(expect.arrayContaining(["payto_published:warn", "payto_lookalike:fail"]));
    expect(r.summary.fail).toBeGreaterThanOrEqual(1);
  });

  it("lookalike between two payTos in the 402 itself is a fail", async () => {
    const b = baseResult();
    b.accepts = [b.accepts[0]!, { ...b.accepts[0]!, network: "eip155:137", payTo: LOOK }];
    const r = await checkX402Deep({ url: URL_ }, deps({}, { base: b }));
    expect(ids(r)).toContain("payto_lookalike:fail");
  });

  it("no published addresses: info only; Solana payTo not judged against EVM listings", async () => {
    const r = await checkX402Deep({ url: URL_ }, deps({ llms: ok(`EVM payout ${PAY}`) }));
    if (!r.ok) throw new Error("expected ok");
    expect(r.payToReports.find((p) => p.payTo === SOL_PAY)!.published).toBe("none_discoverable");
    const r2 = await checkX402Deep({ url: URL_ }, deps({}));
    if (!r2.ok) throw new Error("expected ok");
    expect(r2.payToReports.map((p) => p.published)).toEqual(["none_discoverable", "none_discoverable"]);
  });

  it("drift: URL missing from well-known, Bazaar amount and payTo differ, openapi lists another payTo", async () => {
    const cdp = { resources: [{ resource: URL_, accepts: [{ network: "eip155:8453", payTo: OTHER, amount: "20000" }] }] };
    const oa = ok(JSON.stringify({ paths: { "/api/thing": { get: { description: "$0.01", "x-payment-info": { payTo: OTHER } } } } }));
    const r = await checkX402Deep({ url: URL_ }, deps({ wk: ok(wkBody([`${ORIGIN}/api/other`])), oa }, { cdp }));
    if (!r.ok) throw new Error("expected ok");
    expect(r.drift.wellKnown).toBe("not_listed");
    expect(r.drift.bazaar.status).toBe("drift");
    expect(r.drift.bazaar.detail).toContain("amount live 10000 vs Bazaar 20000");
    expect(r.drift.bazaar.detail).toContain(`payTo live ${PAY} vs Bazaar ${OTHER}`);
    expect(r.drift.bazaar.detail).toContain("solana: served live, not in the Bazaar entry");
    expect(r.drift.openapi.status).toBe("drift");
    expect(ids(r)).toEqual(expect.arrayContaining(["drift_well_known:warn", "drift_bazaar:warn", "drift_openapi:warn"]));
  });

  it("not indexed in Bazaar is info, not a failure", async () => {
    const r = await checkX402Deep({ url: URL_ }, deps({}));
    if (!r.ok) throw new Error("expected ok");
    expect(r.drift.bazaar.status).toBe("not_indexed");
  });

  it("untrusted TLS is a fail; plain http is a fail with no TLS handshake", async () => {
    expect(ids(await checkX402Deep({ url: URL_ }, deps({}, { tlsOk: false })))).toContain("tls:fail");
    const http = `http://seller.example/api/thing`;
    let tlsCalled = false;
    const d = deps({}, { base: baseResult({ target: http, finalUrl: http }) });
    d.tls = async () => { tlsCalled = true; throw new Error("no"); };
    const r = await checkX402Deep({ url: http }, d);
    expect(ids(r)).toContain("tls:fail");
    expect(tlsCalled).toBe(false);
  });

  it("main probe error passes through unchanged (not billed) and no extra request is made", async () => {
    const d = deps({});
    d.base = async () => ({ ok: false, error: "blocked", code: "host_blocked", status: 400 });
    const r = await checkX402Deep({ url: "http://127.0.0.1/" }, d);
    expect(r).toEqual({ ok: false, error: "blocked", code: "host_blocked", status: 400 });
    expect(d.calls).toEqual([]);
  });

  it("side checks that fail or hang are reported as unavailable inside a billed report (budget capped)", async () => {
    const d = deps({});
    const start = Date.now();
    let n = 0;
    d.now = () => (n++ === 0 ? start : start + 19_900); // ~100 ms of the 20 s budget left
    d.get = () => new Promise(() => {}); // never answers
    d.tls = () => new Promise(() => {});
    const t0 = Date.now();
    const r = await checkX402Deep({ url: URL_ }, d);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.securityHeaders.error).toBe("timed out");
    expect(r.publishedSources.every((s) => s.error === "timed out")).toBe(true);
  });
});

describe("SSRF guards (real guards, no network)", () => {
  it.each([
    "http://169.254.169.254/latest/meta-data/",
    "http://127.0.0.1:3000/api/x",
    "http://10.0.0.5/x",
    "http://[::1]/x",
    "http://[fd00:ec2::254]/latest",
    "http://100.100.100.200/latest/meta-data",
  ])("main probe to %s is blocked (400, not billed) before any request", async (u) => {
    const r = await checkX402Deep({ url: u }, { ...defaultDeepDeps(), get: async () => { throw new Error("side fetch must not run"); } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(400);
  });

  it("a listing that redirects to the cloud metadata IP is blocked at that hop and never fetched", async () => {
    const fetched: string[] = [];
    const stubFetch = (async (u: string | URL) => {
      fetched.push(String(u));
      if (String(u).includes("/.well-known/x402")) return new Response("", { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
      return new Response("nope", { status: 404 });
    }) as unknown as typeof fetch;
    const PUB = "https://93.184.215.14";
    const d = deps({}, { base: baseResult({ target: `${PUB}/api/thing`, finalUrl: `${PUB}/api/thing` }) });
    d.get = (u, o) => guardedGetWith({ safeCheck: assertSafePublicUrl, fetch: stubFetch as never }, u, o);
    const r = await checkX402Deep({ url: `${PUB}/api/thing` }, d);
    if (!r.ok) throw new Error("expected ok");
    const wk = r.publishedSources.find((s) => s.name === "well-known")!;
    expect(wk.status).toBeNull();
    expect(wk.error).toMatch(/blocked/i);
    expect(fetched.some((u) => u.includes("169.254"))).toBe(false);
  });

  it("redirect chains are capped", async () => {
    let hops = 0;
    const loop = (async () => { hops++; return new Response("", { status: 302, headers: { location: `https://93.184.215.14/r${hops}` } }); }) as unknown as typeof fetch;
    const r = await guardedGetWith({ safeCheck: assertSafePublicUrl, fetch: loop as never }, "https://93.184.215.14/start", { maxRedirects: 3, timeoutMs: 6_000 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("redirects");
    expect(hops).toBe(4);
  });
});

describe("handler", () => {
  it("bad input: 400, charged:false, deep methodology", async () => {
    const res = await x402CheckDeepHandler(new NextRequest("http://localhost/api/x402-check/deep"));
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j).toMatchObject({ ok: false, code: "missing_url", charged: false });
    expect(j.methodology).toEqual(JSON.parse(JSON.stringify(X402_CHECK_DEEP_METHODOLOGY)));
  });
  it("success body: source x402-check-deep, priced $0.03", async () => {
    const res = await x402CheckDeepHandler(new NextRequest(`http://localhost/api/x402-check/deep?url=${encodeURIComponent(URL_)}`), deps({}));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.source).toBe("x402-check-deep");
    expect(j.priced.amountUsd).toBe("$0.03");
    expect(j.priced.amountAtomic).toBe("30000");
    expect(j.tier).toBe("deep");
  });
});
