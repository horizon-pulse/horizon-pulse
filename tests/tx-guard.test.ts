import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { txGuard, parseTxGuardInput, expectedMatch, sdnCheck, overall, SDN_SNAPSHOT, UNTRUSTED, TX_GUARD_METHODOLOGY, NOTE, type Check } from "@/lib/tx-guard";
import { ROUTE_METADATA } from "@/lib/route-metadata";
import SDN from "@/lib/data/ofac-sdn-crypto-2026-10-14.json";

const V = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
const LOOK = "0xd8da0000000000000000000000000000000a6045";
const SOL = "BjY98A6dS3GGLZdz2zHy8wK7XAwnQgNhCc66mfmBTRPz";
const XRP = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
const SDN_ETH = (SDN.entries as { currency: string; address: string }[]).find((e) => e.currency === "ETH")!.address;
const NOW = Date.parse("2026-10-14T15:00:00Z");

const ok = (j: unknown) => new Response(JSON.stringify(j), { status: 200, headers: { "content-type": "application/json" } });
type O = { nonce?: number; code?: string; sigs?: { signature: string; blockTime: number }[]; xrplNotFound?: boolean; xrplFirst?: string; scam?: string[]; down?: boolean; scamDown?: boolean };
function mockFetch(o: O): typeof fetch {
  return (async (u: RequestInfo | URL, init?: RequestInit) => {
    if (String(u).includes("scamsniffer")) { if (o.scamDown) throw new Error("down"); return ok(o.scam ?? []); }
    if (o.down) throw new Error("down");
    const b = JSON.parse(String(init?.body ?? "{}"));
    switch (b.method) {
      case "eth_getTransactionCount": return ok({ jsonrpc: "2.0", id: 1, result: "0x" + (o.nonce ?? 0).toString(16) });
      case "eth_getCode": return ok({ jsonrpc: "2.0", id: 1, result: o.code ?? "0x" });
      case "getSignaturesForAddress": return ok({ jsonrpc: "2.0", id: 1, result: o.sigs ?? [] });
      case "account_info": return ok(o.xrplNotFound ? { result: { status: "error", error: "actNotFound" } } : { result: { status: "success", account_data: {} } });
      case "account_tx": return ok({ result: { status: "success", transactions: o.xrplFirst ? [{ close_time_iso: o.xrplFirst }] : [] } });
    }
    return ok({ error: "unknown" });
  }) as typeof fetch;
}
const deps = (o: O) => ({ fetch: mockFetch(o), now: () => NOW });

describe("tx-guard input", () => {
  it("chain and to required, addresses validated per chain", () => {
    expect(parseTxGuardInput({ to: V })).toMatchObject({ ok: false, code: "invalid_chain" });
    expect(parseTxGuardInput({ chain: "base" })).toMatchObject({ ok: false, code: "missing_to" });
    expect(parseTxGuardInput({ chain: "base", to: SOL })).toMatchObject({ ok: false, code: "invalid_to" });
    expect(parseTxGuardInput({ chain: "solana", to: SOL, expected: V })).toMatchObject({ ok: false, code: "invalid_expected" });
    expect(parseTxGuardInput({ chain: "xrpl", to: XRP, token: "nope" })).toMatchObject({ ok: false, code: "invalid_token" });
    expect(parseTxGuardInput({ chain: "BASE", to: V.toUpperCase().replace("0X", "0x") })).toMatchObject({ ok: true, input: { chain: "base", to: V } });
  });
});

describe("expected_match", () => {
  it("exact = allow, lookalike = block, other = warn, none = skipped", () => {
    expect(expectedMatch("base", V, V).result).toBe("allow");
    expect(expectedMatch("base", LOOK, V).result).toBe("block");
    expect(expectedMatch("base", "0x1111111111111111111111111111111111111111", V).result).toBe("warn");
    expect(expectedMatch("base", V).result).toBe("skipped");
  });
});

describe("ofac_sdn", () => {
  it("snapshot carries source URL, pull date and publisher date", () => {
    expect(SDN_SNAPSHOT.sourceUrl).toBe("https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV");
    expect(SDN_SNAPSHOT.pulledAt).toMatch(/^2026-10-14T/);
    expect(SDN_SNAPSHOT.publisherLastModified).toMatch(/^2026-/);
    expect(SDN_SNAPSHOT.addresses).toBe(SDN.entries.length);
  });
  it("listed EVM address (any case) = block; not listed = allow", () => {
    expect(sdnCheck("base", SDN_ETH.toLowerCase()).result).toBe("block");
    expect(sdnCheck("polygon", SDN_ETH.toLowerCase()).result).toBe("block");
    expect(sdnCheck("base", V).result).toBe("allow");
  });
});

