import { describe, it, expect, vi, afterAll, beforeAll, afterEach } from "vitest";
import http from "node:http";
import zlib from "node:zlib";
import type { AddressInfo } from "node:net";
import { createGuardedAgent, guardedFetch, __setGuardSelfTestForTests } from "@/lib/net-guard";
import { EncodingRefusedError, SAFE_ACCEPT_ENCODING } from "@/lib/no-brotli";

// TEMP Brotli mitigation; remove once node_patched is yes.
// Hostile server sends Content-Encoding br even though we never ask for it.
let server: http.Server;
let base = "";
const seen: string[] = [];
let bodyWritten = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push(String(req.headers["accept-encoding"] ?? ""));
    const path = req.url ?? "/";
    if (path === "/br") {
      const payload = zlib.brotliCompressSync(Buffer.from("x".repeat(1 << 16)));
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "br" });
      bodyWritten += 1;
      res.end(payload);
    } else if (path === "/zstd") {
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "zstd" });
      res.end("garbage");
    } else if (path === "/stacked") {
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip, br" });
      res.end("garbage");
    } else {
      const gz = zlib.gzipSync(Buffer.from("<p>ok</p>"));
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
      res.end(gz);
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
afterEach(() => vi.restoreAllMocks());

const agent = () => createGuardedAgent({ isBlocked: () => false });

describe("control: spies observe fetch's decoder", () => {
  it("unguarded undici fetch DOES invoke zlib brotli on /br (proves the spy works)", async () => {
    const { fetch: rawFetch } = await import("undici");
    const spy = vi.spyOn(zlib, "createBrotliDecompress");
    const res = await rawFetch(`${base}/br`);
    await res.text();
    expect(spy).toHaveBeenCalled();
  });
});

describe("control (Sentinel LOW-1): built-in globalThis.fetch is observable", () => {
  it("unguarded globalThis.fetch DOES call zlib.createBrotliDecompress on /br", async () => {
    const spy = vi.spyOn(zlib, "createBrotliDecompress");
    const res = await globalThis.fetch(`${base}/br`);
    await res.text();
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

describe("vendorFetch (Sentinel LOW-2)", () => {
  it("never advertises br, even if the caller asks for it", async () => {
    const { vendorFetch } = await import("@/lib/no-brotli");
    seen.length = 0;
    const res = await vendorFetch(`${base}/ok`, { headers: { "Accept-Encoding": "br" } });
    expect(await res.text()).toBe("<p>ok</p>");
    expect(seen.at(-1)).toBe(SAFE_ACCEPT_ENCODING);
  });
});

describe.each([
  ["global fetch", true],
  ["undici fetch fallback", false],
])("guardedFetch vs hostile br server (%s)", (_n, selfTestOk) => {
  beforeAll(() => __setGuardSelfTestForTests(selfTestOk));
  afterAll(() => __setGuardSelfTestForTests(null));

  it.each(["/br", "/zstd", "/stacked"])("refuses %s before any decode; zlib brotli never invoked", async (p) => {
    const spyStream = vi.spyOn(zlib, "createBrotliDecompress");
    const spySync = vi.spyOn(zlib, "brotliDecompressSync");
    const spyAsync = vi.spyOn(zlib, "brotliDecompress");
    let caught: unknown;
    try {
      const res = await guardedFetch(`${base}${p}`, { redirect: "manual" }, agent());
      await res.text();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EncodingRefusedError);
    expect(String((caught as Error).message)).toMatch(/no_charge/);
    expect(spyStream).not.toHaveBeenCalled();
    expect(spySync).not.toHaveBeenCalled();
    expect(spyAsync).not.toHaveBeenCalled();
  });

  it("still decodes gzip and never advertises br", async () => {
    seen.length = 0;
    const res = await guardedFetch(`${base}/ok`, { redirect: "manual", headers: { "Accept-Encoding": "br" } }, agent());
    expect(await res.text()).toBe("<p>ok</p>");
    expect(seen.at(-1)).toBe(SAFE_ACCEPT_ENCODING);
  });
});
