import { describe, it, expect, vi } from "vitest";
import { createOpenAiClassifier, reservationUsd, costUsd, classifierFromEnv, PRIMARY_MODEL, FALLBACK_MODEL, MAX_OUTPUT_TOKENS } from "@/lib/discourse/llm";
import { MemorySpendStore, spendCaps, spendKeys, RESERVE_LUA, UpstashSpendStore } from "@/lib/discourse/spend";

const FAKE_KEY = "sk-test-DO-NOT-LEAK-0123456789";
const env = { DISCOURSE_LLM_API_KEY: FAKE_KEY };
const now = () => new Date("2026-10-13T12:00:00Z");
const caps = { dailyUsd: 1, monthlyUsd: 15 };
const ok = (labels: number[], pt = 1000, ct = 50) =>
  new Response(JSON.stringify({ usage: { prompt_tokens: pt, completion_tokens: ct }, choices: [{ message: { content: JSON.stringify({ labels }) } }] }), { status: 200 });

describe("price table + reservation", () => {
  it("gpt-6-luna worst case x1.25 = $0.0034375", () => {
    expect(reservationUsd(PRIMARY_MODEL)).toBeCloseTo(0.0034375, 10);
    expect(reservationUsd(FALLBACK_MODEL)).toBeCloseTo(0.00725, 10);
  });
  it("unpriced model throws", () => expect(() => costUsd("gpt-x", 1, 1)).toThrow());
  it("caps default $1/$15, env can lower, never raise past $5/$20", () => {
    expect(spendCaps({})).toEqual({ dailyUsd: 1, monthlyUsd: 15 });
    expect(spendCaps({ DISCOURSE_DAILY_USD_CAP: "0.5", DISCOURSE_MONTHLY_USD_CAP: "99" })).toEqual({ dailyUsd: 0.5, monthlyUsd: 20 });
    expect(spendCaps({ DISCOURSE_DAILY_USD_CAP: "50" }).dailyUsd).toBe(5);
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
    const f = async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"labels":[0]}' } }] }), { status: 200 });
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
    const f = async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"labels":[0]}' } }] }), { status: 200 });
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
  it("wrong label count -> bad output", async () => {
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
