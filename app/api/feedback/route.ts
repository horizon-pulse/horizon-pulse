import { handleFeedback, feedbackEnabled, methodNotAllowed, notFound } from "@/lib/feedback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** FREE route: no x402, no 402. Flag FEEDBACK_ROUTE_ENABLED default off -> 404. No public GET. */
export async function POST(req: Request) {
  return handleFeedback(req);
}
const other = async () => (feedbackEnabled() ? methodNotAllowed() : notFound());
export { other as GET, other as PUT, other as PATCH, other as DELETE, other as OPTIONS, other as HEAD };
