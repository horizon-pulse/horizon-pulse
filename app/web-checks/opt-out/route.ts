import type { NextRequest } from "next/server";
import { optOutHandler } from "./handler";

/** GET /web-checks/opt-out?domain= : exact-domain yes/no, rate limited (see handler.ts). GET only. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return optOutHandler(req);
}
