import { describe, expect, it } from "vitest";
import { validateDiscoveryExtension, extractDiscoveryInfo } from "@x402/extensions/bazaar";
import { paymentRequired } from "@/lib/premium/payment";
import { PREMIUM_TIERS } from "@/lib/premium/tiers";
import { BRIEF_BAZAAR_Q_DESCRIPTION, BRIEF_BAZAAR_OUTPUT_DESCRIPTION, briefBazaarExtension } from "@/lib/premium/bazaar";
import { gasRouteConfig } from "@/lib/x402-server";

const brief = PREMIUM_TIERS.find((x) => x.id === "brief")!;

describe("brief 402: extensions.bazaar (Base only, $1, narrow copy)", () => {
  const pr = paymentRequired(brief, "d") as any;
  it("validates against the bazaar spec and names GET with required q", () => {
    const v = validateDiscoveryExtension(pr.extensions.bazaar) as any;
    expect(v.valid).toBe(true);
    expect(pr.extensions.bazaar.info.input).toMatchObject({ type: "http", method: "GET", queryParams: { q: expect.any(String) } });
    expect(pr.extensions.bazaar.schema.properties.input.properties.method.enum).toEqual(["GET"]);
    expect(pr.extensions.bazaar.schema.properties.input.properties.queryParams.required).toEqual(["q"]);
  });
  it("same top-level shape as an existing route's bazaar block", () => {
    const gas = (Object.values(gasRouteConfig())[0] as any).extensions.bazaar;
    expect(Object.keys(pr.extensions.bazaar).sort()).toEqual(Object.keys(gas).sort());
    expect(Object.keys(pr.extensions.bazaar.info).sort()).toEqual(Object.keys(gas.info).sort());
  });
  it("Base only, $1, payTo, resource metadata", () => {
    expect(pr.accepts).toHaveLength(1);
    expect(pr.accepts[0]).toMatchObject({ network: "eip155:8453", amount: "1000000", payTo: "0x5b32c973596078a967562ca652761404f19be0e9" });
    expect(pr.resource).toMatchObject({ serviceName: "Horizon Pulse", iconUrl: "https://horizonpulse.dev/icon.png" });
  });
  it("copy states exactly the accepted scope, charge-on-pass and unpaid refusals; no other tiers, no provider names", () => {
    expect(BRIEF_BAZAAR_Q_DESCRIPTION).toContain("Base or Ethereum gas (on-chain read), USDC supply on Ethereum and Base (on-chain totalSupply), or an x402 spec fact");
    expect(BRIEF_BAZAAR_Q_DESCRIPTION).toContain("refused with 422 before payment");
    expect(BRIEF_BAZAAR_OUTPUT_DESCRIPTION).toContain("Charged only if at least 2 claims are independently confirmed; otherwise 422, unpaid");
    expect(JSON.stringify(briefBazaarExtension())).not.toMatch(/xai|grok|standard|extended|\$5|\$10/i);
  });
  it("only the brief carries a bazaar block", () => {
    for (const x of PREMIUM_TIERS.filter((t) => t.id !== "brief")) expect((paymentRequired(x, "d") as any).extensions).toBeUndefined();
  });
  it("a facilitator can extract discovery info from a payment echoing this 402", () => {
    const info = extractDiscoveryInfo({ x402Version: 2, resource: pr.resource, accepted: pr.accepts[0], payload: {}, extensions: pr.extensions } as never, pr.accepts[0] as never) as any;
    expect(info?.resourceUrl ?? info?.resource ?? info).toBeTruthy();
  });
});

import DEMO_REC from "@/lib/premium/demo-brief-verified.json";
describe("Counsel B1", () => {
  it("the bazaar input example q is the demo recording's exact question", () => {
    expect((briefBazaarExtension().bazaar as any).info.input.queryParams.q).toBe(DEMO_REC.question);
  });
});
