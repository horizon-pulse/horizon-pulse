import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import * as config from "@/lib/config";
import { HINT_KEY, RELATED, relatedHint, relatedRoutesDocument, ROUTE_INFO, withRelatedRoutes } from "@/lib/route-hints";
import { LIVE_PAID_ROUTES } from "@/lib/live-catalog";
import { GET as wellKnownRelated } from "@/app/.well-known/related-routes/route";
import { createX402GetHandler, pulseRouteConfig } from "@/lib/x402-server";
import { paymentOpts as pulseOpts } from "@/app/api/pulse/handler";
import { installFacilitatorMock } from "./helpers/facilitator-mock";
import { CDP_ENV } from "./helpers/capture";

const settle = Buffer.from(JSON.stringify({ success: true, transaction: "0xabc", network: "eip155:8453", payer: "0x1" })).toString("base64");
const paidJson = (body: string, extra: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers: { "content-type": "application/json", "payment-response": settle, "content-length": String(body.length), ...extra } });

describe("route hints map", () => {
  it("covers every live paid route, 2-3 related routes each (grocery pair: 1), all live, never itself", () => {
    const live = new Set(LIVE_PAID_ROUTES.map((r) => r.path.split("?")[0]));
    expect(new Set(Object.keys(ROUTE_INFO))).toEqual(live);
    expect(new Set(Object.keys(RELATED))).toEqual(live);
    for (const [p, rel] of Object.entries(RELATED)) {
      expect(rel.length, p).toBeGreaterThanOrEqual(p.startsWith("/api/grocery/") ? 1 : 2);
      expect(rel.length, p).toBeLessThanOrEqual(3);
      for (const r of rel) {
        expect(live.has(r), `${p} -> ${r}`).toBe(true);
        expect(r).not.toBe(p);
      }
    }
  });
  it("prices equal the live catalog price for every route (read from config, not typed)", () => {
    for (const r of LIVE_PAID_ROUTES) {
      const p = r.path.split("?")[0];
      expect(ROUTE_INFO[p].price, p).toBe((r as { priceUsd?: string; price?: string }).priceUsd ?? (r as { price?: string }).price);
    }
    const prices = new Set<string>((Object.values(config) as unknown[]).filter((v): v is string => typeof v === "string" && /^\$\d/.test(v)));
    for (const i of Object.values(ROUTE_INFO)) expect(prices.has(i.price)).toBe(true);
  });
  it("/.well-known/related-routes serves the same map", async () => {
    const body = await wellKnownRelated().json();
    expect(body).toEqual(JSON.parse(JSON.stringify(relatedRoutesDocument())));
    expect(body.routes.length).toBe(Object.keys(ROUTE_INFO).length);
  });
});

describe("withRelatedRoutes", () => {
  it("splices the hint into a settled 2xx JSON object, keeping every original byte and header", async () => {
    const orig = '{"source":"pulse","n":12345678901234567890,"nested":{"a":1}}';
    const res = await withRelatedRoutes("/api/pulse", "GET", paidJson(orig, { "x-hp-poll-interval-seconds": "60" }));
    const text = await res.text();
    expect(text.startsWith(orig.slice(0, -1) + ",")).toBe(true);
    expect(text).toContain("12345678901234567890");
    const j = JSON.parse(text);
    expect(j[HINT_KEY]).toEqual(relatedHint("/api/pulse"));
    expect(j[HINT_KEY].routes.map((r: { path: string }) => r.path)).toEqual(["/api/signals", "/api/funding", "/api/gas"]);
    expect(res.headers.get("payment-response")).toBe(settle);
    expect(res.headers.get("x-hp-poll-interval-seconds")).toBe("60");
    expect(res.headers.get("content-length")).toBeNull();
    expect(res.status).toBe(200);
  });
  it("empty object body gets no stray comma", async () => {
    const j = JSON.parse(await (await withRelatedRoutes("/api/gas", "GET", paidJson("{}"))).text());
    expect(Object.keys(j)).toEqual([HINT_KEY]);
  });
  it("untouched: unpaid 402, unsettled 200, errors, HEAD, non-JSON, arrays, existing key, unknown route, bad JSON", async () => {
    const cases: [string, string, Response][] = [
      ["/api/pulse", "GET", new Response('{"x402Version":2}', { status: 402, headers: { "content-type": "application/json" } })],
      ["/api/pulse", "GET", new Response("{}", { status: 200, headers: { "content-type": "application/json" } })],
      ["/api/pulse", "GET", new Response("{}", { status: 502, headers: { "content-type": "application/json", "payment-response": settle } })],
      ["/api/pulse", "HEAD", paidJson("{}")],
      ["/api/screenshot", "GET", new Response("PNG", { status: 200, headers: { "content-type": "image/png", "payment-response": settle } })],
      ["/api/pulse", "GET", paidJson("[1,2]")],
      ["/api/pulse", "GET", paidJson('{"relatedRoutes":1}')],
      ["/api/nope", "GET", paidJson("{}")],
      ["/api/pulse", "GET", paidJson("{not json")],
    ];
    for (const [p, m, res] of cases) expect(await withRelatedRoutes(p, m, res)).toBe(res);
  });
});

