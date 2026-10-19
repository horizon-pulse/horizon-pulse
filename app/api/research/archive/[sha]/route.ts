import { NextRequest, NextResponse } from "next/server";
import { archiveView, JOB_KEYS, loadJob, tokenMatches } from "@/lib/premium/jobs";
import { premiumStore } from "@/lib/premium/store";
import { premiumAsyncEnabled } from "@/lib/premium/tiers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ sha: string }> };
const H = { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Referrer-Policy": "no-referrer" };

/**
 * Free archive snippet URL (§1a): /api/research/archive/{sha256}?job=<job_id>, Bearer job token.
 * Serves the quote + <= ~300 chars of context only; the full archived copy is never served.
 * Wrong token / unknown job -> 404; the token holder after the 30-day purge -> 410.
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  if (!premiumAsyncEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404, headers: H });
  const store = premiumStore();
  if (!store) return NextResponse.json({ error: "store_unavailable" }, { status: 503, headers: H });
  const { sha } = await ctx.params;
  const id = new URL(req.url).searchParams.get("job") ?? "";
  const token = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? null;
  const job = await loadJob(store, id).catch(() => null);
  if (!job) {
    const gone = /^job_[0-9a-f]{24}$/.test(id) ? await store.get(JOB_KEYS.gone(id)) : null;
    if (gone && tokenMatches({ token_sha256: gone }, token)) return NextResponse.json({ error: "gone", message: "Archive purged 30 days after the last delivery." }, { status: 410, headers: H });
    return NextResponse.json({ error: "Not found" }, { status: 404, headers: H });
  }
  if (!tokenMatches(job, token) || !["delivered", "completed", "stopped", "watching"].includes(job.status)) return NextResponse.json({ error: "Not found" }, { status: 404, headers: H });
  const v = await archiveView(store, job, sha);
  if (!v) return NextResponse.json({ error: "gone", message: "No archived snippet for this hash (not archived, or purged)." }, { status: 410, headers: H });
  return NextResponse.json(v, { status: 200, headers: H });
}
