/**
 * Raw guarded GET for the dark routes (audit, injection scan). Same SSRF stack
 * as /api/fetch: assertSafePublicUrl on every hop (scheme, userinfo, local
 * names, every DNS answer) + guardedFetch (connect-time IP check, no DNS
 * rebinding; lib/net-guard.ts). Redirects are followed manually and
 * re-checked. Returns the raw body (capped) so callers can inspect HTML
 * comments, hidden text and headers. FLAG FOR SENTINEL: new caller of the guard.
 */
import { CHECK_USER_AGENT } from "./dark-checks-shared";
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
export type GuardedGetErr = { ok: false; code: "bad_url" | "host_blocked" | "timeout" | "upstream" | "redirects"; error: string };

export async function guardedGet(
  raw: string,
  opts: { maxBytes?: number; timeoutMs?: number; maxRedirects?: number; followRedirects?: boolean; headers?: Record<string, string> } = {},
): Promise<GuardedGetOk | GuardedGetErr> {
  const maxBytes = opts.maxBytes ?? 200_000;
  const maxRedirects = opts.followRedirects === false ? 0 : (opts.maxRedirects ?? 3);
  const deadline = Date.now() + (opts.timeoutMs ?? 8_000);
  const hops: { url: string; status: number }[] = [];
  let current = raw;
  for (let hop = 0; ; hop++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { ok: false, code: "timeout", error: "timed out" };
    const checked = await assertSafePublicUrl(current);
    if ("ok" in checked && checked.ok === false) return { ok: false, code: checked.code === "host_blocked" ? "host_blocked" : "bad_url", error: checked.error };
    const url = (checked as { url: URL }).url;
    let res: Response;
    try {
      res = await guardedFetch(url.toString(), {
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
