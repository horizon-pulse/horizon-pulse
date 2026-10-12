// Slash-form alias for the market demos so /api/demo/<route> works for every
// paid route path: /api/demo/market/search and /api/demo/market/quote serve the
// exact same free fixed-input sample as /api/demo/market-search / market-quote.
// Any other op falls through to the shared handler's unknown-demo 404.
import { NextRequest } from "next/server";
import { GET as demoGet } from "../../[route]/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ op: string }> }) {
  const { op } = await ctx.params;
  return demoGet(req, { params: Promise.resolve({ route: `market-${op}` }) });
}
