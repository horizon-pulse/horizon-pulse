/**
 * Rail rejections (Odin 1b, 2026-10-13): the fallback 402 is the golden Base-only
 * 402 with ONE difference: PAYMENT-REQUIRED.error carries a machine-readable
 * reason code instead of "Payment required". Everything else must be
 * byte-identical (re-encoding with the golden error gives the golden header).
 */
import { expect } from "vitest";
import { decodePaymentRequiredHeader, encodePaymentRequiredHeader } from "@x402/core/http";

export function expectRejectedGolden(actual: string | null, golden: string, code: string): string {
  // Odin F2: every call site pins the exact expected reason code.
  expect(actual).not.toBeNull();
  const a = decodePaymentRequiredHeader(actual!);
  const g = decodePaymentRequiredHeader(golden);
  expect(typeof a.error).toBe("string");
  expect(a.error).toMatch(/^[a-z0-9_]{1,80}$/);
  expect(a.error).toBe(code);
  expect(encodePaymentRequiredHeader({ ...a, error: g.error })).toBe(golden);
  return a.error!;
}

/**
 * Odin 2:29 (b) delta6: a reject 402 that ALSO re-offers rails after the golden Base entry. Everything except
 * `error` and the appended accepts must be the golden header byte for byte; the appended accepts are pinned exactly.
 */
export function expectRejectedGoldenPlus(actual: string | null, golden: string, code: string, extra: unknown[]): void {
  expect(actual).not.toBeNull();
  const a = decodePaymentRequiredHeader(actual!);
  const g = decodePaymentRequiredHeader(golden);
  expect(a.error).toBe(code);
  expect(a.accepts).toEqual([...g.accepts, ...extra]);
  expect(encodePaymentRequiredHeader({ ...a, accepts: a.accepts.slice(0, g.accepts.length), error: g.error })).toBe(golden);
}
