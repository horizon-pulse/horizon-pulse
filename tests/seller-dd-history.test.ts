/** Outside review #1: history source order, chunking, retry, caps, reasons; authorizationTx no longer silent. */
import { describe, expect, it } from "vitest";
import { authorizationTxDetailed, baseLogRpcs, HISTORY_MAX_CALLS, LOG_CHUNK_BLOCKS, readHistoryDetailed } from "@/lib/seller-dd/history";
import { USDC_BASE } from "@/lib/config";

const PAYTO = "0x" + "4e".repeat(20);
const HEAD = 50_000_000;
const json = (status: number, body: unknown) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": typeof body === "string" ? "text/html" : "application/json" } });
type Call = { host: string; method: string; params?: any };
function fakeFetch(handler: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const c: Call = { host: u.host, method: body?.method ?? "GET", params: body?.params };
    calls.push(c);
    return handler(c);
  }) as unknown as typeof fetch;
  let t = 1_000_000;
  return { calls, deps: { fetch: f, now: () => t, sleep: async () => { t += 250; }, env: {} as Record<string, string | undefined> } };
}
const rpcOk = (c: Call) => c.method === "eth_blockNumber" ? json(200, { jsonrpc: "2.0", id: 1, result: "0x" + HEAD.toString(16) }) : json(200, { jsonrpc: "2.0", id: 1, result: [{ topics: ["0x", "0x" + "00".repeat(12) + "ab".repeat(20)], data: "0x" + (10_000).toString(16), blockNumber: "0x" + HEAD.toString(16), transactionHash: "0x" + "cd".repeat(32) }] });

describe("provider order", () => {
  it("BASE_RPC_URL first, publicnode, mainnet.base.org, drpc LAST; deduplicated", () => {
    expect(baseLogRpcs({})).toEqual(["https://base-rpc.publicnode.com", "https://mainnet.base.org", "https://base.drpc.org"]);
    expect(baseLogRpcs({ BASE_RPC_URL: "https://keyed.example/v2/abc" })[0]).toBe("https://keyed.example/v2/abc");
    expect(baseLogRpcs({ BASE_RPC_URL: "https://base.drpc.org" })).toEqual(["https://base.drpc.org", "https://base-rpc.publicnode.com", "https://mainnet.base.org"]);
  });
});

