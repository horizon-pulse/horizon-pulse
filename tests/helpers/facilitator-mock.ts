/**
 * Deterministic, offline facilitator stubs for tests.
 *
 * Every @x402/core HTTPFacilitatorClient (the CDP one built by
 * lib/x402-server.ts and, on the XRPL branch, the XRPL one) is patched at the
 * prototype, so no test ever reaches a real facilitator. Calls are recorded
 * with the client's URL so tests can prove which facilitator saw which payload.
 */
import { vi } from "vitest";
import { HTTPFacilitatorClient } from "@x402/core/server";

export const CDP_URL_PREFIX = "https://api.cdp.coinbase.com/";

export type FacilitatorCall = { url: string; op: "supported" | "verify" | "settle"; network?: string };

export type FacilitatorBehaviour = {
  /** Return the supported response for a facilitator URL, or throw to simulate an outage. */
  supported?: (url: string) => unknown;
  verify?: (url: string, payload: any, requirements: any) => unknown;
  settle?: (url: string, payload: any, requirements: any) => unknown;
};

export const CDP_SUPPORTED = {
  kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }],
  extensions: ["bazaar"],
  signers: {},
};

export function installFacilitatorMock(behaviour: FacilitatorBehaviour = {}) {
  const calls: FacilitatorCall[] = [];
  const url = (self: unknown) => String((self as { url?: string }).url ?? "");
  vi.spyOn(HTTPFacilitatorClient.prototype, "getSupported").mockImplementation(async function (this: unknown) {
    calls.push({ url: url(this), op: "supported" });
    if (behaviour.supported) return behaviour.supported(url(this)) as never;
    if (url(this).startsWith(CDP_URL_PREFIX)) return CDP_SUPPORTED as never;
    throw new Error(`unexpected facilitator ${url(this)}`);
  });
  vi.spyOn(HTTPFacilitatorClient.prototype, "verify").mockImplementation(async function (this: unknown, p: any, r: any) {
    calls.push({ url: url(this), op: "verify", network: r?.network });
    if (behaviour.verify) return behaviour.verify(url(this), p, r) as never;
    throw new Error("verify not stubbed");
  });
  vi.spyOn(HTTPFacilitatorClient.prototype, "settle").mockImplementation(async function (this: unknown, p: any, r: any) {
    calls.push({ url: url(this), op: "settle", network: r?.network });
    if (behaviour.settle) return behaviour.settle(url(this), p, r) as never;
    throw new Error("settle not stubbed");
  });
  return calls;
}
