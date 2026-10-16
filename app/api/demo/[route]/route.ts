import { getSolanaRailConfig } from "@/lib/solana-config";
import { getXrplRailConfig } from "@/lib/xrpl-config";
import { getPolygonRailConfig } from "@/lib/polygon-config";
import { NextRequest, NextResponse } from "next/server";
import { DEMO_ROUTES } from "@/lib/demo-catalog";
import { pulseHandler } from "@/app/api/pulse/handler";
import { signalsHandler } from "@/app/api/signals/handler";
import { yieldHandler } from "@/app/api/yield/handler";
import { portfolioHandler } from "@/app/api/portfolio/handler";
import { gasHandler } from "@/app/api/gas/handler";
import { fundingHandler } from "@/app/api/funding/handler";
import { fetchHandler } from "@/app/api/fetch/handler";
import { httpHandler } from "@/app/api/http/handler";
import { extractHandler } from "@/app/api/extract/handler";
import { x402CheckHandler } from "@/app/api/x402-check/handler";
import { bazaarCheckHandler } from "@/app/api/bazaar-check/handler";
import { marketSearchHandler } from "@/app/api/market/search/handler";
import { marketQuoteHandler } from "@/app/api/market/quote/handler";
import { screenshotHandler } from "@/app/api/screenshot/handler";
import { searchHandler } from "@/app/api/search/handler";
import { pdfHandler } from "@/app/api/pdf/handler";
import { txStatusHandler } from "@/app/api/tx-status/handler";
import { tokenizedStockHandler } from "@/app/api/tokenized-stock/handler";
import { watchHandler } from "@/app/api/watch/handler";
import { balanceHandler } from "@/app/api/balance/handler";
import { txGuardHandler } from "@/app/api/tx-guard/handler";
import { groceryNormalizeHandler } from "@/app/api/grocery/normalize/handler";
import { groceryIngredientHandler } from "@/app/api/grocery/ingredient/handler";
import { OUTPUT_EXAMPLES } from "@/lib/route-examples";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Handler = (req: NextRequest) => Promise<NextResponse>;

// bazaar-check: CDP discovery + ~15 outbound probes per run, so one sample per instance per 10 min.
// market-search / market-quote: CDP discovery + live probes of third-party sellers, same 10 min reuse.
const HEAVY_DEMOS = new Set(["screenshot", "search", "pdf", "bazaar-check", "market-search", "market-quote", "tx-status", "tokenized-stock", "watch", "balance", "tx-guard"]);
const HEAVY_TTL_MS = 10 * 60 * 1000;
/** search spends paid provider quota: one sample per instance per day. */
const TTL_MS: Record<string, number> = { search: 24 * 60 * 60 * 1000 };
/** After a failed heavy sample, don't retry the handler for 10 min. */
const FAIL_TTL_MS = 10 * 60 * 1000;
const demoMemo = new Map<string, { at: number; status: number; sample: unknown }>();
const inflight = new Map<string, Promise<{ status: number; sample: unknown }>>();

const HANDLERS: Record<string, Handler> = {
  pulse: pulseHandler,
  signals: signalsHandler,
  yield: yieldHandler,
  portfolio: portfolioHandler,
  gas: gasHandler,
  funding: fundingHandler,
  fetch: fetchHandler,
  http: httpHandler,
  extract: extractHandler,
  "x402-check": x402CheckHandler,
  "bazaar-check": bazaarCheckHandler,
  "market-search": marketSearchHandler,
  "market-quote": marketQuoteHandler,
  screenshot: screenshotHandler,
  search: searchHandler,
  pdf: pdfHandler,
  "tx-status": txStatusHandler,
  "tokenized-stock": tokenizedStockHandler,
  watch: watchHandler,
  balance: balanceHandler,
  "tx-guard": txGuardHandler,
  "grocery-normalize": groceryNormalizeHandler,
  "grocery-ingredient": groceryIngredientHandler,
  // Canned: the recorded example (lib/route-examples.ts). Never runs the
  // classifier or the sources, so the free demo costs nothing per call.
  "discourse-split": async () => NextResponse.json(OUTPUT_EXAMPLES["/api/discourse/split"]),
};

