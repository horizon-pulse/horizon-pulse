import { createFacilitatorConfig } from "@coinbase/x402";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type { RoutesConfig } from "@x402/core/server";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { withX402 } from "@x402/next";
import { asJsonRequest, browser402, isBrowserNavigation, withVary } from "@/lib/browser-402";
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
  SCREENSHOT_PRICE_USD,
  X402_CHECK_PRICE_USD,
  SEARCH_PRICE_USD,
  PDF_PRICE_USD,
  HTTP_PRICE_USD,
  EXTRACT_PRICE_USD,
  USDC_BASE,
  PUBLIC_BASE_URL,
} from "./config";
import { MAX_DESCRIPTION_CHARS, routeMetadata } from "./route-metadata";
import { EXAMPLES_RECORDED_AT, OUTPUT_EXAMPLES } from "./route-examples";

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

/**
 * Bazaar service-level metadata on the top-level `resource` object
 * (x402 specs/extensions/bazaar.md "Service Metadata on `resource`").
 * Purely additive: no effect on accepts / price / payTo. serviceName and
 * tags must be printable ASCII, <= 32 chars; max 5 tags. Tags are per route
 * (lib/route-metadata.ts); the first tag is the route's category.
 */
const SERVICE_NAME = "Horizon Pulse";

export function serviceMetadata(path: string) {
  const meta = routeMetadata(path);
  if (!meta) throw new Error(`No discovery metadata for ${path} (add it to lib/route-metadata.ts)`);
  return {
    serviceName: SERVICE_NAME,
    tags: [...meta.tags],
    iconUrl: `${PUBLIC_BASE_URL}/icon.png`,
  };
}

/** Route description (agent instruction, <= 500 chars) from lib/route-metadata.ts. */
function routeDescription(path: string): string {
  const meta = routeMetadata(path);
  if (!meta) throw new Error(`No discovery metadata for ${path}`);
  if (meta.description.length > MAX_DESCRIPTION_CHARS) {
    throw new Error(`${path} description is ${meta.description.length} chars (> ${MAX_DESCRIPTION_CHARS})`);
  }
  return meta.description;
}

/** Recorded example (see lib/route-examples.ts) + a label saying it is an example. */
function outputOf(path: string, what: string) {
  const example = OUTPUT_EXAMPLES[path];
  if (!example) throw new Error(`No output example for ${path}`);
  return {
    example,
    schema: {
      type: "object",
      description: `${what}. The example is a trimmed real response recorded from GET /api/demo/${path.slice(5)} at ${EXAMPLES_RECORDED_AT} UTC; live values differ on every call.`,
    },
  };
}

/** @x402/extensions types omit `method` (enrichment-only); CDP Bazaar validate needs it statically. */
type DiscoveryDecl = Parameters<typeof declareDiscoveryExtension>[0];

