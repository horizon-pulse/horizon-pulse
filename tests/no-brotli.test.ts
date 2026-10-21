import { describe, it, expect, vi, beforeEach } from "vitest";

// TEMP Brotli mitigation tests; remove with lib/no-brotli.ts once node_patched is yes.
const calls: { url: string; headers: Record<string, string> }[] = [];
let nextResponse: () => Response;
let cancelled = 0;

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
  default: { lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) },
}));

vi.mock("@/lib/net-guard", async (orig) => {
  const real = await orig<typeof import("@/lib/net-guard")>();
  return {
    ...real,
    guardedFetch: vi.fn(async (url: string, init: RequestInit) => {
      const h: Record<string, string> = {};
      new Headers(init.headers as HeadersInit).forEach((v, k) => (h[k] = v));
      calls.push({ url: String(url), headers: h });
      return nextResponse();
    }),
  };
});

import { isBrotliEncoded, SAFE_ACCEPT_ENCODING } from "@/lib/no-brotli";
import { fetchPublicUrl } from "@/lib/fetch-url";
import { proxyPublicHttp } from "@/lib/http-proxy";
import { fetchHtmlForExtract } from "@/lib/extract";

function brResponse(): Response {
  const body = new ReadableStream({
    pull(c) { c.enqueue(new Uint8Array([0xce, 0xb2, 0xcf])); },
    cancel() { cancelled += 1; },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/html", "content-encoding": "br" } });
}
function okResponse(): Response {
  return new Response("<html><body><p>hi</p></body></html>", { status: 200, headers: { "content-type": "text/html" } });
}

beforeEach(() => { calls.length = 0; cancelled = 0; });

describe("isBrotliEncoded", () => {
  it("detects br in single and stacked encodings, case-insensitive", () => {
    expect(isBrotliEncoded(new Response("", { headers: { "content-encoding": "br" } }))).toBe(true);
    expect(isBrotliEncoded(new Response("", { headers: { "content-encoding": "gzip, BR" } }))).toBe(true);
    expect(isBrotliEncoded(new Response("", { headers: { "content-encoding": "gzip" } }))).toBe(false);
    expect(isBrotliEncoded(new Response(""))).toBe(false);
  });
  it("never advertises br", () => {
    expect(SAFE_ACCEPT_ENCODING).not.toMatch(/br/i);
  });
});

const URL_ = "https://93.184.216.34/page";

describe.each([
  ["/api/fetch", () => fetchPublicUrl(URL_)],
  ["/api/http", () => proxyPublicHttp({ url: URL_, method: "GET", headers: { "Accept-Encoding": "br" } } as never)],
  ["/api/extract", () => fetchHtmlForExtract(URL_ as never)],
])("%s Brotli mitigation", (_name, run) => {
  it("sends Accept-Encoding without br", async () => {
    nextResponse = okResponse;
    await run();
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.headers["accept-encoding"]).toBe(SAFE_ACCEPT_ENCODING);
      expect(c.headers["accept-encoding"]).not.toMatch(/br/i);
    }
  });
  it("refuses a br upstream reply with a no-charge 502, without decoding", async () => {
    nextResponse = brResponse;
    const r = (await run()) as { ok: boolean; code?: string; status?: number; error?: string };
    expect(r.ok).toBe(false);
    expect(r.code).toBe("upstream_encoding");
    expect(r.status).toBe(502); // >=400 => x402 does not settle
    expect(r.error).toMatch(/no_charge/);
    expect(cancelled).toBe(1);
  });
});
