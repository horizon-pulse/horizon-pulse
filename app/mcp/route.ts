import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { hasCdpCredentials } from "@/lib/config";
import { buildMcpServer, ensureFacilitatorReady } from "@/lib/mcp-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/** Stateless streamable-HTTP MCP: fresh server + transport per request. */
export async function POST(req: Request): Promise<Response> {
  if (hasCdpCredentials()) await ensureFacilitatorReady();
  const server = buildMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const res = await transport.handleRequest(req);
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  headers.set("Cache-Control", "no-store");
  return new Response(res.body, { status: res.status, headers });
}

export async function GET(): Promise<Response> {
  return new Response(JSON.stringify({ error: "Use POST (MCP streamable HTTP, stateless)." }), {
    status: 405,
    headers: { "content-type": "application/json", Allow: "POST, OPTIONS", ...CORS },
  });
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS });
}
