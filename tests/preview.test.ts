import { describe, it, expect, vi, afterEach } from "vitest";
import { buildPreview, PreviewError, MAX_PROBES } from "@/lib/preview/engine";
import { MemoryPreviewStore, UpstashPreviewStore, RETENTION_MS, getPreviewStore, setPreviewStoreForTests, type PreviewStore } from "@/lib/preview/store";
import { priceUsage, spendCaps, DAILY_CAP_CEILING_USD, MONTHLY_CAP_CEILING_USD } from "@/lib/preview/cost";
import { createOpenAiLlm, inputTokenUpperBound, MAX_INPUT_TOKENS, MAX_INPUT_BYTES, MAX_OUTPUT_TOKENS, LlmError, truncateBytes, type LlmFn } from "@/lib/preview/llm";
import { EXAMPLE_PAY_TO, TEST_LABEL, DISCLAIMERS } from "@/lib/preview/labels";
import { PREVIEW_COPY } from "@/lib/preview/copy";
import { review } from "@/scripts/preview-review";
import { POST, clientIp } from "@/app/api/preview/route";

const out = {
  summary: "Weather API.",
  candidateRoutes: [{ method: "GET" as const, path: "/forecast", reason: "per-call data", suggestedPriceUsd: 0.01 }],
  readinessGaps: ["No OpenAPI descriptions"],
  instructionLikeTextSeen: false,
};
const usage = { inputTokens: 1000, outputTokens: 200 };
const mockLlm: LlmFn = vi.fn(async () => ({ output: out, model: "gpt-4o-mini", usage, usageMissing: false }));
const paths = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`/r${i}`, { get: {} }]));
const fakeFetch = vi.fn(async (u: string) => ({
  ok: true as const, requestedUrl: u, finalUrl: u, status: 200, contentType: "application/json", truncated: false, bytesRead: 10,
  content: u.endsWith("openapi.json") ? JSON.stringify({ paths }) : "{}", format: "json" as const,
}));
const caps1 = { PREVIEW_DAILY_USD_CAP: "1", PREVIEW_MONTHLY_USD_CAP: "15" };
const openAiResp = (content: string, u: unknown) => new Response(JSON.stringify({ choices: [{ message: { content } }], usage: u }));

/** In-process fake of the Upstash REST API (just the commands the store uses). */
function fakeUpstash() {
  const kv = new Map<string, string>();
  const z = new Map<string, Map<string, number>>();
  const calls: string[][] = [];
  const f = vi.fn(async (_u: string, init: RequestInit) => {
    const a = JSON.parse(String(init.body)) as string[];
    calls.push(a);
    const [c, k] = [a[0]!.toUpperCase(), a[1]!];
    let result: unknown = null;
    if (c === "SET") {
      const nx = a.includes("NX"), xx = a.includes("XX");
      if ((nx && kv.has(k)) || (xx && !kv.has(k))) result = null;
      else (kv.set(k, a[2]!), (result = "OK"));
    } else if (c === "GET") result = kv.get(k) ?? null;
    else if (c === "INCR") (kv.set(k, String(Number(kv.get(k) ?? 0) + 1)), (result = Number(kv.get(k))));
    else if (c === "INCRBYFLOAT") (kv.set(k, String(Number(kv.get(k) ?? 0) + Number(a[2]))), (result = kv.get(k)));
    else if (c === "PEXPIRE") result = 1;
    else if (c === "ZADD") (z.set(k, z.get(k) ?? new Map()), z.get(k)!.set(a[3]!, Number(a[2])), (result = 1));
    else if (c === "ZRANGE") result = [...(z.get(k) ?? new Map()).entries()].sort((x, y) => x[1] - y[1]).map((e) => e[0]);
    else if (c === "ZREMRANGEBYSCORE") result = 0;
    return new Response(JSON.stringify({ result }));
  });
  return { f, calls, kv };
}

afterEach(() => setPreviewStoreForTests(undefined));

