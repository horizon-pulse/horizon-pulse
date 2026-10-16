/**
 * /api/name/resolve — ENS and Basenames, forward and reverse, fully on-chain.
 *
 *   Forward (name=…): ENSIP-15 normalize, namehash, registry.resolver(node),
 *     then resolver.addr(node). *.base.eth names use the Basenames registry on
 *     Base; every other name uses the ENS registry on Ethereum mainnet.
 *   Reverse (address=0x…): ENS primary name (<addr>.addr.reverse on Ethereum)
 *     and Basename primary name (<addr>.80002105.reverse on Base), each
 *     checked forward (the name must resolve back to the same address).
 *
 * Off-chain and wildcard names (ENSIP-10 / CCIP-Read gateways) are NOT followed:
 * this route never calls a URL that a contract names. Such names return
 * found:false with a note.
 *
 * Registry addresses (primary sources, verified on-chain 2026-10-16):
 *   ENS Registry, Ethereum: docs.ens.domains/learn/deployments
 *   Basenames Registry, Base: github.com/base/basenames README (Base Mainnet table)
 *
 * Billing: any 200 answer, including found:false. Bad input (400) and RPCs down
 * (502): not charged.
 */

import { decodeFunctionResult, encodeFunctionData, getAddress, namehash, parseAbi } from "viem";
import { normalize } from "viem/ens";
import { RPC_SOURCES, RpcDown, UNTRUSTED_NOTE, cleanText, defaultRpcDeps, ethCall, type RpcDeps } from "@/lib/chain-rpc";

export const ENS_REGISTRY_ETHEREUM = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e" as const;
export const BASENAMES_REGISTRY_BASE = "0xb94704422c2a1e396835a571837aa5ae53285a95" as const;
const ZERO = "0x0000000000000000000000000000000000000000";

export const NAME_RESOLVE_METHODOLOGY = {
  sources: {
    ethereum: `${RPC_SOURCES.ethereum}: ENS Registry ${ENS_REGISTRY_ETHEREUM} (docs.ens.domains/learn/deployments)`,
    base: `${RPC_SOURCES.base}: Basenames Registry ${BASENAMES_REGISTRY_BASE} (github.com/base/basenames)`,
    calls: "registry.resolver(namehash), resolver.addr(namehash), resolver.name(reverse node). Names normalized per ENSIP-15 (viem).",
  },
  limits:
    "On-chain records only: off-chain and wildcard names (CCIP-Read) are not followed and return found:false. Reverse names are returned only when they resolve forward to the same address (verified true); otherwise the name is shown with verified false.",
  billing: "Billed on any 200 answer, including found:false. Bad input and RPCs unreachable: not charged.",
  untrusted: UNTRUSTED_NOTE,
} as const;

export const NAME_RESOLVE_DEADLINE_MS = 12_000;

const ABI = parseAbi([
  "function resolver(bytes32 node) view returns (address)",
  "function addr(bytes32 node) view returns (address)",
  "function name(bytes32 node) view returns (string)",
]);

export type NameInput = { mode: "forward"; name: string } | { mode: "reverse"; address: string };
export type NameParse = { ok: true; input: NameInput } | { ok: false; status: 400; code: string; error: string };

export function parseNameInput(raw: { name?: string | null; address?: string | null }): NameParse {
  const name = (raw.name ?? "").trim();
  const address = (raw.address ?? "").trim();
  if (name && address) return { ok: false, status: 400, code: "one_of", error: "Give name or address, not both" };
  if (!name && !address) return { ok: false, status: 400, code: "missing_input", error: "Give name (e.g. vitalik.eth, jesse.base.eth) or address (0x…)" };
  if (address) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return { ok: false, status: 400, code: "invalid_address", error: "address must be 0x + 40 hex" };
    return { ok: true, input: { mode: "reverse", address: getAddress(address.toLowerCase()) } };
  }
  if (name.length > 255) return { ok: false, status: 400, code: "invalid_name", error: "name is too long" };
  let norm: string;
  try {
    norm = normalize(name);
  } catch {
    return { ok: false, status: 400, code: "invalid_name", error: "name is not a valid ENS name (ENSIP-15 normalization failed)" };
  }
  if (!norm.includes(".") || norm.startsWith(".") || norm.endsWith(".")) return { ok: false, status: 400, code: "invalid_name", error: "name needs a label and a TLD, e.g. vitalik.eth" };
  return { ok: true, input: { mode: "forward", name: norm } };
}

type Registry = { system: "ens" | "basenames"; network: "ethereum" | "base"; registry: string };
const ENS: Registry = { system: "ens", network: "ethereum", registry: ENS_REGISTRY_ETHEREUM };
const BASENAMES: Registry = { system: "basenames", network: "base", registry: BASENAMES_REGISTRY_BASE };

