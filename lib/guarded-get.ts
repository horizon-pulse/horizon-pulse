/**
 * Raw guarded GET for the dark routes (audit, injection scan). Same SSRF stack
 * as /api/fetch: assertSafePublicUrl on every hop (scheme, userinfo, local
 * names, every DNS answer) + guardedFetch (connect-time IP check, no DNS
 * rebinding; lib/net-guard.ts). Redirects are followed manually and
 * re-checked. Returns the raw body (capped) so callers can inspect HTML
 * comments, hidden text and headers. FLAG FOR SENTINEL: new caller of the guard.
 *
 * Opt-out (Odin 11:07 PM ET 10/17): the web-checks opt-out list is checked on
 * EVERY hop, the first URL and each redirect target, BEFORE the DNS check and
 * before any request to that host. An opted-out hop returns code "opted_out"
 * and nothing more is requested (callers answer 403).
 */
import { CHECK_USER_AGENT, isOptedOut } from "./dark-checks-shared";
import { assertSafePublicUrl } from "./fetch-url";
import { guardedFetch, isSsrfBlockedError } from "./net-guard";

export type GuardedGetOk = {
  ok: true;
  status: number;
  headers: Headers;
  body: string;
  bytes: number;
  truncated: boolean;
  finalUrl: string;
  hops: { url: string; status: number }[];
};
export type GuardedGetErr = { ok: false; code: "bad_url" | "host_blocked" | "timeout" | "upstream" | "redirects" | "opted_out"; error: string };
export type GuardedGetOpts = {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  followRedirects?: boolean;
  headers?: Record<string, string>;
  /** Opt-out predicate applied to every hop's host. Defaults to the web-checks list (OPT_OUT_DOMAINS + HP_WEB_CHECKS_OPTOUT). */
  optedOut?: (host: string) => boolean;
};
export type GuardedGetDeps = { safeCheck: typeof assertSafePublicUrl; fetch: typeof guardedFetch };

export function guardedGet(raw: string, opts: GuardedGetOpts = {}): Promise<GuardedGetOk | GuardedGetErr> {
  return guardedGetWith({ safeCheck: assertSafePublicUrl, fetch: guardedFetch }, raw, opts);
}

/** Same as guardedGet with the URL check and fetch injected (tests). */
export async function guardedGetWith(deps: GuardedGetDeps, raw: string, opts: GuardedGetOpts = {}): Promise<GuardedGetOk | GuardedGetErr> {
  const optedOut = opts.optedOut ?? ((h: string) => isOptedOut(h));
  const maxBytes = opts.maxBytes ?? 200_000;
  const maxRedirects = opts.followRedirects === false ? 0 : (opts.maxRedirects ?? 3);
  const deadline = Date.now() + (opts.timeoutMs ?? 8_000);
  const hops: { url: string; status: number }[] = [];
  let current = raw;
  for (let hop = 0; ; hop++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { ok: false, code: "timeout", error: "timed out" };
    let hopHost: string;
    try {
      hopHost = new URL(current).hostname.replace(/^\[|\]$/g, "");
    } catch {
      return { ok: false, code: "bad_url", error: "invalid URL" };
    }
    if (optedOut(hopHost)) {
      return { ok: false, code: "opted_out", error: `${hop === 0 ? "Target" : "Redirect target"} ${hopHost} is on the web-checks opt-out list; no request was sent to it.` };
    }
    const checked = await deps.safeCheck(current);
    if ("ok" in checked && checked.ok === false) return { ok: false, code: checked.code === "host_blocked" ? "host_blocked" : "bad_url", error: checked.error };
    const url = (checked as { url: URL }).url;
    let res: Response;
    try {
      res = await deps.fetch(url.toString(), {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(remaining),
        headers: { Accept: "*/*", ...(opts.headers ?? {}), "User-Agent": CHECK_USER_AGENT },
      });
    } catch (err) {
      if (isSsrfBlockedError(err)) return { ok: false, code: "host_blocked", error: err.message };
      const name = err instanceof Error ? err.name : "";
      if (name === "TimeoutError" || name === "AbortError") return { ok: false, code: "timeout", error: "timed out" };
      return { ok: false, code: "upstream", error: err instanceof Error ? err.message : "fetch failed" };
    }
    hops.push({ url: url.toString(), status: res.status });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc && opts.followRedirects !== false) {
      await res.body?.cancel().catch(() => {});
      if (hop + 1 > maxRedirects) return { ok: false, code: "redirects", error: `too many redirects (max ${maxRedirects})` };
      try {
        current = new URL(loc, url).toString();
      } catch {
        return { ok: false, code: "upstream", error: "bad redirect location" };
      }
      continue;
    }
    const { text, bytes, truncated } = await readCapped(res, maxBytes);
    return { ok: true, status: res.status, headers: res.headers, body: text, bytes, truncated, finalUrl: url.toString(), hops };
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  if (!res.body) return { text: "", bytes: 0, truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (total + value.length > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - total));
        total = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.length;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return { text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8"), bytes: total, truncated };
}
