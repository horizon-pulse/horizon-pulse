/**
 * /api/x402-check — audit any public x402 endpoint from an unpaid request.
 *
 * Sends ONE unpaid request (no payment header; POST sends the caller's JSON
 * body if given, else "{}"). If the method was not specified and GET answers
 * 405, it retries once with POST (reported as a check),
 * follows up to 3 redirects with SSRF re-checks at every hop, and reports:
 * status, x402 version, decoded accepts (price, network, asset, payTo),
 * payTo type via eth_getCode (EOA vs contract) on Base / Ethereum, and
 * discovery-extension hints. Never pays, never signs.
 *
 * Unreachable target (DNS/timeout/connection) → 502/504 so the caller is
 * NOT charged. Any HTTP answer from the target, including 5xx, is a billed
 * report (see methodology.billing). Body is streamed and capped at 64KB.
 */
import { assertSafePublicUrl } from "@/lib/fetch-url";

export const CHECK_TIMEOUT_MS = 8_000;
export const CHECK_MAX_REDIRECTS = 3;
const MAX_BODY_BYTES = 64_000;
export const MAX_PROBE_BODY_BYTES = 8_000;

export const X402_CHECK_METHODOLOGY = {
  request:
    `One unpaid request with the given method (GET default; POST sends the caller's JSON body, up to ${MAX_PROBE_BODY_BYTES / 1000}KB, or '{}' if none). A body implies POST. Redirects follow browser rules: 301/302/303 turn a POST into a GET without the body; 307/308 re-send the POST and body to the new target, which is SSRF-checked like every hop. If no method was given and GET returns 405, one retry with POST is made and reported (skipped when a redirect already turned a POST into a GET). No payment header is ever sent; nothing is signed or paid.`,
  parsing:
    "x402 v2: base64 JSON in the PAYMENT-REQUIRED header (falls back to JSON body). x402 v1: JSON body with x402Version 1 and accepts[].maxAmountRequired.",
  payToType:
    "eth_getCode on Base (eip155:8453 / 'base') and Ethereum (eip155:1 / 'ethereum') via public RPCs. Empty code = EOA (a single private key controls funds). Other networks: not checked.",
  limits: `SSRF-safe (private/local targets blocked at every redirect hop), ${CHECK_MAX_REDIRECTS} redirects, ${CHECK_TIMEOUT_MS / 1000}s timeout, ${MAX_BODY_BYTES / 1000}KB body cap.`,
  billing:
    "Any HTTP answer from the target is a completed report and is billed, including 4xx/5xx answers (e.g. 'returned HTTP 500, not 402' is the finding). Not billed: missing/bad url, bad method, invalid or oversized body, blocked private/local host, DNS failure, connection failure, timeout, or too many redirects; those return 400/502/504 and settlement is skipped.",
  notAdvice:
    "Checks describe the challenge as served. Indexing hints are based on Horizon Pulse's own experience with CDP discovery, not a CDP guarantee.",
} as const;

type Level = "pass" | "warn" | "fail" | "info";
export type Check = { id: string; level: Level; message: string };

export type NormalizedAccept = {
  scheme: string | null;
  network: string | null;
  asset: string | null;
  assetLabel: string | null;
  amountAtomic: string | null;
  amountUsd: string | null;
  payTo: string | null;
  payToType: "eoa" | "contract" | "unknown" | null;
  maxTimeoutSeconds: number | null;
};

export type X402CheckResult = {
  ok: true;
  target: string;
  finalUrl: string;
  method: "GET" | "POST";
  httpStatus: number;
  isX402: boolean;
  x402Version: number | null;
  challengeSource: "header" | "body" | null;
  resource: { url: string | null; description: string | null; mimeType: string | null } | null;
  accepts: NormalizedAccept[];
  discovery: { present: boolean; method: string | null; hasInputSchema: boolean; hasOutputExample: boolean };
  checks: Check[];
  summary: { pass: number; warn: number; fail: number };
  elapsedMs: number;
  methodology: typeof X402_CHECK_METHODOLOGY;
};

