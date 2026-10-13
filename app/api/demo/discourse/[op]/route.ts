// Slash-form alias: /api/demo/discourse/split serves the same free canned
// sample as /api/demo/discourse-split. Other ops → the shared unknown-demo 404.
import { NextRequest } from "next/server";
import { GET as demoGet } from "../../[route]/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ op: string }> }) {
  const { op } = await ctx.params;
  return demoGet(req, { params: Promise.resolve({ route: `discourse-${op}` }) });
}