describe("readHistoryDetailed", () => {
  it("Blockscout answers -> used first, no RPC call; only USDC transfers TO payTo counted", async () => {
    const { calls, deps } = fakeFetch(() => json(200, { items: [
      { token: { address_hash: USDC_BASE }, to: { hash: PAYTO }, from: { hash: "0x" + "ab".repeat(20) }, total: { value: "1000" }, block_number: 100 },
      { token: { address_hash: USDC_BASE }, to: { hash: PAYTO }, from: { hash: "0x" + "ab".repeat(20) }, total: { value: "2000" }, block_number: 120 },
      { token: { address_hash: "0x" + "99".repeat(20) }, to: { hash: PAYTO }, from: { hash: "0x" + "cc".repeat(20) }, total: { value: "5" }, block_number: 110 },
    ] }));
    const r = await readHistoryDetailed(PAYTO, 1_000_000 + 30_000, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.history).toMatchObject({ source: "base.blockscout.com", unique_payers: 1, repeat_payers: 1, volume_usdc: "0.003000", from_block: 100, to_block: 120 });
    expect(calls).toHaveLength(1);
  });
  it("Blockscout 403 (Cloudflare challenge) -> publicnode logs; reason recorded", async () => {
    const { calls, deps } = fakeFetch((c) => (c.host === "base.blockscout.com" ? json(403, "<!DOCTYPE html>Just a moment...") : rpcOk(c)));
    const r = await readHistoryDetailed(PAYTO, 1_000_000 + 30_000, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.attempts).toEqual([{ source: "base.blockscout.com", reason: "http_403" }]);
    expect(r.history.source).toBe("base-rpc.publicnode.com");
    expect(calls.filter((c) => c.host === "base.drpc.org")).toHaveLength(0);
  });
  it("chunking: 9,000 blocks read as contiguous chunks of <= 2,000 (5 getLogs), no gap or overlap", async () => {
    const { calls, deps } = fakeFetch((c) => (c.host === "base.blockscout.com" ? json(403, "x") : rpcOk(c)));
    const r = await readHistoryDetailed(PAYTO, 1_000_000 + 30_000, deps, 9_000);
    expect(r.ok).toBe(true);
    const ranges = calls.filter((c) => c.method === "eth_getLogs").map((c) => [Number(BigInt(c.params[0].fromBlock)), Number(BigInt(c.params[0].toBlock))]);
    expect(ranges).toHaveLength(5);
    expect(ranges[0]![0]).toBe(HEAD - 8_999);
    expect(ranges[ranges.length - 1]![1]).toBe(HEAD);
    for (let i = 0; i < ranges.length; i++) {
      expect(ranges[i]![1] - ranges[i]![0] + 1).toBeLessThanOrEqual(LOG_CHUNK_BLOCKS);
      if (i) expect(ranges[i]![0]).toBe(ranges[i - 1]![1] + 1);
    }
    if (r.ok) expect(r.history.window_blocks).toBe(9_000);
  });
  it("429 -> exactly ONE retry on the same provider, then success", async () => {
    let n = 0;
    const { calls, deps } = fakeFetch((c) => {
      if (c.host === "base.blockscout.com") return json(403, "x");
      if (c.host === "base-rpc.publicnode.com" && c.method === "eth_blockNumber" && n++ === 0) return json(429, { error: { code: -32011, message: "request limit reached" } });
      return rpcOk(c);
    });
    const r = await readHistoryDetailed(PAYTO, 1_000_000 + 30_000, deps, 1_000);
    expect(r.ok).toBe(true);
    expect(calls.filter((c) => c.host === "base-rpc.publicnode.com" && c.method === "eth_blockNumber")).toHaveLength(2);
  });
  it("400 (range refused) is NOT retried: next provider", async () => {
    const { calls, deps } = fakeFetch((c) => {
      if (c.host === "base.blockscout.com") return json(403, "x");
      if (c.host !== "base.drpc.org") return json(400, { error: { code: 35, message: "ranges over 10000 blocks are not supported on free plan" } });
      return rpcOk(c);
    });
    const r = await readHistoryDetailed(PAYTO, 1_000_000 + 30_000, deps, 1_000);
    expect(r.ok).toBe(true);
    expect(calls.filter((c) => c.host === "base-rpc.publicnode.com")).toHaveLength(1);
    if (r.ok) expect(r.attempts.map((a) => a.reason)).toContain("head:http_400:ranges over 10000 blocks are not supported on free plan");
  });
  it("every source fails -> ok:false with a reason per source; never more than 12 calls", async () => {
    const { calls, deps } = fakeFetch((c) => (c.host === "base.blockscout.com" ? json(403, "x") : json(503, {})));
    const r = await readHistoryDetailed(PAYTO, 1_000_000 + 30_000, deps);
    expect(r.ok).toBe(false);
    expect(calls.length).toBeLessThanOrEqual(HISTORY_MAX_CALLS);
    expect(r.attempts.map((a) => a.source)).toEqual(["base.blockscout.com", "base-rpc.publicnode.com", "mainnet.base.org", "base.drpc.org"]);
    expect(r.attempts[1]!.reason).toBe("head:http_503;retry:http_503");
  });
  it("6 s total budget: slow providers stop the read (time_cap), result is a failure not a partial count", async () => {
    let t = 0;
    const deps = { fetch: (async () => { t += 2_500; return json(503, {}); }) as unknown as typeof fetch, now: () => t, sleep: async () => undefined, env: {} };
    const r = await readHistoryDetailed(PAYTO, 60_000, deps);
    expect(r.ok).toBe(false);
    expect(r.attempts.some((a) => /time_cap/.test(a.reason))).toBe(true);
  });
  it("a chunk unreadable on every provider -> failure (no partial history)", async () => {
    let logs = 0;
    const { deps } = fakeFetch((c) => (c.host === "base.blockscout.com" ? json(403, "x") : c.method === "eth_getLogs" && logs++ >= 1 ? json(400, { error: { message: "nope" } }) : rpcOk(c)));
    const r = await readHistoryDetailed(PAYTO, 1_000_000 + 30_000, deps, 4_000);
    expect(r.ok).toBe(false);
  });
});

describe("authorizationTxDetailed (was silent)", () => {
  it("falls back across providers and returns the tx", async () => {
    const { deps } = fakeFetch((c) => (c.host === "base-rpc.publicnode.com" ? json(429, {}) : rpcOk(c)));
    const r = await authorizationTxDetailed("0x" + "20".repeat(20), "0x" + "11".repeat(32), 1_000_000 + 30_000, deps);
    expect(r.tx).toBe("0x" + "cd".repeat(32));
    expect(r.attempts[0]).toEqual({ source: "base-rpc.publicnode.com", reason: "head:http_429;retry:http_429" });
  });
  it("all providers fail -> tx null WITH reasons", async () => {
    const { deps } = fakeFetch(() => json(500, {}));
    const r = await authorizationTxDetailed("0x" + "20".repeat(20), "0x" + "11".repeat(32), 1_000_000 + 30_000, deps);
    expect(r.tx).toBeNull();
    expect(r.attempts.length).toBeGreaterThan(0);
  });
});
