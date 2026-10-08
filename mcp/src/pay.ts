/**
 * x402 v2 pay flow for one route call, using the official @x402 client libs:
 *
 *   1. Send the request unpaid.
 *   2. On 402, decode the PAYMENT-REQUIRED header (base64 JSON, x402 v2).
 *   3. Accept only: scheme "exact", Base mainnet, Base USDC, the expected payTo,
 *      an EIP-3009 transfer, an amount <= the advertised price, <= the per-call
 *      cap and within the session budget.
 *   4. With no key (or HP_DRY_RUN=1) stop and return the quote. Otherwise sign
 *      an EIP-3009 USDC authorization and retry once with PAYMENT-SIGNATURE.
 *   5. Return the response plus the decoded PAYMENT-RESPONSE settlement receipt.
 *
 * Never retries a payment automatically. Never logs the private key.
 */
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { atomicToUsd, BASE_CAIP2, USDC_BASE, type Config } from "./config.js";
import type { RouteTool } from "./catalog.js";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export type CallOutcome = {
  ok: boolean;
  status: number;
  /** "paid" | "free" (no 402) | "quote" (402 decoded, not paid) | "refused" | "error" */
  kind: "paid" | "free" | "quote" | "refused" | "error";
  message?: string;
  body?: Json;
  bodyText?: string;
  requirements?: Json;
  settlement?: Json;
};

/** Session spend tracker (per server process). */
export class Budget {
  spent = 0n;
  reserved = 0n;
  constructor(readonly limit: bigint) {}
  remaining(): bigint {
    return this.limit - this.spent - this.reserved;
  }
}

function buildRequest(cfg: Config, tool: RouteTool, args: Record<string, unknown>): { url: string; init: RequestInit } {
  const url = new URL(tool.path, cfg.baseUrl + "/");
  const headers: Record<string, string> = { accept: "application/json", "user-agent": "horizon-pulse-mcp/0.1.0" };
  if (tool.method === "GET") {
    for (const [k, v] of Object.entries(args ?? {})) {
      if (v === undefined || v === null || v === "") continue;
      url.searchParams.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
    return { url: url.toString(), init: { method: "GET", headers } };
  }
  return {
    url: url.toString(),
    init: { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(args ?? {}) },
  };
}

async function readBody(res: Response): Promise<{ text: string; json: Json }> {
  const text = await res.text();
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: undefined };
  }
}

/** Why a single accepts entry is not payable under our rules, or null if it is. */
export function rejectReason(req: PaymentRequirements, tool: RouteTool, cfg: Config): string | null {
  const r = req as Json;
  if (r.scheme !== "exact") return `scheme ${r.scheme} (only "exact" is supported)`;
  if (r.network !== BASE_CAIP2) return `network ${r.network} (only Base mainnet ${BASE_CAIP2})`;
  if (String(r.asset).toLowerCase() !== USDC_BASE.toLowerCase()) return `asset ${r.asset} (only Base USDC ${USDC_BASE})`;
  if (String(r.payTo).toLowerCase() !== cfg.expectedPayTo) return `payTo ${r.payTo} does not match the expected Horizon Pulse treasury ${cfg.expectedPayTo}`;
  const method = r.extra?.assetTransferMethod;
  if (method && method !== "eip3009") return `asset transfer method ${method} (only EIP-3009 transferWithAuthorization)`;
  let amount: bigint;
  try {
    amount = BigInt(r.amount);
  } catch {
    return `invalid amount ${JSON.stringify(r.amount)}`;
  }
  if (amount <= 0n) return `invalid amount ${r.amount}`;
  if (tool.amount && amount > BigInt(tool.amount)) return `amount ${atomicToUsd(amount)} is above the advertised price ${tool.priceUsd} in /openapi.json`;
  if (amount > cfg.maxAtomicPerCall) return `amount ${atomicToUsd(amount)} is above HP_MAX_USD_PER_CALL ${atomicToUsd(cfg.maxAtomicPerCall)}`;
  return null;
}

function summarizeRequirements(pr: PaymentRequired): Json {
  return {
    x402Version: pr.x402Version,
    resource: (pr as Json).resource?.url,
    accepts: pr.accepts.map((a: Json) => ({
      scheme: a.scheme,
      network: a.network,
      asset: a.asset,
      amount: a.amount,
      priceUsd: atomicToUsd(a.amount),
      payTo: a.payTo,
      maxTimeoutSeconds: a.maxTimeoutSeconds,
      extra: a.extra,
    })),
  };
}

