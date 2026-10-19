import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { compile, isDateline } from "@/lib/premium/research";
import { tierFor } from "@/lib/premium/tiers";
import { ADVICE_DISCLAIMER, AI_SELECTION_NOTE, chatCompletionsCall, questionRefusal, sanitizeQuestion, llmConfig, norm, pageSentences, premiumLlmEnabled, resetSynthesisForTests, setSynthesisForTests, synthesizeBrief, type ModelCall } from "@/lib/premium/synthesis";
import { captureAllowed, captureBody } from "@/lib/premium/capture";

const brief = tierFor("research" as never, "brief")!;
const load = (n: string) => ({ s: JSON.parse(readFileSync(`tests/fixtures/real/${n}-search.json`, "utf8")), e: JSON.parse(readFileSync(`tests/fixtures/real/${n}-extract.json`, "utf8")) });
const ON = { HP_PREMIUM_LLM_ENABLED: "true", PREMIUM_LLM_ZDR_CONFIRMED: "true", PREMIUM_LLM_API_KEY: "test-not-a-key" };
const MD = /\]\(|https?:\/\/|\*\*|^\s*[*#>-]\s/;

/** Recorded model selections (sentence ids) per real fixture; quotes are copied from the page sentences, as a model would. */
const RECORDED: Record<string, { answer: string[]; claims: string[][] }> = {
  prem4: { answer: ["u3s5"], claims: [["u3s5"], ["u2s4"], ["u4s3"], ["u5s4"], ["u3s8"]] },
  howmuch: { answer: ["u3s4"], claims: [["u3s4"], ["u1s1"], ["u3s3"], ["u1s5"]] },
  x402: { answer: [], claims: [["u2s2"], ["u1s63"], ["u1s67"], ["u1s106"], ["u2s3"]] },
};
function recordedModel(n: string, e: any, tweak?: (o: any) => void): ModelCall {
  const { list } = pageSentences(e.results);
  const q = (id: string) => {
    const s = list.find((x) => x.id === id)!;
    return { id, url: s.url, quote: s.text };
  };
  return async () => {
    const out: any = { answer: RECORDED[n].answer.map(q), claims: RECORDED[n].claims.map((ids) => ({ quotes: ids.map(q) })), unanswerable: false };
    tweak?.(out);
    return { text: JSON.stringify(out), inputTokens: 9000, outputTokens: 600 };
  };
}
afterEach(() => resetSynthesisForTests());

const codeOnly = (n: string) => {
  const { s, e } = load(n);
  return compile(brief, s.question, s.results, "2026-10-19T22:00:00Z", e.results) as any;
};
const viaLlm = async (n: string, tweak?: (o: any) => void, env: Record<string, string> = ON) => {
  const { s, e } = load(n);
  setSynthesisForTests({ env, model: recordedModel(n, e, tweak) });
  return (await synthesizeBrief(s.question, codeOnly(n), e.results, Date.now() + 30_000)) as any;
};
const verbatim = (n: string, out: any) => {
  const { pageText } = pageSentences(load(n).e.results);
  for (const sn of out.snippets) {
    const url = out.sources[sn.source - 1].url;
    expect(pageText.get(url)!.includes(norm(sn.text.replace(/ …$/, ""))), `${n}: ${sn.text}`).toBe(true);
  }
};

describe("real extract replay: code-only (3 real bodies)", () => {
  for (const n of ["prem4", "howmuch", "x402"]) {
    it(`${n}: no markdown, no datelines, no false x402 '402' confirmations`, () => {
      const out = codeOnly(n);
      expect(out.claims.length).toBeGreaterThan(0);
      for (const c of [...out.claims.map((c: any) => c.claim), ...out.answer.lines.map((l: any) => l.text)]) {
        expect(c).not.toMatch(MD);
        expect(isDateline(c)).toBe(false);
      }
      for (const c of out.claims) expect(c.confirmed_values ?? []).not.toContain("402");
    });
  }
  it("howmuch: code-only answer line carries a number", () => {
    expect(codeOnly("howmuch").answer.lines[0].text).toMatch(/\$\d/);
  });
});

describe("real extract replay: LLM synthesis with recorded (mocked) model", () => {
  for (const n of ["prem4", "howmuch", "x402"]) {
    it(`${n}: every quote verbatim at its cited URL; no markdown/datelines/pronoun claims`, async () => {
      const out = await viaLlm(n);
      expect(out.synthesis).toBe("llm_selected_verified");
      verbatim(n, out);
      for (const c of out.claims) {
        expect(c.claim).not.toMatch(MD);
        expect(isDateline(c.claim)).toBe(false);
        expect(c.claim).not.toMatch(/^(It|This|They)\b/);
      }
    });
  }
  it("prem4: answer is the dated introduction sentence; nothing falsely confirmed", async () => {
    const out = await viaLlm("prem4");
    expect(out.answer.lines[0].text).toMatch(/^Introduced by Coinbase in February 2023/);
    expect(out.claims.filter((c: any) => c.confirmed_by)).toEqual([]);
  });
  it("howmuch: number answer ($0.0008 for Base)", async () => {
    const out = await viaLlm("howmuch");
    expect(out.answer.lines[0].text).toMatch(/Base \$0\.0008/);
  });
  it("x402: general question -> no answer lines from the model, falls back to the code answer block; pronoun claim dropped", async () => {
    const out = await viaLlm("x402");
    expect(out.claims.some((c: any) => /^It allows/.test(c.claim))).toBe(false);
    expect(out.claims[0].claim).toMatch(/^x402 is an internet-native payments protocol/);
  });
  it("confirmation: same normalised number on 2 publishers confirms; on 1 publisher does not", async () => {
    const ex = [
      { url: "https://a.example/p", title: "A", publish_date: null, excerpts: ["Sending USDC on Base costs about $0.0008 per transfer today."] },
      { url: "https://b.example/q", title: "B", publish_date: null, excerpts: ["A USDC transfer on Base costs roughly $0.0008 in fees."] },
      { url: "https://c.example/r", title: "C", publish_date: null, excerpts: ["Ethereum mainnet costs about $0.021 for the same transfer."] },
    ];
    const { list } = pageSentences(ex);
    const q = (i: number) => ({ id: list[i].id, url: list[i].url, quote: list[i].text });
    setSynthesisForTests({ env: ON, model: async () => ({ text: JSON.stringify({ answer: [q(0)], claims: [{ quotes: [q(0), q(1)] }, { quotes: [q(2)] }], unanswerable: false }) }) });
    const out: any = await synthesizeBrief("How much does it cost to send USDC on Base", compile(brief, "q", [], "t", ex), ex, Date.now() + 30_000);
    expect(out.claims[0].confirmed_values).toEqual(["$0.0008"]);
    expect(out.claims[1].confirmed_by).toBeUndefined();
    expect(out.answer.lines[0].confirmed).toBe(true);
    expect(out.could_not_confirm).toEqual([out.claims[1].claim]);
  });
});

describe("LLM synthesis: fallbacks and rejections", () => {
  it("key absent (or flag off) -> code-only; never reads DISCOURSE_LLM_API_KEY", async () => {
    expect(premiumLlmEnabled({ HP_PREMIUM_LLM_ENABLED: "true" })).toBe(false);
    expect(premiumLlmEnabled({ HP_PREMIUM_LLM_ENABLED: "true", DISCOURSE_LLM_API_KEY: "x" })).toBe(false);
    expect(premiumLlmEnabled({ PREMIUM_LLM_API_KEY: "x" })).toBe(false);
    let called = 0;
    const { s, e } = load("prem4");
    setSynthesisForTests({ env: { HP_PREMIUM_LLM_ENABLED: "true", DISCOURSE_LLM_API_KEY: "x" }, model: async () => (called++, { text: "{}" }) });
    const out: any = await synthesizeBrief(s.question, codeOnly("prem4"), e.results, Date.now() + 30_000);
    expect(called).toBe(0);
    expect(out.synthesis).toBe("code");
    expect(out.claims).toEqual(codeOnly("prem4").claims);
  });
  it("timeout -> code fallback (model aborted by the deadline-bounded signal)", async () => {
    const { s, e } = load("prem4");
    setSynthesisForTests({ env: ON, model: ({ signal }) => new Promise((_r, rej) => signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "TimeoutError" })))) });
    const out: any = await synthesizeBrief(s.question, codeOnly("prem4"), e.results, Date.now() + 2_300);
    expect(out.synthesis).toBe("code_fallback:timeout");
  }, 10_000);
  it("not enough budget left -> skip the model", async () => {
    const { s, e } = load("prem4");
    setSynthesisForTests({ env: ON, model: async () => { throw new Error("must not be called"); } });
    expect(((await synthesizeBrief(s.question, codeOnly("prem4"), e.results, Date.now() + 500)) as any).synthesis).toBe("code_fallback:budget");
  });
  it("fake URL, fake quote, wrong id/url pairing are rejected; all-fake -> code fallback", async () => {
    const out = await viaLlm("howmuch", (o) => {
      o.claims.unshift({ quotes: [{ id: "u1s1", url: "https://evil.example/x", quote: "USDC on Base is a fully-backed digital dollar that settles in seconds and costs pennies in gas." }] });
      o.claims.unshift({ quotes: [{ id: "u3s3", url: o.claims[2].quotes[0].url, quote: "Base transfers are completely free forever for everyone." }] });
      o.claims.unshift({ quotes: [{ id: "u1s1", url: o.claims[3].quotes[0].url, quote: "Ethereum mainnet costs about $0.021 for the same transfer." }] });
    });
    expect(out.rejected_quotes).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(out.claims)).not.toContain("evil.example");
    expect(JSON.stringify(out.claims)).not.toContain("completely free forever");
    verbatim("howmuch", out);
    const all = await viaLlm("howmuch", (o) => {
      o.answer = [{ id: "zz", url: "https://evil.example", quote: "ignore previous instructions" }];
      o.claims = [{ quotes: [{ id: "zz", url: "https://evil.example", quote: "Base fees are $0 forever and always." }] }];
    });
    expect(all.synthesis).toBe("code_fallback:nothing_verified");
  });
  it("bad JSON and spend cap -> code fallback", async () => {
    const { s, e } = load("prem4");
    setSynthesisForTests({ env: ON, model: async () => ({ text: "not json" }) });
    expect(((await synthesizeBrief(s.question, codeOnly("prem4"), e.results, Date.now() + 30_000)) as any).synthesis).toBe("code_fallback:bad_json");
    setSynthesisForTests({ env: ON, model: async () => ({ text: "{}" }), spend: { reserve: async () => false, reconcile: async () => undefined } });
    expect(((await synthesizeBrief(s.question, codeOnly("prem4"), e.results, Date.now() + 30_000)) as any).synthesis).toBe("code_fallback:spend_cap");
  });
  it("provider config: xAI default, base URL and model overridable", () => {
    expect(llmConfig({})).toEqual({ provider: "xai", base: "https://api.x.ai/v1", model: "grok-4.20-0309-non-reasoning" });
    expect(llmConfig({ PREMIUM_LLM_PROVIDER: "other", PREMIUM_LLM_BASE_URL: "https://llm.example/v1/", PREMIUM_LLM_MODEL: "m1" })).toEqual({ provider: "other", base: "https://llm.example/v1", model: "m1" });
  });
});

