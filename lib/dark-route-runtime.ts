/**
 * Route runtime shared by the three dark routes.
 *   flag unset            -> 404 on every verb (no 402, no discovery)
 *   unknown tier          -> 400 before any payment (not charged)
 *   over the per-IP limit -> 429 (not charged). Counted only AFTER the payment
 *                            verifies (inside the paid callback, before any work;
 *                            a non-2xx never settles), so junk payment headers
 *                            cannot burn anyone's quota (Odin LOW). Per instance.
 *                            The per-TARGET limit is shared in Upstash and applied
 *                            inside the audit handler, also after verification.
 *   otherwise             -> the tier's own createX402GetHandler (unchanged
 *                            shared x402 path: Base + enabled rails, payTo pinned)
 * One createX402GetHandler per tier, each with that tier's price. The tier is
 * read from the SAME request that carries the payment, so a payment signed for
 * a cheaper tier is verified against the requested tier's price and fails.
 */
import { NextRequest, NextResponse } from "next/server";
import { createX402GetHandler, discoveryOptionsResponse } from "./x402-server";
import { DISCLAIMER } from "./dark-checks-shared";
import { clientKey, darkEnabled, darkPaymentOpts, darkRouteConfig, DARK_DESCRIPTIONS, DARK_RATE_LIMITS, findTier, newReceiptId, rateLimitHit, RECEIPT_HEADER, type DarkRoute, type Tier } from "./dark-routes";

type Path = keyof typeof DARK_DESCRIPTIONS;
export type TierHandler = (req: NextRequest, tier: Tier, receiptId: string) => Promise<NextResponse>;

const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });

export function makeDarkRoute(opts: {
  route: DarkRoute;
  path: Path;
  tiers: readonly Tier[];
  defaultTier: string;
  handler: TierHandler;
}) {
  const paid = new Map<string, (req: NextRequest) => Promise<NextResponse>>();
  const tierHandler = (t: Tier) => {
    let h = paid.get(t.id);
    if (!h) {
      h = createX402GetHandler(
        async (req) => {
          const receiptId = newReceiptId();
          const wait = rateLimitHit(`${opts.route}:ip:${clientKey(req.headers)}`, DARK_RATE_LIMITS[opts.route].perMinute);
          if (wait) {
            const r429 = NextResponse.json({ ok: false, code: "rate_limited", error: "Too many requests; retry later. Not charged.", charged: false, receiptId, disclaimer: DISCLAIMER }, { status: 429, headers: { "Retry-After": String(wait) } });
            r429.headers.set(RECEIPT_HEADER, receiptId);
            return r429;
          }
          const res = await opts.handler(req, t, receiptId);
          res.headers.set(RECEIPT_HEADER, receiptId);
          return res;
        },
        darkRouteConfig(opts.path, t),
        darkPaymentOpts(opts.path, t),
      ) as (req: NextRequest) => Promise<NextResponse>;
      paid.set(t.id, h);
    }
    return h;
  };

  async function handle(req: NextRequest): Promise<NextResponse> {
    if (!darkEnabled(opts.route)) return notFound();
    const t = findTier(opts.tiers, req.nextUrl.searchParams.get("tier"), opts.defaultTier);
    if (!t) {
      return NextResponse.json({ ok: false, code: "bad_tier", error: `tier must be one of ${opts.tiers.map((x) => x.id).join(", ")}`, tiers: opts.tiers.map((x) => ({ tier: x.id, priceUsd: x.usd, amountAtomic: x.atomicStr })), charged: false, disclaimer: DISCLAIMER }, { status: 400 });
    }
    return tierHandler(t)(req);
  }

  async function OPTIONS(req: NextRequest) {
    if (!darkEnabled(opts.route)) return notFound();
    const t = findTier(opts.tiers, req.nextUrl.searchParams.get("tier"), opts.defaultTier) ?? findTier(opts.tiers, opts.defaultTier, opts.defaultTier)!;
    const res = await discoveryOptionsResponse(darkPaymentOpts(opts.path, t));
    res.headers.set("Allow", "GET, POST, OPTIONS");
    res.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    return res;
  }

  return { GET: handle, POST: handle, OPTIONS };
}
