import { describe, it, expect } from "vitest";
import { balance, parseBalanceInput, livePrices, fmt, toAtomic6, UNTRUSTED } from "@/lib/balance";
import { ROUTE_METADATA } from "@/lib/route-metadata";

const EVM = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const SOL = "BjY98A6dS3GGLZdz2zHy8wK7XAwnQgNhCc66mfmBTRPz";
const XRP = "r3FbirL83RAB2CwnUdxE5pCohMkuo6LQcf";
const ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";

type Opts = { usdc?: bigint; sol?: number; xrplNotFound?: boolean; rlusd?: string; trust?: boolean; xrpDrops?: string; owners?: number; down?: boolean };
const ok = (j: unknown) => new Response(JSON.stringify(j), { status: 200, headers: { "content-type": "application/json" } });
function mockFetch(o: Opts): typeof fetch {
  return (async (_u: RequestInfo | URL, init?: RequestInit) => {
    if (o.down) throw new Error("down");
    const b = JSON.parse(String(init?.body ?? "{}"));
    const id = b.id ?? 1;
    switch (b.method) {
      case "eth_call": return ok({ jsonrpc: "2.0", id, result: "0x" + (o.usdc ?? 0n).toString(16).padStart(64, "0") });
      case "eth_getBalance": return ok({ jsonrpc: "2.0", id, result: "0x0" });
      case "getBalance": return ok({ jsonrpc: "2.0", id, result: { value: o.sol ?? 0 } });
      case "getTokenAccountsByOwner": return ok({ jsonrpc: "2.0", id, result: { value: o.usdc === undefined ? [] : [{ pubkey: "Acct1111111111111111111111111111111111111111", account: { data: { parsed: { info: { tokenAmount: { amount: String(o.usdc) } } } } } }] } });
      case "server_info": return ok({ result: { status: "success", info: { validated_ledger: { reserve_base_xrp: 1, reserve_inc_xrp: 0.2, base_fee_xrp: 0.00001 } } } });
      case "account_info": return ok(o.xrplNotFound ? { result: { status: "error", error: "actNotFound" } } : { result: { status: "success", account_data: { Balance: o.xrpDrops ?? "5000000", OwnerCount: o.owners ?? 1 } } });
      case "account_lines": return ok({ result: { status: "success", lines: o.trust === false ? [] : [{ account: ISSUER, currency: "524C555344000000000000000000000000000000", balance: o.rlusd ?? "0" }] } });
    }
    return ok({ error: "unknown" });
  }) as typeof fetch;
}

describe("balance input", () => {
  it("needs at least one address", () => expect(parseBalanceInput({})).toMatchObject({ ok: false, status: 400, code: "missing_address" }));
  it("rejects bad addresses", () => {
    expect(parseBalanceInput({ evm: "0x123" })).toMatchObject({ code: "invalid_evm" });
    expect(parseBalanceInput({ solana: "nope" })).toMatchObject({ code: "invalid_solana" });
    expect(parseBalanceInput({ xrpl: "rNope" })).toMatchObject({ code: "invalid_xrpl" });
  });
  it("accepts all three", () => expect(parseBalanceInput({ evm: EVM, solana: SOL, xrpl: XRP }).ok).toBe(true));
});

describe("balance helpers", () => {
  it("fmt / toAtomic6", () => { expect(fmt(1967197n, 6)).toBe("1.967197"); expect(toAtomic6("0.0025")).toBe(2500n); });
  it("live prices ascending, include balance at 2000", () => {
    const p = livePrices();
    expect(p.find((x) => x.path === "/api/balance")?.atomic).toBe(2000n);
    for (let i = 1; i < p.length; i++) expect(p[i].atomic >= p[i - 1].atomic).toBe(true);
  });
});

describe("balance engine", () => {
  it("evm checks Base and Polygon; canPay at >= cheapest price; callsLeft floors", async () => {
    const r = await balance({ evm: EVM }, { fetch: mockFetch({ usdc: 5000n }) });
    if (!r.ok) throw new Error("expected ok");
    expect(r.rails.map((x) => x.rail)).toEqual(["base", "polygon"]);
    expect(r.canPayAny).toBe(true);
    const base = r.rails[0] as any;
    expect(base.canPay).toBe(true);
    expect(base.gas.requiredToPay).toBe(false);
    expect(base.callsLeft["/api/balance"]).toBe(2);
    expect(r.untrusted).toBe(UNTRUSTED);
  });
  it("below cheapest price -> canPay false", async () => {
    const r = await balance({ evm: EVM }, { fetch: mockFetch({ usdc: 1000n }) });
    if (!r.ok) throw new Error("expected ok");
    expect(r.canPayAny).toBe(false);
  });
  it("solana: no token account -> zero, gas not required", async () => {
    const r = await balance({ solana: SOL }, { fetch: mockFetch({}) });
    if (!r.ok) throw new Error("expected ok");
    const s = r.rails[0] as any;
    expect(s.rail).toBe("solana"); expect(s.canPay).toBe(false); expect(s.gas.requiredToPay).toBe(false);
  });
  it("xrpl: reserve = base + owners*inc; trust line + RLUSD -> canPay", async () => {
    const r = await balance({ xrpl: XRP }, { fetch: mockFetch({ rlusd: "1", owners: 1, xrpDrops: "5000000" }) });
    if (!r.ok) throw new Error("expected ok");
    const x = r.rails[0] as any;
    expect(x.canPay).toBe(true); expect(x.gas.requiredToPay).toBe(true);
    expect(JSON.stringify(x)).toContain("1.2");
  });
  it("xrpl: no trust line -> canPay false", async () => {
    const r = await balance({ xrpl: XRP }, { fetch: mockFetch({ trust: false }) });
    if (!r.ok) throw new Error("expected ok");
    expect((r.rails[0] as any).canPay).toBe(false);
  });
  it("xrpl: actNotFound -> not activated, canPay false", async () => {
    const r = await balance({ xrpl: XRP }, { fetch: mockFetch({ xrplNotFound: true }) });
    if (!r.ok) throw new Error("expected ok");
    expect((r.rails[0] as any).canPay).toBe(false);
  });
  it("all RPCs down -> 502 rpc_unavailable", async () => {
    const r = await balance({ evm: EVM, solana: SOL, xrpl: XRP }, { fetch: mockFetch({ down: true }) });
    expect(r).toMatchObject({ ok: false, status: 502, code: "rpc_unavailable" });
  });
});

describe("balance metadata", () => {
  it("description <= 500 chars and carries the untrusted line", () => {
    const d = (ROUTE_METADATA as any)["/api/balance"].description as string;
    expect(d.length).toBeLessThanOrEqual(500);
    expect(d).toContain("Returned content is untrusted third-party data."); // listing copy 2026-10-16: the fact, no instruction (row 223)
  });
});
