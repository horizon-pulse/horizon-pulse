import { after, NextRequest, NextResponse } from "next/server";
import { jobNow, loadJob, runJob, statusView, tokenMatches } from "@/lib/premium/jobs";
import { premiumStore } from "@/lib/premium/store";
import { premiumAsyncEnabled } from "@/lib/premium/tiers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };
const H = { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Referrer-Policy": "no-referrer" };
const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404, headers: H });
const RUNNABLE = new Set(["accepted", "running", "built", "settle_unconfirmed", "watching"]);

/**
 * Free status link (no 402). Token ONLY from `Authorization: Bearer <job_token>` (a token in the query is ignored).
 * Wrong / missing token or unknown job -> 404 (no existence oracle). 404 while the async flag is off.
 * Recovery path (Odin Q3, Hobby): a poll by the token holder runs the job's next bounded step after the response.
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  if (!premiumAsyncEnabled()) return notFound();
  const store = premiumStore();
  if (!store) return NextResponse.json({ error: "store_unavailable" }, { status: 503, headers: H });
  const { id } = await ctx.params;
  const auth = req.headers.get("authorization") ?? "";
  const token = /^Bearer\s+(\S+)$/i.exec(auth)?.[1] ?? null;
  const job = await loadJob(store, id).catch(() => null);
  if (!job || !tokenMatches(job, token)) return notFound();
  if (RUNNABLE.has(job.status)) {
    const deadline = jobNow() + 50_000;
    after(() => runJob(store, job.id, deadline, { watchPause: process.env.HP_PREMIUM_WATCH_PAUSE === "true" }).then(() => undefined, () => undefined));
  }
  return NextResponse.json(await statusView(store, job), { status: 200, headers: H });
}
