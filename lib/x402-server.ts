import { createFacilitatorConfig } from "@coinbase/x402";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type { RoutesConfig } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { withX402 } from "@x402/next";
import {
  getNetworkCaip2,
  getPayTo,
  hasCdpCredentials,
  PULSE_PRICE_USD,
  SIGNALS_PRICE_USD,
  YIELD_PRICE_USD,
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

/**
 * Detect x402 payment headers (case-insensitive via Headers API).
 * Matches @x402/next NextAdapter: PAYMENT-SIGNATURE or X-PAYMENT.
 */
export function getPaymentHeader(req: NextRequest): string | undefined {
  return (
    req.headers.get("payment-signature") ||
    req.headers.get("x-payment") ||
    undefined
  );
}

export function hasPaymentHeader(req: NextRequest): boolean {
  const v = getPaymentHeader(req);
  return Boolean(v && v.trim().length > 0);
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "PAYMENT-SIGNATURE, X-PAYMENT, Content-Type, Accept",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

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

export function yieldRouteConfig(): RoutesConfig {
  const payTo = getPayTo();
  const network = getNetworkCaip2();
  return {
    "/api/yield": {
      accepts: [
        {
          scheme: "exact",
          price: YIELD_PRICE_USD,
          network,
          payTo,
        },
      ],
      description:
        "Ranked DeFi yield pools from DefiLlama (TVL >= $10M, prefer stablecoin/single-asset)",
      mimeType: "application/json",
      extensions: discoveryExt("Horizon Pulse yield rankings", {
        pools: [
          {
            rank: 1,
            project: "aave-v3",
            symbol: "USDC",
            chain: "Ethereum",
            tvlUsd: 0,
            apy: 0,
            preferenceTier: 2,
          },
        ],
        methodology: "DefiLlama yields; TVL>=$10M; prefer stablecoin/single",
      }),
    },
  };
}

/**
 * Explicit paymentRequirements JSON (incl. discoverable outputSchema) for
 * OPTIONS / unpaid GET 402 / agent discovery.
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

/** HTTP 402 with the same payment-requirements body as OPTIONS. */
export function paymentRequiredResponse(opts: {
  maxAmountRequired: string;
  resource: string;
  description: string;
}): NextResponse {
  return NextResponse.json(buildPaymentRequirements(opts), {
    status: 402,
    headers: {
      ...CORS_HEADERS,
      "Cache-Control": "no-store",
    },
  });
}

/** HTTP 503 when a payment header is present but CDP settle keys are missing. */
export function settlementUnavailableResponse(): NextResponse {
  return NextResponse.json(
    {
      error:
        "Payment settlement requires CDP_API_KEY_ID and CDP_API_KEY_SECRET on the server (Vercel env). Unpaid discovery still works via 402 / OPTIONS.",
      payTo: getPayTo(),
    },
    {
      status: 503,
      headers: {
        ...CORS_HEADERS,
        "Cache-Control": "no-store",
      },
    },
  );
}

export function discoveryOptionsResponse(opts: {
  maxAmountRequired: string;
  resource: string;
  description: string;
}): NextResponse {
  return NextResponse.json(buildPaymentRequirements(opts), {
    status: 200,
    headers: {
      Allow: "GET, OPTIONS",
      ...CORS_HEADERS,
    },
  });
}

type AppRouteHandler = (req: NextRequest) => Promise<NextResponse>;

/**
 * Gate unpaid GETs to a local 402 (no facilitator sync). Only invoke withX402
 * when a payment header is present AND CDP credentials exist — lazy-init so
 * cold starts without keys never crash.
 */
export function createX402GetHandler(
  routeHandler: AppRouteHandler,
  routes: RoutesConfig,
  paymentOpts: {
    maxAmountRequired: string;
    resource: string;
    description: string;
  },
): AppRouteHandler {
  let paidHandler: AppRouteHandler | null = null;

  function getPaidHandler(): AppRouteHandler {
    if (!paidHandler) {
      paidHandler = withX402(
        routeHandler,
        routes,
        getResourceServer(),
        undefined,
        undefined,
        true, // sync facilitator — CDP keys are present in this path
      );
    }
    return paidHandler;
  }

  return async (req: NextRequest) => {
    if (!hasPaymentHeader(req)) {
      return paymentRequiredResponse(paymentOpts);
    }
    if (!hasCdpCredentials()) {
      return settlementUnavailableResponse();
    }
    return getPaidHandler()(req);
  };
}