describe("x402 preview: report", () => {
  it("builds a review-queued report with code-written labels and reconciled cost", async () => {
    const store = new MemoryPreviewStore();
    const r = await buildPreview({ url: "https://api.example.com/openapi.json" }, { llm: mockLlm, store, fetchUrl: fakeFetch as never, env: caps1 });
    expect(r.status).toBe("pending_review");
    expect(r.sample402.json.accepts[0]!.payTo).toBe(EXAMPLE_PAY_TO);
    expect(r.sample402.label).toMatch(/EXAMPLE/);
    expect(r.demo.label).toBe(TEST_LABEL);
    expect(r.candidateRoutes[0]!.priceLabel).toBe("UNTESTED");
    expect(r.cost.usd).toBeCloseTo((1000 * 0.15 + 200 * 0.6) / 1e6, 6);
    expect(r.probes.length).toBe(MAX_PROBES);
    expect(await store.listReports("pending_review")).toHaveLength(1);
    // reservation reconciled down to the real cost
    expect((await store.getSpend()).day).toBeCloseTo(r.cost.usd, 9);
  });
  it("stores consented contact with the report", async () => {
    const store = new MemoryPreviewStore();
    const r = await buildPreview({ docs: "x", contact: { email: "a@b.co", consent: true, consentAt: 1 } }, { llm: mockLlm, store, env: caps1 });
    expect((await store.getReport(r.id))!.contact!.email).toBe("a@b.co");
  });
  it("retention: reports disappear after 30 days", async () => {
    let now = Date.now();
    const store = new MemoryPreviewStore(() => now);
    await store.putReport({ id: "a", createdAt: now, status: "pending_review", report: {} });
    now += RETENTION_MS + 1;
    expect(await store.listReports()).toHaveLength(0);
  });
});

describe("blocker 1: caps via atomic reservation", () => {
  it("refuses before calling the LLM when the worst case would cross the daily cap", async () => {
    const store = new MemoryPreviewStore();
    await store.reserveSpend(0.999, { dailyUsd: 1, monthlyUsd: 15 });
    const llm = vi.fn(mockLlm);
    await expect(buildPreview({ docs: "x" }, { llm, store, env: caps1 })).rejects.toBeInstanceOf(PreviewError);
    expect(llm).not.toHaveBeenCalled();
    expect((await store.getSpend()).day).toBeCloseTo(0.999, 9); // failed reservation rolled back
  });
  it("monthly cap also enforced", async () => {
    const now = new Date("2026-10-02T00:00:00Z");
    const store = new MemoryPreviewStore();
    await store.reserveSpend(4.9995, { dailyUsd: 100, monthlyUsd: 100 }, new Date("2026-10-01T00:00:00Z"));
    await expect(buildPreview({ docs: "x" }, { llm: mockLlm, store, now, env: { PREVIEW_MONTHLY_USD_CAP: "5", PREVIEW_DAILY_USD_CAP: "5" } })).rejects.toMatchObject({ code: "spend_cap" });
  });
  it("concurrent requests cannot all pass: only as many as the cap allows reach the LLM", async () => {
    const store = new MemoryPreviewStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const llm = vi.fn(async () => (await gate, { output: out, model: "gpt-4o-mini", usage, usageMissing: false }));
    const docs = "y".repeat(MAX_INPUT_BYTES);
    const worst = priceUsage("gpt-4o-mini", { inputTokens: inputTokenUpperBound(docs, ""), outputTokens: MAX_OUTPUT_TOKENS }).usd;
    const cap = worst * 3.5; // room for exactly 3 in-flight reservations
    const env = { PREVIEW_DAILY_USD_CAP: String(cap), PREVIEW_MONTHLY_USD_CAP: "15" };
    const runs = Array.from({ length: 10 }, () => buildPreview({ docs }, { llm, store, env }).then(() => "ok", (e) => (e as PreviewError).code));
    await new Promise((r) => setTimeout(r, 10));
    expect(llm).toHaveBeenCalledTimes(3); // all 3 reserved before any finished
    release();
    const res = await Promise.all(runs);
    expect(res.filter((x) => x === "ok")).toHaveLength(3);
    expect(res.filter((x) => x === "spend_cap")).toHaveLength(7);
  });
  it("Upstash adapter: reserves with INCRBYFLOAT before the call, reconciles after, rolls back over cap", async () => {
    const u = fakeUpstash();
    const store = new UpstashPreviewStore("https://x.upstash.io", "t", u.f as never);
    let seenBeforeCall = false;
    const llm: LlmFn = async (...a) => {
      seenBeforeCall = u.calls.some((c) => c[0] === "INCRBYFLOAT" && Number(c[2]) > 0);
      return mockLlm(...a);
    };
    const r = await buildPreview({ docs: "x" }, { llm, store, env: caps1 });
    expect(seenBeforeCall).toBe(true);
    expect((await store.getSpend()).day).toBeCloseTo(r.cost.usd, 9);
    const no = await store.reserveSpend(2, { dailyUsd: 1, monthlyUsd: 15 });
    expect(no.ok).toBe(false);
    expect((await store.getSpend()).day).toBeCloseTo(r.cost.usd, 9);
    expect(u.calls.filter((c) => c[0] === "PEXPIRE").length).toBeGreaterThan(0);
  });
  it("Upstash rate limit: SET NX PX then INCR (expiry always set)", async () => {
    const u = fakeUpstash();
    const store = new UpstashPreviewStore("https://x.upstash.io", "t", u.f as never);
    for (let i = 1; i <= 4; i++) expect(await store.hit("ip:1", 1000)).toBe(i);
    expect(u.calls[0]).toEqual(["SET", "hp:preview:rl:ip:1", "0", "NX", "PX", "1000"]);
    expect(u.calls[1]).toEqual(["INCR", "hp:preview:rl:ip:1"]);
  });
  it("Upstash reports: 30-day PX TTL; approve keeps TTL", async () => {
    const u = fakeUpstash();
    const store = new UpstashPreviewStore("https://x.upstash.io", "t", u.f as never);
    await store.putReport({ id: "a", createdAt: Date.now(), status: "pending_review", report: {} });
    const px = Number(u.calls[0]![4]);
    expect(u.calls[0]![3]).toBe("PX");
    expect(px).toBeGreaterThan(RETENTION_MS - 5000);
    expect(px).toBeLessThanOrEqual(RETENTION_MS);
    await store.setStatus("a", "approved");
    expect(u.calls.at(-1)).toContain("KEEPTTL");
  });
});

