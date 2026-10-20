import { describe, expect, it } from "vitest";
import { classifyQuestion, BRIEF_EXAMPLES, BRIEF_TYPE_VALUES, withTypePrefix, stripTypePrefix, setClassifierForTests } from "@/lib/premium/source-index";
import { BRIEF_CLAIMS_PER_TYPE, NOT_CURRENTLY_OFFERED } from "@/lib/premium/copy";
import { BRIEF_LISTING } from "@/lib/premium/listing";
import { VERIFIED_BRIEF_TOOL } from "@/lib/mcp-server";
import fs from "fs";

setClassifierForTests(null);
const typeOf = (q: string) => { const c = classifyQuestion(q); return c.ok ? c.type.id : c.reason; };

// Claude round-7 classifier probe, all 18 phrasings (review §2).
const ACCEPT: [string, string][] = [
  ["current gas fees on Base network", "base_gas"],
  ["What is the base fee on Base right now?", "base_gas"],
  ["Base network gas", "base_gas"],
  ["Ethereum gas price now", "eth_gas"],
  ["Ethereum mainnet base fee", "eth_gas"],
  ["What is the total supply of USDC on Base?", "usdc_supply"],
  ["USDC supply on Ethereum", "usdc_supply"],
  ["USDC supply", "usdc_supply"],
  ["How much USDC exists on Base", "usdc_supply"],
  ["What header does an x402 server use to signal payment is required?", "x402"],
  ["What is x402?", "x402"],
  ["Which HTTP status code does x402 use?", "x402"],
  // previously refused, now accepted (the bug)
  ["what is the current base gas price", "base_gas"],
  ["Base gas price", "base_gas"],
  ["x402 PAYMENT-REQUIRED header", "x402"],
];
const REFUSE: [string, string][] = [
  ["SOFR today", "unsupported_question_type"],
  ["gas price on Polygon", "unsupported_question_type"],
  ["what is the x402 facilitator role", "out_of_scope:facilitator_definition"],
];

describe("round 7 classifier", () => {
  it("covers all 18 probe phrasings", () => expect(ACCEPT.length + REFUSE.length).toBe(18));
  it.each(ACCEPT)("accepts %s -> %s", (q, t) => expect(typeOf(q)).toBe(t));
  it.each(REFUSE)("refuses %s -> %s", (q, r) => expect(typeOf(q)).toBe(r));
  it("Base mainnet stays Base; Polygon base fee stays refused", () => {
    expect(typeOf("Base mainnet gas")).toBe("base_gas");
    expect(typeOf("Polygon base fee")).toBe("unsupported_question_type");
  });
  it("every published example classifies to its own type", () => {
    for (const [k, qs] of Object.entries(BRIEF_EXAMPLES)) for (const q of qs) expect(typeOf(q)).toBe(k === "x402_spec" ? "x402" : k);
  });
  it("type= bypasses phrase matching but never out-of-scope refusals", () => {
    expect(typeOf(withTypePrefix("current Base fee please", "base_gas"))).toBe("base_gas");
    expect(typeOf(withTypePrefix("tell me about payment headers", "x402_spec"))).toBe("x402");
    expect(typeOf(withTypePrefix("what is a facilitator", "x402_spec"))).toBe("out_of_scope:facilitator_definition");
    expect(typeOf(withTypePrefix("should I buy USDC", "usdc_supply"))).toBe("out_of_scope:recommendation");
    expect(stripTypePrefix("[type:eth_gas] gas")).toEqual({ q: "gas", type: "eth_gas" });
    expect(BRIEF_TYPE_VALUES).toEqual(["base_gas", "eth_gas", "usdc_supply", "x402_spec"]);
  });
  it("422 message lists three examples per type and the type param", () => {
    const c = classifyQuestion("SOFR today");
    expect(c.ok).toBe(false);
    if (!c.ok) { for (const qs of Object.values(BRIEF_EXAMPLES)) { expect(qs).toHaveLength(3); for (const q of qs) expect(c.message).toContain(q); } expect(c.message).toContain("type=base_gas|eth_gas|usdc_supply|x402_spec"); }
  });
});

describe("round 7 copy", () => {
  it("claim counts per type are stated", () => expect(BRIEF_CLAIMS_PER_TYPE).toMatch(/Base gas and Ethereum gas, 2.*USDC supply, 2.*x402 spec facts, 2-8/));
  it("short copy uses the contract's definition", () => {
    const N = "confirmed in two sources as defined by the contract (two independent nodes, or two separate specification documents)";
    expect(BRIEF_LISTING.summary).toContain(N);
    expect(fs.readFileSync("public/llms.txt", "utf8")).toContain(N);
    expect(BRIEF_LISTING.summary).not.toContain("independently confirmed");
  });
  it("llms.txt notes the premium block is a Horizon Pulse extension", () => expect(fs.readFileSync("public/llms.txt", "utf8")).toMatch(/premium` block in `\/\.well-known\/x402`.*Horizon Pulse extension/));
  it("premium-terms notice names the unoffered tiers", () => expect(NOT_CURRENTLY_OFFERED).toMatch(/Not currently offered: the \$5 standard and \$10 extended.*seller watch/));
});

describe("round 7 MCP quote tool", () => {
  it("is named verified_brief_quote and its first sentence says it never runs or pays", () => {
    expect(VERIFIED_BRIEF_TOOL.name).toBe("verified_brief_quote");
    expect(VERIFIED_BRIEF_TOOL.description.split("; this tool never runs the brief or pays.")[0]).toMatch(/^Returns the payment instructions \(the unpaid HTTP 402\)/);
  });
});
