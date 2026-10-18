import { NextResponse, type NextRequest } from "next/server";
import { darkEnabled } from "@/lib/dark-routes";
import { optOutHandler } from "./handler";

/**
 * GET /web-checks/opt-out?domain= : exact-domain yes/no, rate limited (see handler.ts).
 * Every other method is exported too and answers a bare 404, dark or live, so Next never
 * answers one itself with 405 or an auto-OPTIONS 204 carrying "Allow: GET, HEAD, OPTIONS"
 * (the 10:26 AM ET 10/18 smoke failure). While dark this file is not a route at all: the .audit.ts
 * extension is a page extension only when HP_AUDIT_SECURITY_ENABLED is "true" at build (lib/dark-paths.ts).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });

export async function GET(req: NextRequest) {
  return optOutHandler(req);
}
export async function HEAD(req: NextRequest) {
  const res = darkEnabled("audit") ? await optOutHandler(req) : notFound();
  return new NextResponse(null, { status: res.status, headers: res.headers });
}
export const POST = async () => notFound();
export const PUT = async () => notFound();
export const PATCH = async () => notFound();
export const DELETE = async () => notFound();
export const OPTIONS = async () => notFound();
