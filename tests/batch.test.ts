import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { BATCH_MAX_ITEMS, BATCH_PRICE_ATOMIC, BATCH_PRICE_USD, getPayTo } from "@/lib/config";
import { batchEnabled, BATCH_ROUTES, parseBatchBody } from "@/lib/batch";
import { batchHandler } from "@/app/api/batch/handler";
import * as route from "@/app/api/batch/route";
import { batchRouteConfig } from "@/lib/x402-server";
import { LIVE_PAID_ROUTES } from "@/lib/live-catalog";
import { CDP_ENV } from "./helpers/capture";

const post = (body: unknown) =>
  new NextRequest("https://horizonpulse.dev/api/batch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function fakeHandlers(fail: Set<string> = new Set()) {
  const seen: string[] = [];
  const mk = (name: string) => async (req: NextRequest) => {
    seen.push(`${name}?${req.nextUrl.searchParams.toString()}`);
    return fail.has(name)
      ? NextResponse.json({ ok: false, error: "rpc down", charged: false }, { status: 502 })
      : NextResponse.json({ source: name, priced: { amountUsd: "$0.002" }, value: 1 });
  };
  return { seen, handlers: Object.fromEntries(Object.keys(BATCH_ROUTES).map((k) => [k, mk(k)])) };
}

describe("/api/batch input", () => {
  it("accepts 1..10 items over the six $0.002-tier routes with their own query keys only", () => {
    expect(Object.keys(BATCH_ROUTES)).toEqual(["balance", "gas", "tx-status", "token/meta", "chain/head", "name/resolve"]);
    expect(parseBatchBody({ items: [{ route: "/api/chain/head", params: { network: "base" } }, { route: "gas" }] })).toEqual({
      ok: true,
      items: [
        { route: "chain/head", params: { network: "base" } },
        { route: "gas", params: {} },
      ],
    });
    for (const bad of [
      null,
      [],
      { items: [] },
      { items: Array.from({ length: BATCH_MAX_ITEMS + 1 }, () => ({ route: "gas" })) },
      { items: [{ route: "fetch" }] },
      { items: [{ route: "balance", params: { url: "x" } }] },
      { items: [{ route: "balance", params: { evm: 1 } }] },
      { items: [{ route: "balance", params: { evm: "x".repeat(257) } }] },
    ]) {
      expect(parseBatchBody(bad).ok, JSON.stringify(bad)?.slice(0, 80)).toBe(false);
    }
  });
});

describe("/api/batch prototype keys (Odin C2)", () => {
  const PROTO = ["constructor", "__proto__", "toString", "hasOwnProperty", "/api/constructor"];
  it("parseBatchBody rejects inherited Object.prototype names as routes", () => {
    for (const route of PROTO) {
      const r = parseBatchBody({ items: [{ route }] });
      expect(r, route).toEqual(expect.objectContaining({ ok: false, code: "unsupported_route" }));
    }
    // JSON-parsed "__proto__" is an own key on the item, not the prototype
    const parsed = JSON.parse('{"items":[{"route":"__proto__"},{"route":"gas","params":{"__proto__":"x"}}]}');
    expect(parseBatchBody(parsed).ok).toBe(false);
  });
  it("handler answers 400 (not 500) and runs nothing for constructor, __proto__, toString", async () => {
    const { seen, handlers } = fakeHandlers();
    for (const route of PROTO) {
      const res = await batchHandler(post({ items: [{ route }] }), handlers);
      expect(res.status, route).toBe(400);
      expect((await res.json()).code).toBe("unsupported_route");
    }
    const raw = new NextRequest("https://horizonpulse.dev/api/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"items":[{"route":"__proto__"}]}',
    });
    expect((await batchHandler(raw, handlers)).status).toBe(400);
    expect(seen).toEqual([]);
  });
  it("HANDLERS lookup ignores inherited keys even if parsing were bypassed", async () => {
    const { runBatch } = await import("@/lib/batch");
    const handlers: Record<string, (r: NextRequest) => Promise<Response>> = {};
    const call = async (route: string, q: URLSearchParams) =>
      Object.hasOwn(handlers, route) ? handlers[route](new NextRequest(`https://horizonpulse.dev/api/${route}?${q}`)) : NextResponse.json({}, { status: 400 });
    const out = await runBatch([{ route: "constructor", params: {} }, { route: "toString", params: {} }], call);
    expect(out.map((r) => r.status)).toEqual([400, 400]);
  });
});

