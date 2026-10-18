import { withPaidCallMeta } from "./paid-call-meta";
import { logRouteRequest } from "./route-log";
import { withRelatedRoutes } from "./route-hints";
import {
  consumeFreeCall,
  freeAnswerHeaders,
  freeTierMode,
  isFreeTierRoute,
  routePathOf,
  scheduleMarkPayer,
  shouldAdvertise,
  stripFreeMarker,
  wantsFree,
  withFreeTierAdvert,
  type FreeTierRoute,
} from "./free-tier";
import { createFacilitatorConfig } from "@coinbase/x402";
import {
  FacilitatorTimeoutError,
  getFacilitatorResponseError,
  HTTPFacilitatorClient,
  isFatalStartupInitError,
  x402ResourceServer,
} from "@x402/core/server";
import type { RouteConfig, RoutesConfig, SettleFailureContext } from "@x402/core/server";
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
  BAZAAR_CHECK_PRICE_USD,
  MARKET_SEARCH_PRICE_USD,
  MARKET_QUOTE_PRICE_USD,
  DISCOURSE_SPLIT_PRICE_USD,
  TX_STATUS_PRICE_USD,
  TOKENIZED_STOCK_PRICE_USD,
  WATCH_PRICE_USD,
  BALANCE_PRICE_USD,
  TX_GUARD_PRICE_USD,
  GROCERY_NORMALIZE_PRICE_USD,
  GROCERY_INGREDIENT_PRICE_USD,
  CHAIN_HEAD_PRICE_USD,
  TOKEN_META_PRICE_USD,
  NAME_RESOLVE_PRICE_USD,
  BATCH_PRICE_USD,
  BATCH_MAX_ITEMS,
  SEARCH_PRICE_USD,
  PDF_PRICE_USD,
  HTTP_PRICE_USD,
  EXTRACT_PRICE_USD,
  USDC_BASE,
  PUBLIC_BASE_URL,
} from "./config";
import { MAX_DESCRIPTION_CHARS, routeMetadata } from "./route-metadata";
import { exampleRecordedAt, OUTPUT_EXAMPLES } from "./route-examples";
import { GROCERY_INGREDIENT_OUTPUT_EXAMPLE, GROCERY_INGREDIENT_POST_OUTPUT_EXAMPLE } from "./grocery-ingredient-example";
import { getSolanaRailConfig } from "./solana-config";
import { handleSolanaPayment, isSolanaPaymentRequest, withSolanaAccept } from "./solana-rail";
import { baseRail, runOnPaidRail } from "./paid-rail";
import { getXrplRailConfig } from "./xrpl-config";
import { handleXrplPayment, isXrplPaymentRequest, withXrplAccept } from "./xrpl-rail";
import { getPolygonRailConfig } from "./polygon-config";
import { withRejectReason } from "./rail-reject";
import { handlePolygonPayment, isPolygonPaymentRequest, withPolygonAccept } from "./polygon-rail";

/**
 * Per-request CDP facilitator timeout (verify, settle, every /supported attempt).
 * The @x402/core client default is 90 s, longer than the 30 s maxDuration set
 * by pdf, screenshot, search, demo and mcp (the only routes that set one; the
 * rest use the platform default), so a hung CDP call would outlive those
 * functions instead of becoming a 503. 20 s, not 10 s, because the same
 * timeout also covers settle: a settle that times out can still land on-chain,
 * charging the buyer without returning the response, so only a real hang
 * should trip it. Settle timeouts are logged by logSettleTimeout below.
 */
export const FACILITATOR_TIMEOUT_MS = 20_000;

function buildFacilitatorClient(): HTTPFacilitatorClient {
  const apiKeyId = process.env.CDP_API_KEY_ID?.trim() || undefined;
  const apiKeySecret = process.env.CDP_API_KEY_SECRET?.trim() || undefined;
  return new HTTPFacilitatorClient({
    ...createFacilitatorConfig(apiKeyId, apiKeySecret),
    timeoutMs: FACILITATOR_TIMEOUT_MS,
  });
}

/**
 * Cold-start facilitator sync (fix for the 3-hit cold-start 500 pattern,
 * 2026-10-08/09: one 500 {"error":"Internal Server Error"} on the first
 * request to a fresh instance, the immediate retry a normal 402).
 *
 * Before: every route's withX402 ran its own initialize() on this ONE shared
 * server. That is a single CDP GET /supported (the client only retries 429),
 * so one transient failure (5xx, "fetch failed", socket reset on a thawed
 * instance) made that request a 500; and each later route's first request
 * re-ran initialize(), which clears the shared supported-kinds map before
 * refetching, so a concurrent request on an already-synced route could 500 too.
 *
 * Now initialize() on the shared server is single-flight and sticky: one sync
 * per instance, shared by every route (and the MCP endpoint), retried on a
 * transient failure with a short backoff, never re-run once it succeeded, and
 * reset on failure so a later request tries again. Facilitator timeouts
 * (FACILITATOR_TIMEOUT_MS) and fatal capability/config errors are not retried.
 * Discovery and payment behaviour are unchanged: same facilitator, same
 * /supported response, same accepts / payTo / price; withX402 still runs its
 * per-route route-config validation after the shared sync.
 */
export const FACILITATOR_INIT_BACKOFF_MS = [100, 300] as const;

function isRetryableInitError(error: unknown): boolean {
  if (isFatalStartupInitError(error)) return false;
  return !(getFacilitatorResponseError(error) instanceof FacilitatorTimeoutError);
}

class SharedInitResourceServer extends x402ResourceServer {
  private syncReady = false;
  private syncInFlight: Promise<void> | null = null;

  override initialize(): Promise<void> {
    if (this.syncReady) return Promise.resolve();
    if (!this.syncInFlight) {
      this.syncInFlight = this.syncWithRetry().then(
        () => {
          this.syncReady = true;
          this.syncInFlight = null;
        },
        (error: unknown) => {
          this.syncInFlight = null;
          throw error;
        },
      );
    }
    return this.syncInFlight;
  }

