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
  it("404 on every verb unless HP_BATCH_ENABLED is exactly 'true'; never in the live catalog", async () => {
    for (const v of [undefined, "1", "TRUE", "yes"]) {
      vi.unstubAllEnvs();
      if (v !== undefined) vi.stubEnv("HP_BATCH_ENABLED", v);
      expect(batchEnabled()).toBe(false);
      expect((await route.POST(post({ items: [{ route: "gas" }] }))).status).toBe(404);
      expect((await route.GET(new NextRequest("https://horizonpulse.dev/api/batch"))).status).toBe(404);
      expect((await route.OPTIONS()).status).toBe(404);
    }
    expect(LIVE_PAID_ROUTES.some((r) => r.path.startsWith("/api/batch"))).toBe(false);
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
