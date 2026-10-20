/**
 * Address screens for the dd-tester (spec §3 pinned-payTo rules, Sentinel L-4) and the per-host key (L-2).
 * Every comparison is an exact full-string compare after lowercasing; no prefix/suffix MATCHING is ever an allow.
 * The prefix-4/suffix-4 similarity check (L-4) can only ever turn an allow into warn + NO PAY.
 *
 * Lists are never typed into code from memory: besides our own payTo (lib/config, pinned by tests/payto-base-pin),
 * they come from env, set by Odin/Michael from security/approved-addresses.md:
 *   HP_DD_DENYLIST       comma list of full addresses never paid (lookalikes, private individuals, Caminito, ...)
 *   HP_DD_OWN_ADDRESSES  comma list of our own wallets (premium test wallet, burner, dd-tester, other payTos)
 * Either list unset/empty or containing a malformed entry -> screen unavailable -> no test pay (fail closed).
 */
import { DEFAULT_PAY_TO } from "@/lib/config";

type Env = Record<string, string | undefined>;
export const isEvmAddress = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
export const eqAddr = (a: unknown, b: unknown) => isEvmAddress(a) && isEvmAddress(b) && a.toLowerCase() === b.toLowerCase();

function list(raw: string | undefined): string[] | null {
  const items = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!items.length || items.some((a) => !isEvmAddress(a))) return null;
  return items.map((a) => a.toLowerCase());
}

export type ScreenLists = { version: string; deny: string[]; own: string[] };
export function screenLists(env: Env = process.env): ScreenLists | null {
  const deny = list(env.HP_DD_DENYLIST);
  const own = list(env.HP_DD_OWN_ADDRESSES);
  if (!deny || !own) return null;
  const all = [...new Set([...deny, ...own, DEFAULT_PAY_TO.toLowerCase()])].sort();
  // version = count + short hash of the sorted list; no address is ever returned to callers
  let h = 0;
  for (const c of all.join(",")) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { version: `dd-screen-${all.length}-${h.toString(16)}`, deny, own: [...new Set([...own, DEFAULT_PAY_TO.toLowerCase()])] };
}

export type ScreenResult = { result: "ok" | "warn" | "fail"; pay_allowed: boolean; code: string };
/** Exact denylist / own-address match -> fail + no pay. Prefix-4/suffix-4 similarity to an own address -> warn + no pay. */
export function screenPayTo(payTo: string, lists: ScreenLists): ScreenResult {
  if (!isEvmAddress(payTo)) return { result: "fail", pay_allowed: false, code: "payto_malformed" };
  const p = payTo.toLowerCase();
  if (lists.deny.includes(p)) return { result: "fail", pay_allowed: false, code: "payto_on_denylist" };
  if (lists.own.includes(p)) return { result: "fail", pay_allowed: false, code: "payto_is_own_address" };
  const sim = (a: string) => a.slice(2, 6) === p.slice(2, 6) && a.slice(-4) === p.slice(-4);
  if ([...lists.own, ...lists.deny].some(sim)) return { result: "warn", pay_allowed: false, code: "payto_similar_to_listed_address" };
  return { result: "ok", pay_allowed: true, code: "no_listed_match" };
}

/** Registrable domain (eTLD+1, simplified like lib/premium/onchain rpcOperator: two labels; three for co.uk-style). */
export function registrableDomain(host: string): string {
  const parts = host.toLowerCase().replace(/\.$/, "").split(".");
  if (parts.length <= 2) return parts.join(".");
  const two = /^(co|com|org|net|gov|ac|edu)\.[a-z]{2}$/.test(parts.slice(-2).join("."));
  return parts.slice(two ? -3 : -2).join(".");
}
