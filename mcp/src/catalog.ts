/**
 * Live route catalog, built from the service's own OpenAPI document
 * (GET {HP_BASE_URL}/openapi.json). Every paid operation there carries
 * `x-payment-info` (price, asset, network, payTo), so the tool list and the
 * advertised prices always match what the site actually serves.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export type RouteTool = {
  /** MCP tool name, e.g. "pulse", "x402_check" (same names as the hosted /mcp endpoint). */
  name: string;
  /** Route path, e.g. "/api/pulse". */
  path: string;
  /** Short route name used by the free sample endpoint /api/demo/<route>. */
  demo: string;
  method: "GET" | "POST";
  description: string;
  inputSchema: { type: "object"; properties: Record<string, Json>; required?: string[] };
  priceUsd: string;
  /** Advertised price in USDC atomic units (6 decimals). */
  amount: string;
  payTo: string;
  network: string;
  asset: string;
};

export function toolsFromOpenApi(spec: Json): RouteTool[] {
  const out: RouteTool[] = [];
  for (const [p, item] of Object.entries<Json>(spec?.paths ?? {})) {
    // Routes that accept GET and POST get one tool, using POST (the superset: JSON body, headers, raw HTML).
    const method: "GET" | "POST" | undefined = item.post?.["x-payment-info"] ? "POST" : item.get?.["x-payment-info"] ? "GET" : undefined;
    if (!method) continue;
    const op = item[method.toLowerCase()];
    const pay = op["x-payment-info"];
    const demo = p.replace(/^\/api\//, "");
    const name = demo.replace(/[^a-zA-Z0-9]+/g, "_");

    let inputSchema: RouteTool["inputSchema"];
    if (method === "GET") {
      const properties: Record<string, Json> = {};
      const required: string[] = [];
      for (const prm of op.parameters ?? []) {
        if (prm.in !== "query") continue;
        properties[prm.name] = { ...(prm.schema ?? { type: "string" }), description: prm.description };
        if (prm.required) required.push(prm.name);
      }
      inputSchema = { type: "object", properties, ...(required.length ? { required } : {}) };
    } else {
      const s = op.requestBody?.content?.["application/json"]?.schema ?? {};
      inputSchema = { type: "object", properties: s.properties ?? {}, ...(s.required?.length ? { required: s.required } : {}) };
    }

    const summary = String(op.description ?? op.summary ?? "").split("\n\n")[0].trim();
    out.push({
      name,
      path: p,
      demo,
      method,
      description: `${summary} Price: ${pay.priceUsd} USDC per call, paid automatically via x402 on Base from the configured buyer wallet (capped by HP_MAX_USD_PER_CALL). Errors are not charged unless noted.`,
      inputSchema,
      priceUsd: String(pay.priceUsd),
      amount: String(pay.amount),
      payTo: String(pay.payTo).toLowerCase(),
      network: String(pay.network),
      asset: String(pay.asset),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Fetch the live OpenAPI; fall back to the repo copy (../../public/openapi.json) when offline. */
export async function loadCatalog(baseUrl: string, timeoutMs: number): Promise<{ tools: RouteTool[]; source: string }> {
  const url = `${baseUrl}/openapi.json`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(Math.min(timeoutMs, 15_000)) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const tools = toolsFromOpenApi(await r.json());
      if (tools.length) return { tools, source: url };
      throw new Error("no paid operations in OpenAPI");
    } catch (e) {
      lastErr = e;
      await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
    }
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const local = path.resolve(here, "..", "..", "public", "openapi.json");
  if (fs.existsSync(local)) {
    const tools = toolsFromOpenApi(JSON.parse(fs.readFileSync(local, "utf8")));
    if (tools.length) return { tools, source: `${local} (offline fallback; live fetch failed: ${String(lastErr)})` };
  }
  throw new Error(`Could not load the Horizon Pulse catalog from ${url}: ${String(lastErr)}`);
}
