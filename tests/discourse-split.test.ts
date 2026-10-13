/**
 * /api/discourse/split (branch discourse-split, scope memo 2026-10-13 Option B).
 * Refusals, the <30 no-charge path, Wilson CI math, no text/username leakage,
 * 1h cache with delete re-check, and price parity across discovery surfaces.
 * Four-rail 402s are covered by the shared capture harness (tests/helpers/capture.ts
 * PAID_ROUTES includes discourse/split; solana/xrpl/polygon flag-on suites).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { resetXrplRailForTests } from "@/lib/xrpl-rail";
import { resetSolanaRailForTests } from "@/lib/solana-rail";
import { SOLANA_PAYTO } from "@/lib/solana-config";
import { installXrplFacilitators, setCdp, stubXrplOn } from "./helpers/xrpl-env";
import { installRpc } from "./helpers/solana-env";
import { NextRequest } from "next/server";
import {
  CACHE_TTL_MS,
  DISCOURSE_LABEL,
  MIN_DECIDED,
  estimateCostUsd,
  keywordStubClassifier,
  parseSplitInput,
  refusalFor,
  resetDiscourseCacheForTests,
  setClassifierForTests,
  wilson95,
  type Deps,
} from "@/lib/discourse/engine";
import { discourseSplitHandler } from "@/app/api/discourse/split/handler";
import { DEFAULT_PAY_TO, DISCOURSE_SPLIT_PRICE_ATOMIC, DISCOURSE_SPLIT_PRICE_USD } from "@/lib/config";
import { LIVE_PAID_ROUTES } from "@/lib/live-catalog";
import { TOOLS } from "@/lib/mcp-server";
import { DEMO_ROUTES } from "@/lib/demo-catalog";
import { discourseSplitRouteConfig } from "@/lib/x402-server";
import { ROUTE_METADATA } from "@/lib/route-metadata";

const ROOT = path.resolve(__dirname, "..");

/** Synthetic sources: hnYes/hnNo/bskyYes/bskyNo posts, distinct accounts + threads. */
function fakeSources(o: { hnYes?: number; hnNo?: number; bskyYes?: number; bskyNo?: number; neutral?: number; deletedBsky?: Set<string>; deletedHn?: Set<string> }) {
  const calls: string[] = [];
  const hnHits: unknown[] = [];
  let id = 1000;
  const push = (text: string) => hnHits.push({ objectID: String(id), author: `hnuser${id}`, story_id: id++, comment_text: `<p>${text}</p>` });
  for (let i = 0; i < (o.hnYes ?? 0); i++) push("yes I agree, SECRETWORD-hn");
  for (let i = 0; i < (o.hnNo ?? 0); i++) push("no I disagree, SECRETWORD-hn");
  for (let i = 0; i < (o.neutral ?? 0); i++) push("hmm interesting");
  hnHits.push({ objectID: "1", author: null, comment_text: null }); // deleted comment
  const posts: unknown[] = [];
  let k = 0;
  const bpush = (text: string) => {
    const did = `did:plc:acct${k}`;
    posts.push({ uri: `at://${did}/app.bsky.feed.post/rk${k}`, author: { did, handle: `handle${k}.bsky.social` }, record: { text } });
    k++;
  };
  for (let i = 0; i < (o.bskyYes ?? 0); i++) bpush("yes absolutely SECRETWORD-bsky");
  for (let i = 0; i < (o.bskyNo ?? 0); i++) bpush("nope, never SECRETWORD-bsky");
  const f = async (u: string) => {
    calls.push(u);
    if (u.startsWith("https://hn.algolia.com/")) return Response.json({ hits: hnHits });
    if (u.includes("searchPosts")) return Response.json({ posts });
    if (u.includes("getPosts")) {
      const uris = new URL(u).searchParams.getAll("uris");
      return Response.json({ posts: uris.filter((x) => !o.deletedBsky?.has(x)).map((uri) => ({ uri })) });
    }
    if (u.startsWith("https://hacker-news.firebaseio.com/")) {
      const itemId = u.split("/").pop()!.replace(".json", "");
      return Response.json(o.deletedHn?.has(itemId) ? { id: itemId, deleted: true } : { id: itemId });
    }
    return new Response("no", { status: 404 });
  };
  return { calls, deps: (now = Date.parse("2026-10-13T05:00:00Z")): Deps => ({ fetch: f as Deps["fetch"], now: () => now }) };
}

const req = (qs: string) => new NextRequest(`https://horizonpulse.dev/api/discourse/split?${qs}`);

beforeEach(() => {
  resetDiscourseCacheForTests();
  setClassifierForTests(keywordStubClassifier);
});
afterEach(() => setClassifierForTests(undefined));

