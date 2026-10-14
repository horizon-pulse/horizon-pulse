/**
 * Hosted MCP endpoint (POST /mcp): the paid routes as MCP tools.
 *
 * - Each tool calls the EXISTING route handler unchanged (same SSRF guards,
 *   caps and upstreams). No new data paths, no demo data via MCP. Exception:
 *   FREE_TOOLS (money_market_rates) call the free REST route with no x402
 *   wrapper; they are not paid tools and not in TOOLS.
 * - Payment uses the official @x402/mcp wrapper with the SAME accepts the REST
 *   routes advertise (buildPaymentRequirements: amount, payTo, network, asset).
 *   Same CDP facilitator via getResourceServer().
 * - initialize / tools/list are free. tools/call without payment returns only
 *   the x402 challenge; the handler is never invoked. Handler errors are not
 *   settled (wrapper cancels settlement on isError).
 * - No Bazaar discovery extension on MCP tools (REST discovery unchanged).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createPaymentWrapper } from "@x402/mcp";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { POLL_INTERVAL_SECONDS } from "./paid-call-meta";
import { NextRequest, type NextResponse } from "next/server";
import { z } from "zod";
import { buildPaymentRequirements, getResourceServer } from "./x402-server";
import { PUBLIC_BASE_URL } from "./config";
import { MMR_DESCRIPTION } from "./money-market-rates";
import { GET as moneyMarketRatesGET } from "@/app/api/money-market-rates/route";

import * as pulse from "@/app/api/pulse/handler";
import * as signals from "@/app/api/signals/handler";
import * as yieldR from "@/app/api/yield/handler";
import * as gas from "@/app/api/gas/handler";
import * as funding from "@/app/api/funding/handler";
import * as portfolio from "@/app/api/portfolio/handler";
import * as fetchR from "@/app/api/fetch/handler";
import * as http from "@/app/api/http/handler";
import * as extract from "@/app/api/extract/handler";
import * as x402check from "@/app/api/x402-check/handler";
import * as bazaarCheck from "@/app/api/bazaar-check/handler";
import * as marketSearch from "@/app/api/market/search/handler";
import * as discourseSplit from "@/app/api/discourse/split/handler";
import * as txStatus from "@/app/api/tx-status/handler";
import * as tokenizedStock from "@/app/api/tokenized-stock/handler";
import * as watchRoute from "@/app/api/watch/handler";
import * as balanceRoute from "@/app/api/balance/handler";
import * as txGuardRoute from "@/app/api/tx-guard/handler";
import * as groceryNormalizeRoute from "@/app/api/grocery/normalize/handler";
import * as marketQuote from "@/app/api/market/quote/handler";
import * as screenshot from "@/app/api/screenshot/handler";
import * as search from "@/app/api/search/handler";
import * as pdf from "@/app/api/pdf/handler";

type PaymentOpts = { maxAmountRequired: string; resource: string; description: string };
type Handler = (req: NextRequest) => Promise<NextResponse>;

/** Build the internal request the REST handler expects. */
/** Client IP of the incoming /mcp request (x-real-ip, else first x-forwarded-for entry), set by app/mcp/route.ts. */
const mcpCaller = new AsyncLocalStorage<{ ip?: string }>();
export function mcpClientIp(headers: Headers): string | undefined {
  return headers.get("x-real-ip")?.trim() || headers.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined;
}
export function withMcpCaller<T>(req: Request, fn: () => T): T {
  return mcpCaller.run({ ip: mcpClientIp(req.headers) }, fn);
}

function makeRequest(path: string, query: Record<string, string | undefined>, jsonBody?: unknown): NextRequest {
  const url = new URL(path, PUBLIC_BASE_URL);
  for (const [k, v] of Object.entries(query)) if (v != null && v !== "") url.searchParams.set(k, v);
  // Forward the MCP caller's IP so per-IP limits (e.g. money_market_rates) are per user, not one shared bucket.
  const ip = mcpCaller.getStore()?.ip;
  const fwd: Record<string, string> = ip ? { "x-real-ip": ip } : {};
  if (jsonBody === undefined) return new NextRequest(url, { method: "GET", headers: fwd });
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...fwd },
    body: JSON.stringify(jsonBody),
  });
}

