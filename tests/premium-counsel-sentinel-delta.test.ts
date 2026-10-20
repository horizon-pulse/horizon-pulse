/**
 * Counsel 10/20 hardened-brief review E1-E10 + Sentinel LOW-5 (LLM reservation). Offline; no keys, no network.
 * Handler-level Sentinel fixes (M1-M4, LOW-7) are in premium-async.test.ts "delta 7"; LOW-6 in premium-verified-scope.
 */
import { afterEach, describe, expect, it } from "vitest";
import { briefLaunchBlockers, briefRefundChoice, CLAUSE_10_TEMPLATE, CLAUSE_6, OUTCOME_CONTRACT, outcomeContract } from "@/lib/premium/contract";
import { AI_PROVIDER_PRIVACY, AI_SELECTION_TERM, BRIEF_DESCRIPTION, BUYER_TERMS, DISCLAIMER, TECHNICAL_NOTES } from "@/lib/premium/copy";
import { EXTRACT_NEVER } from "@/lib/premium/parallel";
import { distinctOperators, rpcOperator } from "@/lib/premium/onchain";
import { buildVerified } from "@/lib/premium/verified";
import { SOURCE_INDEX } from "@/lib/premium/source-index";
import { AI_ANSWER_NOTE } from "@/lib/premium/research";
import { resetSynthesisForTests, setSynthesisForTests, writeAnswer } from "@/lib/premium/synthesis";
import demo from "@/lib/premium/demo-brief-verified.json";
import { readFileSync } from "node:fs";

const page = (url: string, text: string, fetched_at?: string) => ({ url, title: null, publish_date: null, excerpts: [text], ...(fetched_at ? { fetched_at } : {}) });
afterEach(() => resetSynthesisForTests());

