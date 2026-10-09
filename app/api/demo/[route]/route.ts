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
import { screenshotHandler } from "@/app/api/screenshot/handler";
import { searchHandler } from "@/app/api/search/handler";
import { pdfHandler } from "@/app/api/pdf/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Handler = (req: NextRequest) => Promise<NextResponse>;

// bazaar-check: CDP discovery + ~15 outbound probes per run, so one sample per instance per 10 min.
const HEAVY_DEMOS = new Set(["screenshot", "search", "pdf", "bazaar-check"]);
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
  screenshot: screenshotHandler,
  search: searchHandler,
  pdf: pdfHandler,
};

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
  const inner = new NextRequest(
    `${origin}/api/${route}${demo.query ? `?${demo.query}` : ""}`,
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
      note: `Free fixed-input sample of real output. The paid route accepts your own input: /api/${route} (${demo.priceUsd} per call, x402 USDC on Base, no signup or API key).`,
      paid_endpoint: `${origin}/api/${route}`,
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
