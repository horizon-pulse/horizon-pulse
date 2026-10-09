/**
 * /api/bazaar-check: one unit test per lint rule (fixtures under
 * tests/fixtures/bazaar-check/), the well-known parser, input/SSRF gating,
 * index matching, the settle inference, and an end-to-end run against a
 * synthetic known-bad seller. Network is fully mocked (deps.fetch); nothing
 * leaves the box, nothing is signed or paid.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CDP_DISCOVERY_URL,
  CDP_TROUBLESHOOTING_URL,
  checkBazaar,
  lintProbe,
  parseTarget,
  parseWellKnown,
  resourceKey,
  type Deps,
  type ProbeInput,
} from "@/lib/bazaar-check";

const FX = path.join(__dirname, "fixtures", "bazaar-check");
const GOOD = JSON.parse(readFileSync(path.join(FX, "good-402.json"), "utf8"));
const BAD = JSON.parse(readFileSync(path.join(FX, "bad-seller.json"), "utf8"));
const WK_GOOD = readFileSync(path.join(FX, "well-known-good.json"), "utf8");

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");

function probe(challenge: unknown, over: Partial<ProbeInput> = {}): ProbeInput {
  return {
    listedUrl: "https://horizonpulse.dev/api/gas",
    method: "GET",
    status: 402,
    headers: new Headers(challenge ? { "payment-required": b64(challenge) } : {}),
    body: "{}",
    ...over,
  };
}
const ids = (p: ProbeInput) => lintProbe(p).findings.map((f) => f.id);

describe("lint rules (one fixture each)", () => {
  it("baseline: our live /api/gas 402 passes with no findings, Base + Solana advertised", () => {
    const r = lintProbe(probe(GOOD));
    expect(r.findings).toEqual([]);
    expect(r.x402Version).toBe(2);
    expect(r.challengeSource).toBe("header");
    expect(r.advertisedNetworks).toEqual(["base", "solana"]);
    expect(r.bazaar).toEqual({ present: true, method: "GET", methodEnum: ["GET"] });
  });

  it("resource_http: resource.url is plain http", () => {
    const c = clone(GOOD);
    c.resource.url = "http://horizonpulse.dev/api/gas";
    const f = lintProbe(probe(c)).findings;
    expect(f.map((x) => x.id)).toEqual(["resource_http"]);
    expect(f[0]!.level).toBe("fail");
    expect(f[0]!.fix).toMatch(/https/);
    expect(f[0]!.doc).toBe(CDP_TROUBLESHOOTING_URL);
  });

  it("not_402: the route does not actually return 402 (405 hints a method problem)", () => {
    const f = lintProbe(probe(null, { status: 200 })).findings;
    expect(f.map((x) => x.id)).toEqual(["not_402"]);
    expect(f[0]!.fix).toMatch(/Return HTTP 402/);
    expect(lintProbe(probe(null, { status: 405 })).findings[0]!.message).toMatch(/wrong method/);
  });

  it("payment_required_header_missing: v2 challenge only in the body", () => {
    expect(ids(probe(null, { body: JSON.stringify(GOOD) }))).toEqual(["payment_required_header_missing"]);
  });

  it("challenge_missing: 402 with neither header nor x402 body", () => {
    expect(ids(probe(null, { body: "<html>pay me</html>" }))).toEqual(["payment_required_header_missing", "challenge_missing"]);
  });

  it("header_undecodable: PAYMENT-REQUIRED is not base64 JSON", () => {
    const p = probe(null, { headers: new Headers({ "payment-required": "%%%not-base64%%%" }) });
    expect(ids(p)).toContain("header_undecodable");
  });

  it("x402_version + v2_fields_missing: legacy v1 body challenge", () => {
    const v1 = JSON.parse(BAD.routes["GET https://bad-seller.example/api/v1"].body);
    const got = ids(probe(null, { body: JSON.stringify(v1), listedUrl: "https://bad-seller.example/api/v1" }));
    expect(got).toEqual(expect.arrayContaining(["payment_required_header_missing", "x402_version", "v2_fields_missing", "bazaar_missing"]));
  });

  it("v2_fields_missing: lists each missing field", () => {
    const c = clone(GOOD);
    delete c.accepts[0].payTo;
    delete c.accepts[0].maxTimeoutSeconds;
    delete c.resource.url;
    const f = lintProbe(probe(c)).findings.find((x) => x.id === "v2_fields_missing")!;
    expect(f.message).toContain("resource.url");
    expect(f.message).toContain("accepts[0].payTo");
    expect(f.message).toContain("accepts[0].maxTimeoutSeconds");
  });

  it("network_not_caip2: v2 with a plain network name", () => {
    const c = clone(GOOD);
    c.accepts[0].network = "base";
    expect(ids(probe(c))).toEqual(["network_not_caip2"]);
  });

  it("bazaar_missing: no extensions.bazaar", () => {
    const c = clone(GOOD);
    delete c.extensions;
    const f = lintProbe(probe(c)).findings;
    expect(f.map((x) => x.id)).toEqual(["bazaar_missing"]);
    expect(f[0]!.fix).toMatch(/declareDiscoveryExtension/);
  });

  it("bazaar_no_method: no explicit method in the Bazaar metadata", () => {
    const c = clone(GOOD);
    delete c.extensions.bazaar.info.input.method;
    expect(ids(probe(c))).toEqual(["bazaar_no_method"]);
  });

  it("method_mismatch + method_enum_mismatch: HEAD declared, GET charged, wide verb enum", () => {
    const c = clone(GOOD);
    c.extensions.bazaar.info.input.method = "HEAD";
    c.extensions.bazaar.schema.properties.input.properties.method.enum = ["GET", "HEAD", "DELETE"];
    const f = lintProbe(probe(c)).findings;
    expect(f.map((x) => x.id)).toEqual(["method_mismatch", "method_enum_mismatch"]);
    expect(f[0]!.message).toMatch(/HEAD and GET/);
    expect(f[1]!.level).toBe("warn"); // GET is in the enum, just not alone
    expect(f[1]!.message).toMatch(/HEAD vs GET/);
  });

  it("method_enum_mismatch is a fail when the charged method is not in the enum", () => {
    const c = clone(GOOD);
    c.extensions.bazaar.schema.properties.input.properties.method.enum = ["POST"];
    const f = lintProbe(probe(c)).findings.find((x) => x.id === "method_enum_mismatch")!;
    expect(f.level).toBe("fail");
  });

  it("resource_mismatch: resource.url points somewhere else", () => {
    const c = clone(GOOD);
    c.resource.url = "https://horizonpulse.dev/api/other";
    expect(ids(probe(c))).toEqual(["resource_mismatch"]);
  });

  it("description_too_long: > 500 chars", () => {
    const c = clone(GOOD);
    c.resource.description = "x".repeat(501);
    expect(ids(probe(c))).toEqual(["description_too_long"]);
  });

  it("every finding carries a fix line", () => {
    for (const key of Object.keys(BAD.routes)) {
      const r = BAD.routes[key];
      const [method, url] = key.split(" ");
      if (url.endsWith("/.well-known/x402")) continue;
      for (const f of lintProbe({ listedUrl: url, method: method as "GET" | "POST", status: r.status, headers: new Headers(r.headers), body: r.body }).findings)
        expect(f.fix, `${key} ${f.id}`).toBeTruthy();
    }
  });
});

describe("parseWellKnown / parseTarget / resourceKey", () => {
  it("parses our live /.well-known/x402: 13 routes, 15 operations (http and extract are GET|POST)", () => {
    const r = parseWellKnown(WK_GOOD)!;
    expect(r.routes).toHaveLength(13);
    expect(r.routes.reduce((n, x) => n + x.methods.length, 0)).toBe(15);
    expect(r.routes.find((x) => x.url.endsWith("/api/http"))!.methods).toEqual(["GET", "POST"]);
    expect(r.findings).toEqual([]);
  });

  it("bare entries default to GET with an info finding; objects accepted; junk rejected", () => {
    const r = parseWellKnown(JSON.stringify({ resources: ["https://a.example/x", { url: "https://a.example/y", method: "post" }] }))!;
    expect(r.routes.map((x) => [x.url, x.methods])).toEqual([["https://a.example/x", ["GET"]], ["https://a.example/y", ["POST"]]]);
    expect(r.findings.map((f) => f.id)).toEqual(["well_known_no_method"]);
    expect(parseWellKnown("not json")).toBeNull();
    expect(parseWellKnown(JSON.stringify({ nope: 1 }))).toBeNull();
  });

  it("parseTarget: bare host → https origin; http refused; credentials refused", () => {
    expect(parseTarget("HorizonPulse.dev")).toEqual({ origin: "https://horizonpulse.dev", host: "horizonpulse.dev", path: null });
    expect(parseTarget("https://x.example/api/a?b=1")).toMatchObject({ host: "x.example", path: "/api/a" });
    expect(parseTarget("http://x.example")).toMatchObject({ code: "https_only" });
    expect(parseTarget("ftp://x.example")).toMatchObject({ code: "scheme_blocked" });
    expect(parseTarget("https://u:p@x.example")).toMatchObject({ code: "bad_url" });
    expect(parseTarget("")).toMatchObject({ code: "missing_url" });
  });

  it("resourceKey normalizes host case, query and trailing slash", () => {
    expect(resourceKey("https://HorizonPulse.dev/api/pulse/?a=1#x")).toBe("https://horizonpulse.dev/api/pulse");
  });
});

/* ------------------------------------------------------------------ */
/* Orchestration with a mocked network                                 */
/* ------------------------------------------------------------------ */

