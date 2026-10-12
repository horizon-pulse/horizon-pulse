/**
 * XRPL rail test helpers. Offline only: facilitators and the read-only RPC are
 * stubbed; tx blobs are binary-encoded but UNSIGNED (no key pair is created
 * or used anywhere); payer addresses are derived from filler bytes and are
 * NOT wallets. Nothing is funded, signed, or sent to any network.
 */
import { vi } from "vitest";
import { encode } from "xrpl";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { CDP_URL_PREFIX, CDP_SUPPORTED, installFacilitatorMock, type FacilitatorBehaviour } from "./facilitator-mock";
import { CDP_ENV } from "./capture";
import {
  RLUSD_CURRENCY_HEX,
  RLUSD_TESTNET_ISSUER,
  X402_ORG_FACILITATOR_URL,
  XRPL_PAYTO,
  XRPL_TESTNET_PAYTO,
  encodeXrplClassicAddress,
} from "@/lib/xrpl-config";
import { __setXrplRpcForTests, type XrplRpc } from "@/lib/xrpl-rail";
import { PAYAI_SUPPORTED } from "./solana-env";

/** Michael's mainnet payTo (xrpl:0 only). */
export const PINNED_XRPL_PAYTO_MAINNET = "r3FbirL83RAB2CwnUdxE5pCohMkuo6LQcf";
/** Throwaway testnet payTo (xrpl:1 only), the default network. */
export const PINNED_XRPL_PAYTO = "rs2cF8jYDp4D7Ny2SrNV21xkNJRp3HiVTJ";
export const payToForNet = (n?: string) => (n === "xrpl:0" ? XRPL_PAYTO : XRPL_TESTNET_PAYTO);
export const XRPL_FAC = X402_ORG_FACILITATOR_URL;
export const T54_MAINNET = "https://xrpl-facilitator-mainnet.t54.ai";
export const T54_TESTNET = "https://xrpl-facilitator-testnet.t54.ai";
export const PAYAI = "https://facilitator.payai.network";

/** Syntactically valid classic address from a filler byte. NOT a wallet: no key exists for it. */
export function fillerAddress(fill: number): string {
  return encodeXrplClassicAddress(new Uint8Array(20).fill(fill));
}
export const XRPL_PAYER = fillerAddress(9);
export const XRPL_TX_HASH = "C".repeat(64);

/**
 * Shapes of the live GET /supported answers, read-only on 2026-10-08:
 * x402.org (multi-network; xrpl:1 kind carries extra.areFeesSponsored=false)
 * and t54 mainnet (xrpl:0 only). The wrapper must filter to one kind.
 */