export async function callRoute(cfg: Config, budget: Budget, tool: RouteTool, args: Record<string, unknown>): Promise<CallOutcome> {
  const { url, init } = buildRequest(cfg, tool, args);
  const signal = () => AbortSignal.timeout(cfg.timeoutMs);

  let first: Response;
  try {
    first = await fetch(url, { ...init, signal: signal() });
  } catch (e) {
    return { ok: false, status: 0, kind: "error", message: `Request to ${url} failed: ${String(e)}` };
  }
  if (first.status !== 402) {
    const b = await readBody(first);
    return { ok: first.ok, status: first.status, kind: first.ok ? "free" : "error", body: b.json, bodyText: b.text, message: first.ok ? undefined : `HTTP ${first.status} before any payment (not charged)` };
  }

  // 402: decode the x402 v2 challenge from the PAYMENT-REQUIRED header.
  const firstBody = await readBody(first);
  const parser = new x402HTTPClient(new x402Client());
  let pr: PaymentRequired;
  try {
    pr = parser.getPaymentRequiredResponse((h) => first.headers.get(h), firstBody.json);
  } catch (e) {
    return { ok: false, status: 402, kind: "error", message: `Got 402 but could not parse the x402 challenge: ${String(e)}` };
  }
  const requirements = summarizeRequirements(pr);

  const reasons: string[] = [];
  const payable = pr.accepts.find((a) => {
    const why = rejectReason(a, tool, cfg);
    if (why) reasons.push(why);
    return !why;
  });
  if (!payable) {
    return { ok: false, status: 402, kind: "refused", requirements, message: `Refusing to pay: no acceptable payment option (${reasons.join("; ")}).` };
  }
  const amount = BigInt((payable as Json).amount);
  if (amount > budget.remaining()) {
    return {
      ok: false,
      status: 402,
      kind: "refused",
      requirements,
      message: `Refusing to pay ${atomicToUsd(amount)}: session budget HP_MAX_USD_TOTAL ${atomicToUsd(budget.limit)} has ${atomicToUsd(budget.remaining() < 0n ? 0n : budget.remaining())} left.`,
    };
  }
  if (cfg.dryRun || !cfg.privateKey) {
    return {
      ok: false,
      status: 402,
      kind: "quote",
      requirements,
      message: cfg.dryRun
        ? `HP_DRY_RUN is set: not paying. This call costs ${atomicToUsd(amount)} USDC on Base to ${String((payable as Json).payTo)}.`
        : `No HP_PRIVATE_KEY configured: not paying. This call costs ${atomicToUsd(amount)} USDC on Base to ${String((payable as Json).payTo)}. Set HP_PRIVATE_KEY to a dedicated low-balance buyer wallet to enable payment.`,
    };
  }

  // Sign exactly the vetted requirement (policy pins it; spendControls is a second cap).
  const account = privateKeyToAccount(cfg.privateKey);
  const client = x402Client.fromConfig({
    schemes: [{ network: BASE_CAIP2, client: new ExactEvmScheme(account) }],
    policies: [(_v, reqs) => reqs.filter((r) => rejectReason(r, tool, cfg) === null)],
    spendControls: { maxAmountPerPayment: atomicToUsd(cfg.maxAtomicPerCall) },
  });
  const http = new x402HTTPClient(client);

  budget.reserved += amount;
  let headers: Record<string, string>;
  try {
    const payload = await http.createPaymentPayload({ ...pr, accepts: [payable] });
    headers = { ...(init.headers as Record<string, string>), ...http.encodePaymentSignatureHeader(payload) };
  } catch (e) {
    // Nothing was signed, so nothing can settle: release the reservation.
    budget.reserved -= amount;
    return { ok: false, status: 0, kind: "error", requirements, message: `Could not sign the payment (nothing was sent or charged): ${String(e)}` };
  }
  let paid: Response;
  try {
    paid = await fetch(url, { ...init, headers, signal: signal() });
  } catch (e) {
    // A signed authorization left this process. The server or facilitator may have
    // settled it even though we got no response, so count it as spent (no refund to
    // the session budget) and never retry automatically.
    budget.reserved -= amount;
    budget.spent += amount;
    return {
      ok: false,
      status: 0,
      kind: "error",
      requirements,
      message: `Signed payment of ${atomicToUsd(amount)} was sent but no response came back (${String(e)}). It may have settled; check the buyer wallet on Base before retrying. Counted against the session budget; not retried.`,
    };
  }
  budget.reserved -= amount;

  let settlement: Json;
  try {
    settlement = http.getPaymentSettleResponse((h) => paid.headers.get(h));
  } catch {
    settlement = undefined;
  }
  // Conservative: count the spend on a settled receipt OR any 2xx (the facilitator settles before success is returned).
  if (settlement?.success || paid.ok) budget.spent += amount;

  const b = await readBody(paid);
  if (paid.status === 402) {
    let reason: string | undefined;
    try {
      reason = (parser.getPaymentRequiredResponse((h) => paid.headers.get(h), b.json) as Json).error;
    } catch {
      /* ignore */
    }
    return { ok: false, status: 402, kind: "error", requirements, body: b.json, bodyText: b.text, message: `Payment was not accepted${reason ? `: ${reason}` : ""}. Not retried.` };
  }
  return {
    ok: paid.ok,
    status: paid.status,
    kind: "paid",
    requirements,
    settlement,
    body: b.json,
    bodyText: b.text,
    message: paid.ok ? `Paid ${atomicToUsd(amount)} USDC on Base.` : `HTTP ${paid.status} after payment header (route errors are not settled).`,
  };
}