export type X402CheckError = { ok: false; error: string; code: string; status: number };

/** Known USDC deployments (6 decimals). Lowercase keys. */
const KNOWN_ASSETS: Record<string, { label: string; decimals: number; usd: boolean }> = {
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { label: "USDC (Base)", decimals: 6, usd: true },
  "0x036cbd53842c5426634e7929541ec2318f3dcf7e": { label: "USDC (Base Sepolia)", decimals: 6, usd: true },
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { label: "USDC (Ethereum)", decimals: 6, usd: true },
  // Solana SPL mints: base58 is case-sensitive, so these keys keep their exact case (looked up before the lowercase EVM keys).
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { label: "USDC (Solana)", decimals: 6, usd: true },
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU": { label: "USDC (Solana devnet)", decimals: 6, usd: true },
};

/** Exact key first (Solana mints, case-sensitive), then lowercase (EVM addresses, checksum casing). */
export function knownAsset(asset: string): { label: string; decimals: number; usd: boolean } | undefined {
  return Object.prototype.hasOwnProperty.call(KNOWN_ASSETS, asset)
    ? KNOWN_ASSETS[asset]
    : /^0x[0-9a-fA-F]{40}$/.test(asset)
      ? KNOWN_ASSETS[asset.toLowerCase()]
      : undefined;
}

/**
 * Hint for an unpaid probe answered 400/422: the endpoint checked its inputs
 * before payment. Shared with /api/bazaar-check (lib/bazaar-check.ts not_402).
 */
export function inputsBeforePaymentHint(method: string): string {
  return `The endpoint may validate the ${method === "POST" ? "body" : "query"} before returning 402`;
}

const RPCS: Record<string, string[]> = {
  base: [process.env.BASE_RPC_URL ?? "", "https://base.drpc.org", "https://mainnet.base.org"].filter(Boolean),
  ethereum: [process.env.ETH_RPC_URL ?? "", "https://eth.drpc.org", "https://ethereum-rpc.publicnode.com"].filter(Boolean),
};

function chainKey(network: string | null): "base" | "ethereum" | null {
  if (!network) return null;
  const n = network.toLowerCase();
  if (n === "eip155:8453" || n === "base" || n === "base-mainnet") return "base";
  if (n === "eip155:1" || n === "ethereum" || n === "mainnet") return "ethereum";
  return null;
}

async function getCodeType(address: string, chain: "base" | "ethereum"): Promise<"eoa" | "contract" | "unknown"> {
  for (const rpc of RPCS[chain]!) {
    try {
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [address, "latest"] }),
        signal: AbortSignal.timeout(5_000),
      });
      const j = (await res.json()) as { result?: string };
      if (typeof j.result === "string") return j.result === "0x" || j.result === "0x0" ? "eoa" : "contract";
    } catch {
      /* try next */
    }
  }
  return "unknown";
}

function formatUnits(atomic: string, decimals: number): string | null {
  if (!/^\d+$/.test(atomic)) return null;
  const s = atomic.padStart(decimals + 1, "0");
  const whole = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/** Stream the body and stop after `cap` bytes (cancels the rest). Never buffers the full response. */
async function readCapped(res: Response, cap: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < cap) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const take = value.subarray(0, cap - total);
      chunks.push(take);
      total += take.length;
    }
  } catch {
    /* body unreadable or timed out; header may still carry the challenge */
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString("utf8");
}

