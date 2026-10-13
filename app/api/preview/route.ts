import { NextResponse } from "next/server";
import { buildPreview, PreviewError } from "@/lib/preview/engine";
import { createOpenAiLlm } from "@/lib/preview/llm";
import { getPreviewStore } from "@/lib/preview/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const PER_IP_PER_HOUR = 3;
export const GLOBAL_PER_DAY = 20;

/**
 * x402 Preview intake (phase 1). Queues a DRAFT for human review; the report is
 * never returned here. Disabled unless PREVIEW_ENABLED=1. Not a paid x402 route.
 */
export async function POST(req: Request) {
  if (process.env.PREVIEW_ENABLED !== "1") return NextResponse.json({ error: "Preview is not open yet" }, { status: 503 });
  const store = getPreviewStore();
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0]!.trim() || "unknown";
  if ((await store.hit(`ip:${ip}`, 3_600_000)) > PER_IP_PER_HOUR)
    return NextResponse.json({ error: "Too many requests, try again later" }, { status: 429 });
  if ((await store.hit("global:day", 86_400_000)) > GLOBAL_PER_DAY)
    return NextResponse.json({ error: "Daily limit reached, try tomorrow" }, { status: 429 });

  const body = (await req.json().catch(() => null)) as { url?: unknown; docs?: unknown; email?: unknown } | null;
  const url = typeof body?.url === "string" ? body.url.slice(0, 2048) : undefined;
  const docs = typeof body?.docs === "string" ? body.docs : undefined;
  if (!url && !docs) return NextResponse.json({ error: "Provide a URL or pasted docs" }, { status: 400 });
  try {
    const r = await buildPreview({ url, docs }, { llm: createOpenAiLlm(), store });
    return NextResponse.json({ received: true, id: r.id, next: "A person reviews the draft before anything is sent." }, { status: 202 });
  } catch (e) {
    const code = e instanceof PreviewError ? e.code : "llm_failed";
    const status = code === "bad_input" || code === "fetch_failed" ? 400 : 503;
    return NextResponse.json({ error: code }, { status });
  }
}
