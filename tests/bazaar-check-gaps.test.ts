/**
 * bazaar-check-gaps (branch bazaar-check-gaps, 2026-10-09):
 * (a) POST probes send an empty body; not_402 on 400/422 carries the
 *     "checked inputs before payment" hint (shared wording with x402-check);
 * (b) schema pattern lint (invalid → fail, lookaround/backreference → warn);
 * (c) 30-day expiry warning from CDP quality.lastCalledAt (> 23 days old);
 * (d) Solana USDC mints in x402-check KNOWN_ASSETS so amountUsd is filled.
 * Network fully mocked; nothing leaves the box, nothing is signed or paid.
 * No CDP /validate call exists in lib/bazaar-check.ts (asserted below).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/fetch-url", async (orig) => {
  const real = await orig<typeof import("@/lib/fetch-url")>();
  return { ...real, assertSafePublicUrl: async (u: string) => ({ url: new URL(u) }) };
});

import {
  BAZAAR_CHECK_METHODOLOGY,
  BC_EXPIRY_WARN_DAYS,
  BC_MAX_PATTERNS,
  CDP_DISCOVERY_URL,
  CDP_GET_DISCOVERED_URL,
  checkBazaar,
  lintProbe,
  lintSchemaPatterns,
  patternUnportable,
  safeFetch,
  type Deps,
  type ProbeInput,
} from "@/lib/bazaar-check";
import { checkX402Endpoint, inputsBeforePaymentHint, knownAsset } from "@/lib/x402-check";

const FX = path.join(__dirname, "fixtures", "bazaar-check");
const GOOD = JSON.parse(readFileSync(path.join(FX, "good-402.json"), "utf8"));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
const probe = (challenge: unknown, over: Partial<ProbeInput> = {}): ProbeInput => ({
  listedUrl: "https://horizonpulse.dev/api/gas",
  method: "GET",
  status: 402,
  headers: new Headers(challenge ? { "payment-required": b64(challenge) } : {}),
  body: "{}",
  ...over,
});
const withPattern = (pattern: string) => {
  const c = clone(GOOD);
  c.extensions.bazaar.schema.properties.input.properties.queryParams.properties = { q: { type: "string", pattern } };
  return c;
};

afterEach(() => vi.unstubAllGlobals());

describe("(a) POST probe body + inputs-before-payment hint", () => {
  it("POST is sent with an empty body and no content-type (not '{}')", async () => {
    const seen: RequestInit[] = [];
    const deps: Deps = {
      now: () => Date.now(),
      assertSafe: async (u) => ({ url: new URL(u) }),
      fetch: (async (_u: string | URL | Request, init?: RequestInit) => {
        seen.push(init ?? {});
        return new Response("{}", { status: 402 });
      }) as typeof fetch,
    };
    const r = await safeFetch(deps, "https://s.example/api/x", "POST", 2000);
    expect("status" in r && r.status).toBe(402);
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.body).toBeUndefined();
    expect(new Headers(seen[0]!.headers).get("content-type")).toBeNull();
    expect(BAZAAR_CHECK_METHODOLOGY.lint).not.toContain("'{}'");
    expect(BAZAAR_CHECK_METHODOLOGY.lint).toMatch(/no body/);
  });

  it("not_402 on 400/422/415 adds the hint; reuses x402-check's wording; other statuses do not", () => {
    for (const status of [400, 422, 415]) {
      const post = lintProbe(probe(null, { status, method: "POST" })).findings[0]!;
      expect(post.id).toBe("not_402");
      expect(post.message).toContain(inputsBeforePaymentHint("POST"));
      expect(post.message).toContain("The endpoint may validate the body before returning 402");
      expect(post.message).toContain("(likely checks inputs before payment)");
      expect(post.message).toMatch(/empty body/);
      const get = lintProbe(probe(null, { status, method: "GET" })).findings[0]!;
      expect(get.message).toContain("The endpoint may validate the query before returning 402");
    }
    for (const status of [200, 401, 404, 405, 500]) expect(lintProbe(probe(null, { status, method: "POST" })).findings[0]!.message).not.toMatch(/checks inputs/);
  });

  it("v2: empty-body POST answered 400/422/415 is a WARN (CDP sends the declared example); other non-402s stay FAIL", () => {
    for (const status of [400, 422, 415]) {
      const f = lintProbe(probe(null, { status, method: "POST" })).findings;
      expect(f.map((x) => x.id), String(status)).toEqual(["not_402"]);
      expect(f[0]!.level, String(status)).toBe("warn");
      expect(f[0]!.message).toMatch(/declared example input/);
    }
    for (const status of [500, 404, 405, 401, 403, 200, 503]) {
      const f = lintProbe(probe(null, { status, method: "POST" })).findings;
      expect(f[0]!.level, String(status)).toBe("fail");
      expect(f[0]!.message).not.toMatch(/declared example input/);
    }
    // GET has no body: 400/422/415 on GET stays FAIL (query hint still shown for 400/422/415).
    for (const status of [400, 422, 415]) {
      const f = lintProbe(probe(null, { status, method: "GET" })).findings[0]!;
      expect(f.level, String(status)).toBe("fail");
      expect(f.message).toContain("The endpoint may validate the query before returning 402 (likely checks inputs before payment)");
    }
  });

  it("v2: a WARN-only POST route does not count as a lint failure in the end-to-end report", async () => {
    const NOW = Date.now();
    const deps: Deps = {
      now: () => NOW,
      assertSafe: async (u) => ({ url: new URL(u) }),
      fetch: (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.startsWith(CDP_DISCOVERY_URL)) return Response.json(new URL(url).pathname.endsWith("/merchant") ? { pagination: { total: 0 }, resources: [] } : { resources: [] });
        if (url === "https://s.example/.well-known/x402") return Response.json({ resources: ["POST https://s.example/api/p"] });
        if (url === "https://s.example/api/p") return new Response("bad", { status: 422 });
        return Response.json({ jsonrpc: "2.0", id: 1, result: "0x" + "0".repeat(64) });
      }) as typeof fetch,
    };
    const r = await checkBazaar({ url: "s.example" }, deps, { arrivedAt: NOW });
    if (!r.ok) throw new Error(r.error);
    const nf = r.routes[0]!.findings.find((x) => x.id === "not_402")!;
    expect(nf.level).toBe("warn");
    expect(r.routes[0]!.findings.find((x) => x.id === "not_indexed")!.message).not.toMatch(/Fix the failures above/);
  });

  it("x402-check wording is unchanged (POST, no caller body, 422)", async () => {
    vi.stubGlobal("fetch", async () => new Response("bad", { status: 422 }));
    const r = await checkX402Endpoint({ url: "https://s.example/api/x", method: "POST" });
    if (!r.ok) throw new Error(r.error);
    const m = r.checks.find((c) => c.id === "status_402")!.message;
    expect(m).toBe("Unpaid POST returned HTTP 422, not 402. x402 clients only start payment on a 402. The endpoint may validate the body before returning 402; pass a representative JSON body.");
  });
});

describe("(b) schema pattern lint", () => {
  it("our own pattern (^0x[0-9a-fA-F]{40}$) passes; the good fixture has no pattern findings", () => {
    expect(lintProbe(probe(withPattern("^0x[0-9a-fA-F]{40}$"))).findings).toEqual([]);
    expect(lintProbe(probe(GOOD)).findings).toEqual([]);
  });

  it("invalid regex → fail schema_pattern_invalid with the JSON path", () => {
    const f = lintProbe(probe(withPattern("^(abc$"))).findings;
    expect(f.map((x) => x.id)).toEqual(["schema_pattern_invalid"]);
    expect(f[0]!.level).toBe("fail");
    expect(f[0]!.message).toContain("extensions.bazaar.schema.properties.input.properties.queryParams.properties.q.pattern");
    expect(f[0]!.fix).toBeTruthy();
  });

  it("lookahead / lookbehind / backreference / named backreference → warn schema_pattern_unportable", () => {
    for (const p of ["^(?=.*\\d).+$", "^(?!x).*", "(?<=a)b", "(?<!a)b", "^(a)\\1$", "^(?<n>a)\\k<n>$"]) {
      const f = lintProbe(probe(withPattern(p))).findings;
      expect(f.map((x) => x.id), p).toEqual(["schema_pattern_unportable"]);
      expect(f[0]!.level).toBe("warn");
    }
  });

  it("no false positives: escaped backslash + digit, (?: groups, named groups, chars inside a class, \\- outside a class", () => {
    for (const p of ["^\\\\1$", "^(?:ab)+$", "^(?<year>\\d{4})$", "^[(?=]+$", "^[\\1]$", "^a\\-b$"]) {
      expect(lintSchemaPatterns({ pattern: p }), p).toEqual([]);
      expect(patternUnportable(p), p).toEqual({ lookaround: false, backreference: false });
    }
  });

  it("walks input AND output schema, patternProperties keys, arrays; skips example/default/const/enum data", () => {
    const schema = {
      properties: {
        input: { properties: { body: { patternProperties: { "^(?=x)": { type: "string" } } } } },
        output: { properties: { list: { items: [{ type: "string", pattern: "(" }] } } },
        example: { pattern: "(" },
        x: { default: { pattern: "(" }, const: { pattern: "(" } },
      },
    };
    const f = lintSchemaPatterns(schema);
    expect(f.map((x) => x.id).sort()).toEqual(["schema_pattern_invalid", "schema_pattern_unportable"]);
    expect(f.find((x) => x.id === "schema_pattern_invalid")!.message).toContain("output.properties.list.items[0].pattern");
    expect(f.find((x) => x.id === "schema_pattern_unportable")!.message).toContain("patternProperties");
  });

  it(`caps at ${BC_MAX_PATTERNS} patterns with an info finding`, () => {
    const props: Record<string, unknown> = {};
    for (let i = 0; i < BC_MAX_PATTERNS + 5; i++) props[`p${i}`] = { type: "string", pattern: "(" };
    const f = lintSchemaPatterns({ properties: props });
    expect(f.filter((x) => x.id === "schema_pattern_invalid")).toHaveLength(BC_MAX_PATTERNS);
    expect(f.at(-1)!.id).toBe("schema_patterns_capped");
  });
});

describe("(c) 30-day expiry warning from quality.lastCalledAt", () => {
  const NOW = Date.parse("2026-10-09T20:00:00Z");
  function run(quality: unknown) {
    const c = clone(GOOD);
    c.resource.url = "https://s.example/api/a";
    const resources = [{ resource: "https://s.example/api/a", accepts: c.accepts.map((a: { network: string }) => ({ network: a.network })), lastUpdated: "2026-10-01T00:00:00Z", quality }];
    const deps: Deps = {
      now: () => NOW,
      assertSafe: async (u) => ({ url: new URL(u) }),
      fetch: (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.startsWith(CDP_DISCOVERY_URL)) return Response.json(new URL(url).pathname.endsWith("/merchant") ? { pagination: { total: 1 }, resources } : { resources: [] });
        if (url === "https://s.example/.well-known/x402") return Response.json({ resources: ["GET https://s.example/api/a"] });
        if (url === "https://s.example/api/a") return new Response("{}", { status: 402, headers: { "payment-required": b64(c) } });
        return new Response("nf", { status: 404 });
      }) as typeof fetch,
    };
    return checkBazaar({ url: "s.example" }, deps, { arrivedAt: NOW });
  }
  const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

  it(`warns when lastCalledAt is more than ${BC_EXPIRY_WARN_DAYS} days old, with days left and the CDP doc`, async () => {
    const r = await run({ lastCalledAt: daysAgo(25), score: 0.9, calls30d: 12 });
    if (!r.ok) throw new Error(r.error);
    const f = r.routes[0]!.findings;
    expect(f.map((x) => x.id)).toEqual(["index_expiry_soon"]);
    expect(f[0]!.level).toBe("warn");
    expect(f[0]!.message).toMatch(/25 days ago\). 5 day\(s\) left of the 30-day window/);
    expect(f[0]!.doc).toBe(CDP_GET_DISCOVERED_URL);
    // Only the timestamp is kept from quality.
    expect(r.routes[0]!.lastCalledAt).toBe(daysAgo(25));
    expect(JSON.stringify(r)).not.toMatch(/calls30d|"score"/);
  });

  it("past 30 days says so; 23 days or newer, missing quality, or junk → no warning", async () => {
    const old = await run({ lastCalledAt: daysAgo(31) });
    if (!old.ok) throw new Error(old.error);
    expect(old.routes[0]!.findings[0]!.message).toMatch(/That is past the 30-day window/);
    for (const q of [{ lastCalledAt: daysAgo(23) }, { lastCalledAt: daysAgo(1) }, undefined, { lastCalledAt: "not a date" }, { lastCalledAt: {} }]) {
      const r = await run(q);
      if (!r.ok) throw new Error(r.error);
      expect(r.routes[0]!.findings, JSON.stringify(q)).toEqual([]);
    }
  });

  it("epoch seconds and epoch ms are accepted and stored as ISO", async () => {
    for (const v of [Math.floor((NOW - 26 * 86_400_000) / 1000), NOW - 26 * 86_400_000]) {
      const r = await run({ lastCalledAt: v });
      if (!r.ok) throw new Error(r.error);
      expect(r.routes[0]!.lastCalledAt).toBe(daysAgo(26));
      expect(r.routes[0]!.findings.map((x) => x.id)).toEqual(["index_expiry_soon"]);
    }
  });

  it("no CDP /validate call anywhere in the module", () => {
    const src = readFileSync(path.join(__dirname, "..", "lib", "bazaar-check.ts"), "utf8");
    expect(src).not.toMatch(/\/validate/);
  });
});

describe("(d) Solana USDC in x402-check KNOWN_ASSETS", () => {
  it("mainnet + devnet mints resolve exactly (case-sensitive); EVM stays case-insensitive", () => {
    expect(knownAsset("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toEqual({ label: "USDC (Solana)", decimals: 6, usd: true });
    expect(knownAsset("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU")?.label).toBe("USDC (Solana devnet)");
    expect(knownAsset("epjfwdd5aufqssqem2qn1xzybapc8g4wegkzwyTdt1v".toLowerCase())).toBeUndefined();
    expect(knownAsset("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")?.label).toBe("USDC (Base)");
    expect(knownAsset("constructor")).toBeUndefined();
  });

  it("end to end: a Solana accepts entry gets assetLabel and amountUsd", async () => {
    const c = clone(GOOD);
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 402, headers: { "payment-required": b64(c) } }));
    const r = await checkX402Endpoint({ url: "https://s.example/api/gas" });
    if (!r.ok) throw new Error(r.error);
    const sol = r.accepts.find((a) => a.network?.startsWith("solana:"))!;
    expect(sol.asset).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(sol.assetLabel).toBe("USDC (Solana)");
    expect(sol.amountUsd).toMatch(/^\$0\.\d+$/);
    expect(sol.payToType).toBeNull();
  });
});