describe("/api/batch handler", () => {
  it("runs each item through its single-route handler, strips per-item priced/charged, one priced block", async () => {
    const { seen, handlers } = fakeHandlers();
    const res = await batchHandler(post({ items: [{ route: "balance", params: { evm: "0xabc" } }, { route: "gas" }] }), handlers);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(seen).toEqual(["balance?evm=0xabc", "gas?"]);
    expect(j.priced.amountUsd).toBe(BATCH_PRICE_USD);
    expect(j.priced.amountAtomic).toBe(BATCH_PRICE_ATOMIC);
    expect(j.priced.payTo).toBe(getPayTo());
    expect(j.count).toBe(2);
    expect(j.okCount).toBe(2);
    for (const r of j.results) {
      expect(r.body.priced).toBeUndefined();
      expect(r.body.charged).toBeUndefined();
    }
  });
  it("GET ?items=<json> runs the same items", async () => {
    const { seen, handlers } = fakeHandlers();
    const q = encodeURIComponent(JSON.stringify([{ route: "chain/head", params: { network: "base" } }]));
    const res = await batchHandler(new NextRequest(`https://horizonpulse.dev/api/batch?items=${q}`), handlers);
    expect(res.status).toBe(200);
    expect(seen).toEqual(["chain/head?network=base"]);
    expect((await batchHandler(new NextRequest("https://horizonpulse.dev/api/batch?items=%7Bbad"), handlers)).status).toBe(400);
  });
  it("partial failure is 200 (charged once); all failing is 502 and bad input 400 (never settle)", async () => {
    const part = await batchHandler(post({ items: [{ route: "gas" }, { route: "balance", params: { evm: "0x1" } }] }), fakeHandlers(new Set(["balance"])).handlers);
    expect(part.status).toBe(200);
    expect((await part.json()).okCount).toBe(1);
    const all = await batchHandler(post({ items: [{ route: "gas" }] }), fakeHandlers(new Set(["gas"])).handlers);
    expect(all.status).toBe(502);
    const { seen, handlers } = fakeHandlers();
    const bad = await batchHandler(post({ items: [{ route: "pdf" }] }), handlers);
    expect(bad.status).toBe(400);
    expect(seen).toEqual([]);
  });
});

describe("/api/batch is inert by default", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("404 on every verb unless HP_BATCH_ENABLED is exactly 'true'; listed once in the live catalog (10/19) at $0.01", async () => {
    for (const v of [undefined, "1", "TRUE", "yes"]) {
      vi.unstubAllEnvs();
      if (v !== undefined) vi.stubEnv("HP_BATCH_ENABLED", v);
      expect(batchEnabled()).toBe(false);
      expect((await route.POST(post({ items: [{ route: "gas" }] }))).status).toBe(404);
      expect((await route.GET(new NextRequest("https://horizonpulse.dev/api/batch"))).status).toBe(404);
      expect((await route.OPTIONS()).status).toBe(404);
    }
    // Listed statically 10/19 (discovery-listing branch): exactly one entry, $0.01 / 10000.
    const listed = LIVE_PAID_ROUTES.filter((r) => r.path.startsWith("/api/batch"));
    expect(listed.map((r) => [r.path, r.priceUsd, r.priceAtomic])).toEqual([["/api/batch", "$0.01", "10000"]]);
  });
  it("when enabled: unpaid POST is a 402 at the proposed price to the pinned payTo; route keys pay every verb", async () => {
    vi.stubEnv("HP_BATCH_ENABLED", "true");
    const res = await route.POST(post({ items: [{ route: "gas" }] }));
    expect(res.status).toBe(402);
    const { decodePaymentRequiredHeader } = await import("@x402/core/http");
    const pr = decodePaymentRequiredHeader(res.headers.get("payment-required")!);
    expect(pr.accepts[0].amount).toBe(BATCH_PRICE_ATOMIC);
    expect(pr.accepts[0].payTo).toBe(getPayTo());
    expect(Object.keys(batchRouteConfig())).toEqual(["GET /api/batch", "POST /api/batch", "/api/batch"]);
    void CDP_ENV;
  });
});

