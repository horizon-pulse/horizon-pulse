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
import { screenshotHandler } from "@/app/api/screenshot/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Handler = (req: NextRequest) => Promise<NextResponse>;

const HEAVY_DEMOS = new Set(["screenshot"]);
const HEAVY_TTL_MS = 10 * 60 * 1000;
const demoMemo = new Map<string, { at: number; status: number; sample: unknown }>();

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
  screenshot: screenshotHandler,
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
  // Expensive renders (headless Chromium) reuse one successful sample per
  // instance for 10 min, on top of the CDN s-maxage, so the free demo can't be
  // used to run up compute. Paid routes are never cached.
  const heavy = HEAVY_DEMOS.has(route);
  const cached = heavy ? demoMemo.get(route) : undefined;
  let status: number;
  let sample: unknown;
  if (cached && Date.now() - cached.at < HEAVY_TTL_MS) {
    ({ status, sample } = cached);
  } else {
    const res = await handler(inner);
    status = res.status;
    sample = (await res.json()) as unknown;
    if (heavy && status === 200) demoMemo.set(route, { at: Date.now(), status, sample });
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
