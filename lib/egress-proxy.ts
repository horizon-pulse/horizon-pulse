/**
 * In-process egress proxy for /api/screenshot (Sentinel appsec 2026-10-17, 1i).
 *
 * Chromium resolves sub-request hosts itself, so the per-request
 * assertSafePublicUrl check in lib/screenshot.ts left a DNS-rebinding window
 * for images, scripts and iframes (whatever an internal service returned
 * could be rendered into the PNG). Launching Chromium with
 * --proxy-server=<this proxy> and --proxy-bypass-list=<-loopback> sends EVERY
 * connection (http, https via CONNECT, ws/wss) here; Chromium never resolves
 * or connects to a target host itself. Each upstream socket is opened with
 * guardedNetConnect (lib/net-guard.ts): IP-literal check, every DNS answer
 * checked inside the connect-time lookup, and the connected peer re-checked.
 *
 * Listens on 127.0.0.1 with an ephemeral port, one proxy per render, closed in
 * the render's finally block.
 */
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { guardedNetConnect, isSsrfBlockedError, type GuardOptions } from "@/lib/net-guard";

export type EgressProxy = {
  /** Chromium launch args that force all traffic through this proxy. */
  chromiumArgs: string[];
  port: number;
  /** Connections refused by the guard (blocked address, bad target). */
  blockedCount: () => number;
  close: () => Promise<void>;
};

const HOP_BY_HOP = new Set([
  "proxy-connection",
  "proxy-authorization",
  "proxy-authenticate",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** "host:port" (CONNECT authority, IPv6 in brackets) -> parts; null if malformed. */
export function parseAuthority(a: string): { host: string; port: number } | null {
  const m = /^(\[[0-9a-fA-F:.%a-zA-Z]+\]|[^:\s/\[\]]+):(\d{1,5})$/.exec(a.trim());
  if (!m) return null;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: m[1]!, port };
}

export async function startEgressProxy(opts: GuardOptions & { connectTimeoutMs?: number } = {}): Promise<EgressProxy> {
  let blocked = 0;
  const sockets = new Set<Socket>();
  const track = (s: Socket) => {
    sockets.add(s);
    s.once("close", () => sockets.delete(s));
  };
  const guardOpts = { ...opts, timeoutMs: opts.connectTimeoutMs ?? 10_000 };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Plain-http request in absolute form: "GET http://host/path HTTP/1.1".
    let target: URL;
    try {
      target = new URL(req.url ?? "");
      if (target.protocol !== "http:") throw new Error("scheme");
    } catch {
      blocked += 1;
      res.writeHead(400, { "content-type": "text/plain" }).end("bad proxy request");
      return;
    }
    const port = target.port ? Number(target.port) : 80;
    guardedNetConnect(target.hostname, port, guardOpts).then(
      (upstreamSock) => {
        track(upstreamSock);
        const headers: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (v === undefined || HOP_BY_HOP.has(k.toLowerCase())) continue;
          headers[k] = v;
        }
        headers["connection"] = "close";
        const up = httpRequest({
          method: req.method,
          path: `${target.pathname}${target.search}`,
          headers,
          createConnection: () => upstreamSock,
        });
        up.on("response", (ur) => {
          const out: Record<string, string | string[]> = {};
          for (const [k, v] of Object.entries(ur.headers)) {
            if (v === undefined || HOP_BY_HOP.has(k.toLowerCase())) continue;
            out[k] = v;
          }
          res.writeHead(ur.statusCode ?? 502, out);
          ur.pipe(res);
        });
        up.on("error", () => {
          if (!res.headersSent) res.writeHead(502).end();
          else res.destroy();
        });
        req.pipe(up);
      },
      (err) => {
        if (isSsrfBlockedError(err)) blocked += 1;
        res.writeHead(isSsrfBlockedError(err) ? 403 : 502, { "content-type": "text/plain" }).end("blocked by egress guard");
      },
    );
  });

  // https / wss: "CONNECT host:443 HTTP/1.1" then a raw tunnel.
  server.on("connect", (req: IncomingMessage, clientSock: Socket, head: Buffer) => {
    track(clientSock);
    clientSock.on("error", () => clientSock.destroy());
    const auth = parseAuthority(req.url ?? "");
    if (!auth) {
      blocked += 1;
      clientSock.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    guardedNetConnect(auth.host, auth.port, guardOpts).then(
      (upstreamSock) => {
        track(upstreamSock);
        upstreamSock.on("error", () => clientSock.destroy());
        clientSock.on("close", () => upstreamSock.destroy());
        upstreamSock.on("close", () => clientSock.destroy());
        clientSock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head?.length) upstreamSock.write(head);
        upstreamSock.pipe(clientSock);
        clientSock.pipe(upstreamSock);
      },
      (err) => {
        if (isSsrfBlockedError(err)) blocked += 1;
        clientSock.end(isSsrfBlockedError(err) ? "HTTP/1.1 403 Forbidden\r\n\r\n" : "HTTP/1.1 502 Bad Gateway\r\n\r\n");
      },
    );
  });
  server.on("clientError", (_e, sock) => sock.destroy());

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    chromiumArgs: [`--proxy-server=http://127.0.0.1:${port}`, "--proxy-bypass-list=<-loopback>"],
    blockedCount: () => blocked,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
