import { describe, expect, it } from "vitest";
import { buildSuggestions, PORTFOLIO_METHODOLOGY, type HoldingRow } from "@/lib/portfolio";
import { OUTPUT_EXAMPLES } from "@/lib/route-examples";
import { ROUTE_METADATA } from "@/lib/route-metadata";

/**
 * /api/portfolio `suggestions` (field name kept for format stability) carries
 * findings only since 2026-10-09: same codes, priorities and thresholds, no
 * instructions or recommendation wording.
 */
const ADVICE = /\b(trim|raise|reduce|increase|allocate|rebalanc\w*|consider|should|keep|swap|unwrap|fund the|cap(ping)?|retry|buy|sell|recommend\w*)\b|dry powder|toward/i;

type Opts = Parameters<typeof buildSuggestions>[0];
const base: Opts = {
  totalUsd: 1000, stableShare: 0.3, maxAssetWeight: 0.3, maxAssetSymbol: "ETH",
  maxChainWeight: 0.6, maxChain: "base", holdings: [], networkOk: true,
};
const row = (p: Partial<HoldingRow>): HoldingRow => ({
  network: "base", chainId: 8453, symbol: "USDC", kind: "erc20", contract: "0x0", decimals: 6,
  balanceAtomic: "0", balance: "0", priceUsd: 1, valueUsd: 0, weight: null, stablecoin: true, ...p,
});

const CASES: Array<[string, Partial<Opts>, string, string]> = [
  ["rpc", { networkOk: false }, "rpc_unavailable", "One or more networks failed RPC reads, so balances may be incomplete (see networks and warnings)."],
  ["empty", { totalUsd: 0 }, "empty_portfolio", "No priced balances found among tracked tokens for this address."],
  ["conc high", { maxAssetWeight: 0.62 }, "concentration_high", "ETH weight 62.0% of USD value, at or above the 50% single-asset threshold."],
  ["conc watch", { maxAssetWeight: 0.35 }, "concentration_watch", "ETH weight 35.0% of USD value, at or above the 35% single-asset threshold (below 50%)."],
  ["stables low", { stableShare: 0.08 }, "stables_low", "Stablecoin share 8.0% of USD value, below the 15% threshold."],
  ["stables high", { stableShare: 0.9 }, "stables_high", "Stablecoin share 90.0% of USD value, above the 85% threshold."],
  ["chain", { maxChainWeight: 0.85 }, "chain_concentration", "base share 85.0% of USD value, at or above the 85% single-chain threshold."],
  ["gas", { holdings: [row({ symbol: "ETH", kind: "native", valueUsd: 3.2 }), row({ valueUsd: 120 })] }, "gas_buffer_low", "Native ETH on base ~$3.20, below the $5 gas-balance threshold, with ~$120 of other tracked tokens on base (over $50)."],
  ["balanced", {}, "balanced", "No rule threshold crossed: largest single-asset weight below 35%, stablecoin share between 15% and 85%, largest single-chain share below 85%, no low native ETH balance flagged."],
];

describe("portfolio suggestions are findings only", () => {
  for (const [name, patch, code, message] of CASES) {
    it(`${name}: ${code}`, () => {
      const out = buildSuggestions({ ...base, ...patch });
      const hit = out.find((s) => s.code === code);
      expect(hit?.message).toBe(message);
      for (const s of out) expect(s.message).not.toMatch(ADVICE);
    });
  }

  it("thresholds unchanged (boundaries)", () => {
    const codes = (p: Partial<Opts>) => buildSuggestions({ ...base, ...p }).map((s) => s.code);
    expect(codes({ maxAssetWeight: 0.4999 })).toContain("concentration_watch");
    expect(codes({ maxAssetWeight: 0.5 })).toContain("concentration_high");
    expect(codes({ maxAssetWeight: 0.3499 })).toEqual(["balanced"]);
    expect(codes({ stableShare: 0.15 })).toEqual(["balanced"]);
    expect(codes({ stableShare: 0.1499 })).toContain("stables_low");
    expect(codes({ stableShare: 0.85 })).toEqual(["balanced"]);
    expect(codes({ maxChainWeight: 0.8499 })).toEqual(["balanced"]);
  });

  it("recorded example, methodology and description carry no advice wording", () => {
    const ex = OUTPUT_EXAMPLES["/api/portfolio"] as { suggestions: Array<{ message: string }> };
    expect(ex.suggestions[0].message).toBe("ETH weight 83.9% of USD value, at or above the 50% single-asset threshold.");
    expect(PORTFOLIO_METHODOLOGY.suggestions).not.toMatch(ADVICE);
    expect(ROUTE_METADATA["/api/portfolio"].description).not.toMatch(/suggestion|rebalanc|recommend/i);
  });
});
