import { NextResponse } from "next/server";
import { buildPreview, PreviewError } from "@/lib/preview/engine";
import { createOpenAiLlm } from "@/lib/preview/llm";
import { getPreviewStore, type Contact } from "@/lib/preview/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const PER_IP_PER_HOUR = 3;
export const GLOBAL_PER_DAY = 20;
/** Explicit request body limit: 50 KB docs + JSON/url/email overhead. Larger bodies get 413 before parsing. */
export const MAX_BODY_BYTES = 64 * 1024;
const EMAIL_RE = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[A-Za-z]{2,}$/;

/** Client IP: Vercel's x-real-ip (set by the platform, not client-controlled). */
export function clientIp(req: Request): string {
  return (req.headers.get("x-real-ip") ?? "").trim() || "unknown";
}

/**
 * x402 Preview intake (phase 1). Queues a DRAFT for human review; the report is
 * never returned here and nothing is emailed by code. Disabled unless
 * PREVIEW_ENABLED=1; fails closed (503) when enabled without a shared store.
 * Input: { url } | { docs: string } | { openapi: object } (JSON/OpenAPI), optional
 * { email, consent: true }. Not a paid x402 route.
 */
export async function POST(req: Request) {
  if (process.env.PREVIEW_ENABLED !== "1") return NextResponse.json({ error: "Preview is not open yet" }, { status: 503 });
  const store = getPreviewStore();
  if (!store) return NextResponse.json({ error: "store_not_configured" }, { status: 503 });
  try {
    if ((await store.hit(`ip:${clientIp(req)}`, 3_600_000)) > PER_IP_PER_HOUR)
      return NextResponse.json({ error: "Too many requests, try again later" }, { status: 429 });
    if ((await store.hit("global:day", 86_400_000)) > GLOBAL_PER_DAY)
      return NextResponse.json({ error: "Daily limit reached, try tomorrow" }, { status: 429 });
  } catch {
    return NextResponse.json({ error: "store_unavailable" }, { status: 503 });
  }

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return NextResponse.json({ error: "too_large" }, { status: 413 });
  const raw = await req.text().catch(() => "");
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return NextResponse.json({ error: "too_large" }, { status: 413 });
  const body = (() => { try { return JSON.parse(raw); } catch { return null; } })() as
    | { url?: unknown; docs?: unknown; openapi?: unknown; email?: unknown; consent?: unknown }
    | null;
  const url = typeof body?.url === "string" && body.url.trim() ? body.url.trim().slice(0, 2048) : undefined;
  let docs = typeof body?.docs === "string" && body.docs.trim() ? body.docs : undefined;
  if (!docs && body?.openapi && typeof body.openapi === "object") docs = JSON.stringify(body.openapi);
  if (!url && !docs) return NextResponse.json({ error: "Provide a URL, pasted docs or an OpenAPI/JSON spec" }, { status: 400 });

  let contact: Contact | undefined;
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  if (email) {
    if (!EMAIL_RE.test(email) || email.length > 254) return NextResponse.json({ error: "bad_email" }, { status: 400 });
    if (body?.consent !== true) return NextResponse.json({ error: "consent_required" }, { status: 400 });
    contact = { email, consent: true, consentAt: Date.now() };
  }
  try {
    const r = await buildPreview({ url, docs, contact }, { llm: createOpenAiLlm(), store });
    return NextResponse.json(
      {
        received: true,
        id: r.id,
        next: contact
          ? "A person reviews the draft. If approved, we email it to the address you gave."
          : "A person reviews the draft. You left no email, so nothing will be sent to you.",
      },
      { status: 202 },
    );
  } catch (e) {
    const code = e instanceof PreviewError ? e.code : "store_unavailable";
    const status = code === "bad_input" || code === "fetch_failed" ? 400 : 503;
    return NextResponse.json({ error: code }, { status });
  }
}