/** Payment rails the paid route's 402 offers right now (same rail flags the paid 402 uses), for the demo note. */
function liveRailsText(): string {
  const rails = ["USDC on Base"];
  if (getSolanaRailConfig().enabled) rails.push("USDC on Solana");
  if (getXrplRailConfig().enabled) rails.push("RLUSD on the XRP Ledger");
  if (getPolygonRailConfig().enabled) rails.push("USDC on Polygon");
  return rails.length === 1 ? rails[0] : `${rails.slice(0, -1).join(", ")} or ${rails[rails.length - 1]}`;
}

/** A canned sample marked illustrative:true (discourse/split) is never called real output. */
function isIllustrative(sample: unknown): boolean {
  return typeof sample === "object" && sample !== null && (sample as { illustrative?: unknown }).illustrative === true;
}

/**
 * Free fixed-input sample. Ignores every caller query param / body: the
 * real handler runs on the catalog's fixed input only. CDN-cached 5 min.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ route: string }> },
): Promise<NextResponse> {
  const { route } = await ctx.params;
  const demo = DEMO_ROUTES.find((d) => d.route === route);
  const handler = HANDLERS[route];
  if (!demo || !handler) {
    return NextResponse.json(
      {
        ok: false,
        error: "Unknown demo route",
        available: DEMO_ROUTES.map((d) => `/api/demo/${d.route}`),
      },
      { status: 404 },
    );
  }

  const origin = req.nextUrl.origin;
  // Demo names are flat; nested paid routes map back (market-search -> /api/market/search, discourse-split -> /api/discourse/split, grocery-normalize -> /api/grocery/normalize, grocery-ingredient -> /api/grocery/ingredient).
  const paidPath = `/api/${route.replace(/^(market|discourse|grocery)-/, "$1/")}`;
  const inner = new NextRequest(
    `${origin}${paidPath}${demo.query ? `?${demo.query}` : ""}`,
    { method: "GET" },
  );
  // Expensive demos (headless Chromium; paid search quota) reuse one sample per
  // instance (10 min; search 24h; failures 10 min), on top of the CDN s-maxage, so the free demo can't be
  // used to run up compute. Paid routes are never cached.
  const heavy = HEAVY_DEMOS.has(route);
  const cached = heavy ? demoMemo.get(route) : undefined;
  let status: number;
  let sample: unknown;
  const ttl = cached && cached.status !== 200 ? FAIL_TTL_MS : (TTL_MS[route] ?? HEAVY_TTL_MS);
  if (cached && Date.now() - cached.at < ttl) {
    ({ status, sample } = cached);
  } else {
    // Concurrent cold requests share one in-flight handler run.
    let p = heavy ? inflight.get(route) : undefined;
    if (!p) {
      p = (async () => {
        const res = await handler(inner);
        return { status: res.status, sample: (await res.json()) as unknown };
      })();
      if (heavy) {
        inflight.set(route, p);
        p.finally(() => inflight.delete(route)).catch(() => {});
      }
    }
    ({ status, sample } = await p);
    if (heavy) demoMemo.set(route, { at: Date.now(), status, sample });
  }

  return NextResponse.json(
    {
      demo: true,
      note: `${isIllustrative(sample) ? "Free fixed-input illustrative format sample (NOT real output: counts are not measured)." : "Free fixed-input sample of real output."} The paid route accepts your own input: ${paidPath} (${demo.priceUsd} per call via x402: ${liveRailsText()}; no signup or API key).`,
      paid_endpoint: `${origin}${paidPath}`,
      price: demo.priceUsd,
      fixed_input: demo.input,
      sample_status: status,
      sample,
    },
    {
      status: 200,
      headers: {
        "Cache-Control": heavy
          ? "public, max-age=300, s-maxage=600, stale-while-revalidate=1200"
          : "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
        "Access-Control-Allow-Origin": "*",
      },
    },
  );
}