function decodeHeader(v: string): unknown {
  try {
    return JSON.parse(Buffer.from(v, "base64").toString("utf8"));
  } catch {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length ? v : null);
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

export async function checkX402Endpoint(input: {
  url?: string;
  method?: string;
  body?: string;
}): Promise<X402CheckResult | X402CheckError> {
  const started = Date.now();
  const raw = input.url?.trim();
  if (!raw) return { ok: false, error: "Query param url is required (absolute http/https URL)", code: "missing_url", status: 400 };
  const rawBody = input.body && input.body.trim() !== "" ? input.body : undefined;
  if (rawBody !== undefined) {
    if (Buffer.byteLength(rawBody, "utf8") > MAX_PROBE_BODY_BYTES)
      return { ok: false, error: `body exceeds ${MAX_PROBE_BODY_BYTES} bytes`, code: "body_too_large", status: 400 };
    try {
      JSON.parse(rawBody);
    } catch {
      return { ok: false, error: "body must be valid JSON", code: "bad_body", status: 400 };
    }
  }
  const explicitMethod = input.method !== undefined && input.method.trim() !== "";
  const m = explicitMethod ? input.method!.trim().toUpperCase() : rawBody !== undefined ? "POST" : "GET";
  if (m !== "GET" && m !== "POST") return { ok: false, error: "method must be GET or POST", code: "bad_method", status: 400 };
  if (m === "GET" && rawBody !== undefined)
    return { ok: false, error: "body is only sent with method POST", code: "bad_method", status: 400 };
  let method = m as "GET" | "POST";
  let retriedFrom405 = false;
  let redirectDowngrade = false;

  let current = raw;
  let redirects = 0;
  const deadline = started + CHECK_TIMEOUT_MS;
  let res: Response | null = null;
  let finalUrl = raw;

  probe: while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { ok: false, error: `Target timed out after ${CHECK_TIMEOUT_MS}ms`, code: "timeout", status: 504 };
    const checked = await assertSafePublicUrl(current);
    if ("ok" in checked && checked.ok === false) return checked;
    const { url } = checked as { url: URL };
    try {
      res = await fetch(url.toString(), {
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(remaining),
        headers: {
          Accept: "application/json, */*;q=0.5",
          "User-Agent": "HorizonPulseX402Check/1.0 (+https://horizonpulse.dev)",
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
        },
        ...(method === "POST" ? { body: (redirectDowngrade ? undefined : rawBody) ?? "{}" } : {}),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "TimeoutError" || name === "AbortError")
        return { ok: false, error: `Target timed out after ${CHECK_TIMEOUT_MS}ms`, code: "timeout", status: 504 };
      return { ok: false, error: err instanceof Error ? err.message : "connection failed", code: "unreachable", status: 502 };
    }
    finalUrl = url.toString();
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      redirects += 1;
      if (redirects > CHECK_MAX_REDIRECTS)
        return { ok: false, error: `Too many redirects (max ${CHECK_MAX_REDIRECTS})`, code: "redirects", status: 502 };
      current = new URL(res.headers.get("location")!, url).toString();
      if (method === "POST" && (res.status === 301 || res.status === 302 || res.status === 303)) {
        method = "GET";
        redirectDowngrade = true;
      }
      continue;
    }
    if (res.status === 405 && method === "GET" && !explicitMethod && !retriedFrom405 && !redirectDowngrade) {
      await res.body?.cancel().catch(() => {});
      retriedFrom405 = true;
      method = "POST";
      continue probe;
    }
    break;
  }

  const checks: Check[] = [];
  const status = res.status;
  let bodyText = "";
  bodyText = await readCapped(res, MAX_BODY_BYTES);

  if (!finalUrl.startsWith("https://")) checks.push({ id: "https", level: "warn", message: "Endpoint is plain http; agents and wallets should see https." });
  if (retriedFrom405)
    checks.push({ id: "method_retry", level: "info", message: "GET returned 405, so the probe was retried once with POST. Pass method explicitly to skip the retry." });
  if (redirectDowngrade)
    checks.push({ id: "redirect_method", level: "warn", message: "A 301/302/303 redirect turned the POST probe into a GET (browser rules). Paid POST clients may hit the same downgrade; list the final URL or use 307/308." });
  if (rawBody !== undefined)
    checks.push({ id: "probe_body", level: "info", message: redirectDowngrade ? "Probe sent your JSON body with POST on the first hop only; the 301/302/303 redirect dropped it (browser rules)." : "Probe sent your JSON body with POST." });
  if (redirects > 0) checks.push({ id: "redirects", level: "info", message: `Followed ${redirects} redirect(s) to ${finalUrl}. Some clients do not follow redirects on paid retries; list the final URL.` });

  let parsed: Record<string, unknown> | null = null;
  let source: "header" | "body" | null = null;
  const hdr = res.headers.get("payment-required");
  if (hdr) {
    parsed = obj(decodeHeader(hdr));
    if (parsed) source = "header";
    else checks.push({ id: "header_decode", level: "fail", message: "PAYMENT-REQUIRED header present but not decodable as base64 JSON." });
  }
  if (!parsed) {
    try {
      const b = obj(JSON.parse(bodyText));
      if (b && ("x402Version" in b || "accepts" in b)) {
        parsed = b;
        source = "body";
      }
    } catch {
      /* not JSON */
    }
  }

  if (status !== 402) {
    checks.push({
      id: "status_402",
      level: "fail",
      message: `Unpaid ${method} returned HTTP ${status}, not 402. x402 clients only start payment on a 402.${status === 405 ? " Try the other method." : ""}${method === "POST" && rawBody === undefined && (status === 400 || status === 422) ? ` ${inputsBeforePaymentHint("POST")}; pass a representative JSON body.` : ""}`,
    });
  } else {
    checks.push({ id: "status_402", level: "pass", message: "Unpaid request returned HTTP 402." });
  }

  const version = parsed && typeof parsed.x402Version === "number" ? parsed.x402Version : null;
  const acceptsRaw = parsed && Array.isArray(parsed.accepts) ? (parsed.accepts as unknown[]) : [];

  if (!parsed) {
    if (status === 402) checks.push({ id: "challenge", level: "fail", message: "402 without a parseable x402 challenge (no PAYMENT-REQUIRED header and no x402 JSON body)." });
  } else {
    checks.push({ id: "challenge", level: "pass", message: `x402 challenge parsed from ${source === "header" ? "PAYMENT-REQUIRED header" : "JSON body"}.` });
    if (version === 2) {
      checks.push({ id: "version", level: "pass", message: "x402 v2." });
      if (source === "body") checks.push({ id: "v2_header", level: "warn", message: "v2 challenge found only in the body; v2 clients read the PAYMENT-REQUIRED header." });
    } else if (version === 1) {
      checks.push({ id: "version", level: "warn", message: "x402 v1 (legacy format: network names like 'base', maxAmountRequired). Current x402 SDKs default to v2." });
    } else {
      checks.push({ id: "version", level: "fail", message: "Missing or unknown x402Version." });
    }
    if (!acceptsRaw.length) checks.push({ id: "accepts", level: "fail", message: "accepts[] is empty or missing; there is nothing a client can pay." });
  }

  const accepts: NormalizedAccept[] = [];
  let discovery = { present: false, method: null as string | null, hasInputSchema: false, hasOutputExample: false };

  for (const a0 of acceptsRaw.slice(0, 5)) {
    const a = obj(a0) ?? {};
    const network = str(a.network);
    const asset = str(a.asset);
    const amountAtomic = str(a.amount) ?? str(a.maxAmountRequired);
    const payTo = str(a.payTo);
    const known = asset ? knownAsset(asset) : undefined;
    const amt = amountAtomic && known ? formatUnits(amountAtomic, known.decimals) : null;
    let payToType: NormalizedAccept["payToType"] = null;
    const ck = chainKey(network);
    if (payTo && /^0x[a-fA-F0-9]{40}$/.test(payTo) && ck) payToType = await getCodeType(payTo, ck);
    accepts.push({
      scheme: str(a.scheme),
      network,
      asset,
      assetLabel: known?.label ?? null,
      amountAtomic,
      amountUsd: amt && known?.usd ? `$${amt}` : null,
      payTo,
      payToType,
      maxTimeoutSeconds: typeof a.maxTimeoutSeconds === "number" ? a.maxTimeoutSeconds : null,
    });
    // v1 carried discovery metadata under accepts[].outputSchema
    const os = obj(a.outputSchema);
    if (os && !discovery.present) {
      const inp = obj(os.input);
      discovery = { present: true, method: str(inp?.method), hasInputSchema: Boolean(inp), hasOutputExample: Boolean(os.output) };
    }
  }

  accepts.forEach((a, i) => {
    const tag = accepts.length > 1 ? ` (accepts[${i}])` : "";
    if (version === 2 && a.network && !/^[a-z0-9-]+:[A-Za-z0-9-]+$/.test(a.network))
      checks.push({ id: "network_caip2", level: "warn", message: `network '${a.network}' is not CAIP-2 (e.g. eip155:8453)${tag}.` });
    if (!a.payTo || !/^0x[a-fA-F0-9]{40}$/.test(a.payTo)) {
      if (chainKey(a.network)) checks.push({ id: "payto", level: "fail", message: `payTo missing or not an EVM address${tag}.` });
    } else if (a.payToType === "eoa") {
      checks.push({ id: "payto_type", level: "info", message: `payTo ${a.payTo} is an EOA: one private key controls every payment. Keep that key backed up; if it is lost, funds sent there are unrecoverable${tag}.` });
    } else if (a.payToType === "contract") {
      checks.push({ id: "payto_type", level: "info", message: `payTo ${a.payTo} is a contract (e.g. a Safe or smart wallet)${tag}.` });
    }
    if (!a.assetLabel && a.asset) checks.push({ id: "asset", level: "info", message: `Asset ${a.asset} is not a USDC contract we recognize; price shown in atomic units only${tag}.` });
    if (!a.amountAtomic || !/^\d+$/.test(a.amountAtomic)) checks.push({ id: "amount", level: "fail", message: `Price (amount / maxAmountRequired) missing or not an integer string${tag}.` });
  });

  // v2 discovery: top-level extensions.bazaar
  const ext = parsed ? obj(parsed.extensions) : null;
  const bz = ext ? obj(ext.bazaar) : null;
  if (bz) {
    const info = obj(bz.info) ?? bz;
    const inp = obj(info.input);
    discovery = {
      present: true,
      method: str(inp?.method),
      hasInputSchema: Boolean(obj(bz.schema) ?? inp),
      hasOutputExample: Boolean(obj(info.output)),
    };
  }
  const resourceObj = parsed ? obj(parsed.resource) : null;
  const resource = parsed
    ? {
        url: str(resourceObj?.url) ?? str(obj(acceptsRaw[0])?.resource),
        description: str(resourceObj?.description) ?? str(obj(acceptsRaw[0])?.description),
        mimeType: str(resourceObj?.mimeType) ?? str(obj(acceptsRaw[0])?.mimeType),
      }
    : null;

  if (parsed) {
    if (!discovery.present) {
      checks.push({ id: "discovery", level: "warn", message: "No discovery metadata (v2 extensions.bazaar / v1 outputSchema). Indexes such as CDP Bazaar use it to describe inputs and outputs to agents." });
    } else if (!discovery.method) {
      checks.push({ id: "discovery_method", level: "warn", message: "Discovery metadata has no explicit HTTP method. In our experience, routes appeared in CDP merchant discovery only after declaring the method and completing a CDP-facilitated paid settle." });
    } else {
      checks.push({ id: "discovery", level: "pass", message: `Discovery metadata present (method ${discovery.method}).` });
    }
    if (!resource?.description) checks.push({ id: "description", level: "warn", message: "No resource description; directories and agents show this to decide whether to pay." });
  }

  const summary = { pass: 0, warn: 0, fail: 0 };
  for (const c of checks) if (c.level !== "info") summary[c.level] += 1;

  return {
    ok: true,
    target: raw,
    finalUrl,
    method,
    httpStatus: status,
    isX402: status === 402 && Boolean(parsed) && acceptsRaw.length > 0,
    x402Version: version,
    challengeSource: source,
    resource,
    accepts,
    discovery,
    checks,
    summary,
    elapsedMs: Date.now() - started,
    methodology: X402_CHECK_METHODOLOGY,
  };
}