describe("input + refusals (422, not charged)", () => {
  it("validates q, sides, window", () => {
    expect(parseSplitInput({}).ok).toBe(false);
    expect(parseSplitInput({ q: "ab" }).ok).toBe(false);
    expect(parseSplitInput({ q: "x".repeat(201) }).ok).toBe(false);
    expect(parseSplitInput({ q: "tabs or spaces", sides: "tabs" }).ok).toBe(false);
    expect(parseSplitInput({ q: "tabs or spaces", sides: "a,b,c,d,e" }).ok).toBe(false);
    expect(parseSplitInput({ q: "tabs or spaces", sides: "a,A" }).ok).toBe(false);
    expect(parseSplitInput({ q: "tabs or spaces", window: "31d" }).ok).toBe(false);
    const ok = parseSplitInput({ q: " tabs  or spaces ", sides: "tabs, spaces", window: "7d" });
    expect(ok).toEqual({ ok: true, input: { q: "tabs or spaces", sides: ["tabs", "spaces"], windowDays: 7 } });
  });

  it.each([
    ["Who will win the 2028 presidential election?", "refused_election"],
    ["Should I vote for the incumbent mayor?", "refused_election"],
    ["Is Trump right about tariffs?", "refused_election"],
    ["Do vaccines cause autism?", "refused_health"],
    ["Is ivermectin a cure for covid", "refused_health"],
    ["Is Jane Smith a fraud?", "refused_person"],
    ["Did John Doe steal from his employer", "refused_person"],
    ["Is my landlord lying about the deposit", "refused_person"],
  ])("refuses %s", async (q, code) => {
    expect(refusalFor(q)?.code).toBe(code);
    const src = fakeSources({ hnYes: 40 });
    const res = await discourseSplitHandler(req(`q=${encodeURIComponent(q)}`), src.deps());
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, code, charged: false, label: DISCOURSE_LABEL });
    expect(src.calls).toHaveLength(0); // refused before any source call
  });

  it.each(["tabs or spaces for indentation", "Is Rust better than Go for CLIs", "Will Apple Vision Pro succeed", "Is remote work here to stay"])(
    "allows %s",
    (q) => expect(refusalFor(q)).toBeNull(),
  );
});

describe("under 30: insufficient data, not charged (status >= 400 → no settle on any rail)", () => {
  it("too few posts fetched → 422 insufficient_data without calling the classifier", async () => {
    let classified = 0;
    setClassifierForTests({ name: "spy", classify: async (q, s, t) => { classified++; return keywordStubClassifier.classify(q, s, t); } });
    const src = fakeSources({ hnYes: 10, bskyNo: 10 });
    const res = await discourseSplitHandler(req("q=tabs%20or%20spaces"), src.deps());
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ ok: false, code: "insufficient_data", charged: false, n_fetched: 20 });
    expect(classified).toBe(0);
  });

  it("enough posts but fewer than 30 take a side → 422", async () => {
    const src = fakeSources({ hnYes: 15, bskyNo: 14, neutral: 40 });
    const res = await discourseSplitHandler(req("q=tabs%20or%20spaces"), src.deps());
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "insufficient_data", n_classified: 29, charged: false });
  });

  it("exactly 30 decided → 200 (billed)", async () => {
    const src = fakeSources({ hnYes: 15, bskyNo: 15 });
    const res = await discourseSplitHandler(req("q=tabs%20or%20spaces"), src.deps());
    expect(res.status).toBe(200);
    expect(MIN_DECIDED).toBe(30);
  });

  it("no classifier configured → 503 classifier_unavailable, no source calls", async () => {
    setClassifierForTests(undefined);
    const src = fakeSources({ hnYes: 40 });
    const res = await discourseSplitHandler(req("q=tabs%20or%20spaces"), src.deps());
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "classifier_unavailable", charged: false });
    expect(src.calls).toHaveLength(0);
  });

  it("classifier throws → 503 classifier_unavailable, not charged, not cached", async () => {
    let calls = 0;
    setClassifierForTests({ name: "boom", classify: async () => { calls++; throw new Error("provider down"); } });
    const src = fakeSources({ hnYes: 20, bskyNo: 20 });
    const res = await discourseSplitHandler(req("q=classifier%20throws%20case"), src.deps());
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, code: "classifier_unavailable", charged: false });
    setClassifierForTests(keywordStubClassifier);
    const again = await discourseSplitHandler(req("q=classifier%20throws%20case"), src.deps());
    expect(again.status).toBe(200);
    expect(calls).toBe(1);
  });

  it("both sources down → 502, not charged", async () => {
    const deps: Deps = { fetch: async () => new Response("x", { status: 500 }), now: () => 0 };
    const res = await discourseSplitHandler(req("q=tabs%20or%20spaces"), deps);
    expect(res.status).toBe(502);
  });
});

