import { vi } from "vitest";
import { CDP_URL_PREFIX, CDP_SUPPORTED, installFacilitatorMock, type FacilitatorBehaviour } from "./facilitator-mock";
import { CDP_ENV } from "./capture";
import { validTestAddress } from "./xrpl-addresses";

export const XRPL_PAYTO = validTestAddress(7);
export const XRPL_PAYER = validTestAddress(9);
export const DEFAULT_XRPL_FACILITATOR = "https://x402.org/facilitator";

/** What the public x402.org facilitator's /supported looks like (multi-network; the wrapper must filter). */
export const XRPL_FACILITATOR_SUPPORTED = {
  kinds: [
    { x402Version: 2, scheme: "exact", network: "eip155:84532" },
    { x402Version: 2, scheme: "exact", network: "xrpl:1" },
    { x402Version: 2, scheme: "exact", network: "xrpl:0" },
  ],
  extensions: [],
  signers: {},
};

export function stubXrplOn(extra: Record<string, string> = {}, cdp = true) {
  vi.unstubAllEnvs();
  vi.stubEnv("HP_XRPL_ENABLED", "true");
  vi.stubEnv("HP_XRPL_PAYTO", XRPL_PAYTO);
  for (const [k, v] of Object.entries(extra)) vi.stubEnv(k, v);
  vi.stubEnv("CDP_API_KEY_ID", cdp ? CDP_ENV.CDP_API_KEY_ID : "");
  vi.stubEnv("CDP_API_KEY_SECRET", cdp ? CDP_ENV.CDP_API_KEY_SECRET : "");
}

export function setCdp(on: boolean) {
  vi.stubEnv("CDP_API_KEY_ID", on ? CDP_ENV.CDP_API_KEY_ID : "");
  vi.stubEnv("CDP_API_KEY_SECRET", on ? CDP_ENV.CDP_API_KEY_SECRET : "");
}

/** CDP answers as usual; any other URL answers like an XRPL-capable facilitator (override per test). */
export function installBothFacilitators(overrides: FacilitatorBehaviour = {}) {
  return installFacilitatorMock({
    supported: (url) => {
      if (url.startsWith(CDP_URL_PREFIX)) return CDP_SUPPORTED;
      if (overrides.supported) return overrides.supported(url);
      return XRPL_FACILITATOR_SUPPORTED;
    },
    verify: overrides.verify,
    settle: overrides.settle,
  });
}
