/**
 * /api/chain/head — current chain tip for Base, Polygon PoS, Ethereum, Solana
 * and the XRP Ledger in one call. Read-only, free public RPCs, no keys.
 *
 * Per network: chain id, head height (block / slot / ledger index), head time,
 * head age, finalized height (EVM "finalized" tag; Solana commitment
 * "finalized"; XRPL validated ledger) and the gap between them.
 *
 * Billing: billed when at least one requested network answers (the others carry
 * a per-network error). Bad input (400) and every requested network down (502):
 * not charged.
 */

import {
  CHAIN_NETWORKS,
  CHAIN_ORDER,
  NETWORK_HINT,
  RPC_SOURCES,
  RpcDown,
  defaultRpcDeps,
  hexToBig,
  obj,
  parseNetwork,
  rpcCall,
  type ChainNetwork,
  type RpcDeps,
} from "@/lib/chain-rpc";

export const CHAIN_HEAD_METHODOLOGY = {
  sources: {
    ...RPC_SOURCES,
    calls:
      "EVM: eth_chainId, eth_getBlockByNumber(latest), eth_getBlockByNumber(finalized). Solana: getSlot (confirmed and finalized), getBlockTime. XRPL: ledger (validated).",
  },
  finality:
    "EVM: the RPC's 'finalized' block tag (Base: L1-finalized; Polygon PoS: milestone-finalized; Ethereum: Casper FFG finalized). Solana: commitment 'finalized'. XRPL: the validated ledger is final, so finalizedHeight equals height.",
  billing: "Billed when at least one requested network answers. Bad input and every requested network unreachable: not charged.",
} as const;

export const CHAIN_HEAD_DEADLINE_MS = 12_000;

export type HeadInput = { networks: ChainNetwork[] };
export type HeadParse = { ok: true; input: HeadInput } | { ok: false; status: 400; code: string; error: string };

export function parseHeadInput(raw: { network?: string | null }): HeadParse {
  const s = (raw.network ?? "").trim();
  if (!s) return { ok: true, input: { networks: [...CHAIN_ORDER] } };
  if (s.length > 200) return { ok: false, status: 400, code: "invalid_network", error: "network is too long" };
  const out: ChainNetwork[] = [];
  for (const part of s.split(",")) {
    if (!part.trim()) continue;
    const n = parseNetwork(part);
    if (!n) return { ok: false, status: 400, code: "invalid_network", error: `network must be a comma list of ${NETWORK_HINT}` };
    if (!out.includes(n)) out.push(n);
  }
  if (!out.length) return { ok: false, status: 400, code: "invalid_network", error: `network must be a comma list of ${NETWORK_HINT}` };
  return { ok: true, input: { networks: CHAIN_ORDER.filter((n) => out.includes(n)) } };
}

export type HeadRow = {
  network: ChainNetwork;
  caip2: string;
  chainId: number | null;
  unit: "block" | "slot" | "ledger";
  height: number | null;
  headTime: string | null;
  headAgeSeconds: number | null;
  finalizedHeight: number | null;
  finalityGap: number | null;
  error: string | null;
};

export type HeadResult = { ok: true; count: number; answered: number; heads: HeadRow[] };
export type HeadError = { ok: false; status: 502; code: "rpc_unavailable"; error: string };

function row(network: ChainNetwork): HeadRow {
  const m = CHAIN_NETWORKS[network];
  return { network, caip2: m.caip2, chainId: null, unit: m.unit, height: null, headTime: null, headAgeSeconds: null, finalizedHeight: null, finalityGap: null, error: null };
}

const age = (deps: RpcDeps, iso: string | null) => (iso ? Math.max(0, Math.round((deps.now() - Date.parse(iso)) / 1000)) : null);
const gap = (h: number | null, f: number | null) => (h !== null && f !== null ? Math.max(0, h - f) : null);

