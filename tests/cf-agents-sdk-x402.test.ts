/**
 * F1 (Odin, from the Mastercard/Cloudflare e2e check): the Cloudflare Agents SDK MCP client
 * (agents 0.29.0, withX402Client) only treats a tool result as payable when it has isError
 * and _meta["x402/error"] with a non-empty accepts array. /mcp now copies the @x402/mcp
 * PaymentRequired (structuredContent) into _meta["x402/error"]; content and structuredContent
 * are unchanged.
 *
 * This drives the REAL agents SDK client (isolated install in tests/cf-agents-sdk, so its MCP
 * SDK 1.32.1 peer never touches the app's pinned 1.31.0) against our real app/mcp/route.ts
 * served on a local HTTP port. No payment is made: the signer throws if asked to sign, the
 * confirmation callback declines, and the facilitator is an offline stub that must see no
 * verify/settle. No network beyond 127.0.0.1, no mainnet.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { installFacilitatorMock } from "./helpers/facilitator-mock";
import { CDP_ENV } from "./helpers/capture";

const ROOT = path.resolve(__dirname, "..");
const HARNESS = path.join(ROOT, "tests", "cf-agents-sdk", "node_modules");
const harness = (p: string) => path.join(HARNESS, p);
// Fresh checkout (Odin Class A condition 1): no harness install -> skip cleanly with a reason, never fail.
const HAVE_HARNESS = fs.existsSync(path.join(HARNESS, "agents", "package.json"));
const SKIP_REASON = "SKIPPED: Cloudflare Agents SDK harness not installed (run `npm ci` in tests/cf-agents-sdk)";
if (!HAVE_HARNESS) console.warn(`[cf-agents-sdk-x402] ${SKIP_REASON}`);

let server: http.Server;
let base = "";
let calls: { op: string }[] = [];

beforeAll(async () => {
  if (!HAVE_HARNESS) return;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("CDP_API_KEY_ID", CDP_ENV.CDP_API_KEY_ID);
  vi.stubEnv("CDP_API_KEY_SECRET", CDP_ENV.CDP_API_KEY_SECRET);
  vi.stubEnv("HP_SOLANA_ENABLED", "");
  calls = installFacilitatorMock();
  const mcp = (await import(path.join(ROOT, "app", "mcp", "route.ts"))) as { POST: (r: Request) => Promise<Response> };
  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const r = await mcp.POST(
      new Request(`https://horizonpulse.dev${req.url}`, {
        method: req.method,
        headers,
        body: req.method === "POST" ? Buffer.concat(chunks) : undefined,
      }),
    );
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server) await new Promise((ok) => server.close(ok));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function cfClient(onAccepts: (a: unknown[]) => void) {
  const { Client } = await import(harness("@modelcontextprotocol/sdk/dist/esm/client/index.js"));
  const { StreamableHTTPClientTransport } = await import(harness("@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js"));
  const { withX402Client } = await import(harness("agents/dist/mcp/client/x402.js"));
  const { toAccount } = await import(harness("viem/_esm/accounts/index.js"));
  const neverSigns = () => {
    throw new Error("test signer must never sign");
  };
  // Address-only signer: any attempt to create a payment throws. No key exists.
  const account = toAccount({
    address: "0x000000000000000000000000000000000000dEaD",
    signMessage: neverSigns,
    signTransaction: neverSigns,
    signTypedData: neverSigns,
  });
  const client = new Client({ name: "cf-agents-sdk-f1-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  return withX402Client(client, {
    account,
    network: "eip155:8453",
    confirmationCallback: async (accepts: unknown[]) => {
      onAccepts(accepts);
      return false; // decline: detection only, never pay
    },
  });
}

describe.skipIf(!HAVE_HARNESS)(HAVE_HARNESS ? "Cloudflare Agents SDK withX402Client detects /mcp payment requirements" : `Cloudflare Agents SDK withX402Client: ${SKIP_REASON}`, () => {
  it("unpaid paid-tool call: SDK sees _meta['x402/error'].accepts and asks to pay (declined, nothing signed or settled)", async () => {
    let seen: any[] | null = null;
    const c = await cfClient((a) => (seen = a as any[]));
    const res = await c.callTool(null, { name: "gas", arguments: {} }); // agents 0.29.0: callTool(confirmationCallback, params)
    expect(seen).not.toBeNull();
    expect(seen!.length).toBeGreaterThan(0);
    expect(seen![0]).toMatchObject({ scheme: "exact", network: "eip155:8453" });
    expect(typeof seen![0].payTo).toBe("string");
    expect(typeof seen![0].amount).toBe("string");
    // The SDK's own decline result proves it took the payment path.
    expect(res).toEqual({ isError: true, content: [{ type: "text", text: "User declined payment" }] });
    expect(calls.filter((x) => x.op === "verify" || x.op === "settle")).toHaveLength(0);
    await c.close();
  });

  it("raw result: _meta['x402/error'] equals structuredContent; content text is the same object", async () => {
    const r = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "gas", arguments: {} } }),
    });
    const { result } = await r.json();
    expect(result.isError).toBe(true);
    expect(result.structuredContent.x402Version).toBe(2);
    expect(result.structuredContent.accepts.length).toBeGreaterThan(0);
    expect(result._meta["x402/error"]).toEqual(result.structuredContent);
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
  });
});

describe("addX402ErrorMeta passthrough", () => {
  it("only touches isError results whose structuredContent is a v2 PaymentRequired with accepts", async () => {
    const { addX402ErrorMeta } = await import(path.join(ROOT, "lib", "mcp-server.ts"));
    const data = { content: [{ type: "text", text: "{}" }], isError: false, structuredContent: { x402Version: 2, accepts: [{}] } };
    expect(addX402ErrorMeta(data)).toBe(data);
    const handlerErr = { content: [{ type: "text", text: "boom" }], isError: true };
    expect(addX402ErrorMeta(handlerErr)).toBe(handlerErr);
    const noAccepts = { content: [], isError: true, structuredContent: { x402Version: 2, accepts: [] } };
    expect(addX402ErrorMeta(noAccepts)).toBe(noAccepts);
    const pr = { x402Version: 2, error: "Payment required", accepts: [{ scheme: "exact" }] };
    const out = addX402ErrorMeta({ content: [{ type: "text", text: JSON.stringify(pr) }], isError: true, structuredContent: pr, _meta: { keep: 1 } });
    expect(out._meta).toEqual({ keep: 1, "x402/error": pr });
    expect(out.structuredContent).toBe(pr);
  });
});