async function runHandler(handler: Handler, req: NextRequest) {
  const res = await handler(req);
  const text = await res.text();
  return {
    content: [{ type: "text" as const, text }],
    isError: res.status >= 400,
  };
}

export type ToolDef = {
  name: string;
  opts: PaymentOpts;
  schema: z.ZodRawShape;
  call: (args: Record<string, unknown>) => Promise<{ content: { type: "text"; text: string }[]; isError: boolean }>;
};

const s = (v: unknown) => (typeof v === "string" ? v : undefined);

export const TOOLS: ToolDef[] = [
  { name: "pulse", opts: pulse.paymentOpts, schema: {}, call: () => runHandler(pulse.pulseHandler, makeRequest("/api/pulse", {})) },
  { name: "signals", opts: signals.paymentOpts, schema: {}, call: () => runHandler(signals.signalsHandler, makeRequest("/api/signals", {})) },
  { name: "yield", opts: yieldR.paymentOpts, schema: {}, call: () => runHandler(yieldR.yieldHandler, makeRequest("/api/yield", {})) },
  { name: "gas", opts: gas.paymentOpts, schema: {}, call: () => runHandler(gas.gasHandler, makeRequest("/api/gas", {})) },
  { name: "funding", opts: funding.paymentOpts, schema: {}, call: () => runHandler(funding.fundingHandler, makeRequest("/api/funding", {})) },
  {
    name: "portfolio",
    opts: portfolio.paymentOpts,
    schema: { address: z.string().describe("EVM address (0x…) to snapshot on Base + Ethereum") },
    call: (a) => runHandler(portfolio.portfolioHandler, makeRequest("/api/portfolio", { address: s(a.address) })),
  },
  {
    name: "fetch",
    opts: fetchR.paymentOpts,
    schema: { url: z.string().describe("Public http(s) URL to fetch as clean text/markdown") },
    call: (a) => runHandler(fetchR.fetchHandler, makeRequest("/api/fetch", { url: s(a.url) })),
  },
  {
    name: "http",
    opts: http.paymentOpts,
    schema: {
      url: z.string().describe("Public http(s) URL"),
      method: z.string().optional().describe("HTTP method (default GET)"),
      headers: z.record(z.string()).optional().describe("Request headers (string values)"),
      body: z.string().optional().describe("Request body as text"),
    },
    call: (a) =>
      runHandler(http.httpHandler, makeRequest("/api/http", {}, { url: a.url, method: a.method, headers: a.headers, body: a.body })),
  },
  {
    name: "extract",
    opts: extract.paymentOpts,
    schema: {
      url: z.string().optional().describe("Public http(s) URL to extract from"),
      html: z.string().optional().describe("Raw HTML to extract from (instead of url)"),
      fields: z
        .record(
          z.union([
            z.string(),
            z.object({
              selector: z.string(),
              attr: z.string().optional(),
              all: z.boolean().optional(),
              limit: z.number().int().optional(),
            }),
          ]),
        )
        .optional()
        .describe(
          'Optional CSS-selector fields (max 20): name -> selector or {selector, attr ("text" default, "html", or an attribute name), all, limit 1-50}. Unmatched fields are null with fieldErrors; if none match, no charge.',
        ),
    },
    call: (a) =>
      runHandler(extract.extractHandler, makeRequest("/api/extract", {}, { url: a.url, html: a.html, fields: a.fields })),
  },
  {
    name: "x402_check",
    opts: x402check.paymentOpts,
    schema: {
      url: z.string().describe("Public http(s) URL of the x402 endpoint to audit"),
      method: z.string().optional().describe("Probe method: GET (default; retries POST on 405) or POST"),
      body: z.string().optional().describe("Optional JSON body (string, <=8KB) for a POST probe; implies POST"),
    },
    call: (a) =>
      runHandler(x402check.x402CheckHandler, makeRequest("/api/x402-check", { url: s(a.url), method: s(a.method), body: s(a.body) })),
  },
  {
    name: "bazaar_check",
    opts: bazaarCheck.paymentOpts,
    schema: {
      url: z.string().describe("Seller host (e.g. example.com) or https URL to check against CDP Bazaar discovery"),
    },
    call: (a) => runHandler(bazaarCheck.bazaarCheckHandler, makeRequest("/api/bazaar-check", { url: s(a.url) })),
  },
  {
    name: "market_search",
    opts: marketSearch.paymentOpts,
    schema: {
      q: z.string().describe("What the agent needs, in words (<=200 chars)"),
      n: z.number().int().optional().describe("Offers to return, 1-10 (default 5); the top 3 are re-checked live"),
      kind: z.string().optional().describe("Product kind filter (api_route, mcp_tool, data_feed, ...)"),
      rail: z.string().optional().describe("Payment rail filter: base | solana | xrpl | evm (any EVM chain except Base) | polygon (eip155:137 only) | an exact CAIP-2 network (e.g. eip155:137, xrpl:0)"),
      max_price: z.number().optional().describe("Max USD price per call, e.g. 0.01"),
      min_health: z.number().optional().describe("Minimum health score 0-1"),
    },
    call: (a) =>
      runHandler(
        marketSearch.marketSearchHandler,
        makeRequest("/api/market/search", {
          q: s(a.q),
          n: a.n != null ? String(a.n) : undefined,
          kind: s(a.kind),
          rail: s(a.rail),
          max_price: a.max_price != null ? String(a.max_price) : undefined,
          min_health: a.min_health != null ? String(a.min_health) : undefined,
        }),
      ),
  },
  {
    name: "discourse_split",
    opts: discourseSplit.paymentOpts,
    schema: {
      q: z.string().describe("Question or topic, 3-200 chars. Elections/candidates, health and a named person's conduct are refused (not charged)"),
      sides: z.string().optional().describe("2-4 comma-separated side labels (default yes,no)"),
      window: z.string().optional().describe("Look-back window 1-30 days, e.g. 7d (default 30d)"),
    },
    call: (a) =>
      runHandler((req) => discourseSplit.discourseSplitHandler(req), makeRequest("/api/discourse/split", { q: s(a.q), sides: s(a.sides), window: s(a.window) })),
  },
  {
    name: "tx_status",
    opts: txStatus.paymentOpts,
    schema: {
      tx: z.string().describe("Transaction id: 0x + 64 hex (Base/Polygon), 64 hex (XRPL) or a base58 Solana signature"),
      network: z.string().optional().describe("base, polygon, solana or xrpl; required for 0x hashes. Poll again after pollAgainSeconds until final is true"),
    },
    call: (a) => runHandler((req) => txStatus.txStatusHandler(req), makeRequest("/api/tx-status", { tx: s(a.tx), network: s(a.network) })),
  },
  {
    name: "tokenized_stock",
    opts: tokenizedStock.paymentOpts,
    schema: {
      symbol: z.string().optional().describe("Ticker (AAPL or AAPLc) or the token address on Base; omit for all listed Coinbase tokenized stocks. Status check only (paused, supply, cap, multiplier, issuer), no price. Not investment advice"),
    },
    call: (a) => runHandler((req) => tokenizedStock.tokenizedStockHandler(req), makeRequest("/api/tokenized-stock", { symbol: s(a.symbol) })),
  },
  {
    name: "watch",
    opts: watchRoute.paymentOpts,
    schema: {
      url: z.string().describe("Public http(s) URL of the page or endpoint to check"),
      since: z.string().optional().describe("The state token from your previous watch answer for this url; omit on the first check"),
    },
    call: (a) => runHandler((req) => watchRoute.watchHandler(req), makeRequest("/api/watch", { url: s(a.url), since: s(a.since) })),
  },
  {
    name: "balance",
    opts: balanceRoute.paymentOpts,
    schema: {
      evm: z.string().optional().describe("0x address checked on Base and Polygon (USDC + gas)"),
      solana: z.string().optional().describe("Solana address (USDC + SOL)"),
      xrpl: z.string().optional().describe("XRP Ledger r-address (RLUSD, trust line, reserve, fee). Give at least one of evm, solana, xrpl"),
    },
    call: (a) => runHandler((req) => balanceRoute.balanceHandler(req), makeRequest("/api/balance", { evm: s(a.evm), solana: s(a.solana), xrpl: s(a.xrpl) })),
  },
  {
    name: "tx_guard",
    opts: txGuardRoute.paymentOpts,
    schema: {
      chain: z.enum(["base", "polygon", "solana", "xrpl"]).describe("Chain of the transfer"),
      to: z.string().describe("Recipient address you are about to send to"),
      expected: z.string().optional().describe("The address you meant to send to (for the lookalike check)"),
      token: z.string().optional().describe("Token contract on Base or Polygon (ScamSniffer public list, GPL-3.0, up to 7-day delay)"),
    },
    call: (a) => runHandler((req) => txGuardRoute.txGuardHandler(req), makeRequest("/api/tx-guard", { chain: s(a.chain), to: s(a.to), expected: s(a.expected), token: s(a.token) })),
  },  {
    name: "grocery_normalize",
    opts: groceryNormalizeRoute.paymentOpts,
    schema: {
      ingredients: z.array(z.string()).describe("Recipe ingredient lines, one per item (max 100, 200 chars each)"),
      servings: z.number().int().optional().describe("Servings the recipe makes (1-100); give with targetServings to scale"),
      targetServings: z.number().int().optional().describe("Servings you want (1-100)"),
    },
    call: (a) =>
      runHandler(
        (req) => groceryNormalizeRoute.groceryNormalizeHandler(req),
        makeRequest("/api/grocery/normalize", {}, { ingredients: a.ingredients, servings: a.servings, targetServings: a.targetServings }),
      ),
  },

  {
    name: "market_quote",
    opts: marketQuote.paymentOpts,
    schema: {
      url: z.string().describe("https URL of the x402 resource to quote before paying"),
      method: z.string().optional().describe("Probe method GET (default; one POST retry on 405) or POST"),
    },
    call: (a) => runHandler(marketQuote.marketQuoteHandler, makeRequest("/api/market/quote", { url: s(a.url), method: s(a.method) })),
  },
  {
    name: "screenshot",
    opts: screenshot.paymentOpts,
    schema: {
      url: z.string().describe("Public http(s) URL to render"),
      width: z.number().int().optional().describe("Viewport width 320-1920 (default 1280)"),
      height: z.number().int().optional().describe("Viewport height 240-2000 (default 800)"),
      fullPage: z.boolean().optional().describe("Capture full page (clipped at 4000px)"),
      format: z.enum(["png", "jpeg"]).optional().describe("Image format (default png)"),
    },
    call: (a) =>
      runHandler(
        screenshot.screenshotHandler,
        makeRequest("/api/screenshot", {
          url: s(a.url),
          width: a.width != null ? String(a.width) : undefined,
          height: a.height != null ? String(a.height) : undefined,
          fullPage: a.fullPage ? "true" : undefined,
          format: s(a.format),
        }),
      ),
  },
  {
    name: "search",
    opts: search.paymentOpts,
    schema: {
      q: z.string().describe("Web search query (<=300 chars)"),
      n: z.number().int().optional().describe("Result pages to fetch as clean text, 1-5 (default 3)"),
    },
    call: (a) =>
      runHandler(search.searchHandler, makeRequest("/api/search", { q: s(a.q), n: a.n != null ? String(a.n) : undefined })),
  },
  {
    name: "pdf",
    opts: pdf.paymentOpts,
    schema: {
      url: z.string().describe("Absolute http(s) URL of a public PDF (max 10MB)"),
      pages: z.number().int().optional().describe("Max pages to return, 1-50 (default 50)"),
    },
    call: (a) =>
      runHandler(pdf.pdfHandler, makeRequest("/api/pdf", { url: s(a.url), pages: a.pages != null ? String(a.pages) : undefined })),
  },
];

