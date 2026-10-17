/**
 * /api/batch: several $0.002-tier checks for one x402 payment (repeat-caller
 * growth plan, 10/17). INERT unless HP_BATCH_ENABLED=true (exactly): the route
 * answers 404 on every verb and is not in the live catalog, /.well-known/x402,
 * openapi.json or llms.txt. Price is PROPOSED (lib/config.ts BATCH_PRICE_USD).
 *
 * Body (POST): {"items":[{"route":"balance","params":{"evm":"0x..."}}, ...]}
 *   or GET ?items=<the same array as JSON> for GET-only clients.
 *   1..BATCH_MAX_ITEMS items; route one of BATCH_ROUTES; params only the
 *   query keys that route already accepts, string values <= 256 chars.
 * Each item runs the SAME handler as the single route (same input checks,
 * same RPCs), in parallel. Per item: index, route, status, ok, body (the
 * single route's JSON minus its own `priced` and `charged` keys).
 * Billing: input invalid -> 400 before any item runs (never settles); every
 * item fails -> 502 (never settles); at least one item ok -> 200, one charge
 * of BATCH_PRICE_USD for the whole call.
 */
import { BATCH_MAX_ITEMS } from "./config";

export const BATCH_ROUTES: Readonly<Record<string, readonly string[]>> = {
  balance: ["evm", "solana", "xrpl"],
  gas: [],
  "tx-status": ["tx", "network"],
  "token/meta": ["network", "token"],
  "chain/head": ["network"],
  "name/resolve": ["name", "address"],
};

export type BatchItem = { route: string; params: Record<string, string> };
export type BatchParse = { ok: true; items: BatchItem[] } | { ok: false; error: string; code: string };

export function batchEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.HP_BATCH_ENABLED === "true";
}

export function parseBatchBody(body: unknown): BatchParse {
  const bad = (error: string, code = "invalid_input"): BatchParse => ({ ok: false, error, code });
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad("Body must be a JSON object {items:[...]}.");
  const items = (body as { items?: unknown }).items;
  if (!Array.isArray(items) || items.length === 0) return bad("items must be a non-empty array.");
  if (items.length > BATCH_MAX_ITEMS) return bad(`At most ${BATCH_MAX_ITEMS} items per call.`, "too_many_items");
  const out: BatchItem[] = [];
  for (const [i, it] of items.entries()) {
    if (!it || typeof it !== "object" || Array.isArray(it)) return bad(`items[${i}] must be an object.`);
    const route = String((it as { route?: unknown }).route ?? "").replace(/^\/?(api\/)?/, "");
    const allowed = BATCH_ROUTES[route];
    if (!allowed) return bad(`items[${i}].route must be one of: ${Object.keys(BATCH_ROUTES).join(", ")}.`, "unsupported_route");
    const raw = (it as { params?: unknown }).params ?? {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad(`items[${i}].params must be an object.`);
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!allowed.includes(k)) return bad(`items[${i}].params.${k} is not accepted by ${route} (allowed: ${allowed.join(", ") || "none"}).`);
      if (typeof v !== "string" || v.length > 256) return bad(`items[${i}].params.${k} must be a string of at most 256 chars.`);
      params[k] = v;
    }
    out.push({ route, params });
  }
  return { ok: true, items: out };
}

export type SubHandler = (url: string) => Promise<Response>;

export type BatchResult = { index: number; route: string; status: number; ok: boolean; body: unknown };

/** Run items in parallel through the single-route handlers. Never throws. */
export async function runBatch(items: BatchItem[], call: (route: string, query: URLSearchParams) => Promise<Response>): Promise<BatchResult[]> {
  return Promise.all(
    items.map(async (it, index): Promise<BatchResult> => {
      try {
        const res = await call(it.route, new URLSearchParams(it.params));
        let body: unknown = null;
        try {
          body = await res.json();
        } catch {
          body = null;
        }
        if (body && typeof body === "object" && !Array.isArray(body)) {
          const { priced: _p, charged: _c, ...rest } = body as Record<string, unknown>;
          void _p;
          void _c;
          body = rest;
        }
        return { index, route: it.route, status: res.status, ok: res.status >= 200 && res.status < 300, body };
      } catch {
        return { index, route: it.route, status: 500, ok: false, body: { error: "item failed" } };
      }
    }),
  );
}
