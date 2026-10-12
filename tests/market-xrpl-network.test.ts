/** Odin fix 1: XRPL in canonicalNetwork (fixed table; unknown xrpl-ish values rejected) + evidence printing. */
import { describe, expect, it } from "vitest";
import { canonicalNetwork, canonicalXrplNetwork, crossCheckPayTo, UNRECOGNIZED_NETWORK } from "@/lib/market/trust";
import { evidenceNetwork } from "@/lib/market/engine";
import { isTestnet, railForNetwork } from "@/lib/market/offer";

describe("canonicalNetwork: XRPL", () => {
  it("only xrpl:0 and xrpl:1 (trim + ASCII lowercase normalisation only)", () => {
    const t: Record<string, string> = { "xrpl:0": "xrpl:0", "XRPL:0": "xrpl:0", " xrpl:0 ": "xrpl:0", "xrpl:1": "xrpl:1", "Xrpl:1\t": "xrpl:1" };
    for (const [k, v] of Object.entries(t)) expect(canonicalNetwork(k), k).toBe(v);
  });

  it("everything else xrpl-ish is unrecognized, incl. former aliases and devnet", () => {
    for (const bad of ["xrpl:2", "xrpl", "xrp", "ripple", "XRP", "xrpl-mainnet", "xrpl-testnet", "xrpl-devnet", "xrpl:3", "xrpl:01", "xrpl:0x", "xrpl:-1", "xrpl:", "xrp:0", "ripple:mainnet", "xrpl_testnet", "xrpl:1\u200b", "xrpl:ｌ"]) {
      expect(canonicalNetwork(bad), JSON.stringify(bad)).toBe(UNRECOGNIZED_NETWORK);
      expect(evidenceNetwork(bad), JSON.stringify(bad)).toBe("unrecognized network");
      expect(railForNetwork(bad), JSON.stringify(bad)).not.toBe("x402:xrpl");
    }
    expect(evidenceNetwork("ｘrpl:0")).toBe("unrecognized network");
    expect(canonicalXrplNetwork("eip155:8453")).toBeNull();
  });

  it("existing networks unchanged", () => {
    expect(canonicalNetwork("base")).toBe("eip155:8453");
    expect(canonicalNetwork("solana")).toBe("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
    expect(canonicalNetwork("eip155:84532")).toBe("eip155:84532");
  });

  it("evidence, rail and testnet check use the same two values", () => {
    expect(evidenceNetwork("xrpl:0")).toBe("xrpl:0");
    expect(evidenceNetwork(" XRPL:1")).toBe("xrpl:1");
    expect(railForNetwork("xrpl:0")).toBe("x402:xrpl");
    expect(railForNetwork("xrpl:1")).toBe("x402:xrpl");
    expect(railForNetwork("xrpl:2")).toBe("x402:other");
    expect(isTestnet("xrpl:1")).toBe(true);
    expect(isTestnet("xrpl:0")).toBe(false);
  });

  it("payTo cross-check: XRPL addresses compare exactly (case-sensitive); testnet vs mainnet are different networks", () => {
    const A = "r3FbirL83RAB2CwnUdxE5pCohMkuo6LQcf";
    const live = [{ network: "xrpl:0", payTo: A }] as never;
    expect(crossCheckPayTo(live, [{ network: "xrpl:0", payTo: A }] as never).status).toBe("match");
    const lc = crossCheckPayTo(live, [{ network: "xrpl:0", payTo: A.toLowerCase() }] as never);
    expect(lc.status).not.toBe("match");
    const tn = crossCheckPayTo(live, [{ network: "xrpl:1", payTo: A }] as never);
    expect(tn.status).not.toBe("match");
  });
});
