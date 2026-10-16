/**
 * /api/token/meta — token metadata from chain state, one token per call.
 *
 *   EVM (Base, Polygon PoS, Ethereum): eth_getCode + eth_call name(), symbol(),
 *     decimals(), totalSupply(). Strings may be ABI `string` or `bytes32`.
 *   Solana: getAccountInfo(jsonParsed) on the mint: program (spl-token or
 *     spl-token-2022), decimals, supply, mint and freeze authority, and the
 *     on-chain tokenMetadata extension (name, symbol) when a Token-2022 mint has
 *     one. Classic SPL names live in a separate metadata program and are not
 *     read: name and symbol are null there.
 *   XRPL issued tokens (token = CURRENCY.rIssuer): account_info on the issuer
 *     (flags, domain, transfer rate) and gateway_balances (total issued).
 *
 * Read-only free public RPCs, no keys, no third-party token lists, no prices.
 * Billing: any 200 answer, including found:false (nothing at that address is a
 * token). Bad input (400) and RPC down (502): not charged.
 */

import { decodeAbiParameters, getAddress, hexToString } from "viem";
import {
  CHAIN_NETWORKS,
  NETWORK_HINT,
  RPC_SOURCES,
  RpcDown,
  UNTRUSTED_NOTE,
  cleanText,
  defaultRpcDeps,
  ethCall,
  formatUnits,
  hexToBig,
  obj,
  parseNetwork,
  rpcCall,
  type ChainNetwork,
  type RpcDeps,
} from "@/lib/chain-rpc";

export const TOKEN_META_METHODOLOGY = {
  sources: {
    ...RPC_SOURCES,
    calls:
      "EVM: eth_getCode, eth_call name() symbol() decimals() totalSupply(). Solana: getAccountInfo (jsonParsed) on the mint. XRPL: account_info and gateway_balances on the issuer (validated ledger).",
  },
  limits:
    "Names and symbols are whatever the contract or issuer set; anyone can deploy a token called USDC. No price, no verification against token lists. Classic SPL tokens: name/symbol null (metadata program not read).",
  billing: "Billed on any 200 answer, including found:false. Bad input and RPCs unreachable: not charged.",
  untrusted: UNTRUSTED_NOTE,
} as const;

export const TOKEN_META_DEADLINE_MS = 12_000;

