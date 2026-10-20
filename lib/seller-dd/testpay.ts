/**
 * dd-tester signer (spec §3, Sentinel C1/C5). The ONLY module that reads HP_DD_TESTER_KEY (static check in tests).
 * The key is never printed, logged, returned or written anywhere; errors are fixed codes.
 *
 * C1 signing scope: ONE operation, an EIP-3009 TransferWithAuthorization on Base USDC. Domain from our constants only
 * (chainId 8453, Base USDC contract, "USD Coin"/"2"), never from the 402 `extra`. Refused: any other kind (permit,
 * approve, Permit2, setApprovalForAll, increaseAllowance, raw tx, personal_sign, other typed data), `to` != pinned payTo,
 * value > min($0.10, remaining reservation) or <= 0, validAfter not 0/now, validBefore beyond now+5 min or in the past,
 * a 402 `extra` that disagrees with our domain. Fresh random 32-byte nonce per signature, never derived from seller input.
 *
 * Boot check: the address derived from the key must equal HP_DD_TESTER_ADDRESS exactly (Odin's approved-addresses.md
 * row, set in env by Michael). Mismatch / missing -> tester unavailable -> route closed (no test pay).
 */
import { randomBytes } from "node:crypto";
import { BASE_CAIP2, USDC_BASE } from "@/lib/config";
import { TRANSFER_WITH_AUTHORIZATION_TYPES, USDC_BASE_DOMAIN } from "@/lib/premium/payment";
import { PER_CALL_MAX_ATOMIC, VALID_BEFORE_MAX_S } from "./config";
import { eqAddr, isEvmAddress, type ScreenLists } from "./screen";

type Env = Record<string, string | undefined>;
const KEY_ENV = "HP_DD_TESTER_KEY";
const ADDR_ENV = "HP_DD_TESTER_ADDRESS";

export const ALLOWED_SIGN_KIND = "eip3009_transfer_with_authorization" as const;

export type TesterStatus = { ok: true; address: string } | { ok: false; code: "tester_key_missing" | "tester_address_missing" | "tester_address_mismatch" | "tester_is_listed_payto" };
export async function testerStatus(env: Env = process.env, lists?: ScreenLists | null): Promise<TesterStatus> {
  const key = (env[KEY_ENV] ?? "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) return { ok: false, code: "tester_key_missing" };
  const expected = (env[ADDR_ENV] ?? "").trim();
  if (!isEvmAddress(expected)) return { ok: false, code: "tester_address_missing" };
  const { privateKeyToAccount } = await import("viem/accounts");
  const derived = privateKeyToAccount(key as `0x${string}`).address;
  if (!eqAddr(derived, expected)) return { ok: false, code: "tester_address_mismatch" };
  // never a payTo: the tester must not be on the deny list as a pay target... it IS expected in OWN (payer-only row),
  // but it must never equal our revenue payTo.
  if (lists && lists.deny.includes(derived.toLowerCase())) return { ok: false, code: "tester_is_listed_payto" };
  return { ok: true, address: derived };
}

export type SignRequest = {
  kind: string;
  /** EIP-712 domain the caller was handed (e.g. from 402 extra). Only checked for agreement; never used to sign. */
  requestedDomain?: Record<string, unknown> | null;
  network: string;
  asset: string;
  to: string;
  pinnedPayTo: string;
  value: bigint;
  remainingAtomic: bigint;
  validAfter: bigint;
  validBefore: bigint;
};
export type SignedAuth = { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string };
export type SignResult = { ok: true; auth: SignedAuth; signature: string } | { ok: false; code: string };

export function domainAgrees(d: Record<string, unknown> | null | undefined): boolean {
  if (!d) return true;
  if ("name" in d && d.name !== USDC_BASE_DOMAIN.name) return false;
  if ("version" in d && String(d.version) !== USDC_BASE_DOMAIN.version) return false;
  if ("chainId" in d && Number(d.chainId) !== USDC_BASE_DOMAIN.chainId) return false;
  if ("verifyingContract" in d && !eqAddr(d.verifyingContract, USDC_BASE)) return false;
  if ("salt" in d) return false;
  return true;
}

/** C1 policy check, pure (unit-tested without a key). */
export function signPolicyError(r: SignRequest, nowS: bigint): string | null {
  if (r.kind !== ALLOWED_SIGN_KIND) return "signing_scope_refused";
  if (r.network !== BASE_CAIP2) return "network_not_base";
  if (!eqAddr(r.asset, USDC_BASE)) return "asset_not_base_usdc";
  if (!domainAgrees(r.requestedDomain)) return "domain_mismatch";
  if (!isEvmAddress(r.to) || !eqAddr(r.to, r.pinnedPayTo)) return "to_not_pinned_payto";
  const max = r.remainingAtomic < PER_CALL_MAX_ATOMIC ? r.remainingAtomic : PER_CALL_MAX_ATOMIC;
  if (r.value <= 0n || r.value > max) return "value_over_cap";
  if (!(r.validAfter === 0n || r.validAfter <= nowS)) return "valid_after_in_future";
  if (r.validBefore <= nowS || r.validBefore > nowS + BigInt(VALID_BEFORE_MAX_S)) return "valid_before_out_of_range";
  return null;
}

export const freshNonce = () => `0x${randomBytes(32).toString("hex")}`;

export async function signTestAuthorization(r: SignRequest, nonce: string, env: Env = process.env, nowS: bigint = BigInt(Math.floor(Date.now() / 1000))): Promise<SignResult> {
  const pe = signPolicyError(r, nowS);
  if (pe) return { ok: false, code: pe };
  if (!/^0x[0-9a-f]{64}$/.test(nonce)) return { ok: false, code: "nonce_malformed" };
  const st = await testerStatus(env);
  if (!st.ok) return { ok: false, code: st.code };
  try {
    const { privateKeyToAccount } = await import("viem/accounts");
    const acct = privateKeyToAccount((env[KEY_ENV] ?? "").trim() as `0x${string}`);
    const message = { from: acct.address, to: r.to as `0x${string}`, value: r.value, validAfter: r.validAfter, validBefore: r.validBefore, nonce: nonce as `0x${string}` };
    const signature = await acct.signTypedData({ domain: USDC_BASE_DOMAIN, types: TRANSFER_WITH_AUTHORIZATION_TYPES, primaryType: "TransferWithAuthorization", message });
    return { ok: true, signature, auth: { from: acct.address, to: r.to, value: r.value.toString(), validAfter: r.validAfter.toString(), validBefore: r.validBefore.toString(), nonce } };
  } catch {
    return { ok: false, code: "sign_failed" };
  }
}