export const X402_ORG_SUPPORTED = {
  kinds: [
    { x402Version: 2, scheme: "exact", network: "eip155:84532" },
    { x402Version: 2, scheme: "exact", network: "xrpl:1", extra: { areFeesSponsored: false } },
    { x402Version: 2, scheme: "exact", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", extra: { feePayer: "x" } },
  ],
  extensions: ["builder-code", "eip2612GasSponsoring", "erc20ApprovalGasSponsoring"],
  signers: { "xrpl:*": [], "eip155:*": ["0x0000000000000000000000000000000000000001"] },
};
export const T54_MAINNET_SUPPORTED = {
  kinds: [{ x402Version: 2, scheme: "exact", network: "xrpl:0" }],
  extensions: ["x402Secure"],
  signers: { "xrpl:*": [] },
};

// ---------------------------------------------------------------------------
// Read-only RPC stub (payTo readiness + settled-tx time)
// ---------------------------------------------------------------------------

export type ReadyMode = "ready" | "unactivated" | "no_trustline" | "frozen" | "zero_limit" | "dest_tag" | "deposit_auth" | "error" | "malformed";
export type XrplRpcCall = { url: string; method: string; params: Record<string, unknown> };

export function trustLine(issuer: string = RLUSD_TESTNET_ISSUER, over: Record<string, unknown> = {}) {
  return { account: issuer, balance: "0", currency: RLUSD_CURRENCY_HEX, limit: "1000000", limit_peer: "0", quality_in: 0, quality_out: 0, no_ripple: true, ...over };
}

export function installXrplRpc(
  mode: ReadyMode | (() => ReadyMode) = "ready",
  /** `tx` result for a settled hash (default: validated, closed "now"). */
  tx: (hash: string) => unknown = () => ({ validated: true, date: Math.floor((Date.now() - 946_684_800_000) / 1000), status: "success" }),
): XrplRpcCall[] {
  const calls: XrplRpcCall[] = [];
  const fn: XrplRpc = async (url, method, params) => {
    calls.push({ url, method, params });
    if (method === "tx") return tx(String(params.transaction));
    const m = typeof mode === "function" ? mode() : mode;
    const ACCT = String(params.account);
    if (ACCT !== XRPL_PAYTO && ACCT !== XRPL_TESTNET_PAYTO) throw new Error(`unexpected account ${String(params.account)}`);
    if (m === "error") throw new Error("RPC unreachable");
    if (m === "malformed") return "nope";
    if (m === "unactivated") return { account: ACCT, error: "actNotFound", error_code: 19, status: "error", validated: true };
    const issuer = String(params.peer ?? RLUSD_TESTNET_ISSUER);
    if (method === "account_info") {
      const Flags = m === "dest_tag" ? 0x00020000 : m === "deposit_auth" ? 0x01000000 : 0;
      return { account_data: { Account: ACCT, Flags, Balance: "1500000" }, status: "success", validated: true };
    }
    if (method === "account_lines") {
      const lines =
        m === "no_trustline" ? [] : m === "frozen" ? [trustLine(issuer, { freeze_peer: true })] : m === "zero_limit" ? [trustLine(issuer, { limit: "0" })] : [trustLine(issuer)];
      return { account: ACCT, lines, status: "success", validated: true };
    }
    throw new Error(`unexpected RPC ${method}`);
  };
  __setXrplRpcForTests(fn);
  return calls;
}

export function setCdp(on: boolean) {
  vi.stubEnv("CDP_API_KEY_ID", on ? CDP_ENV.CDP_API_KEY_ID : "");
  vi.stubEnv("CDP_API_KEY_SECRET", on ? CDP_ENV.CDP_API_KEY_SECRET : "");
}

/** Flag on with the pinned payTo (testnet defaults unless overridden). Does NOT unstub other rails' env. */
export function stubXrplOn(extra: Record<string, string> = {}, cdp = true, ready: ReadyMode = "ready", keepEnv = false): XrplRpcCall[] {
  const calls = installXrplRpc(ready);
  if (!keepEnv) vi.unstubAllEnvs();
  vi.stubEnv("HP_XRPL_ENABLED", "true");
  vi.stubEnv("HP_XRPL_PAYTO", payToForNet(extra.HP_XRPL_NETWORK));
  for (const [k, v] of Object.entries(extra)) vi.stubEnv(k, v);
  setCdp(cdp);
  return calls;
}

/** CDP answers as usual; PayAI with its recorded /supported; XRPL facilitators with their shapes (override per test). */
export function installXrplFacilitators(overrides: FacilitatorBehaviour = {}) {
  return installFacilitatorMock({
    supported: (url) => {
      if (url.startsWith(CDP_URL_PREFIX)) return CDP_SUPPORTED;
      if (url === PAYAI) return PAYAI_SUPPORTED;
      if (overrides.supported) return overrides.supported(url);
      if (url === XRPL_FAC || url === T54_TESTNET) return X402_ORG_SUPPORTED;
      if (url === T54_MAINNET) return T54_MAINNET_SUPPORTED;
      throw new Error(`unexpected facilitator ${url}`);
    },
    verify: overrides.verify,
    settle: overrides.settle,
  });
}

// ---------------------------------------------------------------------------
// Spec-shaped payloads (unsigned blobs)
// ---------------------------------------------------------------------------

let seq = 1000;
/** A fresh payment slot each call (Sequence), so tests don't trip the replay guard by accident. */
export const nextSeq = () => ++seq;

export function rlusd(value: string, issuer: string = RLUSD_TESTNET_ISSUER, currency: string = RLUSD_CURRENCY_HEX) {
  return { currency, issuer, value };
}

export function specTx(accept: PaymentRequirements, over: Record<string, unknown> = {}): Record<string, unknown> {
  const issuer = String((accept.extra as Record<string, unknown>).issuer);
  const tx: Record<string, unknown> = {
    TransactionType: "Payment",
    Account: XRPL_PAYER,
    Destination: accept.payTo,
    Amount: rlusd(accept.amount, issuer, accept.asset),
    SendMax: rlusd(accept.amount, issuer, accept.asset),
    Fee: "12",
    Sequence: nextSeq(),
    LastLedgerSequence: 1_000_000,
    Flags: 0,
    SigningPubKey: "",
    ...over,
  };
  for (const [k, v] of Object.entries(tx)) if (v === undefined) delete tx[k];
  return tx;
}

export function blobOf(tx: Record<string, unknown>): string {
  return encode(tx as never);
}

export function xrplPayload(
  accept: PaymentRequirements,
  txOver: Record<string, unknown> = {},
  acceptedOver: Partial<PaymentRequirements> = {},
  blob?: string,
): PaymentPayload {
  return {
    x402Version: 2,
    accepted: { ...accept, ...acceptedOver },
    payload: { signedTxBlob: blob ?? blobOf(specTx(accept, txOver)) },
  } as PaymentPayload;
}
