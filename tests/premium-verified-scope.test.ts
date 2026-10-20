import { describe, expect, it } from "vitest";
import { classifyQuestion, SOURCE_INDEX } from "@/lib/premium/source-index";
import { buildVerified } from "@/lib/premium/verified";

const page = (url: string, text: string, publish_date: string | null = null) => ({ url, title: null, publish_date, excerpts: [text] });
describe("ruling (c): narrow scope, refused unpaid before any payment step", () => {
  it("narrow scope (Odin 11:40 PM): on-chain live values + x402 spec facts only; everything else refused", () => {
    expect(classifyQuestion("How much USDC is in circulation")).toMatchObject({ ok: true, type: { id: "usdc_supply" } });
    expect(classifyQuestion("What is the current gas price on the Base network")).toMatchObject({ ok: true, type: { id: "base_gas" } });
    expect(classifyQuestion("What is the Ethereum block gas limit")).toMatchObject({ ok: true, type: { id: "eth_gas" } });
    expect(classifyQuestion("What is the x402 payment protocol")).toMatchObject({ ok: true, type: { id: "x402" } });
    for (const [q, r] of [["Should I buy USDC or USDT", "out_of_scope:recommendation"], ["What will the Fed decide at its next meeting", "out_of_scope:prediction"], ["Where does the founder of Zylphix Labs live", "out_of_scope:private_person"], ["What did Jerome Powell say yesterday", "out_of_scope:breaking_news"], ["What is the live order book depth for ETH-USDC on Uniswap right now", "out_of_scope:market_data"], ["What does the GENIUS Act require of stablecoin issuers", "out_of_scope:legal_or_statute"], ["What is the current federal funds rate target range", "unsupported_question_type"], ["What is EIP-4844", "unsupported_question_type"], ["What is an x402 facilitator", "out_of_scope:facilitator_definition"], ["What does a facilitator do in x402", "out_of_scope:facilitator_definition"], ["Definition of the x402 facilitator", "out_of_scope:facilitator_definition"], ["When did Coinbase last change the x402 facilitator fee schedule", "unsupported_question_type"]] as const)
      expect(classifyQuestion(q)).toMatchObject({ ok: false, reason: r });
    expect(SOURCE_INDEX.every((t) => t.official || t.onchain)).toBe(true);
  });
});
describe("ruling (c): deterministic code-confirmed claims", () => {
  const fed = { id: "fed_test", label: "t", match: [], official: { authority: "Federal Reserve", domains: ["federalreserve.gov"] }, indexQuery: null, onchain: null, web: false } as any;
  const s = "The Committee decided to maintain the target range for the federal funds rate at 4 to 4-1/4 percent.";
  const old = "The Committee decided to raise the target range for the federal funds rate to 1/4 to 1/2 percent.";
  it("official pair needs two DIFFERENT documents (locale/query copies are one document)", async () => {
    const idx = [page("https://www.federalreserve.gov/a/monetary20260916a.htm", s), page("https://www.federalreserve.gov/a/monetary20260916a.htm?x=1", s)];
    const b = await buildVerified("What is the federal funds rate target range", fed, [], idx as any, null, "t", Date.now() + 5000, 2);
    expect(b.tiers.official).toBe(0);
    expect(b.status).toBe("fail");
  });
  it("current-value question: an official pair must include the newest document (stale 2022 pair rejected)", async () => {
    const idx = [page("https://www.federalreserve.gov/a/monetary20220316a.htm", old), page("https://www.federalreserve.gov/a/monetary20220316a1.htm", `In March 2022, ${old.toLowerCase()}`), page("https://www.federalreserve.gov/a/monetary20260916a.htm", "Statement.")];
    const b = await buildVerified("What is the current federal funds rate target range", fed, [], idx as any, null, "t", Date.now() + 5000, 2);
    expect(b.claims.some((c) => /1\/4 to 1\/2/.test(c.text))).toBe(false);
  });
  it("same inputs -> byte-identical claims (no model in claim text)", async () => {
    const t = SOURCE_INDEX.find((x) => x.id === "x402")!;
    const web = [page("https://a.com/x", "x402 is an open payment protocol that uses the HTTP 402 status code for stablecoin payments in 2025."), page("https://b.org/y", "Launched in 2025, x402 is an open payment protocol built on the HTTP 402 status code.")];
    const r1 = await buildVerified("What is the x402 payment protocol", t, web as any, [], null, "t", Date.now() + 5000, 2);
    const r2 = await buildVerified("What is the x402 payment protocol", t, [...web].reverse() as any, [], null, "t", Date.now() + 5000, 2);
    expect(JSON.stringify(r1.claims)).toBe(JSON.stringify(r2.claims));
  });
});