describe("CI math (Wilson 95%)", () => {
  it("matches reference values", () => {
    expect(wilson95(35, 84)).toEqual([0.3171, 0.5235]);
    expect(wilson95(49, 84)).toEqual([0.4765, 0.6829]);
    expect(wilson95(0, 30)).toEqual([0, 0.1135]);
    expect(wilson95(30, 30)).toEqual([0.8865, 1]);
    expect(wilson95(50, 100)).toEqual([0.4038, 0.5962]);
    expect(wilson95(0, 0)).toEqual([0, 1]);
  });

  it("answer shares sum to 1 and each share sits inside its interval", async () => {
    const src = fakeSources({ hnYes: 20, hnNo: 5, bskyYes: 10, bskyNo: 15, neutral: 7 });
    const body = await (await discourseSplitHandler(req("q=tabs%20or%20spaces"), src.deps())).json();
    expect(body.label).toBe(DISCOURSE_LABEL);
    expect(body.n_classified).toBe(50);
    expect(body.n_neutral).toBe(7);
    expect(body.sides.map((s: { n: number }) => s.n)).toEqual([30, 20]);
    expect(body.sides[0].share + body.sides[1].share).toBeCloseTo(1, 6);
    for (const s of body.sides) expect(s.ci95[0] <= s.share && s.share <= s.ci95[1]).toBe(true);
    expect(body.sides[0].ci95).toEqual(wilson95(30, 50));
    expect(body.priced).toBeTruthy();
  });
});

describe("no text or username leakage", () => {
  it("output has links only: no post text, author, handle", async () => {
    const src = fakeSources({ hnYes: 20, hnNo: 5, bskyYes: 10, bskyNo: 15 });
    const text = await (await discourseSplitHandler(req("q=tabs%20or%20spaces"), src.deps())).text();
    expect(text).not.toMatch(/SECRETWORD|hnuser|handle\d|bsky\.social|agree/i);
    const body = JSON.parse(text);
    expect(body.sample.length).toBeGreaterThan(0);
    expect(body.sample.length).toBeLessThanOrEqual(10);
    for (const u of body.sample) expect(u).toMatch(/^https:\/\/(news\.ycombinator\.com\/item\?id=\d+|bsky\.app\/profile\/did:plc:[a-z0-9]+\/post\/[A-Za-z0-9]+)$/);
  });
});

describe("1h cache, deletes honored", () => {
  it("second call within 1h is cached (no new searches); drops deleted sample links", async () => {
    const deletedBsky = new Set<string>();
    const deletedHn = new Set<string>();
    const src = fakeSources({ hnYes: 20, hnNo: 5, bskyYes: 10, bskyNo: 15, deletedBsky, deletedHn });
    const t0 = Date.parse("2026-10-13T05:00:00Z");
    const first = await (await discourseSplitHandler(req("q=Tabs%20or%20spaces"), src.deps(t0))).json();
    expect(first.cached).toBe(false);
    const searches = () => src.calls.filter((u) => u.includes("hn.algolia") || u.includes("searchPosts")).length;
    expect(searches()).toBe(2);
    const bskyLink: string = first.sample.find((u: string) => u.includes("bsky.app"));
    const hnLink: string = first.sample.find((u: string) => u.includes("ycombinator"));
    deletedBsky.add(bskyLink.replace(/^https:\/\/bsky\.app\/profile\/([^/]+)\/post\/(.+)$/, "at://$1/app.bsky.feed.post/$2"));
    deletedHn.add(hnLink.split("id=")[1]);
    const second = await (await discourseSplitHandler(req("q=tabs%20or%20SPACES"), src.deps(t0 + CACHE_TTL_MS - 1000))).json();
    expect(second.cached).toBe(true);
    expect(searches()).toBe(2);
    expect(second.sample).not.toContain(bskyLink);
    expect(second.sample).not.toContain(hnLink);
    expect(second.sample.length).toBe(first.sample.length - 2);
    expect(second.sides).toEqual(first.sides);
    const third = await (await discourseSplitHandler(req("q=tabs%20or%20spaces"), src.deps(t0 + CACHE_TTL_MS + 1))).json();
    expect(third.cached).toBe(false);
    expect(searches()).toBe(4);
  });
});

