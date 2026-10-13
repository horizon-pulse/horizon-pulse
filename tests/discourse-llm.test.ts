import { describe, it, expect, vi } from "vitest";
import { createOpenAiClassifier, reservationUsd, costUsd, classifierFromEnv, inputTokenBound, buildUserMessage, adjustFailureCount, PRIMARY_MODEL, FALLBACK_MODEL, MAX_OUTPUT_TOKENS, MAX_INPUT_TOKENS } from "@/lib/discourse/llm";
import { MemorySpendStore, spendCaps, spendKeys, RESERVE_LUA, UpstashSpendStore } from "@/lib/discourse/spend";

const FAKE_KEY = "sk-test-DO-NOT-LEAK-0123456789";
const env = { DISCOURSE_LLM_API_KEY: FAKE_KEY };
const now = () => new Date("2026-10-13T12:00:00Z");
const caps = { dailyUsd: 1, monthlyUsd: 15 };
const ok = (labels: number[], pt = 1000, ct = 50) =>
  new Response(JSON.stringify({ usage: { prompt_tokens: pt, completion_tokens: ct }, choices: [{ message: { content: JSON.stringify({ labels: labels.map((l, i) => [i, l]) }) } }] }), { status: 200 });

describe("price table + reservation", () => {
  it("gpt-6-luna worst case x1.25 = $0.0034375", () => {
    expect(reservationUsd(PRIMARY_MODEL)).toBeCloseTo(0.0034375, 10);
    expect(reservationUsd(FALLBACK_MODEL)).toBeCloseTo(0.00725, 10);
  });
  it("unpriced model throws", () => expect(() => costUsd("gpt-x", 1, 1)).toThrow());
  it("caps default $1/$15; env can only lower (Math.min(env, default))", () => {
    expect(spendCaps({})).toEqual({ dailyUsd: 1, monthlyUsd: 15 });
    expect(spendCaps({ DISCOURSE_DAILY_USD_CAP: "0.5", DISCOURSE_MONTHLY_USD_CAP: "10" })).toEqual({ dailyUsd: 0.5, monthlyUsd: 10 });
    expect(spendCaps({ DISCOURSE_DAILY_USD_CAP: "0", DISCOURSE_MONTHLY_USD_CAP: "0" })).toEqual({ dailyUsd: 0, monthlyUsd: 0 });
  });
  it("caps: env can never raise above $1/$15 (was: up to $5/$20)", () => {
    expect(spendCaps({ DISCOURSE_DAILY_USD_CAP: "3", DISCOURSE_MONTHLY_USD_CAP: "18" })).toEqual({ dailyUsd: 1, monthlyUsd: 15 });
    expect(spendCaps({ DISCOURSE_DAILY_USD_CAP: "50", DISCOURSE_MONTHLY_USD_CAP: "99" })).toEqual({ dailyUsd: 1, monthlyUsd: 15 });
    expect(spendCaps({ DISCOURSE_DAILY_USD_CAP: "1", DISCOURSE_MONTHLY_USD_CAP: "15" })).toEqual({ dailyUsd: 1, monthlyUsd: 15 });
  });
  it("caps: invalid env falls back to the default", () => {
    expect(spendCaps({ DISCOURSE_DAILY_USD_CAP: "abc", DISCOURSE_MONTHLY_USD_CAP: "-1" })).toEqual({ dailyUsd: 1, monthlyUsd: 15 });
    expect(spendCaps({ DISCOURSE_DAILY_USD_CAP: "Infinity" }).dailyUsd).toBe(1);
  });
  it("keys are UTC day/month", () => expect(spendKeys(now())).toEqual({ day: "hp:discourse:spend:d:2026-10-13", month: "hp:discourse:spend:m:2026-10" }));
});

describe("request shape", () => {
  it("gpt-6-luna, reasoning none, max 1500 output, key only in Authorization", async () => {
    const f = vi.fn(async () => ok([0, 1, -1]));
    const c = createOpenAiClassifier({ env, fetchFn: f as unknown as typeof fetch, store: new MemorySpendStore(caps), now });
    const r = await c.classify("q?", ["yes", "no"], ["a", "b", "c"]);
    expect(r.labels).toEqual([0, 1, -1]);
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("gpt-6-luna");
    expect(body.reasoning_effort).toBe("none");
    expect(body.max_completion_tokens).toBe(MAX_OUTPUT_TOKENS);
    expect(String(init.body)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(r)).not.toContain(FAKE_KEY);
  });
});