describe("hint through the real paid handler (Base via mocked CDP; nothing signed or sent)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  it("settled 200 carries relatedRoutes + the original body; unpaid 402 does not", async () => {
    for (const [k, v] of Object.entries(CDP_ENV)) vi.stubEnv(k, v);
    // Route log opt-in for this test only: Upstash calls go to a stub, never the network.
    vi.stubEnv("HP_ROUTE_LOG_IN_TESTS", "true");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example-upstash.test");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "t");
    const upstash = vi.fn(async (..._a: unknown[]) => new Response(JSON.stringify({ result: 1 }), { status: 200 }));
    vi.stubGlobal("fetch", upstash);
    installFacilitatorMock({
      verify: () => ({ isValid: true, payer: `0x${"11".repeat(20)}` }),
      settle: (_u, _p, r) => ({ success: true, transaction: `0x${"ab".repeat(32)}`, network: r.network, payer: `0x${"11".repeat(20)}` }),
    });
    const handler = createX402GetHandler(async () => NextResponse.json({ ok: true, v: 1 }), pulseRouteConfig(), pulseOpts);
    const url = "https://horizonpulse.dev/api/pulse";
    const unpaid = await handler(new NextRequest(url, { headers: { accept: "application/json" } }));
    expect(unpaid.status).toBe(402);
    expect(await unpaid.text()).not.toContain(HINT_KEY);
    const { decodePaymentRequiredHeader, encodePaymentSignatureHeader } = await import("@x402/core/http");
    const a = decodePaymentRequiredHeader(unpaid.headers.get("payment-required")!).accepts[0];
    const payload = {
      x402Version: 2,
      accepted: a,
      payload: {
        signature: `0x${"cd".repeat(65)}`,
        authorization: { from: `0x${"11".repeat(20)}`, to: a.payTo, value: a.amount, validAfter: "0", validBefore: "9999999999", nonce: `0x${"00".repeat(32)}` },
      },
    };
    const paid = await handler(
      new NextRequest(url, { headers: { accept: "application/json", "payment-signature": encodePaymentSignatureHeader(payload as never) } }),
    );
    expect(paid.status).toBe(200);
    expect(paid.headers.get("payment-response")).toBeTruthy();
    const j = await paid.json();
    expect(j.ok).toBe(true);
    expect(j.v).toBe(1);
    expect(j[HINT_KEY].routes.length).toBe(3);
    await new Promise((r) => setTimeout(r, 10));
    const cmds = upstash.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)) as string[]);
    const outcomes = cmds.map((c) => c[3 + Number(c[2])]);
    expect(outcomes).toEqual(["/api/pulse|GET|402_unpaid", "/api/pulse|GET|paid_settled"]);
    const paidCmd = cmds[1];
    expect(paidCmd[2]).toBe("4");
    expect(paidCmd[5]).toMatch(/^hp:rl:p:\d{4}-\d{2}-\d{2}$/);
    expect(paidCmd[6]).toBe(`hp:rl:tx:0x${"ab".repeat(32)}`);
    // End-to-end: the real route + facilitator settle produce the payer-free per-route paid counter.
    expect(paidCmd.slice(12)).toEqual(["/api/pulse|eip155:8453|calls", "/api/pulse|eip155:8453|atomic", pulseOpts.maxAmountRequired]);
    expect(JSON.parse(paidCmd[8])).toMatchObject({ route: "/api/pulse", outcome: "paid_settled", rail: "eip155:8453", amount: pulseOpts.maxAmountRequired, payer: `0x${"11".repeat(20)}` });
    vi.unstubAllGlobals();
  });
});
