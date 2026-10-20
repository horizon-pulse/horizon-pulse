import { NextRequest } from "next/server";
import { sellerDdHandler } from "@/lib/seller-dd/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** $5 seller due-diligence. 404 on every verb unless HP_PREMIUM_ENABLED=true AND HP_SELLER_DD_ENABLED=true. */
const handle = (req: NextRequest) => sellerDdHandler(req);
export const GET = handle;
export const POST = handle;
export const OPTIONS = handle;