describe("blocker 2: uncounted cost", () => {
  it("schema failure still records billed usage (not $0, not refunded)", async () => {
    const store = new MemoryPreviewStore();
    const f = vi.fn(async () => openAiResp(JSON.stringify({ ...out, extra: 1 }), { prompt_tokens: 2000, completion_tokens: 300 }));
    const llm = createOpenAiLlm({ OPENAI_API_KEY: "sk-test" }, f as never);
    await expect(buildPreview({ docs: "x" }, { llm, store, env: caps1 })).rejects.toMatchObject({ code: "llm_failed" });
    expect((await store.getSpend()).day).toBeCloseTo(priceUsage("gpt-4o-mini", { inputTokens: 2000, outputTokens: 300 }).usd, 9);
  });
  it("bad JSON without usage keeps the worst-case reservation", async () => {
    const store = new MemoryPreviewStore();
    const f = vi.fn(async () => openAiResp("not json", undefined));
    const llm = createOpenAiLlm({ OPENAI_API_KEY: "sk-test" }, f as never);
    await expect(buildPreview({ docs: "x" }, { llm, store, env: caps1 })).rejects.toBeInstanceOf(PreviewError);
    const worst = priceUsage("gpt-4o-mini", { inputTokens: inputTokenUpperBound("x", ""), outputTokens: MAX_OUTPUT_TOKENS }).usd;
    expect((await store.getSpend()).day).toBeCloseTo(worst, 9);
  });
  it("valid output but missing usage is billed at worst case, flagged usageMissing", async () => {
    const store = new MemoryPreviewStore();
    const f = vi.fn(async () => openAiResp(JSON.stringify(out), {}));
    const llm = createOpenAiLlm({ OPENAI_API_KEY: "sk-test" }, f as never);
    const r = await buildPreview({ docs: "x" }, { llm, store, env: caps1 });
    expect(r.cost.usageMissing).toBe(true);
    expect(r.cost.usd).toBeGreaterThan(0);
    expect(r.cost.outputTokens).toBe(MAX_OUTPUT_TOKENS);
  });
  it("missing key (never reached provider) releases the reservation", async () => {
    const store = new MemoryPreviewStore();
    await expect(buildPreview({ docs: "x" }, { llm: createOpenAiLlm({}, vi.fn() as never), store, env: caps1 })).rejects.toBeInstanceOf(PreviewError);
    expect((await store.getSpend()).day).toBeCloseTo(0, 9);
  });
  it("LLM call: no tools, strict schema, key not leaked", async () => {
    const f = vi.fn(async (_u: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body));
      expect(b.tools).toBeUndefined();
      expect(b.response_format.json_schema.strict).toBe(true);
      return openAiResp("{", {});
    });
    const e = await createOpenAiLlm({ OPENAI_API_KEY: "sk-test" }, f as never)("d", "p").catch((x) => x);
    expect(e).toBeInstanceOf(LlmError);
    expect(String(e.message)).not.toContain("sk-test");
  });
});

