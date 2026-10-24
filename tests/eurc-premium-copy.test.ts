import { describe, expect, it } from "vitest";
import { premiumRailLive } from "@/lib/premium/rail-copy";
import { VERIFIED_BRIEF_TOOL } from "@/lib/mcp-server";

describe("Counsel E3: live premium rail copy follows eurcActive()", () => {
  it("USDC only when EURC is not active, EURC wording when active", () => {
    expect(premiumRailLive(false)).toBe("Base USDC only");
    expect(premiumRailLive(true)).toBe("USDC or EURC on Base only");
  });
  it("MCP brief description renders per request (flag off in tests -> USDC only)", () => {
    expect(VERIFIED_BRIEF_TOOL.description).toContain("(Base USDC only)");
    expect(VERIFIED_BRIEF_TOOL.description).not.toContain("EURC");
  });
});
