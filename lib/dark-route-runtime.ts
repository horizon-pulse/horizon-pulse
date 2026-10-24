/**
 * Route runtime shared by the three dark routes.
 *   flag unset            -> 404 on every verb (no 402, no discovery, no Allow). In prod the
 *                            route file is not even built (route.<ext>.ts is a page extension
 *                            only when the flag is on at build; lib/dark-paths.ts). Second line.
 *   PUT/PATCH/DELETE      -> 404 always (never 405, never an Allow header)
 *   unknown tier          -> 400 before any payment (not charged)
 *   disabled tier         -> 404 before any payment (opts.tierEnabled; audit
 *                            full/history/deep unless HP_AUDIT_HIGH_TIERS_ENABLED)
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
import { clientKey, darkDescription, darkEnabled, darkPaymentOpts, darkRouteConfig, DARK_DESCRIPTIONS, DARK_RATE_LIMITS, findTier, type DarkPaidPath, newReceiptId, rateLimitHit, RECEIPT_HEADER, type DarkRoute, type Tier } from "./dark-routes";

type Path = DarkPaidPath;
export type TierHandler = (req: NextRequest, tier: Tier, receiptId: string) => Promise<NextResponse>;

const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });

export function makeDarkRoute(opts: {
  route: DarkRoute;
  path: Path;
  tiers: readonly Tier[];
  defaultTier: string;
  handler: TierHandler;
  /** Per-request tier gate; a disabled tier is 404 (no 402, no payment), and is not listed. */
  tierEnabled?: (t: Tier) => boolean;
  /** Disclaimer on runtime-made answers (429/502/400 bad_tier). Default: the dark-checks DISCLAIMER. */
  disclaimer?: string;
}) {
  const disclaimer = opts.disclaimer ?? DISCLAIMER;
  const enabled = (t: Tier) => (opts.tierEnabled ? opts.tierEnabled(t) : true);
  const paid = new Map<string, (req: NextRequest) => Promise<NextResponse>>();
  const tierHandler = (t: Tier) => {
    // Keyed by tier AND served description, so a copy flag change (HP_AUDIT_HIGH_TIERS_ENABLED) is never served stale.
    const key = `${t.id}|${darkDescription(opts.path)}`;
    let h = paid.get(key);
    if (!h) {
      h = createX402GetHandler(
        async (req) => {
          const receiptId = newReceiptId();
          const wait = rateLimitHit(`${opts.route}:ip:${clientKey(req.headers)}`, DARK_RATE_LIMITS[opts.route].perMinute);
          if (wait) {
            const r429 = NextResponse.json({ ok: false, code: "rate_limited", error: "Too many requests; retry later. Not charged.", charged: false, receiptId, disclaimer }, { status: 429, headers: { "Retry-After": String(wait) } });
            r429.headers.set(RECEIPT_HEADER, receiptId);
            return r429;
          }
          let res: NextResponse;
          try {
            res = await opts.handler(req, t, receiptId);
          } catch {
            // Never a 500 (Odin B-1): an unexpected failure is a refused answer; a non-2xx never settles, so nothing is charged.
            res = NextResponse.json({ ok: false, code: "check_failed", error: "The check could not be completed; not charged. Retry later.", charged: false, receiptId, disclaimer }, { status: 502 });
          }
          res.headers.set(RECEIPT_HEADER, receiptId);
          return res;
        },
        darkRouteConfig(opts.path, t),
        darkPaymentOpts(opts.path, t),
      ) as (req: NextRequest) => Promise<NextResponse>;
      paid.set(key, h);
    }
    return h;
  };

  async function handle(req: NextRequest): Promise<NextResponse> {
    if (!darkEnabled(opts.route)) return notFound();
    const t = findTier(opts.tiers, req.nextUrl.searchParams.get("tier"), opts.defaultTier);
    if (!t) {
      const live = opts.tiers.filter(enabled);
      return NextResponse.json({ ok: false, code: "bad_tier", error: `tier must be one of ${live.map((x) => x.id).join(", ")}`, tiers: live.map((x) => ({ tier: x.id, priceUsd: x.usd, amountAtomic: x.atomicStr })), charged: false, disclaimer }, { status: 400 });
    }
    if (!enabled(t)) return notFound();
    return tierHandler(t)(req);
  }

  async function OPTIONS(req: NextRequest) {
    if (!darkEnabled(opts.route)) return notFound();
    const t = findTier(opts.tiers, req.nextUrl.searchParams.get("tier"), opts.defaultTier) ?? findTier(opts.tiers, opts.defaultTier, opts.defaultTier)!;
    if (!enabled(t)) return notFound();
    const res = await discoveryOptionsResponse({ ...darkPaymentOpts(opts.path, t), eurc: false });
    res.headers.set("Allow", "GET, POST, OPTIONS");
    res.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    return res;
  }

  /** HEAD: dark -> 404; live -> the GET answer without a body. */
  async function HEAD(req: NextRequest) {
    const res = darkEnabled(opts.route) ? await handle(req) : notFound();
    return new NextResponse(null, { status: res.status, headers: res.headers });
  }
  /** Methods the route never serves: always the same bare 404 (no Allow, no 405), dark or live. */
  const unsupported = async () => notFound();

  return { GET: handle, HEAD, POST: handle, PUT: unsupported, PATCH: unsupported, DELETE: unsupported, OPTIONS };
}