describe("blocker 3: worst case", () => {
  it("static worst case covers 50k-byte docs + system + schema + probes", () => {
    expect(MAX_INPUT_TOKENS).toBeGreaterThan(MAX_INPUT_BYTES + 5 * 200);
    expect(inputTokenUpperBound("é".repeat(60_000), "")).toBeLessThanOrEqual(MAX_INPUT_TOKENS);
  });
  it("docs are capped by UTF-8 bytes without splitting characters", () => {
    const t = truncateBytes("😀".repeat(20_000), MAX_INPUT_BYTES);
    expect(new TextEncoder().encode(t).length).toBeLessThanOrEqual(MAX_INPUT_BYTES);
    expect(t).not.toMatch(/[\uD800-\uDBFF]$/);
  });
});

describe("caps ceiling + prices", () => {
  it("env overrides cannot exceed $5/day or $20/month", () => {
    expect(spendCaps({ PREVIEW_DAILY_USD_CAP: "999", PREVIEW_MONTHLY_USD_CAP: "999" })).toEqual({ dailyUsd: DAILY_CAP_CEILING_USD, monthlyUsd: MONTHLY_CAP_CEILING_USD });
    expect(spendCaps({})).toEqual({ dailyUsd: 1, monthlyUsd: 15 });
    expect(spendCaps({ PREVIEW_DAILY_USD_CAP: "0.5" }).dailyUsd).toBe(0.5);
  });
  it("cost meter rejects unknown model", () => {
    expect(() => priceUsage("nope", { inputTokens: 1, outputTokens: 1 })).toThrow();
  });
});

describe("route", () => {
  const req = (body: unknown, h: Record<string, string> = {}) =>
    new Request("https://x/api/preview", { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(body) });
  afterEach(() => vi.unstubAllEnvs());
  it("disabled by default", async () => {
    vi.stubEnv("PREVIEW_ENABLED", "");
    expect((await POST(req({ docs: "x" }))).status).toBe(503);
  });
  it("fails closed when enabled without a shared store", async () => {
    vi.stubEnv("PREVIEW_ENABLED", "1");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    vi.stubEnv("KV_REST_API_URL", "");
    vi.stubEnv("KV_REST_API_TOKEN", "");
    expect(getPreviewStore()).toBeNull();
    const r = await POST(req({ docs: "x" }));
    expect(r.status).toBe(503);
    expect((await r.json()).error).toBe("store_not_configured");
  });
  it("uses x-real-ip, not x-forwarded-for", () => {
    expect(clientIp(req({}, { "x-real-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9" }))).toBe("1.2.3.4");
  });
  it("email requires explicit consent", async () => {
    vi.stubEnv("PREVIEW_ENABLED", "1");
    setPreviewStoreForTests(new MemoryPreviewStore());
    const r = await POST(req({ docs: "x", email: "a@b.co" }, { "x-real-ip": "5.5.5.5" }));
    expect((await r.json()).error).toBe("consent_required");
  });
  it("per-IP rate limit", async () => {
    vi.stubEnv("PREVIEW_ENABLED", "1");
    setPreviewStoreForTests(new MemoryPreviewStore());
    let last = 0;
    for (let i = 0; i < 4; i++) last = (await POST(req({}, { "x-real-ip": "7.7.7.7" }))).status;
    expect(last).toBe(429);
  });
});

describe("review script", () => {
  it("lists, shows, approves without sending", async () => {
    const store: PreviewStore = new MemoryPreviewStore();
    await store.putReport({ id: "r1", createdAt: Date.now(), status: "pending_review", contact: { email: "a@b.co", consent: true, consentAt: 1 }, report: { s: 1 } });
    const log: string[] = [];
    const L = (s: string) => log.push(s);
    expect(await review(store, ["list"], L)).toBe(0);
    expect(log[0]).toContain("r1");
    expect(await review(store, ["approve", "r1"], L)).toBe(0);
    expect(log.at(-1)).toMatch(/NOT SENT: send by hand to a@b.co/);
    expect((await store.getReport("r1"))!.status).toBe("approved");
    expect(await review(store, ["show", "nope"], L)).toBe(1);
  });
});

describe("copy", () => {
  it("page copy follows wording rules and is agent-first", () => {
    const t = (JSON.stringify(PREVIEW_COPY) + JSON.stringify(DISCLAIMERS)).toLowerCase();
    for (const bad of ["signals", "open-source", "open source", "customers", "revenue", "rank", "before anything is sent"]) expect(t).not.toContain(bad);
    expect(t).toContain("untested");
    expect(PREVIEW_COPY.h1).toMatch(/payable by AI agents/);
    expect(PREVIEW_COPY.chip).toContain("(draft)");
  });
});
