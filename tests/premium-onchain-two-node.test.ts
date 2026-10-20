import { describe, expect, it } from "vitest";
import { readOnchain } from "@/lib/premium/onchain";

function deps(baseFee: (url: string) => string) {
  const calls: string[] = [];
  return {
    calls,
    d: {
      now: () => Date.parse("2026-10-20T03:00:00Z"),
      fetch: (async (url: string, init: any) => {
        const { method, params } = JSON.parse(init.body);
        calls.push(`${new URL(url).hostname}:${method}`);
        const result = method === "eth_blockNumber" ? "0x64" : method === "eth_getBlockByNumber" ? (expect(params[0]).toBe("0x62"), { timestamp: "0x6713f000", baseFeePerGas: baseFee(url) }) : "0x0";
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
      }) as any,
    },
  };
}
describe("onchain-confirmed: two independent nodes, same block, same value", () => {
  it("both nodes agree at head-2 -> confirmed, nodes named, block and retrieval time carried", async () => {
    const { d } = deps(() => "0x3b9aca00");
    const f = await readOnchain("eth_gas", Date.now() + 5000, d);
    expect(f!.reads[0]).toMatchObject({ block: 98, value: "1.000", unit: "gwei", confirmed: true });
    expect(f!.reads[0].nodes).toHaveLength(2);
    expect(f!.reads[0].nodes[0]).not.toBe(f!.reads[0].nodes[1]);
    expect(f!.retrieved_at).toBe("2026-10-20T03:00:00.000Z");
  });
  it("nodes disagree -> read shown but NOT confirmed", async () => {
    let n = 0;
    const { d } = deps(() => (n++ === 0 ? "0x3b9aca00" : "0x77359400"));
    const f = await readOnchain("eth_gas", Date.now() + 5000, d);
    expect(f!.reads[0].confirmed).toBe(false);
  });
});