/** MCP tool name -> HTTP route path (for the shared poll-interval table). */
const MCP_ROUTE: Readonly<Record<string, string>> = { pulse: "/api/pulse", gas: "/api/gas", funding: "/api/funding", signals: "/api/signals", yield: "/api/yield" };

/**
 * Tool text for MCP clients (plan #4): the route description, the exact price, the rail
 * (MCP payments are Base only), and for feed tools how often the data changes, so an
 * agent loop can decide when calling again is worth it.
 */
export function mcpToolDescription(name: string, opts: PaymentOpts): string {
  const usd = Number(opts.maxAmountRequired) / 1e6;
  const n = POLL_INTERVAL_SECONDS[MCP_ROUTE[name] ?? ""];
  const cadence = n ? ` Data changes about every ${n >= 3600 ? `${n / 3600} h` : n >= 60 ? `${n / 60} min` : `${n} s`}; calling more often returns the same values.` : "";
  return `${opts.description.replace(/\.$/, "")}. Price $${usd} per call via x402, USDC on Base (MCP payments are Base only).${cadence}`;
}

/**
 * MCP tool annotations: every paid tool only reads public data, except the HTTP proxy,
 * which can send POST/PUT/PATCH/DELETE upstream, so it is marked destructive (Odin 10/14).
 */
