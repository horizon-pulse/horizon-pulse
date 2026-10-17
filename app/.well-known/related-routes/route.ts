import { NextResponse } from "next/server";
import { relatedRoutesDocument } from "@/lib/route-hints";

/**
 * GET /.well-known/related-routes: free map of related paid routes with their
 * current prices (lib/route-hints.ts). Same list paid JSON responses carry
 * under relatedRoutes. No payment logic.
 */
export const dynamic = "force-static";

export function GET() {
  return NextResponse.json(relatedRoutesDocument(), {
    headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600" },
  });
}
