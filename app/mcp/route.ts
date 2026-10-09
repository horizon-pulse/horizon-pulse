import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isFatalStartupInitError } from "@x402/core/server";
import { hasCdpCredentials } from "@/lib/config";
import { buildMcpServer } from "@/lib/mcp-server";
import { getResourceServer } from "@/lib/x402-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/**
 * Shared facilitator sync (lib/x402-server.ts: single-flight, retried, reset
 * on failure, so a failed sync is never cached). If it still fails, a 503 the
 * client can retry, not an unhandled 500. Nothing is verified or settled.
 * Fatal capability/config errors are rethrown, same as the API routes.
 */
function facilitatorUnavailable(): Response {
  return new Response(
    JSON.stringify({ error: "Payment facilitator temporarily unavailable. Retry in a moment." }),
    {
      status: 503,
      headers: { "content-type": "application/json", "Cache-Control": "no-store", "Retry-After": "1", ...CORS },
    },
  );
}

/** Stateless streamable-HTTP MCP: fresh server + transport per request. */
export async function POST(req: Request): Promise<Response> {
  if (hasCdpCredentials()) {
    try {
      await getResourceServer().initialize();
    } catch (error) {
      if (isFatalStartupInitError(error)) throw error;
      console.error(`[mcp] facilitator sync failed, serving 503: ${error}`);
      return facilitatorUnavailable();
    }
  }
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
