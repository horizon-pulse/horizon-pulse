/**
 * Hosted MCP endpoint (POST /mcp): the same 9 paid routes as MCP tools.
 *
 * - Each tool calls the EXISTING route handler unchanged (same SSRF guards,
 *   caps and upstreams). No new data paths, no free/demo data via MCP.
 * - Payment uses the official @x402/mcp wrapper with the SAME accepts the REST
 *   routes advertise (buildPaymentRequirements: amount, payTo, network, asset).
 *   Same CDP facilitator via getResourceServer().
 * - initialize / tools/list are free. tools/call without payment returns only
 *   the x402 challenge; the handler is never invoked. Handler errors are not
 *   settled (wrapper cancels settlement on isError).
 * - No Bazaar discovery extension on MCP tools (REST discovery unchanged).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createPaymentWrapper } from "@x402/mcp";
import { NextRequest, type NextResponse } from "next/server";
import { z } from "zod";
import { buildPaymentRequirements, getResourceServer } from "./x402-server";
import { PUBLIC_BASE_URL } from "./config";

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
import * as screenshot from "@/app/api/screenshot/handler";

type PaymentOpts = { maxAmountRequired: string; resource: string; description: string };
type Handler = (req: NextRequest) => Promise<NextResponse>;

/** Build the internal request the REST handler expects. */
function makeRequest(path: string, query: Record<string, string | undefined>, jsonBody?: unknown): NextRequest {
  const url = new URL(path, PUBLIC_BASE_URL);
  for (const [k, v] of Object.entries(query)) if (v != null && v !== "") url.searchParams.set(k, v);
  if (jsonBody === undefined) return new NextRequest(url, { method: "GET" });
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
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
    },
    call: (a) => runHandler(extract.extractHandler, makeRequest("/api/extract", {}, { url: a.url, html: a.html })),
  },
  {
    name: "x402_check",
    opts: x402check.paymentOpts,
    schema: {
      url: z.string().describe("Public http(s) URL of the x402 endpoint to audit"),
      method: z.string().optional().describe("Probe method: GET (default) or POST"),
    },
    call: (a) => runHandler(x402check.x402CheckHandler, makeRequest("/api/x402-check", { url: s(a.url), method: s(a.method) })),
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
];

let initPromise: Promise<void> | null = null;
/** Facilitator sync is only needed to verify/settle; unpaid challenges don't need it. */
export function ensureFacilitatorReady(): Promise<void> {
  if (!initPromise) initPromise = getResourceServer().initialize();
  return initPromise;
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
    server.tool(
      t.name,
      `${t.opts.description}. Paid per call via x402 (USDC on Base).`,
      t.schema,
      paid(async (args) => t.call(args as Record<string, unknown>)),
    );
  }
  return server;
}