describe("account_age", () => {
  it("EVM: never sent = warn; sent = allow; contract = allow", async () => {
    expect((await txGuard({ chain: "base", to: V }, deps({ nonce: 0 }))).checks[2].result).toBe("warn");
    expect((await txGuard({ chain: "base", to: V }, deps({ nonce: 5 }))).checks[2].result).toBe("allow");
    expect((await txGuard({ chain: "polygon", to: V }, deps({ code: "0x6080" }))).checks[2].result).toBe("allow");
  });
  it("Solana: none = warn; first seen < 24h = warn; older = allow", async () => {
    expect((await txGuard({ chain: "solana", to: SOL }, deps({ sigs: [] }))).checks[2].result).toBe("warn");
    expect((await txGuard({ chain: "solana", to: SOL }, deps({ sigs: [{ signature: "s", blockTime: NOW / 1000 - 3600 }] }))).checks[2].result).toBe("warn");
    expect((await txGuard({ chain: "solana", to: SOL }, deps({ sigs: [{ signature: "s", blockTime: NOW / 1000 - 10 * 86400 }] }))).checks[2].result).toBe("allow");
  });
  it("XRPL: not activated = warn; old = allow", async () => {
    expect((await txGuard({ chain: "xrpl", to: XRP }, deps({ xrplNotFound: true }))).checks[2].result).toBe("warn");
    expect((await txGuard({ chain: "xrpl", to: XRP }, deps({ xrplFirst: "2024-01-01T00:00:00Z" }))).checks[2].result).toBe("allow");
  });
  it("RPC down = unavailable, overall warn, still 200 shape", async () => {
    const r = await txGuard({ chain: "base", to: V, expected: V }, deps({ down: true }));
    expect(r.checks[2].result).toBe("unavailable");
    expect(r.result).toBe("warn");
  });
});

describe("scam_token", () => {
  it("listed = block, not listed = allow, list down = unavailable, non-EVM = skipped", async () => {
    const T = "0x1234567890abcdef1234567890abcdef12345678";
    expect((await txGuard({ chain: "base", to: V, token: T }, deps({ nonce: 1, scam: [T] }))).checks[3].result).toBe("block");
    const a = (await txGuard({ chain: "base", to: V, token: T }, deps({ nonce: 1, scam: [] }))).checks[3];
    expect(a.result).toBe("allow");
    expect(a.source).toContain("github.com/scamsniffer/scam-database");
    expect((await txGuard({ chain: "base", to: V, token: T }, deps({ nonce: 1, scamDown: true }))).checks[3].result).toBe("unavailable");
    expect((await txGuard({ chain: "solana", to: SOL, token: SOL }, deps({ sigs: [{ signature: "s", blockTime: 1 }] }))).checks[3].result).toBe("skipped");
  });
});

describe("overall + response", () => {
  it("block beats warn beats allow", () => {
    const c = (result: Check["result"]): Check => ({ id: "ofac_sdn", result, detail: "" });
    expect(overall([c("allow"), c("warn"), c("block")])).toBe("block");
    expect(overall([c("allow"), c("skipped"), c("unavailable")])).toBe("warn");
    expect(overall([c("allow"), c("skipped")])).toBe("allow");
  });
  it("every response carries the SDN source URL and pull date, and the untrusted line", async () => {
    const r = await txGuard({ chain: "base", to: V, expected: V }, deps({ nonce: 3 }));
    expect(r.result).toBe("allow");
    expect(r.sdnSnapshot.sourceUrl).toBe(SDN_SNAPSHOT.sourceUrl);
    expect(r.sdnSnapshot.pulledAt).toBe(SDN_SNAPSHOT.pulledAt);
    expect(r.untrusted).toBe(UNTRUSTED);
  });
});

describe("wording", () => {
  const BANNED = /complian|\bsafe\b|guarantee/i;
  it("no 'compliance', 'compliant', 'safe' or 'guarantee' in tx-guard code, docs or output", async () => {
    const r = await txGuard({ chain: "base", to: LOOK, expected: V, token: V }, deps({ scam: [V] }));
    const texts = [
      readFileSync("lib/tx-guard.ts", "utf8"),
      readFileSync("app/api/tx-guard/handler.ts", "utf8"),
      JSON.stringify(TX_GUARD_METHODOLOGY), NOTE, JSON.stringify(r),
      (ROUTE_METADATA as Record<string, { description: string }>)["/api/tx-guard"].description,
      ...readFileSync("public/llms.txt", "utf8").split("\n").filter((l) => l.includes("tx-guard")),
    ];
    for (const t of texts) expect(t).not.toMatch(BANNED);
  });
  it("description <= 500 chars with the untrusted line", () => {
    const d = (ROUTE_METADATA as Record<string, { description: string }>)["/api/tx-guard"].description;
    expect(d.length).toBeLessThanOrEqual(500);
    expect(d).toContain(UNTRUSTED);
  });
});