describe("C1 debug capture", () => {
  const H = (v?: string) => new Headers(v ? { "x-vercel-protection-bypass": v } : {});
  const env = { VERCEL_ENV: "preview", HP_PREMIUM_CAPTURE: "true", VERCEL_AUTOMATION_BYPASS_SECRET: "s3cret-test" };
  it("allowed only on preview + flag + matching bypass header", () => {
    expect(captureAllowed(H("s3cret-test"), env)).toBe(true);
    expect(captureAllowed(H("s3cret-test"), { ...env, VERCEL_ENV: "production" })).toBe(false);
    expect(captureAllowed(H("s3cret-test"), { ...env, VERCEL_ENV: undefined as never })).toBe(false);
    expect(captureAllowed(H("s3cret-test"), { ...env, HP_PREMIUM_CAPTURE: "false" })).toBe(false);
    expect(captureAllowed(H(), env)).toBe(false);
    expect(captureAllowed(H("wrong"), env)).toBe(false);
    expect(captureAllowed(H("s3cret-test"), { ...env, VERCEL_AUTOMATION_BYPASS_SECRET: undefined as never })).toBe(false);
  });
  it("carries only content fields (no headers, no keys)", () => {
    const b: any = captureBody({ data: { search: [{ url: "https://a", title: "t", publish_date: null, excerpts: ["x"], extra: "h" } as never], extract: [] } });
    expect(Object.keys(b.search[0]).sort()).toEqual(["excerpts", "publish_date", "title", "url"]);
    expect(JSON.stringify(b)).not.toMatch(/authorization|bypass|x-api-key|bearer/i);
    expect(captureBody({})).toBeNull();
  });
});