type Mock = { status: number; headers?: Record<string, string>; body: string };
function mockDeps(opts: {
  pages: Record<string, Mock>;
  merchant?: (payTo: string) => unknown;
  search?: () => unknown;
  cdpDown?: boolean;
  usdcBalanceHex?: string;
  blocked?: string[];
}): Deps & { calls: string[] } {
  const calls: string[] = [];
  const deps = {
    calls,
    now: () => Date.now(),
    assertSafe: async (u: string) => {
      const url = new URL(u);
      if (opts.blocked?.includes(url.hostname)) return { ok: false as const, error: "Private, loopback, or link-local IP targets are blocked", code: "host_blocked", status: 400 };
      return { url };
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push(`${method} ${url}`);
      if (url.startsWith(CDP_DISCOVERY_URL)) {
        if (opts.cdpDown) return new Response("down", { status: 503 });
        const u = new URL(url);
        if (u.pathname.endsWith("/merchant")) {
          const body = opts.merchant?.(u.searchParams.get("payTo")!) ?? { pagination: { total: 0 }, resources: [] };
          return Response.json(body);
        }
        return Response.json(opts.search?.() ?? { resources: [] });
      }
      if (url.includes("base") && method === "POST") {
        return Response.json({ jsonrpc: "2.0", id: 1, result: opts.usdcBalanceHex ?? "0x" + "0".repeat(64) });
      }
      if (url.includes("solana") && method === "POST") {
        return Response.json({ jsonrpc: "2.0", id: 1, result: { value: [] } });
      }
      const m = opts.pages[`${method} ${url}`];
      if (!m) return new Response("not found", { status: 404 });
      return new Response(m.body, { status: m.status, headers: m.headers });
    }) as typeof fetch,
  };
  return deps;
}

