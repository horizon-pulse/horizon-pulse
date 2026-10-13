import { describe, it, expect, vi } from "vitest";
import { buildPreview, PreviewError, MAX_PROBES } from "@/lib/preview/engine";
import { MemoryPreviewStore, RETENTION_MS } from "@/lib/preview/store";
import { priceUsage } from "@/lib/preview/cost";
import { createOpenAiLlm, type LlmFn } from "@/lib/preview/llm";
import { EXAMPLE_PAY_TO, TEST_LABEL } from "@/lib/preview/labels";
import { PREVIEW_COPY } from "@/lib/preview/copy";

const out = {
  summary: "Weather API.",
  candidateRoutes: [{ method: "GET" as const, path: "/forecast", reason: "per-call data", suggestedPriceUsd: 0.01 }],
  readinessGaps: ["No OpenAPI descriptions"],
  instructionLikeTextSeen: false,
};
const mockLlm: LlmFn = vi.fn(async () => ({ output: out, model: "gpt-4o-mini", usage: { inputTokens: 1000, outputTokens: 200 } }));
const paths = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`/r${i}`, { get: {} }]));
const fakeFetch = vi.fn(async (u: string) => ({
  ok: true as const, requestedUrl: u, finalUrl: u, status: 200, contentType: "application/json", truncated: false, bytesRead: 10,
  content: u.endsWith("openapi.json") ? JSON.stringify({ paths }) : "{}", format: "json" as const,
}));

describe("x402 preview", () => {
  it("builds a review-queued report with code-written labels and cost", async () => {
    const store = new MemoryPreviewStore();
    const r = await buildPreview({ url: "https://api.example.com/openapi.json" }, { llm: mockLlm, store, fetchUrl: fakeFetch as never });
    expect(r.status).toBe("pending_review");
    expect(r.sample402.json.accepts[0]!.payTo).toBe(EXAMPLE_PAY_TO);
    expect(r.sample402.label).toMatch(/EXAMPLE/);
    expect(r.demo.label).toBe(TEST_LABEL);
    expect(r.candidateRoutes[0]!.priceLabel).toBe("UNTESTED");
    expect(r.cost.usd).toBeCloseTo((1000 * 0.15 + 200 * 0.6) / 1e6, 9);
    expect(r.probes.length).toBe(MAX_PROBES);
    expect(await store.listReports("pending_review")).toHaveLength(1);
    expect((await store.getSpend()).day).toBeCloseTo(r.cost.usd, 9);
  });
  it("spend guard refuses before calling the LLM", async () => {
    const store = new MemoryPreviewStore();
    await store.addSpend(0.999);
    const llm = vi.fn(mockLlm);
    await expect(buildPreview({ docs: "x" }, { llm, store, env: { PREVIEW_DAILY_USD_CAP: "1" } })).rejects.toBeInstanceOf(PreviewError);
    expect(llm).not.toHaveBeenCalled();
  });
  it("monthly cap also enforced", async () => {
    const store = new MemoryPreviewStore();
    await store.addSpend(4.9995, new Date("2026-10-01T00:00:00Z"));
    await expect(buildPreview({ docs: "x" }, { llm: mockLlm, store, env: { PREVIEW_MONTHLY_USD_CAP: "5", PREVIEW_DAILY_USD_CAP: "5" } })).rejects.toMatchObject({ code: "spend_cap" });
  });
  it("retention purges after 30 days", async () => {
    const store = new MemoryPreviewStore();
    await store.putReport({ id: "a", createdAt: Date.now() - RETENTION_MS - 1, status: "pending_review", report: {} });
    expect(await store.listReports()).toHaveLength(0);
  });
  it("rate-limit counter", async () => {
    const s = new MemoryPreviewStore();
    for (let i = 0; i < 3; i++) await s.hit("ip:1", 1000);
    expect(await s.hit("ip:1", 1000)).toBe(4);
  });
  it("LLM call: no tools, strict schema, key not leaked, bad JSON rejected", async () => {
    const f = vi.fn(async (_u: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body));
      expect(b.tools).toBeUndefined();
      expect(b.response_format.json_schema.strict).toBe(true);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ...out, extra: 1 }) } }], usage: {} }));
    });
    const llm = createOpenAiLlm({ OPENAI_API_KEY: "sk-test" }, f as never);
    await expect(llm("d", "p")).rejects.toThrow();
    await expect(createOpenAiLlm({}, f as never)("d", "p")).rejects.toThrow(/not set/);
  });
  it("cost meter rejects unknown model", () => {
    expect(() => priceUsage("nope", { inputTokens: 1, outputTokens: 1 })).toThrow();
  });
  it("page copy follows wording rules", () => {
    const t = JSON.stringify(PREVIEW_COPY).toLowerCase();
    for (const bad of ["signals", "open-source", "open source", "customers", "revenue", "rank"]) expect(t).not.toContain(bad);
    expect(t).toContain("untested");
  });
});