export const registryFor = (name: string): Registry => (name.endsWith(".base.eth") ? BASENAMES : ENS);

async function readAddress(deps: RpcDeps, reg: Registry, to: string, fn: "resolver" | "addr", node: `0x${string}`, deadline: number): Promise<string | null> {
  const hex = await ethCall(deps, reg.network, to, encodeFunctionData({ abi: ABI, functionName: fn, args: [node] }), deadline);
  if (!hex) return null;
  try {
    const a = decodeFunctionResult({ abi: ABI, functionName: fn, data: hex as `0x${string}` }) as string;
    return a && a.toLowerCase() !== ZERO ? getAddress(a) : null;
  } catch {
    return null;
  }
}

async function readName(deps: RpcDeps, reg: Registry, to: string, node: `0x${string}`, deadline: number): Promise<string | null> {
  const hex = await ethCall(deps, reg.network, to, encodeFunctionData({ abi: ABI, functionName: "name", args: [node] }), deadline);
  if (!hex) return null;
  try {
    return cleanText(decodeFunctionResult({ abi: ABI, functionName: "name", data: hex as `0x${string}` }) as string, 255);
  } catch {
    return null;
  }
}

export type ForwardAnswer = { found: boolean; address: string | null; resolver: string | null; note: string | null };

async function forward(deps: RpcDeps, name: string, deadline: number): Promise<ForwardAnswer & { reg: Registry }> {
  const reg = registryFor(name);
  const node = namehash(name);
  const resolver = await readAddress(deps, reg, reg.registry, "resolver", node, deadline);
  if (!resolver) {
    return { reg, found: false, address: null, resolver: null, note: "No resolver set on-chain for this name (unregistered, or an off-chain/wildcard name: CCIP-Read is not followed)" };
  }
  const address = await readAddress(deps, reg, resolver, "addr", node, deadline);
  return { reg, found: !!address, address, resolver, note: address ? null : "The resolver has no address record for this name" };
}

export type NameResult =
  | {
      ok: true;
      mode: "forward";
      name: string;
      system: "ens" | "basenames";
      network: "ethereum" | "base";
      found: boolean;
      address: string | null;
      resolver: string | null;
      note: string | null;
      untrusted: string;
    }
  | {
      ok: true;
      mode: "reverse";
      address: string;
      found: boolean;
      ens: { name: string | null; verified: boolean };
      basename: { name: string | null; verified: boolean };
      untrusted: string;
    };
export type NameError = { ok: false; status: 502; code: "rpc_unavailable"; error: string };

async function primary(deps: RpcDeps, reg: Registry, address: string, deadline: number): Promise<{ name: string | null; verified: boolean }> {
  const suffix = reg.system === "basenames" ? "80002105.reverse" : "addr.reverse";
  const node = namehash(`${address.slice(2).toLowerCase()}.${suffix}`);
  const resolver = await readAddress(deps, reg, reg.registry, "resolver", node, deadline);
  if (!resolver) return { name: null, verified: false };
  const raw = await readName(deps, reg, resolver, node, deadline);
  if (!raw) return { name: null, verified: false };
  let name: string;
  try {
    name = normalize(raw);
  } catch {
    return { name: raw, verified: false };
  }
  // Forward check uses the registry that owns the name (a *.base.eth ENS primary name is checked on Base).
  const f = await forward(deps, name, deadline);
  return { name, verified: !!f.address && f.address.toLowerCase() === address.toLowerCase() };
}

export async function nameResolve(input: NameInput, deps: RpcDeps = defaultRpcDeps()): Promise<NameResult | NameError> {
  const deadline = deps.now() + NAME_RESOLVE_DEADLINE_MS;
  try {
    if (input.mode === "forward") {
      const f = await forward(deps, input.name, deadline);
      return { ok: true, mode: "forward", name: input.name, system: f.reg.system, network: f.reg.network, found: f.found, address: f.address, resolver: f.resolver, note: f.note, untrusted: UNTRUSTED_NOTE };
    }
    const [ens, basename] = await Promise.all([primary(deps, ENS, input.address, deadline), primary(deps, BASENAMES, input.address, deadline)]);
    return { ok: true, mode: "reverse", address: input.address, found: ens.verified || basename.verified, ens, basename, untrusted: UNTRUSTED_NOTE };
  } catch (e) {
    if (e instanceof RpcDown || e instanceof Error) {
      return { ok: false, status: 502, code: "rpc_unavailable", error: `No public RPC answered (${e.message}); not charged, retry shortly` };
    }
    return { ok: false, status: 502, code: "rpc_unavailable", error: "No public RPC answered; not charged, retry shortly" };
  }
}
