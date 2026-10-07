/**
 * SPIKE buyer helper for x402 `batch-settlement` (EVM). Encodes the two buyer-side
 * requirements found in the 2026-10-07 Base Sepolia run:
 *  1. Feed EVERY paid response back to the client (`handlePaymentResponse`), or the next
 *     voucher carries a stale cumulative total and fails `cumulative_amount_mismatch`.
 *  2. The signer MUST be able to read the chain (`readContract`): corrective-402 recovery
 *     reads the channel's on-chain balance. Use `toClientEvmSigner(account, publicClient)`.
 * Channel storage must be durable (file/DB), not in-memory, for any real buyer.
 */
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import type { Network } from "@x402/core/types";
import { toClientEvmSigner } from "@x402/evm";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/client";

type Signer = Parameters<typeof toClientEvmSigner>[0];
type PublicClient = Parameters<typeof toClientEvmSigner>[1];
type Opts = ConstructorParameters<typeof BatchSettlementEvmScheme>[1];

export function createBatchBuyer(account: Signer, publicClient: PublicClient, network: Network, opts: Opts = {}) {
  if (!publicClient) throw new Error("batch buyer needs a publicClient: the signer must read the chain for channel recovery");
  const signer = toClientEvmSigner(account, publicClient);
  if (typeof signer.readContract !== "function") throw new Error("batch buyer signer has no readContract");
  const scheme = new BatchSettlementEvmScheme(signer, opts);
  const client = new x402Client();
  client.register(network, scheme);
  const http = new x402HTTPClient(client);

  /** One paid GET. Feeds the receipt back; on a corrective 402 resyncs and retries ONCE. */
  async function payGet(url: string, init: RequestInit = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const unpaid = await fetch(url, init);
      if (unpaid.status !== 402) return { response: unpaid, settle: null, attempt };
      const pr = http.getPaymentRequiredResponse((h) => unpaid.headers.get(h), await unpaid.json().catch(() => ({})));
      const payload = await http.createPaymentPayload(pr);
      const requirements = payload.accepted;
      const paid = await fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), ...http.encodePaymentSignatureHeader(payload) } });
      if (paid.ok) {
        const settle = http.getPaymentSettleResponse((h) => paid.headers.get(h));
        await client.handlePaymentResponse({ paymentPayload: payload, requirements, settleResponse: settle }); // requirement 1
        return { response: paid, settle, attempt };
      }
      if (paid.status !== 402) return { response: paid, settle: null, attempt };
      const corrective = http.getPaymentRequiredResponse((h) => paid.headers.get(h), await paid.clone().json().catch(() => ({})));
      const err = (corrective as { error?: string }).error;
      if (err?.includes("cumulative_exceeds_balance")) {
        // Found 2026-10-07: after a refund the channel is empty but the local record still
        // looks funded; the SDK does not auto-top-up. Open a new channel (new `salt`) or top up.
        return { response: paid, settle: null, attempt, error: `${err}: channel drained or refunded; reopen with a new salt or top up` };
      }
      const recovered = await scheme.processCorrectivePaymentRequired(corrective); // needs readContract (requirement 2)
      if (!recovered) return { response: paid, settle: null, attempt, error: (corrective as { error?: string }).error };
    }
    throw new Error("batch payment failed after one corrective resync");
  }
  return { scheme, client, http, payGet };
}
