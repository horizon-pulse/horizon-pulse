/**
 * Live x402 terms → normalized accepts, and the payTo cross-check between the
 * live 402 and the index (CDP Bazaar) entry for the same resource.
 *
 * A payTo that differs between the two is the strongest signal we have of a
 * hijacked seller domain, a poisoned listing or a stale index entry, so it is
 * always a hard "do not pay" (verdict avoid, no ready buy plan). Pure
 * functions: no network.
 */
import { networkLabel, payToKey } from "@/lib/bazaar-check";
import { SOLANA_MAINNET_CAIP2 } from "@/lib/solana-config";
import { formatUnits, knownAsset } from "@/lib/x402-check";
import { isTestnet, railForNetwork, type OfferAccept, type PayToCrossCheck } from "./offer";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length ? v : null);

export const MAX_ACCEPTS = 10;

/** One raw accepts entry (v2 `amount`, v1 `maxAmountRequired`) → OfferAccept. */
export function normalizeAccept(a0: unknown): OfferAccept | null {
  const a = obj(a0);
  if (!a) return null;
  const network = str(a.network);
  if (!network) return null;
  const asset = str(a.asset);
  const amountAtomic = str(a.amount) ?? str(a.maxAmountRequired);
  const known = asset ? knownAsset(asset) : undefined;
  const amt = amountAtomic && known ? formatUnits(amountAtomic, known.decimals) : null;
  return {
    rail: railForNetwork(network),
    network,
    scheme: str(a.scheme),
    asset,
    assetLabel: known?.label ?? null,
    amountAtomic,
    amountUsd: amt && known?.usd ? `$${amt}` : null,
    payTo: str(a.payTo),
    maxTimeoutSeconds: typeof a.maxTimeoutSeconds === "number" ? a.maxTimeoutSeconds : null,
    testnet: isTestnet(network),
  };
}

export function normalizeAccepts(list: unknown): OfferAccept[] {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_ACCEPTS).map(normalizeAccept).filter((x): x is OfferAccept => Boolean(x));
}

/** Lowest USD price across mainnet accepts with a known USD asset, as a number (null if none). */
export function minUsd(accepts: OfferAccept[]): number | null {
  const v = accepts
    .filter((a) => !a.testnet && a.amountUsd)
    .map((a) => Number(a.amountUsd!.slice(1)))
    .filter((n) => Number.isFinite(n));
  return v.length ? Math.min(...v) : null;
}

/**
 * One form per network before any comparison (Odin B1): "base" and
 * "eip155:8453" -> "eip155:8453"; "solana" and the Solana MAINNET genesis
 * CAIP-2 -> SOLANA_MAINNET_CAIP2. Reuses bazaar-check's networkLabel for
 * the aliases, but only the mainnet genesis is merged into "solana" here:
 * a devnet/testnet solana:* id stays its own network (bazaar-check's label
 * groups every solana:* for display only; a payTo comparison must not).
 * Anything else: trimmed, lowercased (EVM CAIP-2 ids are case-insensitive).
 */
/**
 * XRPL networks (x402 exact-XRPL spec CAIP-2): a FIXED table. xrpl:0 mainnet,
 * xrpl:1 testnet, xrpl:2 devnet, plus a fixed alias list. Any other xrpl-ish
 * value (xrpl:3, xrpl:01, "xrpl:0 ", Unicode lookalikes after trim, …) is
 * UNRECOGNIZED_NETWORK, never passed through (b381a16 rule).
 */
export const UNRECOGNIZED_NETWORK = "unrecognized network" as const;
export const XRPL_NETWORKS: Readonly<Record<string, "xrpl:0" | "xrpl:1" | "xrpl:2">> = Object.freeze({
  "xrpl:0": "xrpl:0",
  "xrpl:1": "xrpl:1",
  "xrpl:2": "xrpl:2",
  xrpl: "xrpl:0",
  "xrpl-mainnet": "xrpl:0",
  xrp: "xrpl:0",
  ripple: "xrpl:0",
  "xrpl-testnet": "xrpl:1",
  "xrpl-devnet": "xrpl:2",
});
/** Exact-match lookup (after trim + ASCII lowercase); anything xrpl-shaped that is not listed → unrecognized. */
export function canonicalXrplNetwork(n: string): "xrpl:0" | "xrpl:1" | "xrpl:2" | typeof UNRECOGNIZED_NETWORK | null {
  const t = n.trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(XRPL_NETWORKS, t)) return XRPL_NETWORKS[t];
  if (/^xrpl[:\-_]|^xrp[:\-_]|^ripple[:\-_]/.test(t)) return UNRECOGNIZED_NETWORK;
  return null;
}

