/**
 * Local (no keys, no money) check of the Solana accepts entry against the
 * @x402/svm SDK itself:
 *   1. the SDK's CLIENT builds the payment transaction from our accept, using
 *      a WATCH-ONLY signer (a fixed address with no private key; it returns a
 *      zero placeholder signature), and
 *   2. the SDK's FACILITATOR runs its static verification (fee payer, compute
 *      budget, TransferChecked program/mint/destination ATA/amount, memo)
 *      against our accept, with simulation stubbed out.
 * Nothing is signed for real, broadcast, or funded. The only network access
 * is optional read-only JSON-RPC (mint account + latest blockhash) when an
 * rpcUrl is given; tests stub fetch instead.
 */
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactSvmScheme as ClientScheme } from "@x402/svm/exact/client";
import { ExactSvmScheme as FacilitatorScheme } from "@x402/svm/exact/facilitator";
import {
  address,
  decompileTransactionMessage,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from "@solana-program/token";

export function watchOnlySigner(addr: string) {
  return {
    address: address(addr),
    // Placeholder signature: 64 zero bytes. No private key exists anywhere.
    signTransactions: async (txs: readonly unknown[]) => txs.map(() => ({ [addr]: new Uint8Array(64) })),
  };
}

export async function buildClientPayload(
  accept: PaymentRequirements,
  payer: string,
  rpcUrl?: string,
): Promise<PaymentPayload> {
  const client = new ClientScheme(watchOnlySigner(payer) as never, rpcUrl ? { rpcUrl } : undefined);
  const partial = await client.createPaymentPayload(2, accept);
  return { ...partial, accepted: accept } as PaymentPayload;
}

export function decodeTx(b64: string) {
  const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(b64));
  const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  const decompiled = decompileTransactionMessage(compiled);
  return { transaction, compiled, decompiled };
}

/** Facilitator signer stub: manages ONLY PayAI's listed fee payer address; simulation is a no-op. */
function facilitatorStub(feePayer: string) {
  return {
    getAddresses: () => [address(feePayer)],
    simulateTransaction: async () => {},
    signTransaction: async () => {
      throw new Error("not used: local verify never signs");
    },
    sendTransaction: async () => {
      throw new Error("not used: local verify never broadcasts");
    },
    confirmTransaction: async () => {
      throw new Error("not used");
    },
  };
}

export async function sdkStaticVerify(payload: PaymentPayload, requirement: PaymentRequirements) {
  const feePayer = (requirement.extra as { feePayer: string }).feePayer;
  const fac = new FacilitatorScheme(facilitatorStub(feePayer) as never) as unknown as {
    verifyStaticPath: (...a: unknown[]) => Promise<{ isValid: boolean; invalidReason?: string; payer: string }>;
    verify: (p: PaymentPayload, r: PaymentRequirements) => Promise<{ isValid: boolean; invalidReason?: string }>;
  };
  const tx = (payload.payload as { transaction: string }).transaction;
  const { transaction, decompiled } = decodeTx(tx);
  const staticResult = await fac.verifyStaticPath(transaction, decompiled, payload.payload, requirement, [feePayer]);
  const fullResult = await fac.verify(payload, requirement);
  return { staticResult, fullResult };
}

export async function usdcAta(owner: string, mint: string): Promise<string> {
  const [ata] = await findAssociatedTokenPda({ owner: address(owner), mint: address(mint), tokenProgram: TOKEN_PROGRAM_ADDRESS });
  return ata.toString();
}

type Ix = { programAddress: { toString(): string }; accounts?: { address: { toString(): string } }[]; data?: Uint8Array };

/** Human summary of the decoded instructions (for evidence). */
export function describeTx(b64: string) {
  const { compiled, decompiled } = decodeTx(b64);
  return {
    bytes: Buffer.from(b64, "base64").length,
    feePayer: compiled.staticAccounts[0]?.toString(),
    numSigners: compiled.header.numSignerAccounts,
    instructions: ([...(decompiled.instructions ?? [])] as unknown as Ix[]).map((ix) => ({
      program: ix.programAddress.toString(),
      accounts: (ix.accounts ?? []).map((a) => a.address.toString()),
      dataHex: ix.data ? Buffer.from(ix.data).toString("hex") : "",
    })),
  };
}
