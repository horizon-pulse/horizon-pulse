import { createFacilitatorConfig } from "@coinbase/x402";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type { RouteConfig, RoutesConfig } from "@x402/core/server";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { NextRequest, NextResponse } from "next/server";
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
import { getSolanaRailConfig } from "./solana-config";
import { handleSolanaPayment, isSolanaPaymentRequest, withSolanaAccept } from "./solana-rail";

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

/**
 * declareDiscoveryExtension + the Bazaar schema's input.method enum pinned to
 * the one method this route key charges (its info.input.method).
 *
 * The library emits the whole verb family in the schema (["GET","HEAD","DELETE"]
 * for query declarations, ["POST","PUT","PATCH"] for body declarations) and
 * relies on @x402/next's runtime enrichment to narrow it to the request method.
 * That enrichment loads via a lazy webpackIgnore'd import("@x402/extensions/bazaar"),
 * which runs under vitest/Node but not in the Vercel bundle, so production served
 * the wide list. Pinning at declaration time gives the same bytes the enrichment
 * produces (it is a no-op on an already-pinned enum), so prod now matches the
 * golden. Discovery metadata only: accepts, price, payTo and gating are unchanged.
 */
function declareChargedDiscovery(config: DiscoveryDecl): ReturnType<typeof declareDiscoveryExtension> {
  const ext = declareDiscoveryExtension(config);
  const bazaar = ext.bazaar as {
    info?: { input?: { method?: unknown } };
    schema?: { properties?: { input?: { properties?: { method?: { enum?: unknown } } } } };
  };
  const method = bazaar.info?.input?.method;
  const methodSchema = bazaar.schema?.properties?.input?.properties?.method;
  if (typeof method !== "string" || !methodSchema) {
    throw new Error("Bazaar declaration must name the one method the route charges (info.input.method)");
  }
  methodSchema.enum = [method];
  return ext;
}

