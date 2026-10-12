/** Odin fix 1: XRPL in canonicalNetwork (fixed table; unknown xrpl-ish values rejected) + evidence printing. */
import { describe, expect, it } from "vitest";
import { canonicalNetwork, canonicalXrplNetwork, crossCheckPayTo, UNRECOGNIZED_NETWORK } from "@/lib/market/trust";
import { evidenceNetwork } from "@/lib/market/engine";
import { isTestnet, railForNetwork } from "@/lib/market/offer";

describe("canonicalNetwork: XRPL", () => {
  it("fixed alias table", () => {
    const t: Record<string, string> = {
      "xrpl:0": "xrpl:0", "XRPL:0": "xrpl:0", " xrpl:0 ": "xrpl:0", xrpl: "xrpl:0", "xrpl-mainnet": "xrpl:0", xrp: "xrpl:0", ripple: "xrpl:0", XRP: "xrpl:0",
      "xrpl:1": "xrpl:1", "xrpl-testnet": "xrpl:1", "xrpl:2": "xrpl:2", "xrpl-devnet": "xrpl:2",
    };
    for (const [k, v] of Object.entries(t)) expect(canonicalNetwork(k), k).toBe(v);
  });

  it("unknown xrpl-ish values are unrecognized, never passed through", () => {
    for (const bad of ["xrpl:3", "xrpl:01", "xrpl:0x", "xrpl:-1", "xrpl:", "xrpl-main", "xrp:0", "ripple:mainnet", "xrpl_testnet", "xrpl:1\u200b", "xrpl:ｌ"]) {
      expect(canonicalNetwork(bad), JSON.stringify(bad)).toBe(UNRECOGNIZED_NETWORK);
      expect(evidenceNetwork(bad), JSON.stringify(bad)).toBe("unrecognized network");
    }
    // Unicode lookalike that does not even start with ascii "xrpl" stays a non-xrpl string and still never prints
    expect(evidenceNetwork("ｘrpl:0")).toBe("unrecognized network");
    expect(canonicalXrplNetwork("eip155:8453")).toBeNull();
  });

  it("existing networks unchanged", () => {
    expect(canonicalNetwork("base")).toBe("eip155:8453");
    expect(canonicalNetwork("solana")).toBe("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
    expect(canonicalNetwork("eip155:84532")).toBe("eip155:84532");
  });

  it("evidence prints only xrpl:0|1|2", () => {
    expect(evidenceNetwork("xrpl")).toBe("xrpl:0");
    expect(evidenceNetwork("xrpl-testnet")).toBe("xrpl:1");
  });

  it("testnet/devnet flagged; mainnet not; rail only for table values", () => {
    expect(isTestnet("xrpl:1")).toBe(true);
    expect(isTestnet("xrpl:2")).toBe(true);
    expect(isTestnet("xrpl:0")).toBe(false);
    expect(railForNetwork("xrpl:0")).toBe("x402:xrpl");
    expect(railForNetwork("xrpl:9")).toBe("x402:other");
  });

  it("payTo cross-check: XRPL addresses compare exactly (case-sensitive); testnet vs mainnet are different networks", () => {
    const A = "r3FbirL83RAB2CwnUdxE5pCohMkuo6LQcf";
    const live = [{ network: "xrpl", payTo: A }] as never;
    expect(crossCheckPayTo(live, [{ network: "xrpl:0", payTo: A }] as never).status).toBe("match");
    const lc = crossCheckPayTo(live, [{ network: "xrpl:0", payTo: A.toLowerCase() }] as never);
    expect(lc.status).not.toBe("match");
    const tn = crossCheckPayTo(live, [{ network: "xrpl:1", payTo: A }] as never);
    expect(tn.status).not.toBe("match");
  });
});
