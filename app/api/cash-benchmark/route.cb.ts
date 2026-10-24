import { makeDarkRoute } from "@/lib/dark-route-runtime";
import { CASH_BENCHMARK_TIERS } from "@/lib/dark-routes";
import { CASH_BENCHMARK_DISCLAIMER } from "@/lib/cash-benchmark";
import { cashBenchmarkHandler } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** DARK: 404 unless HP_CASH_BENCHMARK_ENABLED=true (default off). Not listed anywhere. base $0.005. */
const r = makeDarkRoute({ route: "cashbenchmark", path: "/api/cash-benchmark", tiers: CASH_BENCHMARK_TIERS, defaultTier: "base", disclaimer: CASH_BENCHMARK_DISCLAIMER, handler: (req, tier, receiptId) => cashBenchmarkHandler(req, tier, receiptId) });
export const GET = r.GET;
export const HEAD = r.HEAD;
export const POST = r.POST;
export const PUT = r.PUT;
export const PATCH = r.PATCH;
export const DELETE = r.DELETE;
export const OPTIONS = r.OPTIONS;
