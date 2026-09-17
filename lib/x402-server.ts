import { createFacilitatorConfig } from "@coinbase/x402";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type { RoutesConfig } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import {
  getNetworkCaip2,
  getPayTo,
  hasCdpCredentials,
  PULSE_PRICE_USD,
  SIGNALS_PRICE_USD,
  USDC_BASE,
} from "./config";

/**
 * Coinbase CDP facilitator via @coinbase/x402.
 * list/discovery works without keys; verify+settle need CDP_API_KEY_ID/SECRET.
 */
function buildFacilitatorClient(): HTTPFacilitatorClient {
  const apiKeyId = process.env.CDP_API_KEY_ID?.trim() || undefined;
  const apiKeySecret = process.env.CDP_API_KEY_SECRET?.trim() || undefined;
  return new HTTPFacilitatorClient(
    createFacilitatorConfig(apiKeyId, apiKeySecret),
  );
}

let cachedServer: x402ResourceServer | null = null;

export function getResourceServer(): x402ResourceServer {
  if (cachedServer) return cachedServer;
  const network = getNetworkCaip2();
  cachedServer = new x402ResourceServer(buildFacilitatorClient()).register(
    network,
    new ExactEvmScheme(),
  );
  return cachedServer;
}

/** Avoid facilitator sync at boot when CDP secrets are absent. */
export function shouldSyncFacilitator(): boolean {
  return hasCdpCredentials();
}

function discoveryExt(
  description: string,
  outputExample: Record<string, unknown>,
) {
  return {
    ...declareDiscoveryExtension({
      input: {},
      inputSchema: {
        properties: {},
        required: [],
      },
      output: {
        example: outputExample,
        schema: {
          type: "object",
          description,
        },
      },
    }),
  };
}

export function pulseRouteConfig(): RoutesConfig {
  const payTo = getPayTo();
  const network = getNetworkCaip2();
  return {
    "/api/pulse": {
      accepts: [
        {
          scheme: "exact",
          price: PULSE_PRICE_USD,
          network,
          payTo,
        },
      ],
      description:
        "BTC/ETH/SOL spot prices with momentum, overall sentiment, and signal from CoinGecko",
      mimeType: "application/json",
      extensions: discoveryExt("Horizon Pulse market snapshot", {
        assets: { BTC: { priceUsd: 0, change24hPct: 0, momentum: "neutral" } },
        overall: { momentum: "neutral", sentiment: "neutral", signal: "hold" },
      }),
    },
  };
}

export function signalsRouteConfig(): RoutesConfig {
  const payTo = getPayTo();
  const network = getNetworkCaip2();
  return {
    "/api/signals": {
      accepts: [
        {
          scheme: "exact",
          price: SIGNALS_PRICE_USD,
          network,
          payTo,
        },
      ],
      description:
        "RSI/MACD/Bollinger from CoinGecko OHLC plus OKX perpetual funding rates",
      mimeType: "application/json",
      extensions: discoveryExt("Horizon Pulse technical signals", {
        assets: {
          BTC: {
            rsi14: 50,
            macd: { macd: 0, signal: 0, histogram: 0 },
            bollinger: { upper: 0, middle: 0, lower: 0 },
            fundingRate: 0,
          },
        },
        methodology: "CoinGecko OHLC + OKX funding",
      }),
    },
  };
}

/**
 * Explicit paymentRequirements JSON (incl. discoverable outputSchema) for
 * OPTIONS / agent discovery. Complements the x402 PAYMENT-REQUIRED header.
 */
export function buildPaymentRequirements(opts: {
  maxAmountRequired: string;
  resource: string;
  description: string;
}) {
  const payTo = getPayTo();
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: "base",
        maxAmountRequired: opts.maxAmountRequired,
        resource: opts.resource,
        description: opts.description,
        mimeType: "application/json",
        payTo,
        maxTimeoutSeconds: 60,
        asset: USDC_BASE,
        outputSchema: {
          input: {
            type: "http",
            method: "GET",
            discoverable: true,
          },
          output: {
            type: "object",
          },
        },
        extra: {
          name: "USD Coin",
          version: "2",
        },
      },
    ],
  };
}