const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;
const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const XRPL_ACCOUNT = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const XRPL_CUR3 = /^[A-Za-z0-9?!@#$%^&*<>(){}[\]|]{3}$/;
const XRPL_CURHEX = /^[0-9A-Fa-f]{40}$/;

export type TokenInput =
  | { network: "base" | "polygon" | "ethereum"; kind: "evm"; token: string }
  | { network: "solana"; kind: "solana"; token: string }
  | { network: "xrpl"; kind: "xrpl"; token: string; currency: string; issuer: string };

export type TokenParse = { ok: true; input: TokenInput } | { ok: false; status: 400; code: string; error: string };

export function parseTokenInput(raw: { network?: string | null; token?: string | null }): TokenParse {
  const token = (raw.token ?? "").trim();
  if (!token) return { ok: false, status: 400, code: "missing_token", error: "Query param token is required (0x contract address, Solana mint, or XRPL CURRENCY.rIssuer)" };
  if (token.length > 100) return { ok: false, status: 400, code: "invalid_token", error: "token is too long" };
  const n = (raw.network ?? "").trim();
  if (!n) return { ok: false, status: 400, code: "missing_network", error: `Query param network is required: ${NETWORK_HINT}` };
  const network = parseNetwork(n);
  if (!network) return { ok: false, status: 400, code: "invalid_network", error: `network must be one of ${NETWORK_HINT}` };
  if (network === "solana") {
    if (!SOL_ADDR.test(token)) return { ok: false, status: 400, code: "invalid_token", error: "Solana token must be a base58 mint address" };
    return { ok: true, input: { network, kind: "solana", token } };
  }
  if (network === "xrpl") {
    const m = token.split(/[.:]/);
    if (m.length !== 2) return { ok: false, status: 400, code: "invalid_token", error: "XRPL token must be CURRENCY.rIssuer (e.g. USD.r… or a 40-hex currency code)" };
    const [cur, issuer] = m;
    if (!(XRPL_CUR3.test(cur) || XRPL_CURHEX.test(cur)) || cur.toUpperCase() === "XRP") return { ok: false, status: 400, code: "invalid_token", error: "XRPL currency must be a 3-character code (not XRP) or 40 hex characters" };
    if (!XRPL_ACCOUNT.test(issuer)) return { ok: false, status: 400, code: "invalid_token", error: "XRPL issuer must be a classic r… address" };
    const currency = XRPL_CURHEX.test(cur) ? cur.toUpperCase() : cur;
    return { ok: true, input: { network, kind: "xrpl", token: `${currency}.${issuer}`, currency, issuer } };
  }
  if (!EVM_ADDR.test(token)) return { ok: false, status: 400, code: "invalid_token", error: `${network} token must be a 0x + 40 hex contract address` };
  return { ok: true, input: { network, kind: "evm", token: getAddress(token.toLowerCase()) } };
}

export type TokenResult = {
  ok: true;
  network: ChainNetwork;
  caip2: string;
  token: string;
  found: boolean;
  standard: string | null;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  totalSupply: { atomic: string; amount: string | null } | null;
  details: Record<string, unknown>;
  note: string | null;
  untrusted: string;
};
export type TokenError = { ok: false; status: 502; code: "rpc_unavailable"; error: string };

const SEL = { name: "0x06fdde03", symbol: "0x95d89b41", decimals: "0x313ce567", totalSupply: "0x18160ddd" } as const;

/** ABI string, or bytes32 (older tokens), or null. */
export function decodeAbiText(hex: string | null): string | null {
  if (!hex || hex.length < 66) return null;
  try {
    if (hex.length > 66) {
      const [s] = decodeAbiParameters([{ type: "string" }], hex as `0x${string}`);
      return cleanText(s);
    }
  } catch {
    /* fall through to bytes32 */
  }
  try {
    return cleanText(hexToString(hex.slice(0, 66) as `0x${string}`, { size: 32 }).replace(/\u0000+$/g, ""));
  } catch {
    return null;
  }
}

function base(input: TokenInput): TokenResult {
  return {
    ok: true,
    network: input.network,
    caip2: CHAIN_NETWORKS[input.network].caip2,
    token: input.token,
    found: false,
    standard: null,
    name: null,
    symbol: null,
    decimals: null,
    totalSupply: null,
    details: {},
    note: null,
    untrusted: UNTRUSTED_NOTE,
  };
}

async function evmMeta(deps: RpcDeps, input: Extract<TokenInput, { kind: "evm" }>, deadline: number): Promise<TokenResult> {
  const r = base(input);
  const code = await rpcCall(deps, input.network, "eth_getCode", [input.token, "latest"], deadline);
  if (typeof code !== "string" || code === "0x") {
    r.note = "No contract code at this address (an externally owned account or not deployed on this network)";
    r.details = { isContract: false };
    return r;
  }
  const [n, s, d, t] = await Promise.all([
    ethCall(deps, input.network, input.token, SEL.name, deadline),
    ethCall(deps, input.network, input.token, SEL.symbol, deadline),
    ethCall(deps, input.network, input.token, SEL.decimals, deadline),
    ethCall(deps, input.network, input.token, SEL.totalSupply, deadline),
  ]);
  const dec = d && d.length >= 66 ? hexToBig(d.slice(0, 66)) : null;
  const sup = t && t.length >= 66 ? hexToBig(t.slice(0, 66)) : null;
  r.name = decodeAbiText(n);
  r.symbol = decodeAbiText(s);
  r.decimals = dec !== null && dec <= 255n ? Number(dec) : null;
  r.details = { isContract: true };
  if (r.decimals !== null && sup !== null) {
    r.found = true;
    r.standard = "erc20";
    r.totalSupply = { atomic: sup.toString(), amount: formatUnits(sup.toString(), r.decimals) };
  } else {
    if (sup !== null) r.totalSupply = { atomic: sup.toString(), amount: null };
    r.note = "Contract does not answer decimals() and totalSupply() like an ERC-20 token";
  }
  return r;
}

async function solanaMeta(deps: RpcDeps, input: Extract<TokenInput, { kind: "solana" }>, deadline: number): Promise<TokenResult> {
  const r = base(input);
  const res = obj(await rpcCall(deps, "solana", "getAccountInfo", [input.token, { encoding: "jsonParsed", commitment: "confirmed" }], deadline));
  const v = obj(res?.value);
  const data = obj(v?.data);
  const parsed = obj(data?.parsed);
  const program = typeof data?.program === "string" ? data.program : null;
  if (!v) {
    r.note = "No account at this address";
    return r;
  }
  if (!parsed || parsed.type !== "mint" || (program !== "spl-token" && program !== "spl-token-2022")) {
    r.note = "This account is not an SPL token mint";
    r.details = { program };
    return r;
  }
  const info = obj(parsed.info) ?? {};
  const decimals = typeof info.decimals === "number" ? info.decimals : null;
  const supply = typeof info.supply === "string" ? info.supply : null;
  const exts = Array.isArray(info.extensions) ? (info.extensions as unknown[]).map(obj).filter(Boolean) as Record<string, unknown>[] : [];
  const md = obj(exts.find((e) => e.extension === "tokenMetadata")?.state);
  r.found = true;
  r.standard = program;
  r.decimals = decimals;
  r.name = cleanText(md?.name);
  r.symbol = cleanText(md?.symbol, 16);
  r.totalSupply = supply !== null ? { atomic: supply, amount: decimals !== null ? formatUnits(supply, decimals) : null } : null;
  r.details = {
    mintAuthority: typeof info.mintAuthority === "string" ? info.mintAuthority : null,
    freezeAuthority: typeof info.freezeAuthority === "string" ? info.freezeAuthority : null,
    extensions: exts.map((e) => String(e.extension)).slice(0, 20),
  };
  if (!md) r.note = program === "spl-token" ? "Classic SPL mint: name and symbol live in a separate metadata program that this route does not read" : "No on-chain tokenMetadata extension on this Token-2022 mint";
  return r;
}

const XRPL_FLAGS: [string, number][] = [
  ["defaultRipple", 0x00800000],
  ["requireAuth", 0x00040000],
  ["globalFreeze", 0x00400000],
  ["noFreeze", 0x00200000],
  ["allowTrustLineClawback", 0x80000000],
  ["depositAuth", 0x01000000],
];

/** 40-hex currency code to ASCII when it is printable (e.g. RLUSD), else null. */
export function xrplCurrencyText(cur: string): string | null {
  if (cur.length === 3) return cur;
  if (cur.startsWith("00")) return null; // non-standard / LP token style codes
  const t = hexToString(`0x${cur}` as `0x${string}`).replace(/\u0000+$/g, "");
  return /^[\x20-\x7e]{1,20}$/.test(t) ? t : null;
}

async function xrplMeta(deps: RpcDeps, input: Extract<TokenInput, { kind: "xrpl" }>, deadline: number): Promise<TokenResult> {
  const r = base(input);
  const ai = obj(await rpcCall(deps, "xrpl", "account_info", { account: input.issuer, ledger_index: "validated" }, deadline));
  if (!ai || ai.error === "actNotFound") {
    r.note = "Issuer account not found on the validated ledger";
    return r;
  }
  if (ai.error) throw new RpcDown(String(ai.error));
  const acct = obj(ai.account_data) ?? {};
  const flags = typeof acct.Flags === "number" ? acct.Flags : 0;
  const gb = obj(await rpcCall(deps, "xrpl", "gateway_balances", { account: input.issuer, ledger_index: "validated", strict: true }, deadline));
  if (gb?.error) throw new RpcDown(String(gb.error));
  const obligations = obj(gb?.obligations) ?? {};
  const issued = typeof obligations[input.currency] === "string" ? String(obligations[input.currency]) : null;
  const domainHex = typeof acct.Domain === "string" && /^[0-9A-Fa-f]+$/.test(acct.Domain) ? acct.Domain : null;
  const domain = domainHex ? cleanText(hexToString(`0x${domainHex}` as `0x${string}`), 256) : null;
  const rate = typeof acct.TransferRate === "number" && acct.TransferRate > 0 ? acct.TransferRate : null;
  r.found = issued !== null;
  r.standard = "xrpl-issued-currency";
  r.symbol = xrplCurrencyText(input.currency);
  r.decimals = null;
  r.totalSupply = issued !== null ? { atomic: issued, amount: issued } : null;
  r.details = {
    currency: input.currency,
    issuer: input.issuer,
    issuerDomain: domain,
    transferFeePct: rate ? Number(((rate - 1_000_000_000) / 10_000_000).toFixed(7)) : 0,
    flags: Object.fromEntries(XRPL_FLAGS.map(([k, bit]) => [k, (flags & bit) >>> 0 === bit >>> 0])),
  };
  if (!r.found) r.note = "The issuer has no outstanding balance in this currency (nothing issued, or a different currency code)";
  else r.note = "XRPL issued currencies have no fixed decimals (up to 15 significant digits); totalSupply is the issuer's outstanding obligations";
  return r;
}

export async function tokenMeta(input: TokenInput, deps: RpcDeps = defaultRpcDeps()): Promise<TokenResult | TokenError> {
  const deadline = deps.now() + TOKEN_META_DEADLINE_MS;
  try {
    if (input.kind === "solana") return await solanaMeta(deps, input, deadline);
    if (input.kind === "xrpl") return await xrplMeta(deps, input, deadline);
    return await evmMeta(deps, input, deadline);
  } catch (e) {
    return { ok: false, status: 502, code: "rpc_unavailable", error: `No public ${input.network} RPC answered (${e instanceof Error ? e.message : "error"}); not charged, retry shortly` };
  }
}
