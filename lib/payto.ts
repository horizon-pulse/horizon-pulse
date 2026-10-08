/**
 * The ONE place the payTo addresses come from: config/payto.json.
 *
 * Everything else (lib/config.ts DEFAULT_PAY_TO / getPayTo(), lib/solana-config.ts
 * SOLANA_PAYTO / SOLANA_PAYTO_USDC_ATA, the 402s, the copy, the generated
 * discovery docs) reads these values. Env vars are guards, never sources:
 * PAY_TO (Base) must equal base.payTo or getPayTo() throws; HP_SOLANA_PAYTO
 * must equal solana.payTo exactly or the Solana rail stays off.
 *
 * Changing a value is a cut-over (Class A, highest-risk tier: Michael's
 * approval, Solana also his fresh passphrase). Procedure: edit
 * config/payto.json, run `npm run sync:payto`, update the literal tripwire in
 * tests/payto-pin.test.ts by hand, all in one commit. See README "Changing the
 * payTo".
 *
 * Imports nothing but the JSON (safe for lib/solana-config.ts, which must not
 * pull in @solana/* or @x402/svm). Shapes are checked at module load: a
 * malformed config fails the build and every import, never pays elsewhere.
 */
import raw from "../config/payto.json";

export type PayToConfig = {
  base: { payTo: `0x${string}`; basename: string };
  solana: { payTo: string; usdcAta: string };
  retired: { base: string[]; solana: string[] };
};

/** Lower-case 0x + 40 hex: the exact form the 402 challenge carries. */
export const EVM_ADDRESS_LOWER = /^0x[0-9a-f]{40}$/;
/** base58 alphabet, 32..44 chars (32-byte decode is re-checked in lib/solana-config.ts). */
export const BASE58_PUBKEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function check(cond: boolean, what: string): void {
  if (!cond) throw new Error(`config/payto.json: invalid ${what}`);
}

function load(c: typeof raw): PayToConfig {
  check(EVM_ADDRESS_LOWER.test(c?.base?.payTo ?? ""), "base.payTo (must be lower-case 0x + 40 hex)");
  check(typeof c.base.basename === "string" && c.base.basename.endsWith(".base.eth"), "base.basename");
  check(BASE58_PUBKEY.test(c?.solana?.payTo ?? ""), "solana.payTo (base58 pubkey)");
  check(BASE58_PUBKEY.test(c.solana.usdcAta ?? ""), "solana.usdcAta (base58 pubkey)");
  check(c.solana.usdcAta !== c.solana.payTo, "solana.usdcAta (must differ from payTo)");
  check(Array.isArray(c?.retired?.base) && c.retired.base.every((a) => EVM_ADDRESS_LOWER.test(a)), "retired.base");
  check(Array.isArray(c.retired.solana) && (c.retired.solana as string[]).every((a) => BASE58_PUBKEY.test(a)), "retired.solana");
  check(!c.retired.base.includes(c.base.payTo), "base.payTo (is on retired.base)");
  check(!(c.retired.solana as string[]).includes(c.solana.payTo), "solana.payTo (is on retired.solana)");
  return Object.freeze({
    base: Object.freeze({ payTo: c.base.payTo as `0x${string}`, basename: c.base.basename }),
    solana: Object.freeze({ payTo: c.solana.payTo, usdcAta: c.solana.usdcAta }),
    retired: Object.freeze({ base: Object.freeze([...c.retired.base]) as string[], solana: Object.freeze([...(c.retired.solana as string[])]) as string[] }),
  });
}

export const PAYTO: PayToConfig = load(raw);
