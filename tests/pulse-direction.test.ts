import { describe, expect, it } from "vitest";
import { aggregatePulse } from "@/lib/indicators";
import { OUTPUT_EXAMPLES } from "@/lib/route-examples";
import { ROUTE_METADATA } from "@/lib/route-metadata";

/**
 * /api/pulse overall.direction replaced overall.signal (buy/sell/hold) on
 * 2026-10-09. Same thresholds on the average 24h change: >= +2.5% -> up
 * (was buy), <= -2.5% -> down (was sell), otherwise flat (was hold).
 */
describe("aggregatePulse direction (formerly signal)", () => {
  it("maps the old buy/sell/hold thresholds to up/down/flat", () => {
    expect(aggregatePulse([2.5, 2.5, 2.5]).direction).toBe("up");
    expect(aggregatePulse([2.49, 2.49]).direction).toBe("flat");
    expect(aggregatePulse([-2.5]).direction).toBe("down");
    expect(aggregatePulse([-2.49]).direction).toBe("flat");
    expect(aggregatePulse([10, -10]).direction).toBe("flat");
    expect(aggregatePulse([null, null]).direction).toBe("flat");
  });

  it("leaves momentum and sentiment unchanged", () => {
    const r = aggregatePulse([3, 3]);
    expect(r).toEqual({ momentum: "bullish", sentiment: "risk-on", direction: "up", avgChange24hPct: 3 });
  });

  it("no longer emits a signal field anywhere in the pulse surface", () => {
    expect("signal" in aggregatePulse([1])).toBe(false);
    const overall = (OUTPUT_EXAMPLES["/api/pulse"] as { overall: Record<string, unknown> }).overall;
    expect(overall).not.toHaveProperty("signal");
    expect(overall.direction).toBe("flat");
    const d = ROUTE_METADATA["/api/pulse"].description;
    expect(d).toContain("direction (up/down/flat)");
    expect(d).not.toMatch(/signal|buy|sell|hold/i);
  });
});