describe("reservation + reconcile", () => {
  it("reconciles to usage cost (negative delta)", async () => {
    const s = new MemorySpendStore(caps);
    const c = createOpenAiClassifier({ env, fetchFn: (async () => ok([0], 1000, 100)) as unknown as typeof fetch, store: s, now });
    await c.classify("q", ["a", "b"], ["x"]);
    expect(s.v.get(spendKeys(now()).day)).toBeCloseTo(costUsd(PRIMARY_MODEL, 1000, 100), 12);
  });
  it("missing usage keeps the full reservation", async () => {
    const s = new MemorySpendStore(caps);
    const f = async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"labels":[[0,0]]}' } }] }), { status: 200 });
    await createOpenAiClassifier({ env, fetchFn: f as unknown as typeof fetch, store: s, now }).classify("q", ["a", "b"], ["x"]);
    expect(s.v.get(spendKeys(now()).day)).toBeCloseTo(reservationUsd(PRIMARY_MODEL), 12);
  });
  it("cap reached -> throws, no request made", async () => {
    const f = vi.fn(async () => ok([0]));
    const c = createOpenAiClassifier({ env, fetchFn: f as unknown as typeof fetch, store: new MemorySpendStore({ dailyUsd: 0.001, monthlyUsd: 15 }), now });
    await expect(c.classify("q", ["a", "b"], ["x"])).rejects.toThrow("model_budget_reached");
    expect(f).not.toHaveBeenCalled();
  });
  it("N parallel reservations never exceed the daily cap", async () => {
    const s = new MemorySpendStore(caps);
    const f = async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"labels":[[0,0]]}' } }] }), { status: 200 });
    const c = createOpenAiClassifier({ env, fetchFn: f as unknown as typeof fetch, store: s, now });
    const rs = await Promise.allSettled(Array.from({ length: 400 }, () => c.classify("q", ["a", "b"], ["x"])));
    const okN = rs.filter((r) => r.status === "fulfilled").length;
    expect(okN).toBe(Math.floor(1 / reservationUsd(PRIMARY_MODEL)));
    expect(s.v.get(spendKeys(now()).day)!).toBeLessThanOrEqual(1);
  });
  it("store unreachable -> throws (fail closed), no request", async () => {
    const f = vi.fn(async () => ok([0]));
    const store = { reserve: async () => { throw new Error("down"); }, adjust: async () => undefined };
    await expect(createOpenAiClassifier({ env, fetchFn: f as unknown as typeof fetch, store, now }).classify("q", ["a"], ["x"])).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
  });
});

describe("fallback + errors", () => {
  it("primary HTTP error -> fallback gpt-5.6-luna, primary reservation released", async () => {
    const s = new MemorySpendStore(caps);
    const f = vi.fn().mockResolvedValueOnce(new Response(`{"error":"x ${FAKE_KEY}"}`, { status: 404 })).mockResolvedValueOnce(ok([1], 100, 10));
    const r = await createOpenAiClassifier({ env, fetchFn: f as unknown as typeof fetch, store: s, now }).classify("q", ["a", "b"], ["x"]);
    expect(r.usage.model).toBe("gpt-5.6-luna");
    expect(JSON.parse(String((f.mock.calls[1] as unknown as [string, RequestInit])[1].body)).model).toBe("gpt-5.6-luna");
    expect(s.v.get(spendKeys(now()).day)).toBeCloseTo(costUsd(FALLBACK_MODEL, 100, 10), 12);
  });
  it("both fail -> throws without echoing body or key", async () => {
    const f = async () => new Response(`{"error":"${FAKE_KEY}"}`, { status: 500 });
    const e = await createOpenAiClassifier({ env, fetchFn: f as unknown as typeof fetch, store: new MemorySpendStore(caps), now }).classify("q", ["a"], ["x"]).catch((x) => x);
    expect(String(e.message)).toBe("llm_unavailable");
    expect(String(e.stack)).not.toContain(FAKE_KEY);
  });
  it("out-of-range post number -> bad output", async () => {
    const f = async () => ok([0, 1]);
    await expect(createOpenAiClassifier({ env, fetchFn: f as unknown as typeof fetch, store: new MemorySpendStore(caps), now }).classify("q", ["a"], ["x"])).rejects.toThrow("llm_bad_output");
  });
});

describe("env wiring fails closed", () => {
  it("no key -> null; key without spend store -> null; key+store -> classifier", () => {
    expect(classifierFromEnv({})).toBeNull();
    expect(classifierFromEnv({ DISCOURSE_LLM_API_KEY: FAKE_KEY })).toBeNull();
    expect(classifierFromEnv({ DISCOURSE_LLM_API_KEY: FAKE_KEY, UPSTASH_REDIS_REST_URL: "https://x.upstash.io", UPSTASH_REDIS_REST_TOKEN: "t" })?.name).toBe("openai:gpt-6-luna");
  });
});

