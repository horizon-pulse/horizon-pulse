/**
 * Horizon Pulse — shared payment & network config.
 * payTo MUST remain the Coinbase treasury address below unless overridden by env.
 */

export const DEFAULT_PAY_TO =
  "0x5b32c973596078a967562ca652761404f19be0e9" as const;

/** USDC on Base mainnet */
export const USDC_BASE =
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

/** CDP hosted x402 facilitator */
export const CDP_FACILITATOR_URL =
  "https://api.cdp.coinbase.com/platform/v2/x402" as const;

/** CAIP-2 network id for Base mainnet (x402 v2) */
export const BASE_CAIP2 = "eip155:8453" as const;

export const PULSE_PRICE_USD = "$0.005" as const;
export const PULSE_PRICE_ATOMIC = "5000" as const; // USDC 6 decimals

export const SIGNALS_PRICE_USD = "$0.008" as const;
export const SIGNALS_PRICE_ATOMIC = "8000" as const;

export const GITHUB_REPO = "https://github.com/horizon-pulse/horizon-pulse" as const;

export function getPayTo(): `0x${string}` {
  const fromEnv = process.env.PAY_TO?.trim();
  const addr = (fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_PAY_TO).toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(addr)) {
    throw new Error(`Invalid PAY_TO address: ${addr}`);
  }
  // Guard: never silently fall back to the retired treasury
  if (addr === "0xe16a1b12404cb2ebc6e783beca6e2a9253c3dc7e") {
    throw new Error(
      "Refusing retired payTo 0xe16A1b12404cB2EbC6e783beCA6E2A9253c3dC7E — use the new treasury",
    );
  }
  return addr as `0x${string}`;
}

/**
 * Resolve X402_NETWORK env (default "base") to CAIP-2 for the SDK.
 */
export function getNetworkCaip2(): typeof BASE_CAIP2 {
  const raw = (process.env.X402_NETWORK ?? "base").trim().toLowerCase();
  if (raw === "base" || raw === "base-mainnet" || raw === BASE_CAIP2) {
    return BASE_CAIP2;
  }
  // Allow explicit CAIP-2 override for advanced use, but document base as canonical
  if (raw.startsWith("eip155:")) {
    return raw as typeof BASE_CAIP2;
  }
  return BASE_CAIP2;
}

export function hasCdpCredentials(): boolean {
  return Boolean(
    process.env.CDP_API_KEY_ID?.trim() && process.env.CDP_API_KEY_SECRET?.trim(),
  );
}
