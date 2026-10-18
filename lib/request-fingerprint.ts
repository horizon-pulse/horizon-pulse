/**
 * Request fingerprint for redeem-on-retry binding (Odin 5:40 PM ET 10/18, Sentinel shared-claim-v3 F1 applied to XRPL).
 *
 * A redeem delivers a paid response for a payment that was charged-or-unknown but never delivered. The payment
 * itself (signed blob / hash) is public once it lands, so it cannot prove WHICH request it paid for. The first
 * request that claims a payment slot stores this fingerprint in the slot; a redeem is allowed only for a request with
 * the same fingerprint.
 *
 *   fingerprint = sha256( "hp-rq-v1\n" + METHOD + "\n" + pathname + "\n" + normalizedQuery + "\n" + sha256(body) )  (hex)
 *
 * - METHOD: upper-case. pathname: exactly as received (routes are case-sensitive; no decoding/re-encoding).
 * - normalizedQuery: every (key, value) pair, percent-decoded, STABLE-sorted by key only (a repeated key keeps its
 *   value order: routes read the first value), re-encoded with encodeURIComponent and joined with "&". Reordered
 *   distinct keys and encoding differences normalize away; reordered values of a repeated key do not (Odin 6:08 PM ET).
 *   NO parameter is excluded, including `free` (the free tier only applies to unpaid requests, so on a paid request
 *   it is just another query parameter): a legitimate retry repeats the exact request, and excluding nothing keeps
 *   "the request that was paid for" strict. Payment data never travels in the query (it is the PAYMENT-SIGNATURE
 *   header), so no payment parameter exists to exclude. Headers are not part of the fingerprint.
 * - body: sha256 of the raw body bytes ("" for none), read from a clone so the route still gets the original.
 *
 * Limitation (documented): for a request with no query and no body the fingerprint is just METHOD + path, which a
 * chain watcher can guess; binding then only guarantees the delivery is for the same request the payment bought.
 */
import { createHash } from "node:crypto";

export const REQUEST_FINGERPRINT_RE = /^[0-9a-f]{64}$/;

const sha256Hex = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

export function normalizeQuery(search: string): string {
  const pairs = [...new URLSearchParams(search).entries()];
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); // stable: a repeated key keeps its value order
  return pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
}

/** Fingerprint of method + path + normalized query + body. Throws only if the body cannot be read. */
export async function requestFingerprint(req: Request): Promise<string> {
  const url = new URL(req.url);
  const method = req.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" || !req.body ? new Uint8Array(0) : new Uint8Array(await req.clone().arrayBuffer());
  return sha256Hex(`hp-rq-v1\n${method}\n${url.pathname}\n${normalizeQuery(url.search)}\n${sha256Hex(body)}`);
}
