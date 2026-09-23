import { createFacilitatorConfig } from "@coinbase/x402";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type { RoutesConfig } from "@x402/core/server";
import { encodePaymentRequiredHeader } from "@x402/core/http";
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
  PORTFOLIO_PRICE_USD,
  GAS_PRICE_USD,
  FUNDING_PRICE_USD,
  FETCH_PRICE_USD,
  HTTP_PRICE_USD,
  EXTRACT_PRICE_USD,
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
    "PAYMENT-SIGNATURE, X-PAYMENT, PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE, Content-Type, Accept",
  "Access-Control-Expose-Headers":
    "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

/** @x402/extensions types omit `method` (enrichment-only); CDP Bazaar validate needs it statically. */
type DiscoveryDecl = Parameters<typeof declareDiscoveryExtension>[0];

function discoveryExt(
  description: string,
  outputExample: Record<string, unknown>,
) {
  return {
    ...declareDiscoveryExtension({
      method: "GET",
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
    } as DiscoveryDecl),
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

export function portfolioRouteConfig(): RoutesConfig {
  const payTo = getPayTo();
  const network = getNetworkCaip2();
  return {
    "/api/portfolio": {
      accepts: [
        {
          scheme: "exact",
          price: PORTFOLIO_PRICE_USD,
          network,
          payTo,
        },
      ],
      description:
        "On-chain portfolio for one EVM address (?address=0x...) on Base + Ethereum: native ETH, USDC, WETH, WBTC/cbBTC, DAI; rule-based risk + rebalance suggestions",
      mimeType: "application/json",
      extensions: {
        ...declareDiscoveryExtension({
          method: "GET",
          input: { address: "0x..." },
          inputSchema: {
            properties: {
              address: {
                type: "string",
                description: "EVM address (0x + 40 hex) required as query param",
              },
            },
            required: ["address"],
          },
          output: {
            example: {
              address: "0x...",
              totals: { valueUsd: 0, stablecoinShare: 0 },
              risk: { score: 0, band: "moderate" },
              suggestions: [],
              methodology: {},
            },
            schema: {
              type: "object",
              description: "Horizon Pulse portfolio snapshot",
            },
          },
        } as DiscoveryDecl),
      },
    },
  };
}

export function gasRouteConfig(): RoutesConfig {
  const payTo = getPayTo();
  const network = getNetworkCaip2();
  return {
    "/api/gas": {
      accepts: [
        {
          scheme: "exact",
          price: GAS_PRICE_USD,
          network,
          payTo,
        },
      ],
      description:
        "Live Base + Ethereum gas fees via eth_feeHistory / eth_gasPrice: baseFee, priority, suggested maxFee, timingHint (cheap/normal/expensive), optional transfer USD cost",
      mimeType: "application/json",
      extensions: discoveryExt("Horizon Pulse gas snapshot", {
        ethUsd: 0,
        networks: [
          {
            network: "base",
            baseFeeGwei: "0",
            priorityFeeGwei: "0",
            suggestedMaxFeeGwei: "0",
            timingHint: "normal",
          },
        ],
        methodology: "eth_feeHistory + optional CoinGecko ETH USD",
      }),
    },
  };
}

export function fundingRouteConfig(): RoutesConfig {
  const payTo = getPayTo();
  const network = getNetworkCaip2();
  return {
    "/api/funding": {
      accepts: [
        {
          scheme: "exact",
          price: FUNDING_PRICE_USD,
          network,
          payTo,
        },
      ],
      description:
        "Live OKX perpetual funding rates for BTC/ETH/SOL with optional rule-based crowding hint (sign/magnitude)",
      mimeType: "application/json",
      extensions: discoveryExt("Horizon Pulse funding snapshot", {
        assets: {
          BTC: {
            instId: "BTC-USDT-SWAP",
            fundingRate: 0,
            crowding: { side: "neutral", level: "quiet" },
          },
        },
        methodology: "OKX public funding-rate; crowding = rules only",
      }),
    },
  };
}


export function fetchRouteConfig(): RoutesConfig {
  const payTo = getPayTo();
  const network = getNetworkCaip2();
  return {
    "/api/fetch": {
      accepts: [
        {
          scheme: "exact",
          price: FETCH_PRICE_USD,
          network,
          payTo,
        },
      ],
      description:
        "Fetch a public http(s) URL (?url=...) and return best-effort clean text/markdown; SSRF-safe with size/time caps",
      mimeType: "application/json",
      extensions: {
        ...declareDiscoveryExtension({
          method: "GET",
          input: { url: "https://example.com" },
          inputSchema: {
            properties: {
              url: {
                type: "string",
                description:
                  "Absolute http(s) URL to fetch (required). Private/localhost blocked; ~200KB / 8s caps.",
              },
            },
            required: ["url"],
          },
          output: {
            example: {
              ok: true,
              finalUrl: "https://example.com",
              format: "markdown",
              truncated: false,
              content: "# Example\n\nClean text…",
            },
            schema: {
              type: "object",
              description: "Horizon Pulse URL fetch (clean text)",
            },
          },
        } as DiscoveryDecl),
      },
    },
  };
}

export function httpRouteConfig(): RoutesConfig {
  const payTo = getPayTo();
  const network = getNetworkCaip2();
  // Path without verb prefix → matches GET and POST (*). Same $0.01 price.
  // Bazaar discovery advertises GET (CDP validate); POST is paid identically.
  return {
    "/api/http": {
      accepts: [
        {
          scheme: "exact",
          price: HTTP_PRICE_USD,
          network,
          payTo,
        },
      ],
      description:
        "Universal agent HTTP proxy: GET|POST /api/http with url (+ optional method/headers/body) → status, filtered headers, body text|base64; SSRF-safe; $0.01 for volume (fetch remains $0.02 clean-text)",
      mimeType: "application/json",
      extensions: {
        ...declareDiscoveryExtension({
          method: "GET",
          input: {
            url: "https://example.com",
            method: "GET",
          },
          inputSchema: {
            properties: {
              url: {
                type: "string",
                description:
                  "Absolute http(s) URL (required). Private/localhost blocked.",
              },
              method: {
                type: "string",
                description:
                  "Upstream method: GET (default) | POST | HEAD | PUT | PATCH | DELETE",
              },
              headers: {
                type: "object",
                description:
                  "Optional allowlisted outbound headers (no Cookie / hop-by-hop). On GET pass as JSON string query param.",
              },
              body: {
                type: "string",
                description:
                  "Optional body for POST/PUT/PATCH (via POST /api/http JSON). Size-capped.",
              },
            },
            required: ["url"],
          },
          output: {
            example: {
              ok: true,
              status: 200,
              headers: { "content-type": "text/plain" },
              body: "hello",
              bodyEncoding: "text",
              contentType: "text/plain",
              elapsedMs: 42,
            },
            schema: {
              type: "object",
              description: "Horizon Pulse universal HTTP proxy result",
            },
          },
        } as DiscoveryDecl),
      },
    },
  };
}



export function extractRouteConfig(): RoutesConfig {
  const payTo = getPayTo();
  const network = getNetworkCaip2();
  // Path without verb prefix → matches GET and POST (*). Same $0.015 price.
  // Bazaar discovery advertises GET (CDP validate); POST is paid identically.
  return {
    "/api/extract": {
      accepts: [
        {
          scheme: "exact",
          price: EXTRACT_PRICE_USD,
          network,
          payTo,
        },
      ],
      description:
        "Extract structured page fields from a public URL or provided HTML (title, description, canonical, links, images, headings, json-ld, text sample); SSRF-safe; $0.015 between http ($0.01) and fetch ($0.02)",
      mimeType: "application/json",
      extensions: {
        ...declareDiscoveryExtension({
          method: "GET",
          input: {
            url: "https://example.com",
          },
          inputSchema: {
            properties: {
              url: {
                type: "string",
                description:
                  "Absolute http(s) URL to fetch and extract (optional if html provided). Private/localhost blocked.",
              },
              html: {
                type: "string",
                description:
                  "Optional raw HTML to parse (size-capped). Prefer POST JSON when sending html. If both url and html are sent, html is parsed and url is echoed.",
              },
            },
            required: [],
          },
          output: {
            example: {
              ok: true,
              url: "https://example.com",
              title: "Example Domain",
              description: "Example description",
              canonical: "https://example.com/",
              language: "en",
              links: [{ href: "https://example.com/", text: "More information" }],
              images: [{ src: "https://example.com/og.png", alt: "Logo" }],
              jsonLd: [],
              headings: [{ level: 1, text: "Example Domain" }],
              textSample: "Example Domain…",
              elapsedMs: 42,
            },
            schema: {
              type: "object",
              description: "Horizon Pulse structured HTML extract result",
            },
          },
        } as DiscoveryDecl),
      },
    },
  };
}


/**
 * Explicit x402 v2 PaymentRequired (no facilitator sync) for OPTIONS /
 * unpaid GET when CDP keys are absent. Must stay wire-compatible with
 * @x402/next: PAYMENT-REQUIRED header + CAIP-2 network + `amount`.
 *
 * NOTE: when CDP is present, createX402GetHandler routes unpaid through
 * withX402 so the challenge matches facilitator-enhanced accepts exactly.
 */
export function buildPaymentRequirements(opts: {
  maxAmountRequired: string;
  resource: string;
  description: string;
}) {
  const payTo = getPayTo();
  const network = getNetworkCaip2();
  return {
    x402Version: 2 as const,
    resource: {
      url: opts.resource,
      description: opts.description,
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network,
        amount: opts.maxAmountRequired,
        asset: USDC_BASE,
        payTo,
        // Match @x402/core default when route omits maxTimeoutSeconds
        maxTimeoutSeconds: 300,
        extra: {
          name: "USD Coin",
          version: "2",
        },
      },
    ],
  };
}

/** HTTP 402 with v2 body + PAYMENT-REQUIRED header (canonical wire location). */
export function paymentRequiredResponse(opts: {
  maxAmountRequired: string;
  resource: string;
  description: string;
}): NextResponse {
  const paymentRequired = buildPaymentRequirements(opts);
  return NextResponse.json(paymentRequired, {
    status: 402,
    headers: {
      ...CORS_HEADERS,
      "Cache-Control": "no-store",
      "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired),
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
  const paymentRequired = buildPaymentRequirements(opts);
  return NextResponse.json(paymentRequired, {
    status: 200,
    headers: {
      Allow: "GET, OPTIONS",
      ...CORS_HEADERS,
      "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired),
    },
  });
}

type AppRouteHandler = (req: NextRequest) => Promise<NextResponse>;

/**
 * Unpaid + no CDP → local v2 402 (no facilitator sync).
 * Unpaid + CDP → withX402 (same v2 PAYMENT-REQUIRED the settle path uses).
 * Paid + no CDP → 503.
 * Paid + CDP → withX402 verify+settle.
 *
 * Critical: @x402/core extractPayment only reads PAYMENT-SIGNATURE (v2), not
 * X-PAYMENT (v1). Advertising a v1 body caused clients to retry with X-PAYMENT,
 * which withX402 ignored → 402 {} + v2 PAYMENT-REQUIRED "Payment required".
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
    const cdpReady = hasCdpCredentials();
    if (!hasPaymentHeader(req)) {
      // With CDP, return the identical v2 challenge withX402 will verify against.
      if (cdpReady) {
        return getPaidHandler()(req);
      }
      return paymentRequiredResponse(paymentOpts);
    }
    if (!cdpReady) {
      return settlementUnavailableResponse();
    }
    return getPaidHandler()(req);
  };
}