describe("Counsel E1-E10 (verbatim copy)", () => {
  it("E1: clause 3 narrowed (RPC nodes only; x402 spec publishers; no statutes, regulators' notices or explorers) + 'Why official' paragraph", () => {
    expect(OUTCOME_CONTRACT).toContain("two independent RPC nodes return the same value for the same block (Ethereum and Base base fee and gas limit; USDC totalSupply() on Ethereum and Base)");
    expect(OUTCOME_CONTRACT).toContain("two different documents from the x402 specification publishers (x402.org, docs.x402.org, Coinbase developer documentation, github.com/coinbase/x402)");
    expect(OUTCOME_CONTRACT).not.toMatch(/explorers|regulators' notices|administered rates|balances, tx state/);
    const pageSrc = readFileSync("app/contracts/brief-verified/page.tsx", "utf8");
    expect(pageSrc).toContain("For x402 specification facts, the specification's own publishers are the source of record.");
    expect(pageSrc).not.toMatch(/statutes/);
  });
  it("E2: clause 5 wording; each quote carries its page's own fetch time, not the build time", async () => {
    expect(OUTCOME_CONTRACT).toContain("every claim's quote is found verbatim in the text of its page as fetched for this brief (fetch time and body hash shown)");
    const t = SOURCE_INDEX.find((x) => x.id === "x402")!;
    const web = [page("https://a.com/x", "x402 is an open payment protocol that uses the HTTP 402 status code for stablecoin payments in 2025.", "2026-10-20T09:00:00.000Z"), page("https://b.org/y", "Launched in 2025, x402 is an open payment protocol built on the HTTP 402 status code.", "2026-10-20T08:30:00.000Z")];
    const b = await buildVerified("What is the x402 payment protocol", t, web as any, [], null, "BUILD_TIME", Date.now() + 5000, 2);
    const c = b.claims.find((x: any) => x.primary && x.secondary) as any;
    expect(c).toBeTruthy();
    expect([c.primary.fetched_at, c.secondary.fetched_at].sort()).toEqual(["2026-10-20T08:30:00.000Z", "2026-10-20T09:00:00.000Z"]);
    expect(JSON.stringify(b.claims)).not.toContain("BUILD_TIME");
  });
  it("E3 (Odin 7:22 AM): clause 6 is behind HP_BRIEF_REFUND_CHOICE, default pending (no refund promise); (a), (b) and E3 texts ready; launch blocked while pending", () => {
    expect(briefRefundChoice({})).toBe("pending");
    expect(OUTCOME_CONTRACT).toContain(CLAUSE_6.pending);
    expect(outcomeContract({})).not.toMatch(/refund the full price|usually within 7 days|24 hours|logged publicly/);
    expect(outcomeContract({ HP_BRIEF_REFUND_CHOICE: "a" })).toContain("6. No refund promise: a brief is charged only when it passes clause 5");
    const b = outcomeContract({ HP_BRIEF_REFUND_CHOICE: "b" });
    expect(b).toContain("we refund the full price in USDC on Base");
    expect(b).not.toContain("usually within 7 days");
    expect(outcomeContract({ HP_BRIEF_REFUND_CHOICE: "e3" })).toContain("6. Corrections: if a claim we marked confirmed did not meet clause 3 when the brief was delivered, tell us at horizonpulse.co@proton.me within 30 days with the transaction hash.");
    expect(briefLaunchBlockers({})).toEqual(["refund_choice_pending"]);
    expect(briefLaunchBlockers({ HP_BRIEF_REFUND_CHOICE: "a" })).toEqual([]);
    expect(briefLaunchBlockers({ HP_BRIEF_REFUND_CHOICE: "b" })).toEqual(["premium_terms_refund_line_pending"]);
    expect(briefLaunchBlockers({ HP_BRIEF_REFUND_CHOICE: "b", HP_REFUND_LINE_APPROVED: "true" })).toEqual([]);
    expect(CLAUSE_6.pending).toBe("6. Refunds and corrections for delivered briefs: terms pending; none are offered until they are published here. This does not affect the refund terms at /premium-terms for a charge without delivery.");
    expect(CLAUSE_6.a).toContain("Delivered briefs are final, except as the refund terms at /premium-terms provide for a charge without delivery.");
    const copy = readFileSync("lib/premium/copy.ts", "utf8");
    expect(copy).not.toMatch(/Michael-approved \[M\]|\[M\] approved/);
    expect(copy).toContain("[M] items: OPEN, pending Michael");
  });
  it("E4: clause 7 has no forward promise", () => {
    expect(OUTCOME_CONTRACT).not.toMatch(/coming later/);
    expect(OUTCOME_CONTRACT).toContain("7. Every claim carries its evidence object. Briefs are not signed. For a charged brief, the x402 PAYMENT-RESPONSE settlement header (with the transaction hash) is the payment record.");
  });
  it("E5: clause 10, AI_ANSWER_NOTE, AI_SELECTION_TERM, AI_PROVIDER_PRIVACY; never 'fact-checked' in public copy", () => {
    expect(outcomeContract({ HP_BRIEF_MODEL_ANSWER: "true" })).toContain("10. For x402 questions the answer line is written by an AI model from the confirmed claims only;");
    expect(OUTCOME_CONTRACT).toContain(CLAUSE_10_TEMPLATE); // default: model answer OFF (ZDR unconfirmed)
    expect(outcomeContract({ HP_BRIEF_MODEL_ANSWER: "true" })).not.toContain(CLAUSE_10_TEMPLATE); // template clause only while the flag is off
    expect(AI_ANSWER_NOTE).toContain("Its wording can vary slightly between requests.");
    expect(AI_SELECTION_TERM).not.toContain("We add no prose of our own");
    expect(AI_SELECTION_TERM).toContain("that line is marked as machine-written");
    expect(AI_PROVIDER_PRIVACY).toContain("only to select and order quotes and, for verified briefs, to write the answer line from the confirmed claims");
    expect([OUTCOME_CONTRACT, AI_ANSWER_NOTE, AI_SELECTION_TERM, BRIEF_DESCRIPTION, ...BUYER_TERMS].join(" ")).not.toMatch(/fact-checked/i);
    const src = readFileSync("lib/premium/research.ts", "utf8");
    expect(src).toContain('answer_by === "model" ? { ai_note: AI_ANSWER_NOTE } : {}');
  });
  it("E6: payment line and TECHNICAL_NOTES para 4 say charge-on-pass for the $1 brief", () => {
    expect(BUYER_TERMS.join(" ")).toContain("The $1 verified brief is settled only after the brief passes its published contract (/contracts/brief-verified); a brief that does not pass is not charged. The $5 and $10 tiers are settled before the result is built;");
    expect(BUYER_TERMS.join(" ")).not.toContain("The $1, $5 and $10 tiers are settled before");
    expect(TECHNICAL_NOTES[3]).toContain("The $1 verified brief is settled only after it passes; if that settlement cannot be confirmed, the response says settle_unconfirmed and the steps below apply.");
  });
  it("E7/E8: disclaimer wording; BRIEF_DESCRIPTION 2-8 claims + 2 x402 spec documents (<=500 chars with suffix)", () => {
    expect(DISCLAIMER).toContain("Horizon Pulse does not check whether the sources are accurate");
    expect(DISCLAIMER).not.toContain("does not verify the sources");
    expect(BRIEF_DESCRIPTION).toContain("answer plus 2-8 claims");
    expect(BRIEF_DESCRIPTION).toContain("2 x402 spec documents");
    expect((BRIEF_DESCRIPTION + " No personal data in q.").length).toBe(472);
  });
  it("E9: the demo is a labelled recording of a PASSING in-scope brief", () => {
    const d = demo as any;
    expect(d.recording).toBe(true);
    expect(d.recorded_at).toMatch(/^2026-/);
    expect(d.status).toBe("pass");
    expect(d.fail_reasons).toEqual([]);
    expect(d.claims.filter((c: any) => c.status === "confirmed").length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(d)).not.toMatch(/EIP-4844|fewer than 4/);
  });
  it("E10: basescan.org never extracted; RPC nodes deduped by operator; reason renamed fewer_than_2_claims", () => {
    expect(EXTRACT_NEVER).toContain("basescan.org");
    expect(rpcOperator("https://eth.drpc.org")).toBe(rpcOperator("https://base.drpc.org"));
    expect(distinctOperators(["https://lb.drpc.org/ogrpc?network=base&dkey=x", "https://base.drpc.org", "https://mainnet.base.org"])).toEqual(["https://lb.drpc.org/ogrpc?network=base&dkey=x", "https://mainnet.base.org"]);
    expect(readFileSync("lib/premium/contract.ts", "utf8")).not.toContain("fewer_than_3_claims");
    const h = readFileSync("lib/premium/handler.ts", "utf8");
    for (const e of ["time_budget_exceeded", "chain_unavailable", "settlement_unavailable", "store_unavailable", "facilitator_unavailable"])
      for (const m of h.matchAll(new RegExp(`jsonError\\(503, \\{ error: "${e}"[^}]*\\}`, "g"))) if (!m[0].includes("extended tier's time budget")) expect(m[0]).toContain("Nothing was charged for this request.");
  });
  it("E1 hygiene: github.com counts as official only under /coinbase/x402", async () => {
    const t = SOURCE_INDEX.find((x) => x.id === "x402")!;
    const s = "x402 is an open standard for internet native payments over HTTP 402.";
    const b = await buildVerified("What is the x402 payment protocol", t, [], [page("https://github.com/someone/x402-fork", s), page("https://github.com/other/x402", `Intro. ${s}`)] as any, null, "t", Date.now() + 5000, 2);
    expect(b.tiers.official ?? 0).toBe(0);
  });
});

describe("Sentinel LOW-5: the LLM answer reservation is kept through timeout", () => {
  it("timed-out model call reconciles to the full reservation, not 0", async () => {
    const recon: [number, number][] = [];
    setSynthesisForTests({
      env: { HP_PREMIUM_LLM_ENABLED: "true", PREMIUM_LLM_ZDR_CONFIRMED: "true", PREMIUM_LLM_API_KEY: "test-not-a-key" },
      spend: { reserve: async () => true, reconcile: async (r, a) => void recon.push([r, a]) },
      model: () => Promise.reject(Object.assign(new Error("timed out"), { name: "TimeoutError" })),
    });
    expect(await writeAnswer("What is x402", ["x402 is an open payment standard."], Date.now() + 5000)).toBeNull();
    expect(recon).toHaveLength(1);
    expect(recon[0][1]).toBe(recon[0][0]);
    expect(recon[0][1]).toBeGreaterThan(0);
  });
});

describe("Odin 7:22 AM: all answer lines templated (model path behind HP_BRIEF_MODEL_ANSWER, default OFF)", () => {
  it("x402 answer is a confirmed claim's text; the model is never called even with the LLM gates on", async () => {
    let called = 0;
    setSynthesisForTests({ env: { HP_PREMIUM_LLM_ENABLED: "true", PREMIUM_LLM_ZDR_CONFIRMED: "true", PREMIUM_LLM_API_KEY: "test-not-a-key" }, spend: { reserve: async () => true, reconcile: async () => {} }, model: async () => (called++, { text: JSON.stringify({ answer: "x402 is great." }) }) });
    const t = SOURCE_INDEX.find((x) => x.id === "x402")!;
    const web = [page("https://a.com/x", "x402 is an open payment protocol that uses the HTTP 402 status code for stablecoin payments in 2025."), page("https://b.org/y", "Launched in 2025, x402 is an open payment protocol built on the HTTP 402 status code.")];
    const b = await buildVerified("What is the x402 payment protocol", t, web as any, [], null, "t", Date.now() + 5000, 1);
    expect(called).toBe(0);
    expect(b.answer_by).toBe("template");
    expect(b.claims.map((c: any) => c.text)).toContain(b.answer);
  });
});
