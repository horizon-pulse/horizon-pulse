/**
 * Connect-time SSRF guard (Sentinel appsec review 2026-10-17, findings 1h/1i/1k).
 *
 * assertSafePublicUrl (lib/fetch-url.ts) checks a URL before we fetch it, but a
 * plain fetch() resolves the hostname a second time, so a DNS server that
 * answers "public" to the check and "127.0.0.1" to the connect (DNS rebinding)
 * could slip past it. This module closes that gap at the socket level:
 *   - guardedLookup: the ONLY resolver our outbound sockets use. It resolves
 *     once, rejects if ANY answer is blocked, and hands the checked address
 *     straight to connect(); there is no second lookup to rebind.
 *   - guardedDispatcher(): one shared undici Agent whose connector uses
 *     guardedLookup, refuses blocked IP-literal hosts (Node skips lookup for
 *     literals), and re-checks socket.remoteAddress after connect (fail closed).
 *   - guardedFetch(): global fetch with that dispatcher. Every caller-supplied
 *     URL fetch (fetch, http, extract, pdf, x402-check, bazaar-check, market,
 *     watch, search) goes through it, on every redirect hop.
 *   - guardedNetConnect(): the same checks for raw TCP (the screenshot egress
 *     proxy in lib/egress-proxy.ts).
 * isBlockedIp classifies on parsed bytes, not string prefixes, so every
 * textual IPv6 form (hex IPv4-mapped, IPv4-compatible, uncompressed) is covered.
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { isIP, connect as netConnect, type Socket } from "node:net";
import { Agent, buildConnector, fetch as undiciFetch } from "undici";

/** Thrown (as fetch's cause) when a connection would reach a blocked address. */
export class SsrfBlockedError extends Error {
  readonly code = "HP_SSRF_BLOCKED";
  constructor(
    readonly host: string,
    readonly address: string | undefined,
  ) {
    super(`Host ${host} resolves to a blocked address${address ? ` (${address})` : ""} (checked at connect time)`);
    this.name = "SsrfBlockedError";
  }
}