function discoveryExt(path: string, what: string) {
  return {
    ...declareChargedDiscovery({
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
        ...declareChargedDiscovery({
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
        ...declareChargedDiscovery({
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

/**
 * GET and POST get separate route keys so each method's Bazaar declaration
 * names its own method (CDP validate rejects a POST probe of a GET-declared
 * route). The accepts are the same object for every key, so the price, payTo,
 * network and asset are identical per method.
 *
 * Order matters: @x402/core matches the first compiled route. The trailing
 * bare-path key keeps every other verb (e.g. HEAD, which Next serves from the
 * GET handler) paid exactly as before the split, when the only key was the
 * bare path. Without it an unmatched verb would run the handler unpaid.
 */
function methodSplitRoutes(
  path: string,
  shared: Omit<RouteConfig, "extensions">,
  getExtension: Record<string, unknown>,
  postExtension: Record<string, unknown>,
): RoutesConfig {
  return {
    [`GET ${path}`]: { ...shared, extensions: getExtension },
    [`POST ${path}`]: { ...shared, extensions: postExtension },
    [path]: { ...shared, extensions: getExtension },
  };
}

const HTTP_GET_INPUT_SCHEMA = {
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
      type: "string",
      description:
        'Optional allowlisted outbound headers as a URL-encoded JSON object string, e.g. {"accept":"application/json"} (no Cookie / Host / hop-by-hop).',
    },
    body: {
      type: "string",
      description:
        "Not read on GET. To send a request body (POST/PUT/PATCH upstream), call POST /api/http with a JSON body {url, method, headers, body}. Size-capped (64KB).",
    },
  },
  required: ["url"],
};

const HTTP_POST_BODY_SCHEMA = {
  properties: {
    url: {
      type: "string",
      description: "Absolute http(s) URL (required). Private/localhost blocked.",
    },
    method: {
      type: "string",
      description: "Upstream method: GET (default) | POST | HEAD | PUT | PATCH | DELETE",
    },
    headers: {
      type: "object",
      description:
        "Optional allowlisted outbound headers as a JSON object of string values (no Cookie / Host / hop-by-hop).",
    },
    body: {
      description:
        "Optional upstream request body for POST/PUT/PATCH: a string, or a JSON value (sent JSON-encoded). Size-capped (64KB).",
    },
  },
  required: ["url"],
};

export function httpRouteConfig(): RoutesConfig {
  const payTo = getPayTo();
  const network = getNetworkCaip2();
  const output = outputOf("/api/http", "Horizon Pulse universal HTTP proxy result");
  return methodSplitRoutes(
    "/api/http",
    {
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
    },
    {
      ...declareChargedDiscovery({
        method: "GET",
        input: {
          url: "https://example.com",
          method: "GET",
        },
        inputSchema: HTTP_GET_INPUT_SCHEMA,
        output,
      } as DiscoveryDecl),
    },
    {
      ...declareChargedDiscovery({
        method: "POST",
        bodyType: "json",
        input: {
          url: "https://example.com",
          method: "GET",
        },
        inputSchema: HTTP_POST_BODY_SCHEMA,
        output,
      } as DiscoveryDecl),
    },
  );
}

const EXTRACT_FIELDS_DESCRIPTION =
  'Optional CSS-selector fields (max 20). Map of name to selector string or {selector, attr?: "text"|"html"|<attribute>, all?: boolean, limit?: 1-50}. Missing fields come back null with fieldErrors; if none match, 422 no_fields_matched and no charge.';

export function extractRouteConfig(): RoutesConfig {
  const payTo = getPayTo();
  const network = getNetworkCaip2();
  const output = outputOf("/api/extract", "Horizon Pulse structured HTML extract result");
  return methodSplitRoutes(
    "/api/extract",
    {
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
    },
    {
      ...declareChargedDiscovery({
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
              type: "string",
              description:
                'Optional CSS-selector fields (max 20) as a URL-encoded JSON object string: map of name to selector string or {selector, attr?: "text"|"html"|<attribute>, all?: boolean, limit?: 1-50}, e.g. {"heading":"h1"}. Missing fields come back null with fieldErrors; if none match, 422 no_fields_matched and no charge.',
            },
          },
          required: ["url"],
        },
        output,
      } as DiscoveryDecl),
    },
    {
      ...declareChargedDiscovery({
        method: "POST",
        bodyType: "json",
        input: {
          url: "https://horizonpulse.dev",
          fields: {
            heading: "h1",
            links: { selector: "a", attr: "href", all: true, limit: 5 },
          },
        },
        inputSchema: {
          properties: {
            url: {
              type: "string",
              description:
                "Absolute http(s) URL to fetch and extract. Send url or html (at least one). Private/localhost blocked.",
            },
            html: {
              type: "string",
              description:
                "Raw HTML to parse instead of fetching (size-capped, 200KB). Send url or html (at least one); if both are sent, html is parsed and url is echoed.",
            },
            fields: {
              type: "object",
              description: `${EXTRACT_FIELDS_DESCRIPTION} POST: a JSON object.`,
            },
          },
          required: [],
        },
        output,
      } as DiscoveryDecl),
    },
  );
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
        ...declareChargedDiscovery({
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
        ...declareChargedDiscovery({
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

export async function discoveryOptionsResponse(opts: {
  maxAmountRequired: string;
  resource: string;
  description: string;
}): Promise<NextResponse> {
  const paymentRequired = buildPaymentRequirements(opts);
  const res = NextResponse.json(paymentRequired, {
    status: 200,
    headers: {
      Allow: "GET, OPTIONS",
      ...CORS_HEADERS,
      "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired),
    },
  });
  // Solana USDC rail (lib/solana-config.ts): off unless HP_SOLANA_ENABLED=true
  // + HP_SOLANA_PAYTO equal to the pinned payTo. Off → `res` above, unchanged.
  // On → Solana entry appended after Base; any Solana failure → `res` unchanged.
  const solana = getSolanaRailConfig();
  if (!solana.enabled) return res;
  return withSolanaAccept(res, solana.config, opts.maxAmountRequired);
}

type AppRouteHandler = (req: NextRequest) => Promise<NextResponse>;

/** Copy of req minus x402 payment headers (used only on the Solana fallback path). */
function withoutPaymentHeaders(req: NextRequest): NextRequest {
  const headers = new Headers(req.headers);
  headers.delete("payment-signature");
  headers.delete("x-payment");
  return new NextRequest(req.url, { method: req.method, headers });
}

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

  /** Base-only unpaid challenge: exactly what main serves. */
  async function baseChallenge(req: NextRequest, cdpReady: boolean): Promise<NextResponse> {
    return cdpReady
      ? await getPaidHandler()(asJsonRequest(req))
      : paymentRequiredResponse(paymentOpts);
  }

  return async (req: NextRequest) => {
    const cdpReady = hasCdpCredentials();
    // Solana USDC rail (lib/solana-config.ts). Off (the default) → every
    // branch below behaves exactly as on main. On → Solana entry appended
    // after Base on the unpaid 402; Solana-paid requests go to the
    // Solana-only (PayAI) server. Any Solana failure falls back to the
    // Base-only 402. Base payments never touch Solana code: they take the
    // unchanged CDP path at the bottom.
    const solana = getSolanaRailConfig();
    if (!hasPaymentHeader(req)) {
      // Library's JSON path always (it would otherwise serve its own HTML to
      // any Mozilla + text/html request); our HTML only for real navigations.
      let challenge: NextResponse = await baseChallenge(req, cdpReady);
      if (solana.enabled && challenge.status === 402) {
        challenge = await withSolanaAccept(challenge, solana.config, paymentOpts.maxAmountRequired);
      }
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
    if (solana.enabled && isSolanaPaymentRequest(req)) {
      const paid = await handleSolanaPayment(req, routeHandler, routes, paymentOpts.maxAmountRequired, solana.config);
      // Solana unavailable / rejected / threw → the Base-only 402 (built from
      // a copy of the request WITHOUT the Solana payment header, so the Base
      // server never even parses a Solana payload).
      return withVary(paid ?? (await baseChallenge(withoutPaymentHeaders(req), cdpReady))) as NextResponse;
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
        ...declareChargedDiscovery({
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
        ...declareChargedDiscovery({
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
