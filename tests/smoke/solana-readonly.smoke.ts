/**
 * READ-ONLY network smoke for the Solana rail. No wallet, no keys, no
 * payment, nothing broadcast. Network calls: GET PayAI /supported, and
 * Solana mainnet JSON-RPC reads (getAccountInfo, getLatestBlockhash,
 * getTokenAccountsByOwner).
 *
 * Input: SMOKE_FLAG_ON_JSON = output of scripts/smoke-solana-rail.mjs against
 * a flag-on `next start`. Output: SMOKE_OUT (JSON evidence).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PaymentRequirements } from "@x402/core/types";
import { PAYAI_FACILITATOR_URL, SOLANA_MAINNET_CAIP2, SOLANA_PAYTO, USDC_SOLANA_MINT, base58Encode } from "@/lib/solana-config";
import { validateSolanaPaymentPayload } from "@/lib/solana-rail";
import { buildClientPayload, describeTx, sdkStaticVerify, usdcAta } from "../helpers/svm-local";

const RPC = process.env.SMOKE_SOLANA_RPC ?? "https://api.mainnet-beta.solana.com";
const IN = process.env.SMOKE_FLAG_ON_JSON!;
const OUT = process.env.SMOKE_OUT ?? "solana-readonly-smoke.json";
/** Watch-only placeholder payer (32 filler bytes; no key exists). */
const PAYER = base58Encode(new Uint8Array(32).fill(9));

async function rpc(method: string, params: unknown[]) {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await res.json()).result;
}

describe("Solana rail read-only smoke", () => {
  it("live 402 accepts vs PayAI + mainnet + SDK", async () => {
    const evidence: Record<string, unknown> = { at: new Date().toISOString(), rpc: RPC };
    const smoke = JSON.parse(readFileSync(IN, "utf8"));

    // 1. PayAI /supported (read-only GET)
    const sup = await (await fetch(`${PAYAI_FACILITATOR_URL}/supported`)).json();
    const solKinds = sup.kinds.filter((k: { network: string }) => String(k.network).startsWith("solana"));
    const exactMain = solKinds.find((k: { x402Version: number; scheme: string; network: string }) => k.x402Version === 2 && k.scheme === "exact" && k.network === SOLANA_MAINNET_CAIP2);
    evidence.payaiSolanaKinds = solKinds.map((k: { x402Version: number; scheme: string; network: string; extra?: { feePayer?: string } }) => ({ v: k.x402Version, scheme: k.scheme, network: k.network, feePayer: k.extra?.feePayer }));
    evidence.payaiExtensions = sup.extensions;
    expect(exactMain).toBeTruthy();

    // 2. Every live Solana accept: exact payTo / mint / network, fee payer = PayAI's current one, amount = Base amount
    const perRoute: Record<string, unknown> = {};
    for (const r of smoke.results) {
      const [base, sol] = r.accepts as PaymentRequirements[];
      expect(base.network).toBe("eip155:8453");
      expect(sol).toMatchObject({ scheme: "exact", network: SOLANA_MAINNET_CAIP2, asset: USDC_SOLANA_MINT, payTo: SOLANA_PAYTO, amount: base.amount });
      expect((sol.extra as { feePayer: string }).feePayer).toBe(exactMain.extra.feePayer);
      perRoute[r.key] = { status: r.status, baseAmount: base.amount, solanaAmount: sol.amount };
    }
    evidence.liveRoutesChecked = Object.keys(perRoute).length;

    // 3. Mainnet reads: USDC mint, payTo account, payTo's USDC ATA
    const mint = await rpc("getAccountInfo", [USDC_SOLANA_MINT, { encoding: "jsonParsed" }]);
    evidence.usdcMint = { owner: mint.value.owner, decimals: mint.value.data.parsed.info.decimals, slot: mint.context.slot };
    expect(mint.value.owner).toBe("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    expect(mint.value.data.parsed.info.decimals).toBe(6);
    const ata = await usdcAta(SOLANA_PAYTO, USDC_SOLANA_MINT);
    const payToAcct = await rpc("getAccountInfo", [SOLANA_PAYTO, { encoding: "base64" }]);
    const ataAcct = await rpc("getAccountInfo", [ata, { encoding: "jsonParsed" }]);
    const byOwner = await rpc("getTokenAccountsByOwner", [SOLANA_PAYTO, { mint: USDC_SOLANA_MINT }, { encoding: "jsonParsed" }]);
    evidence.payTo = { address: SOLANA_PAYTO, accountExists: payToAcct.value !== null, slot: payToAcct.context.slot };
    evidence.payToUsdcAta = { address: ata, exists: ataAcct.value !== null, usdcTokenAccountsByOwner: byOwner.value.length };

    // 4. SDK client builds the tx from the LIVE accept with real read-only RPC; SDK facilitator static verify
    const sample = smoke.results.find((r: { key: string }) => r.key === "GET /api/pulse json").accepts[1] as PaymentRequirements;
    const payload = await buildClientPayload(sample, PAYER, RPC);
    expect(validateSolanaPaymentPayload(payload, sample)).toEqual({ ok: true });
    const tx = (payload.payload as { transaction: string }).transaction;
    const { staticResult, fullResult } = await sdkStaticVerify(payload, sample);
    evidence.sdkLocalVerify = {
      route: "/api/pulse",
      decodedTx: describeTx(tx),
      staticVerify: staticResult,
      fullVerify: fullResult,
      note: "watch-only placeholder signer: full verify stops at the signature check by design; nothing signed or broadcast",
    };
    expect(staticResult.isValid).toBe(true);
    writeFileSync(OUT, JSON.stringify(evidence, null, 1) + "\n");
  });
});