  private async syncWithRetry(): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await super.initialize();
        return;
      } catch (error) {
        const delay = FACILITATOR_INIT_BACKOFF_MS[attempt];
        if (delay === undefined || !isRetryableInitError(error)) throw error;
        console.warn(`[x402] facilitator sync attempt ${attempt + 1} failed, retrying in ${delay} ms: ${error}`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
}

/**
 * Route of the settle for logs: the server-side request route (method + path)
 * when the HTTP layer passed it, else the path of the payload's resource URL.
 * Never a query string, host, payment header or payload.
 */
function settleRoute(ctx: SettleFailureContext): string {
  const req = (ctx.transportContext as { request?: { method?: unknown; path?: unknown; routePattern?: unknown } } | undefined)
    ?.request;
  const path = typeof req?.routePattern === "string" ? req.routePattern : typeof req?.path === "string" ? req.path : "";
  if (path) return typeof req?.method === "string" && req.method ? `${req.method} ${path}` : path;
  const url = ctx.paymentPayload?.resource?.url;
  if (!url) return "unknown route";
  try {
    return new URL(url, "https://horizonpulse.dev").pathname;
  } catch {
    return "unknown route";
  }
}

/**
 * onSettleFailure hook: a settle that hit FACILITATOR_TIMEOUT_MS may still have
 * settled on-chain (buyer charged, response withheld), so log it loudly to
 * check the payer's transfer before any refund. Route, network and timeout
 * only: no payload, signature, payer or keys. Never recovers the settle.
 */
export async function logSettleTimeout(ctx: SettleFailureContext): Promise<void> {
  const timeout = getFacilitatorResponseError(ctx.error);
  if (!(timeout instanceof FacilitatorTimeoutError) || timeout.operation !== "settle") return;
  console.warn(
    `[x402] settle timeout on ${settleRoute(ctx)} (${ctx.requirements?.network ?? "unknown network"}) ` +
      `after ${timeout.timeoutMs} ms: the payment may still have settled on-chain; check the transfer before treating the call as unpaid`,
  );
}

let cachedServer: x402ResourceServer | null = null;

export function getResourceServer(): x402ResourceServer {
  if (cachedServer) return cachedServer;
  const network = getNetworkCaip2();
  cachedServer = new SharedInitResourceServer(buildFacilitatorClient())
    .register(network, new ExactEvmScheme())
    .onSettleFailure(logSettleTimeout);
  return cachedServer;
}

/**
 * Handler init: start the shared facilitator sync when a paid route module
 * loads on an instance with CDP keys, so it runs alongside the cold start
 * instead of inside the first request. Never during `next build`. Failures
 * are swallowed here; the next request retries via initialize().
 */
export function warmFacilitator(): void {
  if (!hasCdpCredentials() || process.env.NEXT_PHASE === "phase-production-build") return;
  void getResourceServer().initialize().catch(() => {});
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

/** /api/demo/<name> for a route path: nested paths join with '-' (/api/market/search -> market-search). */
export function demoName(path: string): string {
  return path.replace(/^\/api\//, "").replace(/\//g, "-");
}

/** Recorded example (see lib/route-examples.ts) + a label saying it is an example. */
function outputOf(path: string, what: string) {
  const example = OUTPUT_EXAMPLES[path];
  if (!example) throw new Error(`No output example for ${path}`);
  return {
    example,
    schema: {
      type: "object",
      // An example flagged illustrative:true (discourse/split until a real recording exists) is never called a real response.
      description:
        example.illustrative === true
          ? `${what}. The example is an illustrative format sample (illustrative: true; counts are NOT measured), not a recorded real response.`
          : `${what}. The example is a trimmed real response recorded from GET /api/demo/${demoName(path)} at ${exampleRecordedAt(path)} UTC; live values differ on every call.`,
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
  return keyGetHead({
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
  });
}

export function signalsRouteConfig(): RoutesConfig {
  const payTo = getPayTo();
  const network = getNetworkCaip2();
  return keyGetHead({
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
      extensions: discoveryExt("/api/signals", "Horizon Pulse crypto market data (technical indicators)"),
    },
  });
}

export function yieldRouteConfig(): RoutesConfig {
  const payTo = getPayTo();
  const network = getNetworkCaip2();
  return keyGetHead({
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
  });
}

export function portfolioRouteConfig(): RoutesConfig {
  const payTo = getPayTo();
  const network = getNetworkCaip2();
  return keyGetHead({
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
  });
}

export function gasRouteConfig(): RoutesConfig {
  const payTo = getPayTo();
  const network = getNetworkCaip2();
  return keyGetHead({
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
  });
}

export function fundingRouteConfig(): RoutesConfig {
  const payTo = getPayTo();
  const network = getNetworkCaip2();
  return keyGetHead({
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
  });
}


export function fetchRouteConfig(): RoutesConfig {
  const payTo = getPayTo();
  const network = getNetworkCaip2();
  return keyGetHead({
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
  });
}

/**
 * Verb-keyed routes (Odin 10/13 hygiene b): x402/core matches a bare path key on
 * EVERY method, so single-verb paid routes are keyed explicitly by verb.
 * HEAD gets the same config as GET because Next serves HEAD from the GET
 * handler; without a HEAD key a HEAD request would run the handler unpaid
 * (F2 strips payment headers on HEAD, so HEAD only ever gets the unpaid 402).
 * GET and HEAD share ONE config object: never mutate a returned RouteConfig in
 * place (copy it first), or the edit silently applies to both verbs.
 */
function keyGetHead(routes: Record<string, RouteConfig>): RoutesConfig {
  const out: RoutesConfig = {};
  for (const [path, config] of Object.entries(routes)) {
    if (/\s/.test(path)) throw new Error(`keyGetHead expects a bare path, got "${path}"`);
    out[`GET ${path}`] = config;
    out[`HEAD ${path}`] = config;
  }
  return out;
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
        // Same fixed input as GET /api/demo/extract, so the recorded example answers this exact input.
        input: {
          url: "https://horizonpulse.dev",
          fields: '{"heading":"h1","links":{"selector":"a","attr":"href","all":true,"limit":5}}',
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
  return keyGetHead({
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
  });
}

export function bazaarCheckRouteConfig(): RoutesConfig {
  const payTo = getPayTo();
  const network = getNetworkCaip2();
  return keyGetHead({
    "/api/bazaar-check": {
      accepts: [
        {
          scheme: "exact",
          price: BAZAAR_CHECK_PRICE_USD,
          network,
          payTo,
        },
      ],
      description: routeDescription("/api/bazaar-check"),
      mimeType: "application/json",
      ...serviceMetadata("/api/bazaar-check"),
      extensions: {
        ...declareChargedDiscovery({
          method: "GET",
          input: { url: "horizonpulse.dev" },
          inputSchema: {
            properties: {
              url: {
                type: "string",
                description:
                  "Seller host (e.g. example.com) or https URL (required). A URL path is also probed as a route. https only; private/localhost blocked.",
              },
            },
            required: ["url"],
          },
          output: outputOf("/api/bazaar-check", "Horizon Pulse CDP Bazaar index check with lint findings"),
        } as DiscoveryDecl),
      },
    },
  });
}

/**
 * Agent marketplace (MVP). Same rails, pinned payTo and Bazaar declaration
 * pattern as every other GET route. Prices are UNTESTED (lib/config.ts).
 */
export function marketSearchRouteConfig(): RoutesConfig {
  const payTo = getPayTo();
  const network = getNetworkCaip2();
  return keyGetHead({
    "/api/market/search": {
      accepts: [
        {
          scheme: "exact",
          price: MARKET_SEARCH_PRICE_USD,
          network,
          payTo,
        },
      ],
      description: routeDescription("/api/market/search"),
      mimeType: "application/json",
      ...serviceMetadata("/api/market/search"),
      extensions: {
        ...declareChargedDiscovery({
          method: "GET",
          input: { q: "weather forecast", n: "3" },
          inputSchema: {
            properties: {
              q: { type: "string", description: "What the agent needs, in words (required, <=200 chars)." },
              n: { type: "string", description: "Offers to return, integer 1-10 (default 5). The top 3 are re-checked live." },
              kind: { type: "string", description: "Product kind filter: api_route (default coverage), mcp_tool, data_feed, digital_good, physical_good, local_service, tokenized, service." },
              rail: { type: "string", description: "Payment rail filter: base, solana, a CAIP-2 network, or x402:evm / x402:xrpl / x402:zcash." },
              max_price: { type: "string", description: "Max USD price per call, e.g. 0.01." },
              min_health: { type: "string", description: "Minimum health score 0-1." },
            },
            required: ["q"],
          },
          output: outputOf("/api/market/search", "Horizon Pulse agent marketplace search: ranked x402 offers with live re-check and buy plans"),
        } as DiscoveryDecl),
      },
    },
  });
}

/** Online discourse split (HN + Bluesky; NOT a poll). Same rails, payTo and Bazaar pattern. */
export function discourseSplitRouteConfig(): RoutesConfig {
  const payTo = getPayTo();
  const network = getNetworkCaip2();
  return {
    "/api/discourse/split": {
      accepts: [
        {
          scheme: "exact",
          price: DISCOURSE_SPLIT_PRICE_USD,
          network,
          payTo,
        },
      ],
      description: routeDescription("/api/discourse/split"),
      mimeType: "application/json",
      ...serviceMetadata("/api/discourse/split"),
      extensions: {
        ...declareChargedDiscovery({
          method: "GET",
          input: { q: "self-driving cars", sides: "for,against" },
          inputSchema: {
            properties: {
              q: { type: "string", description: "Question or topic, 3-200 chars (required). Elections/candidates, health, and a named person's conduct are refused (not charged)." },
              sides: { type: "string", description: "2-4 comma-separated side labels (default yes,no)." },
              window: { type: "string", description: "Look-back window 1-30 days, e.g. 7d (default 30d)." },
            },
            required: ["q"],
          },
          output: outputOf("/api/discourse/split", "Horizon Pulse online discourse split (NOT a poll): shares with 95% intervals, counts and source links"),
        } as DiscoveryDecl),
      },
    },
  };
}

/** Transaction status + finality (Base, Polygon, Solana, XRPL; public RPCs). Same rails, payTo and Bazaar pattern. */
export function txStatusRouteConfig(): RoutesConfig {
  const payTo = getPayTo();
  const network = getNetworkCaip2();
  return {
    "/api/tx-status": {
      accepts: [
        {
          scheme: "exact",
          price: TX_STATUS_PRICE_USD,
          network,
          payTo,
        },
      ],
      description: routeDescription("/api/tx-status"),
      mimeType: "application/json",
      ...serviceMetadata("/api/tx-status"),
      extensions: {
        ...declareChargedDiscovery({
          method: "GET",
          input: { network: "base", tx: "0xe6e6ebd93db6735aad12a86a1084d5e1d6759e31fbedf7b741946f2bf410644f" },
          inputSchema: {
            properties: {
              tx: { type: "string", description: "Transaction id (required): 0x + 64 hex (Base/Polygon), 64 hex (XRPL) or a base58 Solana signature." },
              network: { type: "string", description: "base, polygon, solana or xrpl (or CAIP-2). Required for 0x hashes; optional for Solana signatures and XRPL hashes." },
            },
            required: ["tx"],
          },
          output: outputOf("/api/tx-status", "Horizon Pulse transaction status: landed or not, final flag, confirmations, fee and token transfers"),
        } as DiscoveryDecl),
      },
    },
  };
}

/** Tokenized stock status on Base (on-chain B20 token state, no price). Same rails, payTo and Bazaar pattern. */
export function tokenizedStockRouteConfig(): RoutesConfig {
  const payTo = getPayTo();
  const network = getNetworkCaip2();
  return {
    "/api/tokenized-stock": {
      accepts: [
        {
          scheme: "exact",
          price: TOKENIZED_STOCK_PRICE_USD,
          network,
          payTo,
        },
      ],
      description: routeDescription("/api/tokenized-stock"),
      mimeType: "application/json",
      ...serviceMetadata("/api/tokenized-stock"),
      extensions: {
        ...declareChargedDiscovery({
          method: "GET",
          input: { symbol: "AAPL" },
          inputSchema: {
            properties: {
              symbol: { type: "string", description: "Optional. Ticker (AAPL or AAPLc) or the token address on Base; omit for every listed Coinbase tokenized stock." },
            },
          },
          output: outputOf("/api/tokenized-stock", "Horizon Pulse tokenized stock status check on Base: paused flags, supply, supply cap, multiplier, issuer, token address (no price). Not investment advice"),
        } as DiscoveryDecl),
      },
    },
  };
}

/** Page/endpoint change watch (stateless token, SSRF-guarded fetch). Same rails, payTo and Bazaar pattern. */
export function watchRouteConfig(): RoutesConfig {
  const payTo = getPayTo();
  const network = getNetworkCaip2();
  return {
    "/api/watch": {
      accepts: [
        {
          scheme: "exact",
          price: WATCH_PRICE_USD,
          network,
          payTo,
        },
      ],
      description: routeDescription("/api/watch"),
      mimeType: "application/json",
      ...serviceMetadata("/api/watch"),
      extensions: {
        ...declareChargedDiscovery({
          method: "GET",
          input: { url: "https://example.com" },
          inputSchema: {
            properties: {
              url: { type: "string", description: "Public http(s) URL of the page or endpoint (required)." },
              since: { type: "string", description: "Optional. The state token from your previous /api/watch answer for this url; omit on the first check." },
            },
            required: ["url"],
          },
          output: outputOf("/api/watch", "Horizon Pulse watch: changed true/false since your last check; when changed, added lines and added/removed counts; pass state back as since"),
        } as DiscoveryDecl),
      },
    },
  };
}

/** Can-I-pay-now balance check per rail (public RPCs, read-only). Same rails, payTo and Bazaar pattern. */
export function balanceRouteConfig(): RoutesConfig {
  const payTo = getPayTo();
  const network = getNetworkCaip2();
  return {
    "/api/balance": {
      accepts: [
        {
          scheme: "exact",
          price: BALANCE_PRICE_USD,
          network,
          payTo,
        },
      ],
      description: routeDescription("/api/balance"),
      mimeType: "application/json",
      ...serviceMetadata("/api/balance"),
      extensions: {
        ...declareChargedDiscovery({
          method: "GET",
          input: { evm: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" },
          inputSchema: {
            properties: {
              evm: { type: "string", description: "0x address checked on Base and Polygon (USDC + gas)." },
              solana: { type: "string", description: "Solana address (USDC + SOL)." },
              xrpl: { type: "string", description: "XRP Ledger classic r-address (RLUSD, trust line, reserve, fee). Give at least one of evm, solana, xrpl." },
            },
          },
          output: outputOf("/api/balance", "Horizon Pulse balance: per rail stablecoin balance, gas/fee state, canPay yes/no and calls left at our live prices (no risk score, no USD valuation)"),
        } as DiscoveryDecl),
      },
    },
  };
}

/** Mechanical pre-transfer recipient checks (bundled OFAC SDN snapshot, public RPCs, cited scam list). Same rails, payTo and Bazaar pattern. */
export function txGuardRouteConfig(): RoutesConfig {
  const payTo = getPayTo();
  const network = getNetworkCaip2();
  return {
    "/api/tx-guard": {
      accepts: [
        {
          scheme: "exact",
          price: TX_GUARD_PRICE_USD,
          network,
          payTo,
        },
      ],
      description: routeDescription("/api/tx-guard"),
      mimeType: "application/json",
      ...serviceMetadata("/api/tx-guard"),
      extensions: {
        ...declareChargedDiscovery({
          method: "GET",
          input: { chain: "base", to: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", expected: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" },
          inputSchema: {
            properties: {
              chain: { type: "string", enum: ["base", "polygon", "solana", "xrpl"], description: "Chain of the transfer." },
              to: { type: "string", description: "Recipient address you are about to send to." },
              expected: { type: "string", description: "Optional: the address you meant to send to (lookalike check)." },
              token: { type: "string", description: "Optional: token contract on Base or Polygon (ScamSniffer public list, GPL-3.0, up to 7-day delay)." },
            },
            required: ["chain", "to"],
          },
          output: outputOf("/api/tx-guard", "Horizon Pulse tx-guard: mechanical allow/warn/block per check (expected match, OFAC SDN snapshot, account age, scam token) and overall"),
        } as DiscoveryDecl),
      },
    },
  };
}

export function marketQuoteRouteConfig(): RoutesConfig {
  const payTo = getPayTo();
  const network = getNetworkCaip2();
  return keyGetHead({
    "/api/market/quote": {
      accepts: [
        {
          scheme: "exact",
          price: MARKET_QUOTE_PRICE_USD,
          network,
          payTo,
        },
      ],
      description: routeDescription("/api/market/quote"),
      mimeType: "application/json",
      ...serviceMetadata("/api/market/quote"),
      extensions: {
        ...declareChargedDiscovery({
          method: "GET",
          input: { url: "https://horizonpulse.dev/api/pulse" },
          inputSchema: {
            properties: {
              url: { type: "string", description: "https URL of the x402 resource to quote (required). Private/localhost blocked." },
              method: { type: "string", description: "Probe method GET or POST (default GET; one POST retry on 405)." },
            },
            required: ["url"],
          },
          output: outputOf("/api/market/quote", "Horizon Pulse pre-pay quote: live x402 terms, payTo cross-check and verdict"),
        } as DiscoveryDecl),
      },
    },
  });
}

export function screenshotRouteConfig(): RoutesConfig {
  const payTo = getPayTo();
  const network = getNetworkCaip2();
  return keyGetHead({
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
  });
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

/**
 * HTTP 503 when the CDP facilitator sync still fails after the retries above.
 * Replaces the library's generic 500: nothing was verified or settled, no
 * challenge is served, and the client is told to retry shortly.
 */
export function facilitatorUnavailableResponse(): NextResponse {
  return NextResponse.json(
    { error: "Payment facilitator temporarily unavailable. Retry in a moment." },
    {
      status: 503,
      headers: {
        ...CORS_HEADERS,
        "Cache-Control": "no-store",
        "Retry-After": "1",
      },
    },
  );
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
  const withSolana = solana.enabled ? await withSolanaAccept(res, solana.config, opts.maxAmountRequired) : res;
  // XRPL RLUSD rail (lib/xrpl-config.ts): off unless HP_XRPL_ENABLED=true +
  // HP_XRPL_PAYTO equal to the pinned payTo. Off → `withSolana`, unchanged.
  // On → RLUSD entry appended last (after Base, and Solana if on); any XRPL
  // failure → `withSolana` unchanged.
  const xrpl = getXrplRailConfig();
  const withXrpl = xrpl.enabled ? await withXrplAccept(withSolana, xrpl.config, opts.maxAmountRequired) : withSolana;
  // Polygon USDC rail (lib/polygon-config.ts): off unless HP_POLYGON_ENABLED=true
  // (+ mainnet code lock). Off → `withXrpl`, unchanged. On → appended LAST.
  const polygon = getPolygonRailConfig();
  const out = polygon.enabled ? await withPolygonAccept(withXrpl, polygon.config, opts.maxAmountRequired) : withXrpl;
  // Free daily cap (lib/free-tier.ts): HP_FREE_TIER=optin only, the 7 free-tier routes
  // only -> the same OPTIONS answer plus the opt-in advert. Off -> `out`, unchanged.
  const route = routePathOf(opts.resource);
  if (freeTierMode() !== "optin" || !isFreeTierRoute(route)) return out;
  return (await withFreeTierAdvert(out, route)) as NextResponse;
}

type AppRouteHandler = (req: NextRequest) => Promise<NextResponse>;

/** Copy of req minus x402 payment headers (paid-HEAD guard and the Solana / XRPL / Polygon fallback paths). */
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
  warmFacilitator();

  /** Shared facilitator sync first; on failure a 503 instead of withX402's 500. */
  async function runPaidHandler(req: NextRequest): Promise<NextResponse> {
    try {
      await getResourceServer().initialize();
    } catch (error) {
      if (isFatalStartupInitError(error)) throw error;
      console.error(`[x402] facilitator sync failed, serving 503: ${error}`);
      return facilitatorUnavailableResponse();
    }
    return getPaidHandler()(req);
  }

  function getPaidHandler(): AppRouteHandler {
    if (!paidHandler) {
      paidHandler = withX402(
        // The Base (CDP) server only verifies/settles Base USDC: the handler's
        // `priced` block (lib/paid-rail.ts) reports the Base rail.
        runOnPaidRail(baseRail, routeHandler),
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
      ? await runPaidHandler(asJsonRequest(req))
      : paymentRequiredResponse(paymentOpts);
  }

  const routePath = (() => {
    try {
      return new URL(paymentOpts.resource).pathname;
    } catch {
      return paymentOpts.resource;
    }
  })();
  // After serve(): cadence header (paid-call-meta), one fire-and-forget route-log
  // record (lib/route-log.ts; never awaited, never throws), then the free
  // relatedRoutes hint on settled 2xx JSON bodies (lib/route-hints.ts). None of
  // these runs before or inside verify/settle, and the unpaid 402 is untouched.
  //
  // Free daily cap (lib/free-tier.ts, item 0): only when HP_FREE_TIER=optin and only
  // on the 7 free-tier routes. Off (code default) -> `freeRoute` is null and this
  // closure behaves exactly as before. On: an unpaid GET with ?free=1 / X-HP-Free: 1
  // is counted (one EVAL); allowed -> the route handler runs directly (no verify, no
  // settle) and the answer carries X-HP-Free-* + X-HP-Next. Capped or counter
  // unavailable -> the normal path (402), never unlimited free. Paid requests never
  // touch the counter. The opt-in marker is stripped before any handler sees it.
  return async (original: NextRequest) => {
    const paidHeader = hasPaymentHeader(original);
    const freeRoute: FreeTierRoute | null = freeTierMode() === "optin" && isFreeTierRoute(routePath) ? routePath : null;
    let incoming = original;
    let freeExtra: Record<string, string> = {};
    let advertise: boolean | null = null; // null = decide below (known-payer guard)
    if (freeRoute) {
      const optedIn = wantsFree(original);
      incoming = stripFreeMarker(original, (u, init) => new NextRequest(u, init));
      if (optedIn && original.method === "GET" && !paidHeader) {
        const d = await consumeFreeCall({ route: freeRoute, headers: original.headers });
        if (d.kind === "free") {
          let res = await routeHandler(incoming);
          const fh = freeAnswerHeaders(freeRoute, d);
          try {
            for (const [k, v] of Object.entries(fh)) res.headers.set(k, v);
          } catch {
            // immutable headers (a passed-through fetch Response): same body, copied headers
            const h = new Headers(res.headers);
            for (const [k, v] of Object.entries(fh)) h.set(k, v);
            res = new NextResponse(res.body, { status: res.status, statusText: res.statusText, headers: h });
          }
          logRouteRequest({ route: routePath, method: original.method, res, paidHeader: false, amountAtomic: paymentOpts.maxAmountRequired });
          return res;
        }
        if (d.kind === "known_payer") advertise = false; // known payer: today's 402, untouched
        else advertise = true; // the caller already knows the tier; tell it why it got a 402
        freeExtra =
          d.kind === "known_payer"
            ? {}
            : d.kind === "capped"
            ? { "X-HP-Free-Remaining": "0", "X-HP-Free-Reset": d.reset, "X-HP-Free-Status": d.global ? "global_budget_spent" : "daily_limit_reached" }
            : { "X-HP-Free-Status": "unavailable" };
      }
    }
    let res = withPaidCallMeta(routePath, incoming.method, await serve(incoming));
    if (freeRoute && !paidHeader && res.status === 402) {
      if (advertise === null) advertise = await shouldAdvertise({ headers: original.headers });
      if (advertise) res = (await withFreeTierAdvert(res, freeRoute, freeExtra)) as NextResponse;
    }
    // Known-payer guard: a settled paid call (any route) marks the caller's IP (hashed, 30 d).
    // Only while the guard is active (lib/free-tier.ts payerMarkWriting); fire-and-forget.
    if (paidHeader && res.status >= 200 && res.status < 300 && (res.headers.get("payment-response") ?? res.headers.get("x-payment-response")))
      scheduleMarkPayer(original.headers);
    logRouteRequest({ route: routePath, method: incoming.method, res, paidHeader, amountAtomic: paymentOpts.maxAmountRequired });
    return (await withRelatedRoutes(routePath, incoming.method, res)) as NextResponse;
  };

  async function serve(incoming: NextRequest): Promise<NextResponse> {
    // Paid HEAD (F2): a HEAD response has no body, so a paid HEAD would settle
    // and deliver nothing. A HEAD that carries PAYMENT-SIGNATURE / X-PAYMENT is
    // served exactly like an unpaid HEAD: the payment headers are dropped
    // BEFORE any rail is chosen, so no facilitator verify or settle, no XRPL /
    // Solana lookup, and no route handler ever runs for it. 402 (not 405)
    // keeps HEAD a faithful mirror of GET for probes and caches; the challenge
    // tells the client to pay with GET.
    const req = incoming.method === "HEAD" && hasPaymentHeader(incoming) ? withoutPaymentHeaders(incoming) : incoming;
    const cdpReady = hasCdpCredentials();
    // Solana USDC rail (lib/solana-config.ts). Off (the default) → every
    // branch below behaves exactly as on main. On → Solana entry appended
    // after Base on the unpaid 402; Solana-paid requests go to the
    // Solana-only (PayAI) server. Any Solana failure falls back to the
    // Base-only 402. Base payments never touch Solana code: they take the
    // unchanged CDP path at the bottom.
    const solana = getSolanaRailConfig();
    // XRPL RLUSD rail (lib/xrpl-config.ts), same contract: off (the default)
    // → nothing below changes; on → RLUSD entry appended LAST on the unpaid
    // 402 (Base first, Solana second if on); XRPL-paid requests go to the
    // XRPL-only server; any XRPL failure → the 402 built without it.
    const xrpl = getXrplRailConfig();
    // Polygon USDC rail (lib/polygon-config.ts), same contract: off (the
    // default) → nothing below changes; on → Polygon entry appended LAST;
    // Polygon-paid requests go to the Polygon-only server; any failure →
    // the Base-only 402.
    const polygon = getPolygonRailConfig();
    if (!hasPaymentHeader(req)) {
      // Library's JSON path always (it would otherwise serve its own HTML to
      // any Mozilla + text/html request); our HTML only for real navigations.
      let challenge: NextResponse = await baseChallenge(req, cdpReady);
      if (solana.enabled && challenge.status === 402) {
        challenge = await withSolanaAccept(challenge, solana.config, paymentOpts.maxAmountRequired);
      }
      if (xrpl.enabled && challenge.status === 402) {
        challenge = await withXrplAccept(challenge, xrpl.config, paymentOpts.maxAmountRequired);
      }
      if (polygon.enabled && challenge.status === 402) {
        challenge = await withPolygonAccept(challenge, polygon.config, paymentOpts.maxAmountRequired);
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
      let rejected: string | null = null;
      const paid = await handleSolanaPayment(req, routeHandler, routes, paymentOpts.maxAmountRequired, solana.config, (r) => {
        rejected = r;
      });
      // Solana unavailable / rejected / threw → the Base-only 402 (built from
      // a copy of the request WITHOUT the Solana payment header, so the Base
      // server never even parses a Solana payload).
      // Rejected (nothing charged, no body): Base-only 402 + PAYMENT-REQUIRED.error = reason, as Base does.
      return withVary(paid ?? (await withRejectReason(await baseChallenge(withoutPaymentHeaders(req), cdpReady), rejected))) as NextResponse;
    }
    if (xrpl.enabled && isXrplPaymentRequest(req)) {
      let rejected: string | null = null;
      const paid = await handleXrplPayment(req, routeHandler, routes, paymentOpts.maxAmountRequired, xrpl.config, (r) => {
        rejected = r;
      });
      // XRPL unavailable / rejected / threw → the Base-only 402 (built from a
      // copy of the request WITHOUT the XRPL payment header, so the Base
      // server never even parses an XRPL payload).
      // Rejected (nothing charged, no body): Base-only 402 + PAYMENT-REQUIRED.error = reason, as Base does.
      return withVary(paid ?? (await withRejectReason(await baseChallenge(withoutPaymentHeaders(req), cdpReady), rejected))) as NextResponse;
    }
    if (polygon.enabled && isPolygonPaymentRequest(req, polygon.config)) {
      let rejected: string | null = null;
      const paid = await handlePolygonPayment(req, routeHandler, routes, paymentOpts.maxAmountRequired, polygon.config, (r) => {
        rejected = r;
      });
      // Rejected (nothing charged, no body): Base-only 402 + PAYMENT-REQUIRED.error = reason, as Base does.
      return withVary(paid ?? (await withRejectReason(await baseChallenge(withoutPaymentHeaders(req), cdpReady), rejected))) as NextResponse;
    }
    if (!cdpReady) {
      return settlementUnavailableResponse();
    }
    return runPaidHandler(req);
  }
}

export function searchRouteConfig(): RoutesConfig {
  const payTo = getPayTo();
  const network = getNetworkCaip2();
  return keyGetHead({
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
  });
}

export function pdfRouteConfig(): RoutesConfig {
  const payTo = getPayTo();
  const network = getNetworkCaip2();
  return keyGetHead({
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
  });
}

const GROCERY_NORMALIZE_SCHEMA_PROPS = {
  servings: { type: "integer", description: "Servings the recipe makes (1-100). Give with targetServings to scale, or neither." },
  targetServings: { type: "integer", description: "Servings wanted (1-100)." },
};

/** GET query form: same fields as digit strings (query params are strings; matches market/search `n`). */
const GROCERY_NORMALIZE_QUERY_PROPS = {
  servings: { type: "string", pattern: "^[0-9]{1,3}$", description: "Servings the recipe makes, integer 1-100 as digits. Give with targetServings to scale, or neither." },
  targetServings: { type: "string", pattern: "^[0-9]{1,3}$", description: "Servings wanted, integer 1-100 as digits." },
};

/** Recipe ingredient lines to a normalized shopping list. Deterministic, no outbound calls. Same rails, payTo and Bazaar pattern; GET and POST share one price. */
export function groceryNormalizeRouteConfig(): RoutesConfig {
  const payTo = getPayTo();
  const network = getNetworkCaip2();
  const output = outputOf("/api/grocery/normalize", "Horizon Pulse grocery normalize: per line name, canonicalId, qty, unit, metric, category, pack hint; merged shoppingList; unparsed lines (no prices)");
  return methodSplitRoutes(
    "/api/grocery/normalize",
    {
      accepts: [
        {
          scheme: "exact",
          price: GROCERY_NORMALIZE_PRICE_USD,
          network,
          payTo,
        },
      ],
      description: routeDescription("/api/grocery/normalize"),
      mimeType: "application/json",
      ...serviceMetadata("/api/grocery/normalize"),
    },
    {
      ...declareChargedDiscovery({
        method: "GET",
        input: { ingredients: "2 cups all-purpose flour|3 large eggs|1 tbsp olive oil", servings: "4", targetServings: "8" }, // same 3 lines as the recorded example and the POST input
        inputSchema: {
          properties: {
            ingredients: { type: "string", description: "Ingredient lines separated by | (max 100 lines, 200 chars each). POST JSON is preferred." },
            // Query values are strings on the wire: declared as digit strings so the
            // GET example ("4", "8") validates (was integer -> "invalid bazaar extension").
            ...GROCERY_NORMALIZE_QUERY_PROPS,
          },
          required: ["ingredients"],
        },
        output,
      } as DiscoveryDecl),
    },
    {
      ...declareChargedDiscovery({
        method: "POST",
        bodyType: "json",
        input: { ingredients: ["2 cups all-purpose flour", "3 large eggs", "1 tbsp olive oil"], servings: 4, targetServings: 8 },
        inputSchema: {
          properties: {
            ingredients: { type: "array", items: { type: "string" }, description: "Ingredient lines, one per item (max 100, 200 chars each)." },
            text: { type: "string", description: "Alternative to ingredients: one ingredient per line (max 10,000 chars)." },
            ...GROCERY_NORMALIZE_SCHEMA_PROPS,
          },
          required: [],
        },
        output,
      } as DiscoveryDecl),
    },
  );
}

/** /api/grocery/ingredient: ingredient name/canonicalId and/or barcode -> nutrition per 100 g (USDA FDC snapshot + Open Food Facts barcode reads). Bazaar example values use the declared types: GET query values are strings (q, barcode, n as digits), POST body n is an integer. */
export function groceryIngredientRouteConfig(): RoutesConfig {
  const payTo = getPayTo();
  const network = getNetworkCaip2();
  const output = {
    example: GROCERY_INGREDIENT_OUTPUT_EXAMPLE,
    schema: {
      type: "object",
      description:
        "Horizon Pulse ingredient nutrition: per item matches[] (source, id, fdcId for USDA matches, name, nutrientsPer100g, allergens null when unknown, sourceUrl, license, attribution), whereToBuy (Open Food Facts store names only), unknowns; attribution[]; disclaimer. The example is a trimmed response recorded from the handler on this method's declared input (USDA snapshot only); live values differ.",
    },
  };
  return methodSplitRoutes(
    "/api/grocery/ingredient",
    {
      accepts: [{ scheme: "exact", price: GROCERY_INGREDIENT_PRICE_USD, network, payTo }],
      description: routeDescription("/api/grocery/ingredient"),
      mimeType: "application/json",
      ...serviceMetadata("/api/grocery/ingredient"),
    },
    {
      ...declareChargedDiscovery({
        method: "GET",
        input: { q: "all-purpose flour", n: "2" },
        inputSchema: {
          properties: {
            q: { type: "string", description: "Ingredient name or a /api/grocery/normalize canonicalId (1-100 chars). Give q and/or barcode." },
            barcode: { type: "string", pattern: "^([0-9]{8}|[0-9]{12,14})$", description: "Product GTIN-8, UPC-A, EAN-13 or GTIN-14 (valid check digit); read live from Open Food Facts." },
            n: { type: "string", pattern: "^[1-5]$", description: "USDA matches per item, integer 1-5 as a digit (default 3)." },
          },
          required: [],
        },
        output,
      } as DiscoveryDecl),
    },
    {
      ...declareChargedDiscovery({
        method: "POST",
        bodyType: "json",
        input: { items: [{ q: "egg" }, { q: "olive oil" }], n: 1 },
        inputSchema: {
          properties: {
            items: {
              type: "array",
              maxItems: 10,
              items: {
                type: "object",
                properties: {
                  q: { type: "string", description: "Ingredient name or canonicalId (1-100 chars)." },
                  barcode: { type: "string", pattern: "^([0-9]{8}|[0-9]{12,14})$", description: "Product GTIN (valid check digit)." },
                },
              },
              description: "Up to 10 items, each with q and/or barcode. One price per call.",
            },
            n: { type: "integer", minimum: 1, maximum: 5, description: "USDA matches per item (default 3)." },
          },
          required: ["items"],
        },
        output: { ...output, example: GROCERY_INGREDIENT_POST_OUTPUT_EXAMPLE },
      } as DiscoveryDecl),
    },
  );
}

/** Chain tip for Base, Polygon, Ethereum, Solana and XRPL (public RPCs). Same rails, payTo and Bazaar pattern as tx-status. */
export function chainHeadRouteConfig(): RoutesConfig {
  const payTo = getPayTo();
  const network = getNetworkCaip2();
  return {
    "/api/chain/head": {
      accepts: [
        {
          scheme: "exact",
          price: CHAIN_HEAD_PRICE_USD,
          network,
          payTo,
        },
      ],
      description: routeDescription("/api/chain/head"),
      mimeType: "application/json",
      ...serviceMetadata("/api/chain/head"),
      extensions: {
        ...declareChargedDiscovery({
          method: "GET",
          input: { network: "base,solana,xrpl" },
          inputSchema: {
            properties: {
              network: { type: "string", description: "Optional comma list of base, polygon, ethereum, solana, xrpl (or CAIP-2 ids). Default: all five." },
            },
            required: [],
          },
          output: outputOf("/api/chain/head", "Horizon Pulse chain head: per network chainId, height (block, slot or ledger index), headTime, headAgeSeconds, finalizedHeight, finalityGap"),
        } as DiscoveryDecl),
      },
    },
  };
}

/** Token metadata from chain state (EVM, Solana, XRPL; public RPCs). Same rails, payTo and Bazaar pattern as tx-status. */
export function tokenMetaRouteConfig(): RoutesConfig {
  const payTo = getPayTo();
  const network = getNetworkCaip2();
  return {
    "/api/token/meta": {
      accepts: [
        {
          scheme: "exact",
          price: TOKEN_META_PRICE_USD,
          network,
          payTo,
        },
      ],
      description: routeDescription("/api/token/meta"),
      mimeType: "application/json",
      ...serviceMetadata("/api/token/meta"),
      extensions: {
        ...declareChargedDiscovery({
          method: "GET",
          input: { network: "base", token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
          inputSchema: {
            properties: {
              network: { type: "string", description: "base, polygon, ethereum, solana or xrpl (or CAIP-2 id). Required." },
              token: { type: "string", description: "Required. EVM: 0x + 40 hex contract address. Solana: base58 mint. XRPL: CURRENCY.rIssuer (3-char code or 40 hex)." },
            },
            required: ["network", "token"],
          },
          output: outputOf("/api/token/meta", "Horizon Pulse token metadata from chain state: found, standard, name, symbol, decimals, totalSupply, details (no price)"),
        } as DiscoveryDecl),
      },
    },
  };
}

/** ENS and Basenames, forward and reverse, on-chain only. Same rails, payTo and Bazaar pattern as tx-status. */
export function nameResolveRouteConfig(): RoutesConfig {
  const payTo = getPayTo();
  const network = getNetworkCaip2();
  return {
    "/api/name/resolve": {
      accepts: [
        {
          scheme: "exact",
          price: NAME_RESOLVE_PRICE_USD,
          network,
          payTo,
        },
      ],
      description: routeDescription("/api/name/resolve"),
      mimeType: "application/json",
      ...serviceMetadata("/api/name/resolve"),
      extensions: {
        ...declareChargedDiscovery({
          method: "GET",
          input: { name: "vitalik.eth" },
          inputSchema: {
            properties: {
              name: { type: "string", description: "ENS or Basename to resolve (e.g. vitalik.eth, jesse.base.eth). Give name or address." },
              address: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$", description: "0x address for reverse lookup (ENS and Basename primary names). Give name or address." },
            },
            required: [],
          },
          output: outputOf("/api/name/resolve", "Horizon Pulse name resolution: forward (address, resolver, registry) or reverse (ENS and Basename primary names, verified forward)"),
        } as DiscoveryDecl),
      },
    },
  };
}

/**
 * /api/batch (INERT unless HP_BATCH_ENABLED=true; PROPOSED price, needs
 * Michael's yes). POST only: the bare-path key keeps every other verb paid
 * with the same declaration, so no verb runs the handler unpaid. Example is
 * illustrative (no recording exists while the route is off).
 */
export const BATCH_OUTPUT_EXAMPLE = {
  illustrative: true,
  source: "batch",
  count: 2,
  okCount: 2,
  results: [
    { index: 0, route: "chain/head", status: 200, ok: true, body: { source: "chain-head", networks: [{ network: "base", height: 0 }] } },
    { index: 1, route: "gas", status: 200, ok: true, body: { ok: true, source: "rpc", networks: [{ network: "base", baseFeeGwei: 0 }] } },
  ],
} as const;

const BATCH_ITEMS_SCHEMA = {
  type: "array",
  minItems: 1,
  maxItems: BATCH_MAX_ITEMS,
  items: {
    type: "object",
    properties: {
      route: { type: "string", enum: ["balance", "gas", "tx-status", "token/meta", "chain/head", "name/resolve"] },
      params: { type: "object", description: "The query keys the single route takes, string values." },
    },
    required: ["route"],
  },
  description: `1-${BATCH_MAX_ITEMS} checks. One price per call.`,
} as const;

const BATCH_EXAMPLE_ITEMS = [{ route: "chain/head", params: { network: "base" } }, { route: "gas", params: {} }];

export function batchRouteConfig(): RoutesConfig {
  const payTo = getPayTo();
  const network = getNetworkCaip2();
  const output = {
    example: BATCH_OUTPUT_EXAMPLE,
    schema: {
      type: "object",
      description:
        "Horizon Pulse batch: results[] in request order (index, route, status, ok, body = the single route's JSON without priced/charged), count, okCount. The example is an illustrative format sample (illustrative: true), not a recorded real response.",
    },
  };
  return methodSplitRoutes(
    "/api/batch",
    {
      accepts: [{ scheme: "exact", price: BATCH_PRICE_USD, network, payTo }],
      description: routeDescription("/api/batch"),
      mimeType: "application/json",
      ...serviceMetadata("/api/batch"),
    },
    {
      ...declareChargedDiscovery({
        method: "GET",
        input: { items: JSON.stringify(BATCH_EXAMPLE_ITEMS) },
        inputSchema: {
          properties: {
            items: { type: "string", description: `JSON array of 1-${BATCH_MAX_ITEMS} {route, params} objects (same shape as the POST body's items).` },
          },
          required: ["items"],
        },
        output,
      } as DiscoveryDecl),
    },
    {
      ...declareChargedDiscovery({
        method: "POST",
        bodyType: "json",
        input: { items: BATCH_EXAMPLE_ITEMS },
        inputSchema: { properties: { items: BATCH_ITEMS_SCHEMA }, required: ["items"] },
        output,
      } as DiscoveryDecl),
    },
  );
}
