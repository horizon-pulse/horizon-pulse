/**
 * C1 (Odin GO 10/19): Preview-only debug capture of the cleaned Parallel search + extract results for a paid brief,
 * so real bodies can be replayed as fixtures. Refused unless ALL hold:
 *   VERCEL_ENV !== "production" (and is "preview"), HP_PREMIUM_CAPTURE === "true", and the request carries the Vercel
 *   automation bypass header matching VERCEL_AUTOMATION_BYPASS_SECRET (compared by SHA-256, constant time).
 * Carries no request/response headers and no keys: only url/title/publish_date/excerpts.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { CaptureSink } from "./research";

type Env = Record<string, string | undefined>;
export const CAPTURE_MAX_BYTES = 256 * 1024;
const h = (s: string) => createHash("sha256").update(s).digest();

export function captureAllowed(headers: Headers, env: Env = process.env): boolean {
  if (env.VERCEL_ENV === "production" || env.VERCEL_ENV !== "preview") return false;
  if (env.HP_PREMIUM_CAPTURE !== "true") return false;
  const secret = env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
  const got = headers.get("x-vercel-protection-bypass")?.trim();
  if (!secret || !got) return false;
  return timingSafeEqual(h(secret), h(got));
}

/** The debug_capture body field, or null (size-capped; only content fields). */
export function captureBody(sink: CaptureSink): Record<string, unknown> | null {
  if (!sink.data) return null;
  const pick = (r: { url: string; title: string | null; publish_date: string | null; excerpts: string[] }) => ({ url: r.url, title: r.title, publish_date: r.publish_date, excerpts: r.excerpts });
  const body = { search: sink.data.search.map(pick), extract: sink.data.extract.map(pick), note: "Preview debug capture (cleaned Parallel results; no headers, no keys)." };
  return JSON.stringify(body).length <= CAPTURE_MAX_BYTES ? body : { truncated: true, note: "capture exceeded size cap" };
}