describe("/api/batch discovery listing (10/19)", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("MCP batch tool: $0.01 opts; flag off -> isError (the wrapper never settles on isError)", async () => {
    const { TOOLS } = await import("@/lib/mcp-server");
    const t = TOOLS.find((x) => x.name === "batch");
    expect(t?.opts.maxAmountRequired).toBe("10000");
    expect(t?.opts.resource).toBe("/api/batch");
    for (const v of [undefined, "1", "TRUE"]) {
      vi.unstubAllEnvs();
      if (v !== undefined) vi.stubEnv("HP_BATCH_ENABLED", v);
      const r = await t!.call({ items: [{ route: "gas" }] });
      expect(r.isError).toBe(true);
      expect(JSON.parse(r.content[0].text)).toMatchObject({ ok: false, code: "unavailable", charged: false });
    }
  });
  it("related-routes: batch has its own complements; no other route lists batch (single-route paid bodies unchanged)", async () => {
    const { RELATED, ROUTE_INFO } = await import("@/lib/route-hints");
    expect(ROUTE_INFO["/api/batch"].price).toBe("$0.01");
    expect(RELATED["/api/batch"]).toEqual(["/api/tx-guard", "/api/portfolio"]);
    for (const [p, rel] of Object.entries(RELATED)) if (p !== "/api/batch") expect(rel, p).not.toContain("/api/batch");
  });
});

describe("/api/batch Class A delta (Odin 10/19): value statement + no 404 sample link", () => {
  const info = (resource: string) => ({ resource, description: "d", priceUsd: "$0.01" });
  const paid402 = () => new Response("{}", { status: 402, headers: { "content-type": "application/json" } });
  it("browser 402: batch has no /api/demo link; other routes keep it", async () => {
    const { browser402, NO_DEMO_ROUTES } = await import("@/lib/browser-402");
    expect([...NO_DEMO_ROUTES]).toEqual(["batch"]);
    const b = await browser402(paid402(), info("/api/batch")).text();
    expect(b).not.toContain("/api/demo/");
    expect(b).not.toContain("free fixed-input sample");
    expect(b).toContain('<a href="/llms.txt">Agent docs (llms.txt)</a>');
    for (const r of ["/api/pulse", "/api/gas", "/api/name/resolve"]) {
      const h = await browser402(paid402(), info(r)).text();
      expect(h).toContain(`<p><a href="/api/demo/${r.slice(5)}">See a free fixed-input sample</a> · <a href="/llms.txt">`);
    }
  });
  it("value statement: in openapi, llms.txt, skill.md and the MCP batch description only", async () => {
    const { BATCH_VALUE_NOTE } = await import("@/lib/batch");
    expect(BATCH_VALUE_NOTE).toContain("$0.001 per item vs the $0.002 single-call floor");
    expect(BATCH_VALUE_NOTE).toContain("4 x $0.002 = $0.008");
    const fs = await import("node:fs");
    const spec = JSON.parse(fs.readFileSync("public/openapi.json", "utf8"));
    for (const m of ["get", "post"]) expect(spec.paths["/api/batch"][m].description).toContain(BATCH_VALUE_NOTE);
    expect(fs.readFileSync("public/llms.txt", "utf8")).toContain(BATCH_VALUE_NOTE);
    expect(fs.readFileSync("public/llms.txt", "utf8")).toContain("no free sample for `/api/batch`");
    const { buildSkillMarkdown } = await import("@/lib/agent-skill");
    expect(buildSkillMarkdown()).toContain(BATCH_VALUE_NOTE);
    const { TOOLS, mcpToolDescription } = await import("@/lib/mcp-server");
    for (const t of TOOLS) {
      const d = mcpToolDescription(t.name, t.opts);
      if (t.name === "batch") expect(d).toContain(BATCH_VALUE_NOTE);
      else expect(d).not.toContain("Value: one payment");
    }
    // 402 / Bazaar description (ROUTE_METADATA) is unchanged and stays <= 500 chars.
    const { ROUTE_METADATA } = await import("@/lib/route-metadata");
    expect(ROUTE_METADATA["/api/batch"].description).not.toContain("Value:");
    expect(ROUTE_METADATA["/api/batch"].description.length).toBeLessThanOrEqual(500);
  });
});