describe("Upstash EVAL", () => {
  it("sends one atomic EVAL with both keys and caps", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ result: 1 }), { status: 200 }));
    const s = new UpstashSpendStore("https://x.upstash.io", "tok", caps, f as unknown as typeof fetch);
    expect(await s.reserve(0.0034375, now())).toBe(true);
    const args = JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(args.slice(0, 5)).toEqual(["EVAL", RESERVE_LUA, "2", "hp:discourse:spend:d:2026-10-13", "hp:discourse:spend:m:2026-10"]);
    expect(args.slice(5, 8)).toEqual(["0.00343750", "1.00000000", "15.00000000"]);
  });
  it("result 0 -> refused; HTTP error -> throws", async () => {
    const s0 = new UpstashSpendStore("https://x", "t", caps, (async () => new Response('{"result":0}')) as unknown as typeof fetch);
    expect(await s0.reserve(1, now())).toBe(false);
    const sE = new UpstashSpendStore("https://x", "t", caps, (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch);
    await expect(sE.reserve(1, now())).rejects.toThrow();
  });
});

describe("F1: reservation sized from input bytes", () => {
  const latin = Array.from({ length: 200 }, () => "a".repeat(280));
  const cjk = Array.from({ length: 200 }, () => "\u6f22".repeat(280)); // 3 UTF-8 bytes each
  const emoji = Array.from({ length: 200 }, () => "\u{1F600}".repeat(140)); // 4 bytes, 280 UTF-16 units
  const bound = (t: string[]) => inputTokenBound(buildUserMessage("q?", ["yes", "no"], t));

  it("small Latin input stays at the 20k floor ($0.0034375)", () => {
    expect(bound(["hi"])).toBeLessThan(MAX_INPUT_TOKENS);
    expect(reservationUsd(PRIMARY_MODEL, bound(["hi"]))).toBeCloseTo(0.0034375, 10);
  });
  it("bound >= UTF-8 bytes of the user message (tokens <= bytes)", () => {
    for (const t of [latin, cjk, emoji]) {
      const m = buildUserMessage("q?", ["yes", "no"], t);
      expect(bound(t)).toBeGreaterThanOrEqual(new TextEncoder().encode(m).length);
    }
  });
  it("max CJK input (200 x 280, ~1 token/char) reserves above its worst-case cost", () => {
    const b = bound(cjk);
    expect(b).toBeGreaterThan(168_000);
    const worst = costUsd(PRIMARY_MODEL, 200 * 280 + 2_000, MAX_OUTPUT_TOKENS); // ~1 tok/char + prompt
    expect(reservationUsd(PRIMARY_MODEL, b)).toBeGreaterThan(worst);
    expect(reservationUsd(PRIMARY_MODEL, b)).toBeGreaterThan(reservationUsd(PRIMARY_MODEL));
  });
  it("max emoji input reserves above its worst-case cost", () => {
    const b = bound(emoji);
    expect(b).toBeGreaterThan(112_000);
    const worst = costUsd(PRIMARY_MODEL, 200 * 280 + 2_000, MAX_OUTPUT_TOKENS);
    expect(reservationUsd(PRIMARY_MODEL, b)).toBeGreaterThan(worst);
  });
  it("classifier reserves the byte-sized amount on the store (CJK)", async () => {
    const s = new MemorySpendStore(caps);
    const spy = vi.spyOn(s, "reserve");
    const texts = cjk.slice(0, 50);
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    await createOpenAiClassifier({ env, fetchFn: f as unknown as typeof fetch, store: s, now, log: () => undefined }).classify("q?", ["yes", "no"], texts).catch(() => undefined);
    const expected = reservationUsd(PRIMARY_MODEL, bound(texts));
    expect(expected).toBeGreaterThan(reservationUsd(PRIMARY_MODEL));
    expect(spy.mock.calls[0][0]).toBeCloseTo(expected, 12);
  });
  it("max CJK request still fits under the $1 daily cap", () => {
    expect(reservationUsd(FALLBACK_MODEL, bound(cjk))).toBeLessThan(1);
  });
});

