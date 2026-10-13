/**
 * Rail rejections (Odin 1b, 2026-10-13): the fallback 402 is the golden Base-only
 * 402 with ONE difference: PAYMENT-REQUIRED.error carries a machine-readable
 * reason code instead of "Payment required". Everything else must be
 * byte-identical (re-encoding with the golden error gives the golden header).
 */
import { expect } from "vitest";
import { decodePaymentRequiredHeader, encodePaymentRequiredHeader } from "@x402/core/http";

export function expectRejectedGolden(actual: string | null, golden: string, code?: string | RegExp): string {
  expect(actual).not.toBeNull();
  const a = decodePaymentRequiredHeader(actual!);
  const g = decodePaymentRequiredHeader(golden);
  expect(typeof a.error).toBe("string");
  expect(a.error).toMatch(/^[a-z0-9_]{1,80}$/);
  if (typeof code === "string") expect(a.error).toBe(code);
  else if (code) expect(a.error).toMatch(code);
  expect(encodePaymentRequiredHeader({ ...a, error: g.error })).toBe(golden);
  return a.error!;
}
