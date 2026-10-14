import { describe, expect, it } from "vitest";
import { mcpToolAnnotations, mcpToolDescription } from "@/lib/mcp-server";

describe("MCP tool text (plan #4)", () => {
  it("names the price and Base-only rail; feed tools get a cadence line", () => {
    const d = mcpToolDescription("pulse", { maxAmountRequired: "5000", resource: "https://horizonpulse.dev/api/pulse", description: "Crypto prices." });
    expect(d).toBe("Crypto prices. Price $0.005 per call via x402, USDC on Base (MCP payments are Base only). Data changes about every 1 min; calling more often returns the same values.");
    const f = mcpToolDescription("fetch", { maxAmountRequired: "20000", resource: "x", description: "Fetch." });
    expect(f).not.toContain("Data changes");
  });
  it("annotations: read-only except the http proxy", () => {
    expect(mcpToolAnnotations("pulse")).toMatchObject({ readOnlyHint: true, openWorldHint: true, destructiveHint: false });
    expect(mcpToolAnnotations("http").readOnlyHint).toBe(false);
  });
});
