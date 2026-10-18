/**
 * Connect-time SSRF guard (Sentinel appsec review 2026-10-17: 1h DNS rebinding,
 * 1i screenshot sub-requests, 1k IPv6 classifier, 1n credential headers on
 * cross-origin redirects). Offline: DNS is stubbed; the only sockets are to a
 * local test server on 127.0.0.1 which the guard must refuse to reach.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, request as httpRequest, type Server } from "node:http";
import { connect as netConnect, type AddressInfo } from "node:net";

// Resolver stubs: dns/promises feeds assertSafePublicUrl (the pre-check);
// node:dns feeds the connect-time lookup. Rebinding = the two disagree.
const dnsState = vi.hoisted(() => ({
  precheck: [{ address: "93.184.216.34", family: 4 }] as { address: string; family: number }[],
  connect: [{ address: "127.0.0.1", family: 4 }] as { address: string; family: number }[],
  connectCalls: 0,
}));
vi.mock("node:dns/promises", async (orig) => {
  const real = await orig<typeof import("node:dns/promises")>();
  const lookup = async () => dnsState.precheck;
  return { ...real, lookup, default: { ...real, lookup } };
});
vi.mock("node:dns", async (orig) => {
  const real = await orig<typeof import("node:dns")>();
  const lookup = (_h: string, _o: unknown, cb: (e: Error | null, a: unknown) => void) => {
    dnsState.connectCalls++;
    cb(null, dnsState.connect);
  };
  return { ...real, lookup, default: { ...real, lookup } };
});

import {
  createGuardedAgent,
  guardedFetch,
  guardedNetConnect,
  isBlockedIp,
  isSsrfBlockedError,
  makeGuardedLookup,
  parseIpv6,
  SsrfBlockedError,
} from "@/lib/net-guard";
import { assertSafePublicUrl, fetchPublicUrl } from "@/lib/fetch-url";
import { proxyPublicHttp, isCredentialHeaderForCrossOrigin } from "@/lib/http-proxy";
import { extractPage } from "@/lib/extract";
import { startEgressProxy, parseAuthority } from "@/lib/egress-proxy";

let server: Server;
let port = 0;
let hits = 0;
const seen: { url: string; headers: Record<string, unknown> }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    hits++;
    seen.push({ url: req.url ?? "", headers: req.headers });
    res.writeHead(200, { "content-type": "text/plain" }).end("INTERNAL-SECRET");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  hits = 0;
  seen.length = 0;
  dnsState.precheck = [{ address: "93.184.216.34", family: 4 }];
  dnsState.connect = [{ address: "127.0.0.1", family: 4 }];
  dnsState.connectCalls = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isBlockedIp: byte-level classifier (1k)", () => {
  const blocked = [
    // IPv4 (existing ranges + 1l additions)
    "0.0.0.0", "10.1.2.3", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "100.64.0.1", "192.0.0.8", "224.0.0.1", "255.255.255.255", "198.18.0.1", "198.19.255.1", "192.0.2.1",
    "198.51.100.7", "203.0.113.9",
    // IPv6 forms Sentinel found unblocked
    "::ffff:7f00:1", "::ffff:a9fe:a9fe", "::7f00:1", "0:0:0:0:0:0:0:1", "64:ff9b::a9fe:a9fe", "64:ff9b::808:808",
    "2002:a9fe:a9fe::", "2002:0808:0808::1", "fec0::1", "feff::1",
    // existing IPv6 + extras
    "::", "::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254", "fd00:ec2::254", "fc00::1", "fe80::1", "fe80::1%eth0",
    "ff02::1", "100::1", "2001:db8::1", "2001::1", "64:ff9b:1::1", "[::1]", "0000:0000:0000:0000:0000:ffff:7f00:0001",
    // garbage fails closed
    "", "not-an-ip", "1.2.3", "1.2.3.256", "::ffff:1.2.3.256", "1::2::3", "12345::1",
  ];
  it.each(blocked)("blocks %s", (ip) => expect(isBlockedIp(ip)).toBe(true));

  const allowed = ["93.184.216.34", "8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "::ffff:8.8.8.8", "::ffff:808:808", "2606:4700:4700::1111", "2a00:1450:4001:82a::200e"];
  it.each(allowed)("allows public %s", (ip) => expect(isBlockedIp(ip)).toBe(false));

  it("parseIpv6 handles compressed, full, dotted-tail and zone forms", () => {
    expect(parseIpv6("::1")).toEqual([...new Array(15).fill(0), 1]);
    expect(parseIpv6("::ffff:1.2.3.4")?.slice(10)).toEqual([0xff, 0xff, 1, 2, 3, 4]);
    expect(parseIpv6("fe80::1%lo0")?.slice(0, 2)).toEqual([0xfe, 0x80]);
    expect(parseIpv6("1:2:3:4:5:6:7:8:9")).toBeNull();
  });
});

describe("assertSafePublicUrl: IPv6 literals classified directly (1j)", () => {
  it.each(["http://[::1]/", "http://[::ffff:7f00:1]/", "http://[64:ff9b::a9fe:a9fe]/", "http://[2002:a9fe:a9fe::]/", "http://[fec0::1]/"])(
    "%s is blocked as a literal (no DNS path)",
    async (u) => {
      const r = await assertSafePublicUrl(u);
      expect(r).toMatchObject({ ok: false, code: "host_blocked", error: expect.stringMatching(/Private, loopback, or link-local IP/) });
    },
  );
});

describe("connect-time lookup", () => {
  const resolveTo = (addrs: { address: string; family: number }[]) => (_h: string, _o: unknown, cb: (e: NodeJS.ErrnoException | null, a: { address: string; family: number }[]) => void) => cb(null, addrs);

  it("refuses when ANY answer is blocked, returns checked answers otherwise", async () => {
    const lk = makeGuardedLookup({ resolve: resolveTo([{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }]) });
    const err = await new Promise<unknown>((r) => lk("mixed.test", { all: true }, (e) => r(e)));
    expect(err).toBeInstanceOf(SsrfBlockedError);
    const ok = makeGuardedLookup({ resolve: resolveTo([{ address: "93.184.216.34", family: 4 }]) });
    const single = await new Promise<unknown[]>((r) => ok("ok.test", {}, (e, a, f) => r([e, a, f])));
    expect(single).toEqual([null, "93.184.216.34", 4]);
    const all = await new Promise<unknown[]>((r) => ok("ok.test", { all: true }, (e, a) => r([e, a])));
    expect(all).toEqual([null, [{ address: "93.184.216.34", family: 4 }]]);
  });
});

describe("DNS rebinding regression (1h): pre-check sees public, connect sees 127.0.0.1", () => {
  it("guardedFetch refuses and the internal server is never reached", async () => {
    await expect(guardedFetch(`http://rebind.test:${port}/`)).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(dnsState.connectCalls).toBeGreaterThan(0);
    expect(hits).toBe(0);
  });

  it("an IP-literal loopback host is refused by the connector even without the pre-check", async () => {
    await expect(guardedFetch(`http://127.0.0.1:${port}/`)).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(hits).toBe(0);
  });

  it("control: global fetch honours the dispatcher (a loopback-permitting guard reaches the server via the guarded lookup)", async () => {
    const agent = createGuardedAgent({ isBlocked: () => false });
    const res = await guardedFetch(`http://rebind.test:${port}/x`, {}, agent);
    expect(await res.text()).toBe("INTERNAL-SECRET");
    expect(hits).toBe(1);
    expect(dnsState.connectCalls).toBeGreaterThan(0);
    await agent.close();
  });

  it("peer re-check: even if the lookup policy lets an answer through, the connected peer is re-checked", async () => {
    // Lookup policy allows everything; only the post-connect peer check uses the real classifier.
    let phase: "lookup" | "peer" = "lookup";
    const agent = createGuardedAgent({
      resolve: (_h, _o, cb) => cb(null, [{ address: "127.0.0.1", family: 4 }]),
      isBlocked: (ip) => {
        if (phase === "lookup") {
          phase = "peer";
          return false;
        }
        return isBlockedIp(ip);
      },
    });
    await expect(guardedFetch(`http://lie.test:${port}/`, {}, agent)).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(phase).toBe("peer");
    await agent.close();
  });

  it("/api/fetch pipeline (fetchPublicUrl) returns host_blocked 400, nothing fetched", async () => {
    const r = await fetchPublicUrl(`http://rebind.test:${port}/`);
    expect(r).toMatchObject({ ok: false, code: "host_blocked", status: 400 });
    expect(hits).toBe(0);
  });

  it("/api/http pipeline (proxyPublicHttp) returns host_blocked 400, nothing fetched", async () => {
    const r = await proxyPublicHttp({ url: `http://rebind.test:${port}/`, method: "GET" });
    expect(r).toMatchObject({ ok: false, code: "host_blocked", status: 400 });
    expect(hits).toBe(0);
  });

  it("/api/extract pipeline returns host_blocked 400, nothing fetched", async () => {
    const r = await extractPage({ url: `http://rebind.test:${port}/` });
    expect(r).toMatchObject({ ok: false, code: "host_blocked", status: 400 });
    expect(hits).toBe(0);
  });

  it("isSsrfBlockedError sees through fetch's TypeError cause chain", () => {
    const wrapped = new TypeError("fetch failed", { cause: new SsrfBlockedError("h", "127.0.0.1") });
    expect(isSsrfBlockedError(wrapped)).toBe(true);
    expect(isSsrfBlockedError(new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") }))).toBe(false);
  });
});

describe("/api/http credential headers on cross-origin redirects (1n)", () => {
  it("classifier: authorization, proxy-authorization, x-api-key and custom x-* are credentials; others are not", () => {
    for (const h of ["Authorization", "proxy-authorization", "X-Api-Key", "x-custom-token"]) expect(isCredentialHeaderForCrossOrigin(h)).toBe(true);
    for (const h of ["accept", "content-type", "user-agent"]) expect(isCredentialHeaderForCrossOrigin(h)).toBe(false);
  });

  it("same-origin hop keeps them; once the chain leaves the origin they are dropped (sticky)", async () => {
    dnsState.precheck = [{ address: "93.184.216.34", family: 4 }];
    const calls: { url: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal("fetch", async (u: string, init: RequestInit) => {
      calls.push({ url: u, headers: { ...(init.headers as Record<string, string>) } });
      const n = calls.length;
      const loc = n === 1 ? "https://a.example/second" : n === 2 ? "https://b.example/third" : n === 3 ? "https://a.example/back" : null;
      return loc ? new Response(null, { status: 302, headers: { location: loc } }) : new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    });
    const r = await proxyPublicHttp({ url: "https://a.example/first", method: "GET", headers: { Authorization: "Bearer k", "x-api-key": "k2", "x-trace": "t", Accept: "text/plain" } });
    expect(r.ok).toBe(true);
    expect(calls.map((c) => c.url)).toEqual(["https://a.example/first", "https://a.example/second", "https://b.example/third", "https://a.example/back"]);
    for (const c of calls.slice(0, 2)) expect(c.headers).toMatchObject({ Authorization: "Bearer k", "x-api-key": "k2", "x-trace": "t" });
    for (const c of calls.slice(2)) {
      expect(Object.keys(c.headers).map((k) => k.toLowerCase())).not.toEqual(expect.arrayContaining(["authorization"]));
      expect(c.headers["x-api-key"]).toBeUndefined();
      expect(c.headers["x-trace"]).toBeUndefined();
      expect(c.headers.Accept).toBe("text/plain");
    }
  });
});

describe("screenshot egress proxy (1i)", () => {
  function connectVia(proxyPort: number, authority: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const s = netConnect(proxyPort, "127.0.0.1", () => s.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
      let buf = "";
      s.on("data", (d) => {
        buf += d.toString();
        if (buf.includes("\r\n\r\n")) {
          s.destroy();
          resolve(buf.split("\r\n")[0]!);
        }
      });
      s.on("error", reject);
      s.on("close", () => resolve(buf.split("\r\n")[0] ?? ""));
    });
  }
  function getVia(proxyPort: number, absUrl: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const r = httpRequest({ host: "127.0.0.1", port: proxyPort, method: "GET", path: absUrl }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      r.on("error", reject);
      r.end();
    });
  }

  it("CONNECT to a host that resolves to 127.0.0.1 (rebinding sub-request) is refused 403", async () => {
    const p = await startEgressProxy();
    try {
      expect(await connectVia(p.port, `rebind.test:${port}`)).toMatch(/^HTTP\/1\.1 403/);
      expect(p.blockedCount()).toBe(1);
    } finally {
      await p.close();
    }
    expect(hits).toBe(0);
  });

  it("CONNECT to loopback / metadata literals is refused 403", async () => {
    const p = await startEgressProxy();
    try {
      expect(await connectVia(p.port, `127.0.0.1:${port}`)).toMatch(/403/);
      expect(await connectVia(p.port, "169.254.169.254:80")).toMatch(/403/);
      expect(await connectVia(p.port, "[::1]:80")).toMatch(/403/);
      expect(await connectVia(p.port, "[::ffff:7f00:1]:80")).toMatch(/403/);
    } finally {
      await p.close();
    }
    expect(hits).toBe(0);
  });

  it("plain-http absolute-form request to an internal target is refused 403", async () => {
    const p = await startEgressProxy();
    try {
      expect(await getVia(p.port, `http://rebind.test:${port}/img.png`)).toBe(403);
      expect(await getVia(p.port, `http://127.0.0.1:${port}/`)).toBe(403);
      expect(await getVia(p.port, `ftp://x.test/`)).toBe(400);
    } finally {
      await p.close();
    }
    expect(hits).toBe(0);
  });

  it("control: with a permissive policy the proxy tunnels and forwards (proves the path works)", async () => {
    const p = await startEgressProxy({ isBlocked: () => false });
    try {
      expect(await connectVia(p.port, `rebind.test:${port}`)).toMatch(/^HTTP\/1\.1 200/);
      expect(await getVia(p.port, `http://rebind.test:${port}/via-proxy`)).toBe(200);
    } finally {
      await p.close();
    }
    expect(seen.map((s) => s.url)).toContain("/via-proxy");
    expect(seen.find((s) => s.url === "/via-proxy")?.headers["proxy-connection"]).toBeUndefined();
  });

  it("chromium args force all traffic (incl. loopback) through the proxy", async () => {
    const p = await startEgressProxy();
    try {
      expect(p.chromiumArgs).toEqual([`--proxy-server=http://127.0.0.1:${p.port}`, "--proxy-bypass-list=<-loopback>"]);
    } finally {
      await p.close();
    }
  });

  it("parseAuthority", () => {
    expect(parseAuthority("example.com:443")).toEqual({ host: "example.com", port: 443 });
    expect(parseAuthority("[::1]:80")).toEqual({ host: "[::1]", port: 80 });
    expect(parseAuthority("example.com")).toBeNull();
    expect(parseAuthority("example.com:0")).toBeNull();
    expect(parseAuthority("a b:80")).toBeNull();
  });

  it("guardedNetConnect refuses rebinding hosts and blocked literals", async () => {
    await expect(guardedNetConnect("rebind.test", port)).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(guardedNetConnect("127.0.0.1", port)).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(hits).toBe(0);
  });
});