function indexedFor(host: string, paths: string[], networks = ["eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]) {
  return {
    pagination: { total: paths.length },
    resources: paths.map((p) => ({ resource: `https://${host}${p}`, accepts: networks.map((network) => ({ network })), lastUpdated: "2026-10-09T15:20:43.778Z" })),
  };
}

describe("checkBazaar (mocked network)", () => {
  it("known-bad seller: every rule fires on its route, nothing indexed, settle inferred with doc + on-chain boolean", async () => {
    const deps = mockDeps({ pages: BAD.routes });
    const r = await checkBazaar({ url: "bad-seller.example" }, deps);
    if (!r.ok) throw new Error(r.error);
    expect(r.verdict).toBe("not_indexed");
    const by = Object.fromEntries(r.routes.map((x) => [new URL(x.url).pathname, x]));
    const has = (p: string, id: string) => expect(by[p]!.findings.map((f) => f.id), `${p}`).toContain(id);
    has("/api/http-resource", "resource_http");
    has("/api/not-402", "not_402");
    has("/api/v1", "x402_version");
    has("/api/v1", "payment_required_header_missing");
    has("/api/no-bazaar", "bazaar_missing");
    has("/api/no-method", "bazaar_no_method");
    has("/api/head-mismatch", "method_mismatch");
    has("/api/head-mismatch", "method_enum_mismatch");
    has("/api/plain", "resource_http");
    expect(by["/api/plain"]!.skippedReason).toMatch(/plain http/);
    for (const x of r.routes) if (!x.skippedReason) has(new URL(x.url).pathname, "not_indexed");
    // lint-clean route: points at the settle inference
    expect(by["/api/ok"]!.findings.map((f) => f.id)).toEqual(["not_indexed"]);
    const settle = r.findings.find((f) => f.id === "no_cdp_settle_likely")!;
    expect(settle.message).toMatch(/likely needs one CDP-facilitated paid settle/);
    expect(settle.message).toMatch(/no USDC held/);
    expect(settle.doc).toBe(CDP_TROUBLESHOOTING_URL);
    expect(r.onchain).toEqual([{ network: "eip155:8453", payTo: BAD.payTo, method: "USDC balanceOf on Base (eth_call)", holdsUsdc: false }]);
    // the plain-http route was never fetched
    expect(deps.calls.some((c) => c.includes("http://bad-seller.example"))).toBe(false);
  });

  it("settle inference needs an empty index: no on-chain check and no settle finding when the payTo is indexed", async () => {
    const deps = mockDeps({ pages: BAD.routes, merchant: () => indexedFor("bad-seller.example", ["/api/ok"], ["eip155:8453"]) });
    const r = await checkBazaar({ url: "bad-seller.example" }, deps);
    if (!r.ok) throw new Error(r.error);
    expect(r.verdict).toBe("partially_indexed");
    expect(r.onchain).toEqual([]);
    expect(r.findings.map((f) => f.id)).not.toContain("no_cdp_settle_likely");
    expect(deps.calls.some((c) => c.startsWith("POST https://") && c.includes("base"))).toBe(false);
  });

  it("on-chain USDC present: still 'likely needs a CDP settle', amount never reported", async () => {
    const deps = mockDeps({ pages: BAD.routes, usdcBalanceHex: "0x" + "0".repeat(60) + "2710" });
    const r = await checkBazaar({ url: "bad-seller.example" }, deps);
    if (!r.ok) throw new Error(r.error);
    const f = r.findings.find((x) => x.id === "no_cdp_settle_likely")!;
    expect(f.message).toMatch(/amount not reported/);
    expect(JSON.stringify(r)).not.toMatch(/10000|0\.01 USDC held|2710/);
  });

  it("fully indexed host: 13/13 on Base + Solana, zero findings; CDP results on other hosts are ignored", async () => {
    const wk = parseWellKnown(WK_GOOD)!;
    const pages: Record<string, Mock> = { "GET https://horizonpulse.dev/.well-known/x402": { status: 200, body: WK_GOOD } };
    for (const route of wk.routes)
      for (const m of route.methods) {
        const c = clone(GOOD);
        c.resource.url = route.url;
        c.extensions.bazaar.info.input.method = m;
        c.extensions.bazaar.schema.properties.input.properties.method.enum = [m];
        pages[`${m} ${route.url}`] = { status: 402, headers: { "payment-required": b64(c) }, body: "{}" };
      }
    const paths = wk.routes.map((x) => new URL(x.url).pathname);
    const merchant = () => {
      const j = indexedFor("horizonpulse.dev", paths);
      j.resources.push({ resource: "https://someone-else.example/api/x", accepts: [{ network: "eip155:8453" }], lastUpdated: "x" });
      return j;
    };
    const r = await checkBazaar({ url: "horizonpulse.dev" }, mockDeps({ pages, merchant }));
    if (!r.ok) throw new Error(r.error);
    expect(r.verdict).toBe("fully_indexed");
    expect(r.summary).toMatchObject({ routesListed: 13, routesProbed: 13, indexed: 13, notIndexed: 0, indexedOnBase: 13, indexedOnSolana: 13, fail: 0, warn: 0 });
    expect(r.index.indexedNotListed).toEqual([]);
    expect(r.routes.every((x) => x.findings.length === 0)).toBe(true);
  });

  it("network_not_indexed: 402 advertises Solana but the index entry is Base-only", async () => {
    const c = clone(GOOD);
    c.resource.url = "https://s.example/api/a";
    const pages: Record<string, Mock> = {
      "GET https://s.example/.well-known/x402": { status: 200, body: JSON.stringify({ resources: ["GET https://s.example/api/a"] }) },
      "GET https://s.example/api/a": { status: 402, headers: { "payment-required": b64(c) }, body: "{}" },
    };
    const r = await checkBazaar({ url: "s.example" }, mockDeps({ pages, merchant: () => indexedFor("s.example", ["/api/a"], ["eip155:8453"]) }));
    if (!r.ok) throw new Error(r.error);
    expect(r.routes[0]!.findings.map((f) => f.id)).toEqual(["network_not_indexed"]);
    expect(r.summary.indexedOnSolana).toBe(0);
  });

  it("missing /.well-known/x402: warns, still probes a caller-supplied path", async () => {
    const c = clone(GOOD);
    c.resource.url = "https://n.example/api/a";
    const pages: Record<string, Mock> = { "GET https://n.example/api/a": { status: 402, headers: { "payment-required": b64(c) }, body: "{}" } };
    const r = await checkBazaar({ url: "https://n.example/api/a" }, mockDeps({ pages }));
    if (!r.ok) throw new Error(r.error);
    expect(r.findings.map((f) => f.id)).toContain("well_known_missing");
    expect(r.routes.map((x) => x.url)).toEqual(["https://n.example/api/a"]);
  });

  it("routes on other hosts are listed, not probed", async () => {
    const pages: Record<string, Mock> = {
      "GET https://o.example/.well-known/x402": { status: 200, body: JSON.stringify({ resources: ["GET https://elsewhere.example/api/a"] }) },
    };
    const deps = mockDeps({ pages });
    const r = await checkBazaar({ url: "o.example" }, deps);
    if (!r.ok) throw new Error(r.error);
    expect(r.routes[0]!.skippedReason).toMatch(/another host/);
    expect(deps.calls.some((x) => x.includes("elsewhere.example"))).toBe(false);
    expect(r.verdict).toBe("no_routes_found");
  });

  it("not billed: bad input, http, blocked host, unreachable host, CDP down", async () => {
    const d = () => mockDeps({ pages: BAD.routes, blocked: ["internal.example"] });
    expect(await checkBazaar({}, d())).toMatchObject({ ok: false, status: 400, code: "missing_url" });
    expect(await checkBazaar({ url: "http://bad-seller.example" }, d())).toMatchObject({ ok: false, status: 400, code: "https_only" });
    expect(await checkBazaar({ url: "internal.example" }, d())).toMatchObject({ ok: false, status: 400, code: "host_blocked" });
    const dead = mockDeps({ pages: {} });
    dead.fetch = (async (u: string | URL | Request) => {
      if (String(u).startsWith(CDP_DISCOVERY_URL)) return Response.json({ resources: [] });
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    expect(await checkBazaar({ url: "dead.example" }, dead)).toMatchObject({ ok: false, status: 502, code: "unreachable" });
    expect(await checkBazaar({ url: "bad-seller.example" }, mockDeps({ pages: BAD.routes, cdpDown: true }))).toMatchObject({ ok: false, status: 502, code: "cdp_unavailable" });
  });

  it("redirects to a private host or to http are refused at the hop", async () => {
    const pages: Record<string, Mock> = {
      "GET https://r.example/.well-known/x402": { status: 302, headers: { location: "https://internal.example/x" }, body: "" },
      "GET https://r.example/api/a": { status: 301, headers: { location: "http://r.example/api/a" }, body: "" },
    };
    const deps = mockDeps({ pages, blocked: ["internal.example"] });
    const r = await checkBazaar({ url: "https://r.example/api/a" }, deps);
    // well-known redirect hit a blocked host → whole request refused, not billed
    expect(r).toMatchObject({ ok: false, code: "host_blocked", status: 400 });
    expect(deps.calls.some((x) => x.includes("internal.example"))).toBe(false);
  });

  it("report contains no revenue/customer wording and no secrets", async () => {
    const r = await checkBazaar({ url: "bad-seller.example" }, mockDeps({ pages: BAD.routes }));
    const { methodology: _m, ...rest } = r as Record<string, unknown>; // methodology carries the disclaimer itself
    void _m;
    const s = JSON.stringify(rest).toLowerCase();
    for (const w of ["revenue", "customer", "earned", "income", "cdp_api_key", "secret"]) expect(s).not.toContain(w);
  });
});
