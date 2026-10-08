/**
 * LITERAL TRIPWIRE for the payTo addresses. Deliberately the ONE test file
 * that spells them out (everything else imports config/payto.json).
 *
 * A cut-over must edit config/payto.json AND this file by hand, in the same
 * commit, so a stray or malicious config change cannot pass `npm test` on its
 * own. Code-level twin of the "fresh passphrase" rule in lib/solana-config.ts.
 * Changing these values needs Michael's explicit approval (Solana: his fresh
 * passphrase) and Odin review. Do not "fix" this test to make CI green.
 */
import { describe, expect, it } from "vitest";
import payto from "../config/payto.json";
import { BASE_PAY_TO_BASENAME, DEFAULT_PAY_TO, getPayTo } from "@/lib/config";
import { SOLANA_PAYTO, SOLANA_PAYTO_USDC_ATA } from "@/lib/solana-config";

const PIN = {
  basePayTo: "0x5b32c973596078a967562ca652761404f19be0e9",
  basename: "horizonpulsebase.base.eth",
  solanaPayTo: "BjY98A6dS3GGLZdz2zHy8wK7XAwnQgNhCc66mfmBTRPz",
  solanaUsdcAta: "3v95wKFDYRxegtZQYYeUzNnPrhogaCs9UpaR4QD7MzZu",
  retiredBase: ["0xe16a1b12404cb2ebc6e783beca6e2a9253c3dc7e"],
} as const;

describe("payTo literal tripwire", () => {
  it("config/payto.json holds exactly the pinned values", () => {
    expect(payto.base.payTo).toBe(PIN.basePayTo);
    expect(payto.base.basename).toBe(PIN.basename);
    expect(payto.solana.payTo).toBe(PIN.solanaPayTo);
    expect(payto.solana.usdcAta).toBe(PIN.solanaUsdcAta);
    expect(payto.retired.base).toEqual(PIN.retiredBase);
    expect(payto.retired.solana).toEqual([]);
  });

  it("the runtime exports resolve to the pinned values", () => {
    expect(DEFAULT_PAY_TO).toBe(PIN.basePayTo);
    expect(getPayTo()).toBe(PIN.basePayTo);
    expect(BASE_PAY_TO_BASENAME).toBe(PIN.basename);
    expect(SOLANA_PAYTO).toBe(PIN.solanaPayTo);
    expect(SOLANA_PAYTO.length).toBe(44);
    expect(SOLANA_PAYTO_USDC_ATA).toBe(PIN.solanaUsdcAta);
  });
});
