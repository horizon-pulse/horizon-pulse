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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Handler = (req: NextRequest) => Promise<NextResponse>;

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
  const res = await handler(inner);
  const sample = (await res.json()) as unknown;

  return NextResponse.json(
    {
      demo: true,
      note: `Free fixed-input sample of real output. The paid route accepts your own input: /api/${route} (${demo.priceUsd} per call, x402 USDC on Base, no signup or API key).`,
      paid_endpoint: `${origin}/api/${route}`,
      price: demo.priceUsd,
      fixed_input: demo.input,
      sample_status: res.status,
      sample,
    },
    {
      status: 200,
      headers: {
        "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
        "Access-Control-Allow-Origin": "*",
      },
    },
  );
}
