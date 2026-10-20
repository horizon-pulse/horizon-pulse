import { describe, expect, it } from "vitest";
import { OUTCOME_CONTRACT, toContract } from "@/lib/premium/contract";

const page = (url: string, text: string) => ({ url, title: null, publish_date: null, excerpts: [text] });
const S = ["A one 2021.", "B two 2022.", "C three 2023.", "D four 2024.", "E five 2025."];
const ex = [page("https://a.com/", S.join(" ")), page("https://b.com/", S.join(" "))];
const sources = [{ n: 1, url: "https://a.com/" }, { n: 2, url: "https://b.com/" }];
function brief(nConfirmed: number, nClaims = 5, mutate?: (t: string) => string) {
  const snippets: any[] = [];
  const claims = S.slice(0, nClaims).map((t, i) => {
    snippets.push({ id: `s${i}a`, source: 1, text: mutate && i === 0 ? mutate(t) : t }, { id: `s${i}b`, source: 2, text: t });
    return { claim: t, snippets: [`s${i}a`, `s${i}b`], sources: [1, 2], ...(i < nConfirmed ? { confirmed_by: ["b.com"], confirmed_values: [`d:${2021 + i}`] } : {}) };
  });
  return { synthesis: "llm_selected_verified", answer: { lines: [{ text: "A one 2021.", snippets: ["s0a"], confirmed: true }] }, sources, snippets, claims };
}
describe("hardened brief outcome contract", () => {
  it("publishes the 8 clauses verbatim", () => {
    expect(OUTCOME_CONTRACT).toContain("At least 2 independently confirmed claims, or no charge");
    expect(OUTCOME_CONTRACT.split("\n").filter((l) => /^\d\./.test(l))).toHaveLength(9);
    expect(OUTCOME_CONTRACT).toContain("Signed receipts are coming later");
    expect(OUTCOME_CONTRACT).toContain("statutes, regulations and other legal questions");
  });
  it("4 publisher-confirmed claims + all verbatim -> pass; evidence objects carry hash and offset", () => {
    const c = toContract("q A", brief(4), ex as any, "2026-10-20T03:00:00Z");
    expect(c.status).toBe("pass");
    expect(c.counts.confirmed).toBe(4);
    expect(c.claims[0].primary!.body_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(c.claims[1].primary!.offset).toBeGreaterThan(0);
    expect(c.claims[0].secondary!.publisher).not.toBe(c.claims[0].primary!.publisher);
  });
  it("1 confirmed -> fail (never charged); minimum is 2 (Odin ruling (c))", () => {
    const c = toContract("q", brief(1), ex as any, "t");
    expect(c.status).toBe("fail");
    expect(c.fail_reasons).toContain("confirmed_1_of_2");
  });
  it("a quote not verbatim at its URL fails the whole brief", () => {
    const c = toContract("q", brief(5, 5, (t) => t.replace("one", "uno")), ex as any, "t");
    expect(c.status).toBe("fail");
    expect(c.fail_reasons).toContain("quote_not_verbatim_at_url");
  });
  it("consistent is shown but never counted as confirmed; onchain reads count only when two nodes agree", () => {
    const b: any = { onchain: { line: "x", reads: [
      { chain: "ethereum", block: 1, timestamp: "2026-10-20T00:00:00Z", value: "1", unit: "USDC", nodes: ["n1", "n2"], confirmed: true },
      { chain: "base", block: 2, timestamp: "2026-10-20T00:00:00Z", value: "2", unit: "USDC", nodes: ["n1"], confirmed: false },
    ] }, consistent: [{ range: "1 to 2", snippets: [{ id: "x", source: 1, text: "A one 2021." }, { id: "y", source: 2, text: "A one 2021." }] }], sources, snippets: [] };
    const c = toContract("q", b, ex as any, "t");
    expect(c.tiers["onchain-confirmed"]).toBe(1);
    expect(c.counts).toEqual({ confirmed: 1, consistent: 1, unconfirmed: 1 });
    expect(c.status).toBe("fail");
  });
});
