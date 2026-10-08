#!/usr/bin/env node
/**
 * Horizon Pulse MCP server (stdio).
 *
 * Exposes every live paid route on https://horizonpulse.dev as an MCP tool
 * (catalog read from /openapi.json at startup) and pays each call's x402 v2
 * challenge in USDC on Base from the buyer wallet in HP_PRIVATE_KEY.
 * Three free helper tools: catalog, quote (decode the 402 without paying),
 * demo (free fixed-input sample of a route's real output).
 *
 * stdout is the MCP channel; all logs go to stderr. The key is never logged.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { privateKeyToAccount } from "viem/accounts";
import { atomicToUsd, loadConfig } from "./config.js";
import { loadCatalog, type RouteTool } from "./catalog.js";
import { Budget, callRoute, type CallOutcome } from "./pay.js";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

const VERSION = "0.1.0";
const MAX_TEXT = 400_000;
const log = (...a: unknown[]) => console.error("[horizon-pulse-mcp]", ...a);

const cfg = loadConfig();
const budget = new Budget(cfg.maxAtomicTotal);
let catalogPromise: Promise<{ tools: RouteTool[]; source: string }> | null = null;
const catalog = () => (catalogPromise ??= loadCatalog(cfg.baseUrl, cfg.timeoutMs).catch((e) => {
  catalogPromise = null; // retry on next request
  throw e;
}));

const ROUTE_ENUM_HINT = "Route tool name, e.g. pulse, fetch, search, x402_check (see the catalog tool).";

const HELPER_TOOLS = [
  {
    name: "catalog",
    description:
      "Free. List every Horizon Pulse paid route with its exact price (USDC on Base), method, inputs and the payTo address, plus this server's spend caps and whether a buyer wallet is configured. Call this first.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "quote",
    description:
      "Free, never pays. Call a route without payment and return the decoded x402 v2 challenge (price, asset, network, payTo) and whether this server would pay it under its caps.",
    inputSchema: {
      type: "object",
      properties: {
        route: { type: "string", description: ROUTE_ENUM_HINT },
        args: { type: "object", description: "Arguments for that route, same as the route tool's inputs." },
      },
      required: ["route"],
    },
  },
  {
    name: "demo",
    description:
      "Free, never pays. Return the route's free sample: the real handler run on a fixed input (GET /api/demo/<route>), to check the response shape before paying.",
    inputSchema: {
      type: "object",
      properties: { route: { type: "string", description: ROUTE_ENUM_HINT } },
      required: ["route"],
    },
  },
];

function text(t: string): Content {
  return { type: "text", text: t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}\n…[truncated ${t.length - MAX_TEXT} chars]` : t };
}

function renderOutcome(o: CallOutcome, tool: RouteTool): { content: Content[]; isError: boolean } {
  const meta: Json = { route: `${tool.method} ${tool.path}`, status: o.status, result: o.kind, message: o.message };
  if (o.settlement) meta.settlement = o.settlement;
  if (o.kind !== "paid" && o.requirements) meta.paymentRequired = o.requirements;
  meta.session = { spentUsd: atomicToUsd(budget.spent), budgetUsd: atomicToUsd(budget.limit) };

  const content: Content[] = [];
  const body = o.body;
  // Screenshots: return the image as MCP image content, not a giant base64 string.
  if (body && typeof body === "object" && typeof body.imageBase64 === "string" && typeof body.mimeType === "string") {
    const { imageBase64, ...rest } = body;
    content.push({ type: "image", data: imageBase64, mimeType: body.mimeType });
    content.push(text(JSON.stringify(rest, null, 2)));
  } else if (body !== undefined) {
    content.push(text(JSON.stringify(body, null, 2)));
  } else if (o.bodyText) {
    content.push(text(o.bodyText));
  }
  content.push(text(`horizon-pulse: ${JSON.stringify(meta)}`));
  return { content, isError: !o.ok };
}

function findTool(tools: RouteTool[], name: unknown): RouteTool | undefined {
  const n = String(name ?? "").replace(/^\/?(api\/)?/, "").replace(/[^a-zA-Z0-9]+/g, "_");
  return tools.find((t) => t.name === n);
}

const server = new Server({ name: "horizon-pulse", version: VERSION }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const { tools } = await catalog();
  return {
    tools: [
      ...HELPER_TOOLS,
      ...tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: rawArgs } = req.params;
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  let tools: RouteTool[];
  let source: string;
  try {
    ({ tools, source } = await catalog());
  } catch (e) {
    return { content: [text(String(e))], isError: true };
  }

  if (name === "catalog") {
    const out = {
      baseUrl: cfg.baseUrl,
      catalogSource: source,
      payment: {
        protocol: "x402 v2, scheme exact (EIP-3009 transferWithAuthorization)",
        network: "eip155:8453 (Base mainnet)",
        asset: "USDC 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        expectedPayTo: cfg.expectedPayTo,
        buyerWallet: cfg.privateKey ? privateKeyToAccount(cfg.privateKey).address : null,
        mode: cfg.dryRun ? "dry-run (never pays)" : cfg.privateKey ? "pays automatically within caps" : "quote-only (no HP_PRIVATE_KEY)",
        maxUsdPerCall: atomicToUsd(cfg.maxAtomicPerCall),
        sessionBudgetUsd: atomicToUsd(cfg.maxAtomicTotal),
        sessionSpentUsd: atomicToUsd(budget.spent),
      },
      routes: tools.map((t) => ({
        tool: t.name,
        method: t.method,
        path: t.path,
        priceUsd: t.priceUsd,
        amountAtomic: t.amount,
        inputs: Object.keys(t.inputSchema.properties),
        required: t.inputSchema.required ?? [],
        freeSample: `${cfg.baseUrl}/api/demo/${t.demo}`,
      })),
    };
    return { content: [text(JSON.stringify(out, null, 2))] };
  }

  if (name === "quote") {
    const tool = findTool(tools, args.route);
    if (!tool) return { content: [text(`Unknown route ${JSON.stringify(args.route)}. ${ROUTE_ENUM_HINT}`)], isError: true };
    const o = await callRoute({ ...cfg, dryRun: true }, budget, tool, (args.args ?? {}) as Record<string, unknown>);
    const wouldPay = o.kind === "quote" && cfg.privateKey && !cfg.dryRun;
    const out = { route: `${tool.method} ${tool.path}`, status: o.status, result: o.kind, message: o.message, paymentRequired: o.requirements, wouldPayWithCurrentConfig: Boolean(wouldPay), body: o.kind === "free" || o.kind === "error" ? o.body ?? o.bodyText : undefined };
    return { content: [text(JSON.stringify(out, null, 2))], isError: o.kind === "error" };
  }

  if (name === "demo") {
    const tool = findTool(tools, args.route);
    if (!tool) return { content: [text(`Unknown route ${JSON.stringify(args.route)}. ${ROUTE_ENUM_HINT}`)], isError: true };
    try {
      const r = await fetch(`${cfg.baseUrl}/api/demo/${tool.demo}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(cfg.timeoutMs) });
      const t = await r.text();
      if (r.status === 402) return { content: [text("Unexpected 402 from a demo route; not paying.")], isError: true };
      let shown = t;
      try {
        const j = JSON.parse(t);
        if (typeof j?.imageBase64 === "string") j.imageBase64 = `${j.imageBase64.slice(0, 80)}…(${j.imageBase64.length} chars)`;
        shown = JSON.stringify(j, null, 2);
      } catch {
        /* not JSON */
      }
      return { content: [text(shown)], isError: !r.ok };
    } catch (e) {
      return { content: [text(`Demo request failed: ${String(e)}`)], isError: true };
    }
  }

  const tool = tools.find((t) => t.name === name);
  if (!tool) return { content: [text(`Unknown tool ${name}`)], isError: true };
  const outcome = await callRoute(cfg, budget, tool, args);
  if (outcome.kind === "paid") log(`paid ${tool.path} status=${outcome.status} tx=${outcome.settlement?.transaction ?? "n/a"} session=${atomicToUsd(budget.spent)}`);
  return renderOutcome(outcome, tool);
});

async function main() {
  const mode = cfg.dryRun ? "dry-run" : cfg.privateKey ? `paying from ${privateKeyToAccount(cfg.privateKey).address}` : "quote-only (no HP_PRIVATE_KEY)";
  log(`v${VERSION} base=${cfg.baseUrl} mode=${mode} cap/call=${atomicToUsd(cfg.maxAtomicPerCall)} session=${atomicToUsd(cfg.maxAtomicTotal)}`);
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  log("fatal:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