describe("F2: failed post-call adjust is counted and logged, key-free", () => {
  const failing = () => {
    const s = new MemorySpendStore(caps);
    s.adjust = async () => { throw new Error(`redis down ${FAKE_KEY}`); };
    return s;
  };
  it("reconcile failure -> count+1, one fixed log line, result still returned", async () => {
    const lines: string[] = [];
    const before = adjustFailureCount();
    const f = vi.fn(async () => ok([0]));
    const r = await createOpenAiClassifier({ env, fetchFn: f as unknown as typeof fetch, store: failing(), now, log: (l) => lines.push(l) }).classify("q", ["a"], ["x"]);
    expect(r.labels).toEqual([0]);
    expect(adjustFailureCount()).toBe(before + 1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^discourse_spend_adjust_failed model=gpt-6-luna phase=reconcile count=\d+$/);
    expect(lines.join("\n")).not.toContain(FAKE_KEY);
    expect(lines.join("\n")).not.toContain("redis down");
  });
  it("release failure on HTTP error is counted per attempt (primary + fallback), key-free", async () => {
    const lines: string[] = [];
    const before = adjustFailureCount();
    const f = vi.fn(async () => new Response(`bad ${FAKE_KEY}`, { status: 500 }));
    await expect(createOpenAiClassifier({ env, fetchFn: f as unknown as typeof fetch, store: failing(), now, log: (l) => lines.push(l) }).classify("q", ["a"], ["x"])).rejects.toThrow("llm_unavailable");
    expect(adjustFailureCount()).toBe(before + 2);
    expect(lines.map((l) => l.replace(/ count=\d+$/, ""))).toEqual([
      "discourse_spend_adjust_failed model=gpt-6-luna phase=release",
      "discourse_spend_adjust_failed model=gpt-5.6-luna phase=release",
    ]);
    expect(lines.join("\n")).not.toContain(FAKE_KEY);
  });
  it("default logger is console.warn and never carries the key", async () => {
    const w = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const f = vi.fn(async () => ok([0]));
    await createOpenAiClassifier({ env, fetchFn: f as unknown as typeof fetch, store: failing(), now }).classify("q", ["a"], ["x"]);
    expect(w).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(w.mock.calls)).not.toContain(FAKE_KEY);
    w.mockRestore();
  });
  it("successful adjust logs nothing", async () => {
    const lines: string[] = [];
    const before = adjustFailureCount();
    const f = vi.fn(async () => ok([0]));
    await createOpenAiClassifier({ env, fetchFn: f as unknown as typeof fetch, store: new MemorySpendStore(caps), now, log: (l) => lines.push(l) }).classify("q", ["a"], ["x"]);
    expect(lines).toEqual([]);
    expect(adjustFailureCount()).toBe(before);
  });
});

describe("label alignment (repro 2026-10-13: 105 labels for 106 posts -> 503 classifier_unavailable)", () => {
  const body = (labels: unknown) => new Response(JSON.stringify({ usage: { prompt_tokens: 5658, completion_tokens: 221 }, choices: [{ message: { content: JSON.stringify({ labels }) } }] }), { status: 200 });
  const texts = Array.from({ length: 106 }, (_, i) => `post ${i}`);
  const run = (labels: unknown) => createOpenAiClassifier({ env, fetchFn: (async () => body(labels)) as unknown as typeof fetch, store: new MemorySpendStore(caps), now }).classify("tabs spaces", ["yes", "no"], texts);
  it("old positional format with one label dropped is rejected (the production failure)", async () => {
    await expect(run(Array.from({ length: 105 }, () => 0))).rejects.toThrow("llm_bad_output");
  });
  it("keyed pairs with one post skipped -> succeeds, skipped post neutral, no shift", async () => {
    const pairs = texts.map((_, i) => [i, i % 2]).filter(([i]) => i !== 50);
    const r = await run(pairs);
    expect(r.labels).toHaveLength(106);
    expect(r.labels[50]).toBe(-1);
    expect(r.labels[51]).toBe(1);
    expect(r.labels[105]).toBe(1);
  });
  it("too many skipped, duplicates, malformed pairs -> bad output", async () => {
    await expect(run(texts.slice(0, 90).map((_, i) => [i, 0]))).rejects.toThrow("llm_bad_output");
    await expect(run([[0, 0], [0, 1], ...texts.slice(2).map((_, i) => [i + 2, 0])])).rejects.toThrow("llm_bad_output");
    await expect(run(texts.map((_, i) => [i]))).rejects.toThrow("llm_bad_output");
  });
  it("request schema asks for [post, side] integer pairs", async () => {
    const f = vi.fn(async () => body([[0, 0]]));
    await createOpenAiClassifier({ env, fetchFn: f as unknown as typeof fetch, store: new MemorySpendStore(caps), now }).classify("q", ["a", "b"], ["x"]);
    const sent = JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(sent.response_format.json_schema.schema.properties.labels).toEqual({ type: "array", items: { type: "array", items: { type: "integer" } } });
  });
});

describe("engine failure reason log", () => {
  it("known codes pass through; anything else is store_or_other (no error text)", async () => {
    const { classifierFailReason } = await import("@/lib/discourse/engine");
    expect(classifierFailReason(new Error("llm_bad_output"))).toBe("llm_bad_output");
    expect(classifierFailReason(new Error(`spend_store 500 ${FAKE_KEY}`))).toBe("store_or_other");
    expect(classifierFailReason("x")).toBe("store_or_other");
  });
});