/** True when err (or anything on its .cause chain) is a connect-time SSRF block. */
export function isSsrfBlockedError(err: unknown): err is SsrfBlockedError {
  let e: unknown = err;
  for (let i = 0; i < 5 && e; i++) {
    if (e instanceof SsrfBlockedError) return true;
    if (typeof e === "object" && (e as { code?: unknown }).code === "HP_SSRF_BLOCKED") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

export function findSsrfBlockedError(err: unknown): SsrfBlockedError | null {
  let e: unknown = err;
  for (let i = 0; i < 5 && e; i++) {
    if (e instanceof SsrfBlockedError) return e;
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

// ---------------------------------------------------------------------------
// IP classification
// ---------------------------------------------------------------------------

function parseIpv4(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out as [number, number, number, number];
}

/** IPv6 text (any notation, optional %zone, optional trailing dotted IPv4) -> 16 bytes. */
export function parseIpv6(raw: string): number[] | null {
  let s = raw.trim().toLowerCase();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const pct = s.indexOf("%");
  if (pct >= 0) s = s.slice(0, pct);
  if (!s.includes(":")) return null;
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  const last = s.slice(lastColon + 1);
  if (last.includes(".")) {
    const v4 = parseIpv4(last);
    if (!v4) return null;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    s = s.slice(0, lastColon + 1) + "0:0"; // placeholder groups, replaced below
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const toGroups = (h: string): number[] | null => {
    if (h === "") return [];
    const gs = h.split(":");
    const out: number[] = [];
    for (const g of gs) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const left = toGroups(halves[0]!);
  const right = halves.length === 2 ? toGroups(halves[1]!) : [];
  if (!left || !right) return null;
  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - left.length - right.length;
    if (fill < 1) return null;
    groups = [...left, ...new Array<number>(fill).fill(0), ...right];
  } else {
    groups = left;
  }
  if (groups.length !== 8) return null;
  if (tail.length) groups.splice(6, 2, tail[0]!, tail[1]!);
  const bytes: number[] = [];
  for (const g of groups) bytes.push(g >> 8, g & 0xff);
  return bytes;
}

/** IPv4 private / special-use ranges we refuse. */
function isBlockedIpv4Bytes([a, b, c]: readonly number[]): boolean {
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b! >= 16 && b! <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b! >= 64 && b! <= 127) return true; // CGNAT 100.64/10
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay anycast (deprecated)
  if (a! >= 224) return true; // multicast / reserved / broadcast
  return false;
}

function isBlockedIpv6Bytes(b: readonly number[]): boolean {
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  // IPv4-mapped ::ffff:0:0/96 (any notation): judge the embedded IPv4.
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return isBlockedIpv4Bytes(b.slice(12));
  // ::/96: unspecified (::), loopback (::1) and deprecated IPv4-compatible (::a.b.c.d).
  // Always refused: no public host is reached this way.
  if (zero(0, 12)) return true;
  // Only global unicast 2000::/3 is allowed. This alone refuses ::/8 leftovers,
  // 64:ff9b::/96 + 64:ff9b:1::/48 (NAT64), 100::/64 (discard), fc00::/7 (ULA),
  // fe80::/10 (link-local), fec0::/10 (old site-local) and ff00::/8 (multicast).
  if ((b[0]! & 0xe0) !== 0x20) return true;
  // Inside 2000::/3: tunnelling / documentation prefixes that embed or stand in
  // for other addresses.
  if (b[0] === 0x20 && b[1] === 0x02) return true; // 2002::/16 6to4 (embeds IPv4)
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return true; // 2001::/32 Teredo
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // 2001:db8::/32 documentation
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && (b[3]! & 0xf0) === 0x10) return true; // 2001:10::/28 ORCHID
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && (b[3]! & 0xf0) === 0x20) return true; // 2001:20::/28 ORCHIDv2
  if (b[0] === 0x3f && b[1] === 0xff && (b[2]! & 0xf0) === 0x00) return true; // 3fff::/20 documentation
  return false;
}

/**
 * True when we must not connect to ip. Unparseable input is blocked (fail
 * closed). Accepts bracketed IPv6 ("[::1]") and zone ids ("fe80::1%eth0").
 */
export function isBlockedIp(ip: string): boolean {
  if (typeof ip !== "string") return true;
  const s = ip.trim();
  const v4 = parseIpv4(s);
  if (v4) return isBlockedIpv4Bytes(v4);
  const v6 = parseIpv6(s);
  if (v6) return isBlockedIpv6Bytes(v6);
  return true;
}

/** "[::1]" -> "::1"; anything else unchanged. */
export function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

// ---------------------------------------------------------------------------
// Connect-time resolver + connectors
// ---------------------------------------------------------------------------

type Resolver = (
  hostname: string,
  options: { all: true; verbatim: true },
  cb: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

export type GuardOptions = {
  /** DNS resolver (tests). Default node:dns lookup. */
  resolve?: Resolver;
  /** Address policy (tests). Default isBlockedIp. */
  isBlocked?: (ip: string) => boolean;
};

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;
export type GuardedLookup = (hostname: string, options: unknown, cb?: LookupCb) => void;

/** A net/tls `lookup` that resolves once, refuses if ANY answer is blocked, and returns only checked addresses. */
export function makeGuardedLookup(opts: GuardOptions = {}): GuardedLookup {
  const resolve: Resolver = opts.resolve ?? ((h, o, cb) => dnsLookup(h, o, cb));
  const isBlocked = opts.isBlocked ?? isBlockedIp;
  return (hostname, options, maybeCb) => {
    const cb = (typeof options === "function" ? options : maybeCb) as LookupCb;
    const o = (typeof options === "object" && options ? options : {}) as { all?: boolean; family?: number | string };
    resolve(hostname, { all: true, verbatim: true }, (err, addrs) => {
      if (err) return cb(err, o.all ? [] : "", undefined);
      if (!addrs || addrs.length === 0) {
        const e = Object.assign(new Error(`DNS lookup returned no addresses for ${hostname}`), { code: "ENOTFOUND" }) as NodeJS.ErrnoException;
        return cb(e, o.all ? [] : "", undefined);
      }
      const bad = addrs.find((a) => isBlocked(a.address));
      if (bad) return cb(new SsrfBlockedError(hostname, bad.address) as unknown as NodeJS.ErrnoException, o.all ? [] : "", undefined);
      const fam = o.family === 4 || o.family === "IPv4" ? 4 : o.family === 6 || o.family === "IPv6" ? 6 : 0;
      const pool = fam ? addrs.filter((a) => a.family === fam) : addrs;
      if (pool.length === 0) {
        const e = Object.assign(new Error(`No IPv${fam} address for ${hostname}`), { code: "ENOTFOUND" }) as NodeJS.ErrnoException;
        return cb(e, o.all ? [] : "", undefined);
      }
      if (o.all) return cb(null, pool);
      return cb(null, pool[0]!.address, pool[0]!.family);
    });
  };
}

/** Fail closed unless the connected peer address is allowed. */
function peerAllowed(sock: Socket, isBlocked: (ip: string) => boolean): boolean {
  const addr = sock.remoteAddress;
  return typeof addr === "string" && addr.length > 0 && !isBlocked(addr);
}

/** One undici Agent whose every connection is resolved and checked by guardedLookup. */
export function createGuardedAgent(opts: GuardOptions = {}): Agent {
  const isBlocked = opts.isBlocked ?? isBlockedIp;
  const lookup = makeGuardedLookup(opts);
  const base = buildConnector({ lookup } as unknown as buildConnector.BuildOptions);
  const connect: buildConnector.connector = (o, cb) => {
    const host = stripBrackets(o.hostname);
    if (isIP(host) && isBlocked(host)) {
      cb(new SsrfBlockedError(host, host), null);
      return;
    }
    base(o, (err, sock) => {
      if (err || !sock) return cb(err ?? new Error("connect failed"), null);
      if (!peerAllowed(sock as unknown as Socket, isBlocked)) {
        const addr = (sock as unknown as Socket).remoteAddress;
        sock.destroy();
        return cb(new SsrfBlockedError(host, addr), null);
      }
      cb(null, sock);
    });
  };
  return new Agent({ connect });
}

// ---------------------------------------------------------------------------
// Fail-closed guarantee (Odin LOW 10/17, net-guard.ts:272): the guard relies on
// global fetch honouring `dispatcher`. A one-time self-test (per instance, no
// network: the probe dispatcher's connector refuses before any socket) checks
// that the runtime's own fetch uses the dispatcher. If it does not, every
// guardedFetch switches to undici's own fetch, which always uses its dispatcher.
// ---------------------------------------------------------------------------
const NATIVE_FETCH: typeof fetch | undefined = typeof globalThis.fetch === "function" ? globalThis.fetch : undefined;
const SELFTEST_MARK = "HP_GUARD_SELFTEST";

function causeChainHas(err: unknown, mark: string): boolean {
  let e: unknown = err;
  for (let i = 0; i < 8 && e; i++) {
    if (e instanceof Error && e.message.includes(mark)) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** true when `fetchImpl` routes through the given dispatcher (probe connector throws a marker before any socket). */
export async function dispatcherHonored(fetchImpl: typeof fetch | null = NATIVE_FETCH ?? null): Promise<boolean> {
  if (!fetchImpl) return false;
  const probe = new Agent({ connect: (_opts: unknown, cb: (err: Error | null, sock: null) => void) => cb(new Error(SELFTEST_MARK), null) } as never);
  try {
    await fetchImpl("http://hp-guard-selftest.invalid/", { dispatcher: probe, signal: AbortSignal.timeout(3_000) } as RequestInit);
    return false;
  } catch (err) {
    return causeChainHas(err, SELFTEST_MARK);
  } finally {
    probe.close().catch(() => {});
  }
}

let selfTest: Promise<boolean> | null = null;
/** For tests: force the self-test result (null = run it again on next use). */
export function __setGuardSelfTestForTests(v: boolean | null): void {
  selfTest = v === null ? null : Promise.resolve(v);
}
async function fetchForGuard(): Promise<typeof fetch> {
  // Under vitest, global fetch is routinely a stub that ignores dispatchers; tests force the
  // fallback explicitly with __setGuardSelfTestForTests(false). Never set in production.
  if (!selfTest && process.env.VITEST) selfTest = Promise.resolve(true);
  selfTest ??= dispatcherHonored().then((ok) => {
    if (!ok) console.warn("[net-guard] runtime fetch ignored the dispatcher; using undici fetch for guarded requests");
    return ok;
  });
  return (await selfTest) ? globalThis.fetch : (undiciFetch as unknown as typeof fetch);
}

let shared: Agent | null = null;
/** The shared guarded dispatcher (created on first use). */
export function guardedDispatcher(): Agent {
  shared ??= createGuardedAgent();
  return shared;
}

/**
 * fetch() through the guarded dispatcher. Uses whatever globalThis.fetch is at
 * call time (tests stub it) once the self-test shows the runtime honours the
 * dispatcher; otherwise undici's own fetch (fail closed, never unguarded). A connect-time block is rethrown as the
 * SsrfBlockedError itself so callers can map it to host_blocked (not charged).
 */
export async function guardedFetch(input: string | URL, init: RequestInit = {}, dispatcher: Agent = guardedDispatcher()): Promise<Response> {
  try {
    const f = await fetchForGuard();
    return await f(input, { ...init, dispatcher } as RequestInit);
  } catch (err) {
    const blocked = findSsrfBlockedError(err);
    if (blocked) throw blocked;
    throw err;
  }
}

/** Raw TCP connect with the same checks (literal host, every DNS answer, connected peer). */
export function guardedNetConnect(host: string, port: number, opts: GuardOptions & { timeoutMs?: number } = {}): Promise<Socket> {
  const isBlocked = opts.isBlocked ?? isBlockedIp;
  const h = stripBrackets(host);
  return new Promise((resolve, reject) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) return reject(new Error(`bad port ${port}`));
    if (isIP(h) && isBlocked(h)) return reject(new SsrfBlockedError(h, h));
    const sock = netConnect({ host: h, port, lookup: makeGuardedLookup(opts) as never });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`connect to ${h}:${port} timed out`));
    }, opts.timeoutMs ?? 10_000);
    sock.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    sock.once("connect", () => {
      clearTimeout(timer);
      if (!peerAllowed(sock, isBlocked)) {
        const addr = sock.remoteAddress;
        sock.destroy();
        return reject(new SsrfBlockedError(h, addr));
      }
      sock.removeAllListeners("error");
      sock.on("error", () => {}); // callers attach their own handlers; never crash the process
      resolve(sock);
    });
  });
}
