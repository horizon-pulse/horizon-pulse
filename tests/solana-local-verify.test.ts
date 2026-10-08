/**
 * Local verify of the Solana accepts/signing shape with the pinned SDK
 * (@x402/svm 2.27.0), no keys and no money: the SDK client builds the payment
 * transaction from OUR emitted accept (watch-only signer, stubbed read-only
 * RPC), then the SDK facilitator's static verification accepts it.
 */
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { resetSolanaRailForTests, validateSolanaPaymentPayload } from "@/lib/solana-rail";
import { SOLANA_PAYTO, USDC_SOLANA_MINT, base58Encode } from "@/lib/solana-config";
import { PAYAI_FEE_PAYER, SOL_PAYER, installBothFacilitators, stubSolanaOn } from "./helpers/solana-env";
import { buildClientPayload, decodeTx, describeTx, sdkStaticVerify, usdcAta } from "./helpers/svm-local";

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const FIXED_BLOCKHASH = base58Encode(new Uint8Array(32).fill(42));

/** Canonical 82-byte SPL mint account: no authorities, decimals 6, initialized. */
function usdcMintAccountB64() {
  const b = Buffer.alloc(82);
  b.writeUInt8(6, 44); // decimals
  b.writeUInt8(1, 45); // is_initialized
  return b.toString("base64");
}

/** Read-only JSON-RPC stub: getAccountInfo(USDC mint) + getLatestBlockhash. Anything else throws. */
function stubRpc() {
  const seen: string[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    const req = JSON.parse(init.body);
    seen.push(req.method);
    let result: unknown;
    if (req.method === "getAccountInfo") {
      expect(req.params[0]).toBe(USDC_SOLANA_MINT);
      result = {
        context: { slot: 1 },
        value: { data: [usdcMintAccountB64(), "base64"], executable: false, lamports: 1, owner: TOKEN_PROGRAM, rentEpoch: 0, space: 82 },
      };
    } else if (req.method === "getLatestBlockhash") {
      result = { context: { slot: 1 }, value: { blockhash: FIXED_BLOCKHASH, lastValidBlockHeight: 100 } };
    } else {
      throw new Error(`unexpected RPC ${req.method}`);
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }), { headers: { "content-type": "application/json" } });
  });
  return seen;
}

async function emittedSolanaAccept(route: string): Promise<PaymentRequirements> {
  const mod = await import(path.join(__dirname, "..", "app", "api", route, "route.ts"));
  const res = await mod.GET(new NextRequest(`https://horizonpulse.dev/api/${route}`, { headers: { accept: "application/json" } }));
  const accepts = decodePaymentRequiredHeader(res.headers.get("payment-required")!).accepts;
  expect(accepts[1].network).toBe("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
  return accepts[1];
}

describe("SDK client + facilitator accept our Solana entry (local, no keys)", () => {
  beforeEach(() => {
    resetSolanaRailForTests();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    installBothFacilitators();
    stubSolanaOn();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  for (const route of ["pulse", "portfolio", "gas", "extract", "search"]) {
    it(`/api/${route}: client-built tx passes SDK static verify; only the (placeholder) signature fails`, async () => {
      const rpcCalls = stubRpc();
      const accept = await emittedSolanaAccept(route);
      const payload = await buildClientPayload(accept, SOL_PAYER, "https://rpc.stub.invalid");
      expect(rpcCalls.sort()).toEqual(["getAccountInfo", "getLatestBlockhash"]);

      // Our own preflight accepts what a real SDK client produces.
      expect(validateSolanaPaymentPayload(payload, accept)).toEqual({ ok: true });

      const d = describeTx((payload.payload as { transaction: string }).transaction);
      expect(d.feePayer).toBe(PAYAI_FEE_PAYER);
      expect(d.bytes).toBeLessThanOrEqual(1232);
      const transfer = d.instructions[2];
      expect(transfer.program).toBe(TOKEN_PROGRAM);
      // TransferChecked accounts: source ATA, mint, destination ATA, authority.
      expect(transfer.accounts[1]).toBe(USDC_SOLANA_MINT);
      expect(transfer.accounts[2]).toBe(await usdcAta(SOLANA_PAYTO, USDC_SOLANA_MINT));
      expect(transfer.accounts[3]).toBe(SOL_PAYER);
      const data = Buffer.from(transfer.dataHex, "hex");
      expect(data[0]).toBe(12); // TransferChecked
      expect(data.readBigUInt64LE(1).toString()).toBe(accept.amount);
      expect(data[9]).toBe(6); // decimals

      const { staticResult, fullResult } = await sdkStaticVerify(payload, accept);
      expect(staticResult).toEqual({ isValid: true, invalidReason: undefined, payer: SOL_PAYER });
      // Full verify reaches the cryptographic signature check and stops there,
      // because the watch-only signer has no key (by design: no keys, no money).
      expect(fullResult.isValid).toBe(false);
      expect(fullResult.invalidReason).toMatch(/signature/i);
    });
  }

  it("SDK facilitator rejects a tx built for another payTo or a lower amount", async () => {
    stubRpc();
    const accept = await emittedSolanaAccept("pulse");
    const other = await buildClientPayload({ ...accept, payTo: base58Encode(new Uint8Array(32).fill(8)) }, SOL_PAYER, "https://rpc.stub.invalid");
    const cheap = await buildClientPayload({ ...accept, amount: "1" }, SOL_PAYER, "https://rpc.stub.invalid");
    const r1 = await sdkStaticVerify({ ...other, accepted: accept }, accept);
    const r2 = await sdkStaticVerify({ ...cheap, accepted: accept }, accept);
    expect(r1.staticResult.isValid).toBe(false);
    expect(r1.staticResult.invalidReason).toMatch(/recipient/i);
    expect(r2.staticResult.isValid).toBe(false);
    expect(r2.staticResult.invalidReason).toMatch(/amount/i);
  });

  it("payTo's USDC ATA derivation (the account a payment credits)", async () => {
    const ata = await usdcAta(SOLANA_PAYTO, USDC_SOLANA_MINT);
    expect(ata).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(decodeTx).toBeTypeOf("function");
    console.log(`payTo USDC ATA: ${ata}`);
  });
});
