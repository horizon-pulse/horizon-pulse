/**
 * The ONE caller-IP helper (Odin 9:12 AM ET 10/18): free tier (lib/free-tier.ts: counter,
 * known-payer guard, advert lookup), the /mcp caller (lib/mcp-server.ts: per-IP budgets on
 * internal calls + known-payer marking on settled paid tools) and the money-market-rates
 * per-IP upstream budget all read the caller IP here and nowhere else.
 *
 * Source = the platform-provided request IP, read exactly the way Vercel's own
 * `ipAddress()` from @vercel/functions does it, without taking the dependency:
 *   @vercel/functions 3.10.1 headers.js:
 *     const IP_HEADER_NAME = "x-real-ip";
 *     function ipAddress(input) {
 *       const headers = "headers" in input ? input.headers : input;
 *       return getHeader(headers, IP_HEADER_NAME);   // headers.get(key) ?? undefined
 *     }
 *   https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package
 *     ipAddress: "Returns the IP address of the request from the headers."
 *   https://vercel.com/docs/headers/request-headers
 *     x-real-ip: "This header is identical to the `x-forwarded-for` header."
 *     x-forwarded-for: "The public IP address of the client that made the request. ... we
 *     currently overwrite the `X-Forwarded-For` header and do not forward external IPs. This
 *     restriction is in place to prevent IP spoofing."
 * (The package itself would add @vercel/oidc and 18 more transitive packages, incl. execa,
 * for this one header read; tests/caller-ip.test.ts pins the header name and lookup shape.)
 *
 * Stricter than ipAddress() on purpose:
 *   - x-forwarded-for and x-vercel-forwarded-for are NEVER read (no fallback to a list a
 *     client or an upstream proxy can extend).
 *   - A comma list in x-real-ip (never sent by the platform: one address) -> no IP.
 *   - Anything that is not an IPv4/IPv6 address -> no IP.
 * No IP -> callers treat the request as unidentified: the free tier serves today's 402
 * byte-identical to mode off (no free call, no advert, no store call); money-market-rates
 * uses its shared (no-IP) bucket; /mcp forwards nothing and marks nothing.
 */
import { isIP } from "node:net";

/** The header Vercel's ipAddress() reads (@vercel/functions IP_HEADER_NAME). */
export const CALLER_IP_HEADER = "x-real-ip";

type HeaderSource = Request | Headers;

/** ipAddress() semantics, then validated: the raw single platform IP, or undefined. */
export function platformIp(input: HeaderSource): string | undefined {
  const headers = "headers" in input ? input.headers : input;
  const v = headers.get(CALLER_IP_HEADER)?.trim();
  if (!v || v.includes(",")) return undefined;
  return normalizeIp(v) === null ? undefined : v;
}

/** Canonical caller key (see normalizeIp) from the platform IP, or null. */
export function callerIp(input: HeaderSource): string | null {
  const raw = platformIp(input);
  return raw === undefined ? null : normalizeIp(raw);
}

/**
 * Canonical form of one IP: lowercased, brackets/ports/zone ids dropped, IPv4-mapped IPv6
 * folded to IPv4, IPv6 truncated to its /64 (one end-user allocation). null if unusable.
 */
export function normalizeIp(value: string): string | null {
  let ip = value.trim().toLowerCase();
  if (!ip) return null;
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);
  if (bracket) ip = bracket[1];
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(":"));
  ip = ip.replace(/%.*$/, "");
  const mapped = /^(?:0{0,4}:){0,5}(?:0{0,4}:)?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip) ?? /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (mapped) ip = mapped[1];
  const kind = isIP(ip);
  if (kind === 4) return ip.split(".").map((o) => String(Number(o))).join(".");
  if (kind === 6) return ipv6Prefix64(ip);
  return null;
}

function ipv6Prefix64(ip: string): string | null {
  let parts: string[];
  if (ip.includes("::")) {
    const [a, b] = ip.split("::");
    const left = a ? a.split(":") : [];
    const right = b ? b.split(":") : [];
    if (right.length && right[right.length - 1].includes(".")) return null; // embedded IPv4 other than ::ffff: is not a client form we key
    parts = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  } else parts = ip.split(":");
  if (parts.length !== 8 || parts.some((h) => !/^[0-9a-f]{1,4}$/.test(h))) return null;
  const hex = parts.map((h) => parseInt(h, 16).toString(16));
  if (hex.slice(0, 4).every((h) => h === "0")) {
    // Not a routed end-user /64: hex-form IPv4-mapped -> IPv4, else the full address.
    if (hex.slice(4, 6).join(":") === "0:ffff") {
      const v = (parseInt(hex[6], 16) << 16) + parseInt(hex[7], 16);
      return [v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join(".");
    }
    return hex.join(":");
  }
  return `${hex.slice(0, 4).join(":")}::/64`;
}