function discoveryExt(path: string, what: string) {
  return {
    ...declareDiscoveryExtension({
      method: "GET",
      input: {},
      inputSchema: {
        properties: {},
        required: [],
      },
      output: outputOf(path, what),
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
      description: routeDescription("/api/pulse"),
      mimeType: "application/json",
      ...serviceMetadata("/api/pulse"),
      extensions: discoveryExt("/api/pulse", "Horizon Pulse market snapshot"),
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
      description: routeDescription("/api/signals"),
      mimeType: "application/json",
      ...serviceMetadata("/api/signals"),
      extensions: discoveryExt("/api/signals", "Horizon Pulse technical signals"),
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
      description: routeDescription("/api/yield"),
      mimeType: "application/json",
      ...serviceMetadata("/api/yield"),
      extensions: discoveryExt("/api/yield", "Horizon Pulse yield rankings"),
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
      description: routeDescription("/api/portfolio"),
      mimeType: "application/json",
      ...serviceMetadata("/api/portfolio"),
      extensions: {
        ...declareDiscoveryExtension({
          method: "GET",
          input: { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" },
          inputSchema: {
            properties: {
              address: {
                type: "string",
                pattern: "^0x[0-9a-fA-F]{40}$",
                description: "EVM address to read on Base + Ethereum (required): 0x followed by 40 hex characters.",
              },
            },
            required: ["address"],
          },
          output: outputOf("/api/portfolio", "Horizon Pulse portfolio snapshot"),
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
      description: routeDescription("/api/gas"),
      mimeType: "application/json",
      ...serviceMetadata("/api/gas"),
      extensions: discoveryExt("/api/gas", "Horizon Pulse gas snapshot"),
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
      description: routeDescription("/api/funding"),
      mimeType: "application/json",
      ...serviceMetadata("/api/funding"),
      extensions: discoveryExt("/api/funding", "Horizon Pulse funding snapshot"),
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
      description: routeDescription("/api/fetch"),
      mimeType: "application/json",
      ...serviceMetadata("/api/fetch"),
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
          output: outputOf("/api/fetch", "Horizon Pulse URL fetch (clean text)"),
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
      description: routeDescription("/api/http"),
      mimeType: "application/json",
      ...serviceMetadata("/api/http"),
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
          output: outputOf("/api/http", "Horizon Pulse universal HTTP proxy result"),
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
      description: routeDescription("/api/extract"),
      mimeType: "application/json",
      ...serviceMetadata("/api/extract"),
      extensions: {
        ...declareDiscoveryExtension({
          method: "GET",
          input: {
            url: "https://horizonpulse.dev",
          },
          inputSchema: {
            properties: {
              url: {
                type: "string",
                description:
                  "Absolute http(s) URL to fetch and extract (required on GET; on POST send url or html in the JSON body). Private/localhost blocked.",
              },
              html: {
                type: "string",
                description:
                  "POST /api/extract JSON body only (ignored on GET): raw HTML to parse instead of fetching (size-capped). If both url and html are sent, html is parsed and url is echoed.",
              },
              fields: {
                type: "object",
                description:
                  'Optional CSS-selector fields (max 20). Map of name to selector string or {selector, attr?: "text"|"html"|<attribute>, all?: boolean, limit?: 1-50}. GET: URL-encoded JSON. Missing fields come back null with fieldErrors; if none match, 422 no_fields_matched and no charge.',
              },
            },
            required: ["url"],
          },
          output: outputOf("/api/extract", "Horizon Pulse structured HTML extract result"),
        } as DiscoveryDecl),
      },
    },
  };
}


export function x402CheckRouteConfig(): RoutesConfig {
  const payTo = getPayTo();
  const network = getNetworkCaip2();
  return {
    "/api/x402-check": {
      accepts: [
        {
          scheme: "exact",
          price: X402_CHECK_PRICE_USD,
          network,
          payTo,
        },
      ],
      description: routeDescription("/api/x402-check"),
      mimeType: "application/json",
      ...serviceMetadata("/api/x402-check"),
      extensions: {
        ...declareDiscoveryExtension({
          method: "GET",
          input: {
            url: "https://horizonpulse.dev/api/pulse",
            method: "GET",
          },
          inputSchema: {
            properties: {
              url: {
                type: "string",
                description: "Absolute http(s) URL of the x402 endpoint to audit (required). Private/localhost blocked.",
              },
              method: {
                type: "string",
                description: "HTTP method for the unpaid probe: GET (default; one POST retry on 405) or POST.",
              },
              body: {
                type: "string",
                description: "Optional JSON body (<=8KB, URL-encoded) sent with a POST probe, for endpoints that validate input before returning 402. Implies POST.",
              },
            },
            required: ["url"],
          },
          output: outputOf("/api/x402-check", "Horizon Pulse x402 endpoint audit report"),
        } as DiscoveryDecl),
      },
    },
  };
}

export function screenshotRouteConfig(): RoutesConfig {
  const payTo = getPayTo();
  const network = getNetworkCaip2();
  return {
    "/api/screenshot": {
      accepts: [
        {
          scheme: "exact",
          price: SCREENSHOT_PRICE_USD,
          network,
          payTo,
        },
      ],
      description: routeDescription("/api/screenshot"),
      mimeType: "application/json",
      ...serviceMetadata("/api/screenshot"),
      extensions: {
        ...declareDiscoveryExtension({
          method: "GET",
          input: {
            url: "https://horizonpulse.dev",
          },
          inputSchema: {
            properties: {
              url: { type: "string", description: "Absolute http(s) URL to render (required). Private/localhost blocked." },
              width: { type: "string", description: "Viewport width 320-1920 (default 1280)." },
              height: { type: "string", description: "Viewport height 240-2000 (default 800)." },
              fullPage: { type: "string", description: "true to capture the full page (clipped at 4000px)." },
              format: { type: "string", description: "png (default) or jpeg." },
              delayMs: { type: "string", description: "Extra wait after load, 0-3000 ms." },
            },
            required: ["url"],
          },
          output: outputOf("/api/screenshot", "Horizon Pulse screenshot result (image as base64, truncated in the example)"),
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
      ...serviceMetadata(opts.resource),
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
      // Library's JSON path always (it would otherwise serve its own HTML to
      // any Mozilla + text/html request); our HTML only for real navigations.
      const challenge = cdpReady
        ? await getPaidHandler()(asJsonRequest(req))
        : paymentRequiredResponse(paymentOpts);
      if (challenge.status === 402 && isBrowserNavigation(req)) {
        const accepts = Object.values(routes)[0]?.accepts;
        const first = Array.isArray(accepts) ? accepts[0] : accepts;
        const priceUsd =
          typeof first?.price === "string" && first.price
            ? first.price
            : `$${Number(paymentOpts.maxAmountRequired) / 1e6}`;
        return withVary(
          browser402(challenge, { resource: paymentOpts.resource, description: paymentOpts.description, priceUsd }),
        ) as NextResponse;
      }
      return withVary(challenge) as NextResponse;
    }
    if (!cdpReady) {
      return settlementUnavailableResponse();
    }
    return getPaidHandler()(req);
  };
}

export function searchRouteConfig(): RoutesConfig {
  const payTo = getPayTo();
  const network = getNetworkCaip2();
  return {
    "/api/search": {
      accepts: [
        {
          scheme: "exact",
          price: SEARCH_PRICE_USD,
          network,
          payTo,
        },
      ],
      description: routeDescription("/api/search"),
      mimeType: "application/json",
      ...serviceMetadata("/api/search"),
      extensions: {
        ...declareDiscoveryExtension({
          method: "GET",
          input: { q: "x402 payment protocol", n: "2" },
          inputSchema: {
            properties: {
              q: { type: "string", description: "Search query (required, <=300 chars)." },
              n: { type: "string", description: "Number of result pages to fetch, integer 1-5 (default 3)." },
            },
            required: ["q"],
          },
          output: outputOf("/api/search", "Horizon Pulse search-then-fetch result with sources"),
        } as DiscoveryDecl),
      },
    },
  };
}

export function pdfRouteConfig(): RoutesConfig {
  const payTo = getPayTo();
  const network = getNetworkCaip2();
  return {
    "/api/pdf": {
      accepts: [
        {
          scheme: "exact",
          price: PDF_PRICE_USD,
          network,
          payTo,
        },
      ],
      description: routeDescription("/api/pdf"),
      mimeType: "application/json",
      ...serviceMetadata("/api/pdf"),
      extensions: {
        ...declareDiscoveryExtension({
          method: "GET",
          input: { url: "https://horizonpulse.dev/sample.pdf" },
          inputSchema: {
            properties: {
              url: { type: "string", description: "Absolute http(s) URL of a public PDF (required, max 10MB)." },
              pages: { type: "string", description: "Max pages to return, integer 1-50 (default 50)." },
            },
            required: ["url"],
          },
          output: outputOf("/api/pdf", "Horizon Pulse PDF text extraction result"),
        } as DiscoveryDecl),
      },
    },
  };
}