export function mcpToolAnnotations(name: string): ToolAnnotations {
  const proxy = name === "http";
  return { readOnlyHint: !proxy, destructiveHint: proxy, idempotentHint: !proxy, openWorldHint: true };
}

export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "horizon-pulse", version: "1.0.0" });
  const resourceServer = getResourceServer();
  for (const t of TOOLS) {
    const pr = buildPaymentRequirements(t.opts);
    const paid = createPaymentWrapper(resourceServer, {
      accepts: pr.accepts,
      resource: {
        url: `mcp://tool/${t.name}`,
        description: t.opts.description,
        mimeType: "application/json",
        serviceName: pr.resource.serviceName,
        tags: pr.resource.tags,
        iconUrl: pr.resource.iconUrl,
      },
    });
    server.tool(t.name, mcpToolDescription(t.name, t.opts), t.schema, mcpToolAnnotations(t.name), paid(async (args) => t.call(args as Record<string, unknown>)));
  }
  // FREE tools: no x402 wrapper, no challenge; counted as free, never in TOOLS (the paid list).
  for (const f of FREE_TOOLS) server.tool(f.name, f.description, f.schema, async (args) => f.call(args as Record<string, unknown>));
  return server;
}

export const FREE_TOOLS = [
  {
    name: "money_market_rates",
    description: MMR_DESCRIPTION,
    schema: {
      rates: z.string().optional().describe("Comma list from SOFR,EFFR,OBFR,TGCR,BGCR (default all five)"),
      last: z.number().int().optional().describe("Last n observations per rate, 1-10 (exclusive with startDate/endDate)"),
      startDate: z.string().optional().describe("YYYY-MM-DD, >= 2018-04-02; needs endDate; span <= 31 days"),
      endDate: z.string().optional().describe("YYYY-MM-DD, >= startDate"),
    },
    call: (a: Record<string, unknown>) =>
      runHandler(
        moneyMarketRatesGET as unknown as Handler,
        makeRequest("/api/money-market-rates", { rates: s(a.rates), last: a.last != null ? String(a.last) : undefined, startDate: s(a.startDate), endDate: s(a.endDate) }),
      ),
  },
];
