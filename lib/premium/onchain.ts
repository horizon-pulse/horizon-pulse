/**
 * Hardened $1 brief (Michael 10/19, Claude research §4.6): live on-chain values are read from the chain itself, the source
 * of record, through the existing approved public RPC fallbacks in lib/chain-rpc.ts (no new accounts or keys). Each value
 * is cited with chain, block number and block timestamp. These are NOT web quotes and are never shown as "confirmed by"
 * a publisher; they carry source_tier "onchain".
 */
import { defaultRpcDeps, hexToBig, obj, readJsonCapped, rpcCall, rpcs, RPC_TIMEOUT_MS, type ChainNetwork, type RpcDeps } from "../chain-rpc";

export const USDC_CONTRACTS: { chain: ChainNetwork; address: string }[] = [
  { chain: "ethereum", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" }, // Circle USDC (Ethereum)
  { chain: "base", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }, // Circle native USDC (Base)
];
const TOTAL_SUPPLY = "0x18160ddd";

export type OnchainTopic = "usdc_supply" | "eth_gas" | "base_gas";
export function onchainTopic(q: string): OnchainTopic | null {
  if (/\busdc\b/i.test(q) && /\b(supply|circulation|circulating|outstanding|minted)\b/i.test(q)) return "usdc_supply";
  if (/\bgas\b/i.test(q) && /\b(ethereum|mainnet|eth)\b/i.test(q) && !/\b(base|arbitrum|optimism|polygon|solana)\b/i.test(q)) return "eth_gas";
  return null;
}

export type OnchainRead = { chain: ChainNetwork; block: number; timestamp: string; method: string; contract?: string; value: string; unit: string; nodes: string[]; confirmed: boolean };
export type OnchainFact = { source_tier: "onchain"; retrieved_at: string; topic: OnchainTopic; line: string; reads: OnchainRead[]; note: string };

/** One JSON-RPC call against ONE node (no fallback), so two answers come from two independent nodes. */
async function one(deps: RpcDeps, url: string, method: string, params: unknown, deadline: number): Promise<unknown> {
  const budget = Math.min(RPC_TIMEOUT_MS, deadline - deps.now());
  if (budget <= 0) throw new Error("budget");
  const res = await deps.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(budget) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = obj(await readJsonCapped(res));
  if (!j || j.error) throw new Error("rpc_error");
  return j.result;
}
const host = (u: string) => { try { return new URL(u).hostname; } catch { return "rpc"; } };
const iso = (ts: bigint) => new Date(Number(ts) * 1000).toISOString().replace(/\.000Z$/, "Z");
const fmt6 = (v: bigint) => (v / 1_000_000n).toLocaleString("en-US");
const gwei = (wei: bigint) => (Number(wei) / 1e9).toFixed(3);
export const ONCHAIN_CONFIRM_LAG = 2n; // read 2 blocks behind head so both nodes have it

/**
 * Spec §1 onchain-confirmed: two independent nodes report the same value at the same block. Block N = head(node A) - 2;
 * block N's timestamp and the value are read from node A and node B; confirmed only when both agree byte-for-byte.
 */
async function pinned(deps: RpcDeps, chain: ChainNetwork, deadline: number, read: (url: string, blockHex: string, blk: any) => Promise<string | null>) {
  const urls = rpcs(chain).slice(0, 3);
  if (urls.length < 2) return null;
  const headHex = await one(deps, urls[0], "eth_blockNumber", [], deadline);
  const h = hexToBig(headHex);
  if (h === null) return null;
  const n = h - ONCHAIN_CONFIRM_LAG;
  const bh = `0x${n.toString(16)}`;
  const answers: { url: string; v: string; ts: bigint }[] = [];
  for (const url of urls) {
    if (answers.length >= 2) break;
    try {
      const blk = obj(await one(deps, url, "eth_getBlockByNumber", [bh, false], deadline));
      const ts = hexToBig(blk?.timestamp);
      const v = await read(url, bh, blk);
      if (ts !== null && v !== null) answers.push({ url, v, ts });
    } catch {
      /* next node */
    }
  }
  if (!answers.length) return null;
  const confirmed = answers.length >= 2 && answers[0].v === answers[1].v && answers[0].ts === answers[1].ts;
  return { block: Number(n), ts: answers[0].ts, v: answers[0].v, nodes: answers.map((a) => host(a.url)), confirmed };
}

/** Read the live value; null when the topic does not apply or reads fail (the brief then relies on web sources). */
export async function readOnchain(topic: OnchainTopic, deadline: number, deps: RpcDeps = defaultRpcDeps()): Promise<OnchainFact | null> {
  try {
    const reads: OnchainRead[] = [];
    if (topic === "usdc_supply") {
      const got = await Promise.all(USDC_CONTRACTS.map(async (c) => ({ c, p: await pinned(deps, c.chain, deadline, async (url, bh) => {
          const v = hexToBig(await one(deps, url, "eth_call", [{ to: c.address, data: TOTAL_SUPPLY }, bh], deadline));
          return v === null ? null : v.toString();
        }) })));
      for (const { c, p } of got) {
        if (!p) continue;
        reads.push({ chain: c.chain, block: p.block, timestamp: iso(p.ts), method: "totalSupply()", contract: c.address, value: fmt6(BigInt(p.v)), unit: "USDC", nodes: p.nodes, confirmed: p.confirmed });
      }
      if (!reads.length) return null;
      const line = reads.map((r) => `${r.value} USDC on ${r.chain === "ethereum" ? "Ethereum" : "Base"} (totalSupply() at block ${r.block}, ${r.timestamp})`).join("; ");
      return { source_tier: "onchain", retrieved_at: new Date(deps.now()).toISOString(), topic, line: `USDC supply read on-chain: ${line}.`, reads, note: "Read directly from Circle's USDC contracts on Ethereum and Base at a pinned block by two independent nodes; other chains are not included, so this is not the all-chain total." };
    }
    // Gas topics (Ethereum mainnet or Base): base fee AND block gas limit of the same pinned block; both nodes must agree on both.
    const chain: ChainNetwork = topic === "base_gas" ? "base" : "ethereum";
    const name = chain === "base" ? "Base" : "Ethereum mainnet";
    const p = await pinned(deps, chain, deadline, async (_url, _bh, blk) => {
      const b = hexToBig(blk?.baseFeePerGas);
      const l = hexToBig(blk?.gasLimit);
      return b === null || l === null ? null : `${b}|${l}`;
    });
    if (!p) return null;
    const [bf, gl] = p.v.split("|").map((x) => BigInt(x));
    const ts = iso(p.ts);
    reads.push({ chain, block: p.block, timestamp: ts, method: "baseFeePerGas", value: gwei(bf), unit: "gwei", nodes: p.nodes, confirmed: p.confirmed });
    reads.push({ chain, block: p.block, timestamp: ts, method: "gasLimit", value: gl.toLocaleString("en-US"), unit: "gas", nodes: p.nodes, confirmed: p.confirmed });
    return { source_tier: "onchain", retrieved_at: new Date(deps.now()).toISOString(), topic, line: `${name} base fee read on-chain: ${reads[0].value} gwei (block ${p.block}, ${ts}).`, reads, note: `Base fee per gas and gas limit of the cited ${name} block, read by two independent nodes; the base fee changes every block. Priority tips are paid on top.` };
  } catch {
    return null;
  }
}