async function evmHead(deps: RpcDeps, network: ChainNetwork, deadline: number): Promise<HeadRow> {
  const r = row(network);
  const [cid, latest] = await Promise.all([
    rpcCall(deps, network, "eth_chainId", [], deadline),
    rpcCall(deps, network, "eth_getBlockByNumber", ["latest", false], deadline),
  ]);
  const n = hexToBig(obj(latest)?.number);
  if (n === null) throw new RpcDown("no latest block");
  const ts = hexToBig(obj(latest)?.timestamp);
  let fin: bigint | null = null;
  try {
    fin = hexToBig(obj(await rpcCall(deps, network, "eth_getBlockByNumber", ["finalized", false], deadline))?.number);
  } catch {
    /* finalized tag optional */
  }
  const c = hexToBig(cid);
  r.chainId = c !== null ? Number(c) : null;
  r.height = Number(n);
  r.headTime = ts !== null ? new Date(Number(ts) * 1000).toISOString() : null;
  r.headAgeSeconds = age(deps, r.headTime);
  r.finalizedHeight = fin !== null ? Number(fin) : null;
  r.finalityGap = gap(r.height, r.finalizedHeight);
  return r;
}

async function solanaHead(deps: RpcDeps, deadline: number): Promise<HeadRow> {
  const r = row("solana");
  const [conf, fin] = await Promise.all([
    rpcCall(deps, "solana", "getSlot", [{ commitment: "confirmed" }], deadline),
    rpcCall(deps, "solana", "getSlot", [{ commitment: "finalized" }], deadline).catch(() => null),
  ]);
  if (typeof conf !== "number") throw new RpcDown("no slot");
  r.height = conf;
  r.finalizedHeight = typeof fin === "number" ? fin : null;
  // headTime is the block time of the head slot (confirmed); a skipped or not-yet-available slot leaves it null.
  try {
    const t = await rpcCall(deps, "solana", "getBlockTime", [conf], deadline);
    if (typeof t === "number") {
      r.headTime = new Date(t * 1000).toISOString();
      r.headAgeSeconds = age(deps, r.headTime);
    }
  } catch {
    /* block time optional */
  }
  r.finalityGap = gap(r.height, r.finalizedHeight);
  return r;
}

async function xrplHead(deps: RpcDeps, deadline: number): Promise<HeadRow> {
  const r = row("xrpl");
  const res = obj(await rpcCall(deps, "xrpl", "ledger", { ledger_index: "validated" }, deadline));
  const led = obj(res?.ledger);
  const idx = typeof res?.ledger_index === "number" ? res.ledger_index : Number(led?.ledger_index);
  if (!Number.isFinite(idx) || idx <= 0) throw new RpcDown(String(res?.error ?? "no validated ledger"));
  r.height = idx;
  r.finalizedHeight = idx;
  r.finalityGap = 0;
  const close = typeof led?.close_time === "number" ? led.close_time : null; // seconds since 2000-01-01
  if (close !== null) {
    r.headTime = new Date((close + 946684800) * 1000).toISOString();
    r.headAgeSeconds = age(deps, r.headTime);
  }
  return r;
}

/** Per-network answer cache (Odin review 2026-10-16): repeat callers within this window share one upstream read. */
export const CHAIN_HEAD_CACHE_MS = 1_500;
const headCache = new Map<ChainNetwork, { at: number; row: HeadRow }>();

/** Test hook: clear the per-network cache. */
export function __resetChainHeadCacheForTests(): void {
  headCache.clear();
}

export async function chainHead(input: HeadInput, deps: RpcDeps = defaultRpcDeps()): Promise<HeadResult | HeadError> {
  const deadline = deps.now() + CHAIN_HEAD_DEADLINE_MS;
  const heads = await Promise.all(
    input.networks.map(async (n) => {
      const hit = headCache.get(n);
      if (hit && deps.now() - hit.at >= 0 && deps.now() - hit.at < CHAIN_HEAD_CACHE_MS) {
        return { ...hit.row, headAgeSeconds: age(deps, hit.row.headTime) };
      }
      try {
        const r = n === "solana" ? await solanaHead(deps, deadline) : n === "xrpl" ? await xrplHead(deps, deadline) : await evmHead(deps, n, deadline);
        if (r.error === null) headCache.set(n, { at: deps.now(), row: r });
        return r;
      } catch (e) {
        return { ...row(n), error: `No public ${n} RPC answered (${e instanceof Error ? e.message : "error"})` };
      }
    }),
  );
  const answered = heads.filter((h) => h.error === null).length;
  if (!answered) {
    return { ok: false, status: 502, code: "rpc_unavailable", error: "No requested network answered; not charged, retry shortly" };
  }
  return { ok: true, count: heads.length, answered, heads };
}