export function canonicalNetwork(n: string): string {
  const t = n.trim();
  const x = canonicalXrplNetwork(t);
  if (x) return x;
  if (t === SOLANA_MAINNET_CAIP2 || t.toLowerCase() === "solana") return SOLANA_MAINNET_CAIP2;
  const label = networkLabel(t.toLowerCase());
  if (label === "base") return "eip155:8453";
  return t.toLowerCase();
}
const netKey = canonicalNetwork;

/**
 * Compare payTos per network. EVM addresses compare case-insensitively
 * (checksum casing), Solana/base58 exactly (payToKey). Never prefix/suffix
 * matching: a lookalike that shares the first and last characters is a
 * mismatch.
 */
export function crossCheckPayTo(
  live: OfferAccept[],
  indexed: OfferAccept[] | null,
  opts: { indexUnavailable?: boolean } = {},
): PayToCrossCheck {
  if (opts.indexUnavailable)
    return { status: "index_unavailable", networks: [], message: "The index (CDP Bazaar) could not be read in time, so the live payTo is unverified against it." };
  if (!indexed || indexed.length === 0)
    return {
      status: "not_indexed",
      networks: [],
      message: "No index (CDP Bazaar) entry for this resource, so the live payTo cannot be cross-checked. Treat the seller as unverified.",
    };
  const nets = new Map<string, { network: string; live: Set<string>; idx: Set<string>; liveRaw: string[]; idxRaw: string[] }>();
  const put = (a: OfferAccept, side: "live" | "idx") => {
    if (!a.payTo) return;
    const k = netKey(a.network);
    const cur = nets.get(k) ?? { network: k, live: new Set(), idx: new Set(), liveRaw: [], idxRaw: [] };
    const key = payToKey(a.payTo);
    if (!cur[side].has(key)) {
      cur[side].add(key);
      (side === "live" ? cur.liveRaw : cur.idxRaw).push(a.payTo);
    }
    nets.set(k, cur);
  };
  live.forEach((a) => put(a, "live"));
  indexed.forEach((a) => put(a, "idx"));

  const networks: PayToCrossCheck["networks"] = [];
  let mismatch = false;
  let overlap = 0;
  let oneSided = 0;
  for (const n of nets.values()) {
    const both = n.live.size > 0 && n.idx.size > 0;
    let agree: boolean | null = null;
    if (both) {
      overlap += 1;
      agree = [...n.live].every((p) => n.idx.has(p));
      if (!agree) mismatch = true;
    } else oneSided += 1;
    networks.push({ network: n.network, rail: railForNetwork(n.network), live: n.liveRaw.join(",") || null, indexed: n.idxRaw.join(",") || null, agree });
  }
  if (mismatch) {
    const bad = networks.filter((x) => x.agree === false).map((x) => x.network).join(", ");
    return {
      status: "mismatch",
      networks,
      message: `payTo MISMATCH on ${bad}: the live 402 asks for a different address than the index lists. Possible hijacked domain, poisoned listing or stale index entry. Do not pay until the seller confirms the address out of band.`,
    };
  }
  if (overlap > 0 && oneSided === 0) return { status: "match", networks, message: "Every network's live payTo matches the index entry exactly." };
  if (overlap > 0)
    return {
      status: "partial",
      networks,
      message:
        "The live payTo matches the index only on the networks both list. Networks on one side only (a new network, a dropped one, or a stale index) are unverified: never pay them on this check.",
    };
  return {
    status: "no_common_network",
    networks,
    message: "The live 402 and the index list no network in common, so no payTo could be verified. Treat the seller as unverified.",
  };
}

/** Canonical networks on which the live payTo agrees with the index (partial plans are limited to these). */
export function agreeingNetworks(cross: PayToCrossCheck): Set<string> {
  return new Set(cross.networks.filter((n) => n.agree === true).map((n) => canonicalNetwork(n.network)));
}

/** Same network + same atomic amount + same asset on both sides, for every live network the index also lists. */
export function priceMatchesIndex(live: OfferAccept[], indexed: OfferAccept[]): boolean | null {
  let compared = 0;
  for (const l of live) {
    const i = indexed.find((x) => netKey(x.network) === netKey(l.network) && x.asset === l.asset);
    if (!i) continue;
    compared += 1;
    if (i.amountAtomic !== l.amountAtomic) return false;
  }
  return compared ? true : null;
}