describe("price parity: $0.03 / 30000 everywhere", () => {
  it("config, route config, catalog, MCP, demo, llms.txt, openapi", () => {
    expect(DISCOURSE_SPLIT_PRICE_USD).toBe("$0.03");
    expect(DISCOURSE_SPLIT_PRICE_ATOMIC).toBe("30000");
    const rc = (discourseSplitRouteConfig() as Record<string, { accepts: { price: unknown } | { price: unknown }[] }>)["/api/discourse/split"];
    const accepts = Array.isArray(rc.accepts) ? rc.accepts : [rc.accepts];
    expect(accepts[0].price).toBe("$0.03");
    const live = LIVE_PAID_ROUTES.find((r) => r.path.startsWith("/api/discourse/split"));
    expect(live).toMatchObject({ priceUsd: "$0.03", priceAtomic: "30000", method: "GET" });
    expect(TOOLS.find((t) => t.name === "discourse_split")?.opts.maxAmountRequired).toBe("30000");
    expect(DEMO_ROUTES.find((d) => d.route === "discourse-split")?.priceUsd).toBe("$0.03");
    const llms = readFileSync(path.join(ROOT, "public", "llms.txt"), "utf8");
    expect(llms).toMatch(/\| GET \| \/api\/discourse\/split\?q=…[^|]*\| \$0\.03 \| 30000 \|/);
    const oa = JSON.parse(readFileSync(path.join(ROOT, "public", "openapi.json"), "utf8"));
    const op = oa.paths["/api/discourse/split"].get;
    expect(JSON.stringify(op)).toContain("30000");
    expect(ROUTE_METADATA["/api/discourse/split"].description.length).toBeLessThanOrEqual(500);
    expect(ROUTE_METADATA["/api/discourse/split"].description).toContain("NOT a poll");
  });

  it("well-known x402 lists the route", async () => {
    const wk = await import("@/app/.well-known/x402/route");
    const body = await wk.GET().json();
    expect(body.resources).toContain("GET https://horizonpulse.dev/api/discourse/split");
  });

  it("free demo serves the canned sample at both demo paths without running sources", async () => {
    const flat = await import("@/app/api/demo/[route]/route");
    const slash = await import("@/app/api/demo/discourse/[op]/route");
    const a = await (await flat.GET(new NextRequest("https://horizonpulse.dev/api/demo/discourse-split"), { params: Promise.resolve({ route: "discourse-split" }) })).json();
    const b = await (await slash.GET(new NextRequest("https://horizonpulse.dev/api/demo/discourse/split"), { params: Promise.resolve({ op: "split" }) })).json();
    for (const d of [a, b]) {
      expect(d.demo).toBe(true);
      expect(d.paid_endpoint).toBe("https://horizonpulse.dev/api/discourse/split");
      expect(d.sample.label).toBe(DISCOURSE_LABEL);
      expect(d.sample.illustrative).toBe(true);
    }
  });
});

describe("cost bound (design estimate)", () => {
  it("200 posts x 280 chars stays well under $0.02 at small-model list prices", () => {
    // Example small-model rates in USD per 1M tokens (input, output); UNVERIFIED list prices.
    expect(estimateCostUsd(200, 280, 0.15, 0.6)).toBeLessThan(0.02);
    expect(estimateCostUsd(200, 280, 0.5, 2.0)).toBeLessThan(0.02);
  });
});

describe("four-rail 402 at $0.03", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("unpaid GET lists Base, Solana, XRPL RLUSD and Polygon, each at $0.03", async () => {
    resetXrplRailForTests();
    resetSolanaRailForTests();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    installXrplFacilitators();
    installRpc("present");
    vi.unstubAllEnvs();
    vi.stubEnv("HP_SOLANA_ENABLED", "true");
    vi.stubEnv("HP_SOLANA_PAYTO", SOLANA_PAYTO);
    stubXrplOn({}, true, "ready", true);
    vi.stubEnv("HP_POLYGON_ENABLED", "true");
    vi.stubEnv("HP_POLYGON_NETWORK", "eip155:137");
    vi.stubEnv("HP_POLYGON_PAYTO", DEFAULT_PAY_TO);
    for (const cdp of [true, false]) {
      setCdp(cdp);
      const route = await import("@/app/api/discourse/split/route");
      const res = await route.GET(new NextRequest("https://horizonpulse.dev/api/discourse/split", { headers: { accept: "application/json" } }));
      expect(res.status).toBe(402);
      const accepts = decodePaymentRequiredHeader(res.headers.get("payment-required")!).accepts;
      const nets = accepts.map((a) => a.network);
      expect(nets[0]).toBe("eip155:8453");
      expect(nets[1]).toBe("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
      expect(nets.some((n) => n.startsWith("xrpl:"))).toBe(true);
      // Polygon is appended only with CDP keys (lib/polygon-config.ts).
      if (cdp) expect(nets).toContain("eip155:137");
      for (const a of accepts) expect(a.amount).toBe(a.network.startsWith("xrpl:") ? "0.03" : "30000");
    }
  });
});