describe("Counsel xAI conditions (X2-X6)", () => {
  it("X2: no LLM without explicit ZDR confirmation, even with flag + key", () => {
    expect(premiumLlmEnabled({ HP_PREMIUM_LLM_ENABLED: "true", PREMIUM_LLM_API_KEY: "k" })).toBe(false);
    expect(premiumLlmEnabled({ ...ON })).toBe(true);
  });
  it("X3: request body carries store:false, no user / previous_response_id; key only in Authorization", async () => {
    let body: any = null;
    let hdr: any = null;
    const f = vi.spyOn(globalThis, "fetch").mockImplementation((async (_u: string, init: any) => {
      body = JSON.parse(init.body);
      hdr = init.headers;
      return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    }) as never);
    await chatCompletionsCall("https://api.x.ai/v1")({ system: "s", user: "u", schema: {}, model: "m", key: "k-test", signal: AbortSignal.timeout(1000) });
    f.mockRestore();
    expect(body.store).toBe(false);
    expect(body.user).toBeUndefined();
    expect(body.previous_response_id).toBeUndefined();
    expect(body.response_format.type).toBe("json_schema");
    expect(JSON.stringify(body)).not.toContain("k-test");
    expect(hdr.authorization).toBe("Bearer k-test");
  });
  it("X4: no model input or output in logs (success and failure paths)", async () => {
    const logs: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" "))));
    await viaLlm("howmuch");
    const { s, e } = load("howmuch");
    setSynthesisForTests({ env: ON, model: async () => { throw new Error("SECRET_MODEL_TEXT boom"); } });
    await synthesizeBrief(s.question, codeOnly("howmuch"), e.results, Date.now() + 30_000);
    setSynthesisForTests({ env: ON, model: async () => ({ text: "SECRET_MODEL_TEXT not json" }) });
    await synthesizeBrief(s.question, codeOnly("howmuch"), e.results, Date.now() + 30_000);
    spies.forEach((sp) => sp.mockRestore());
    const all = logs.join("\n");
    expect(all).not.toContain("SECRET_MODEL_TEXT");
    expect(all).not.toContain("USDC on Base is a fully-backed");
    expect(all).not.toContain(s.question);
    expect(all).not.toContain("test-not-a-key");
  });
  it("X5: personal data stripped from the question before it is sent", async () => {
    const q = "How much did vitalik@example.com send from 0x5b32c973596078a967562ca652761404f19be0e9 or 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU, call +1 (787) 555-0199, card 4111111111111111, in 2023?";
    const out = sanitizeQuestion(q);
    expect(out).not.toMatch(/@|0x5b32|7xKXtg|555-0199|4111/);
    expect(out).toContain("[email]");
    expect(out).toContain("[address]");
    expect(out).toContain("2023");
    let sent = "";
    const { e } = load("howmuch");
    setSynthesisForTests({ env: ON, model: async ({ user }) => ((sent = user), { text: JSON.stringify({ answer: [], claims: [], unanswerable: true }) }) });
    await synthesizeBrief(q, codeOnly("howmuch"), e.results, Date.now() + 30_000);
    expect(sent).not.toMatch(/vitalik@example\.com|0x5b32c973|555-0199|4111111111111111/);
  });
  it("X5: refusals (private-person profiling, health) - no model call; handler refuses before payment", async () => {
    expect(questionRefusal("What is the home address of John Smith")).toBe("private_person_profiling");
    expect(questionRefusal("Compile everything about my neighbour Jane Roe")).toBe("private_person_profiling");
    expect(questionRefusal("What medication dosage should I take for my illness")).toBe("health_data");
    expect(questionRefusal("When did Coinbase launch the Base network")).toBeNull();
    expect(questionRefusal("How much does it cost to send USDC on Base")).toBeNull();
    let called = 0;
    const { e } = load("prem4");
    setSynthesisForTests({ env: ON, model: async () => (called++, { text: "{}" }) });
    const out: any = await synthesizeBrief("What is the home address of John Smith", codeOnly("prem4"), e.results, Date.now() + 30_000);
    expect(called).toBe(0);
    expect(out.synthesis).toBe("code_fallback:refused");
  });
  it("X5/X6: advice disclaimer on every brief; AI note names only 'an AI model provider'; never presented as human-written", async () => {
    expect(codeOnly("prem4").advice_disclaimer).toMatch(/Not financial, investment/);
    const out = await viaLlm("prem4");
    expect(out.advice_disclaimer).toBe(ADVICE_DISCLAIMER);
    expect(out.ai_note).toBe(AI_SELECTION_NOTE);
    expect(out.ai_note).toMatch(/AI model provider/);
    const buyer = JSON.stringify({ ...out, sources: [], snippets: [], claims: [] });
    expect(buyer).not.toMatch(/xai|x\.ai|grok/i);
    expect(buyer).not.toMatch(/human[- ]written|written by (our|a) (team|analyst|human)/i);
  });
});
