/**
 * Human review tool for the x402 Preview queue (shared store only).
 * Approving NEVER sends email: it marks the item approved and prints the report
 * and contact so a person can send it by hand.
 *
 * Usage (needs UPSTASH_REDIS_REST_URL/TOKEN in env, never printed):
 *   npx -y tsx --tsconfig tsconfig.json scripts/preview-review.ts list [pending_review|approved|rejected]
 *   npx -y tsx --tsconfig tsconfig.json scripts/preview-review.ts show <id>
 *   npx -y tsx --tsconfig tsconfig.json scripts/preview-review.ts approve <id>
 *   npx -y tsx --tsconfig tsconfig.json scripts/preview-review.ts reject <id>
 */
import { getPreviewStore, type PreviewStore, type ReviewStatus } from "@/lib/preview/store";

export async function review(store: PreviewStore, argv: string[], log: (s: string) => void = console.log): Promise<number> {
  const [cmd, arg] = argv;
  if (cmd === "list") {
    const st = (arg as ReviewStatus | undefined) ?? "pending_review";
    for (const r of await store.listReports(st))
      log(`${r.id}\t${new Date(r.createdAt).toISOString()}\t${r.status}\t${r.contact ? "email" : "no-email"}`);
    return 0;
  }
  if ((cmd === "show" || cmd === "approve" || cmd === "reject") && arg) {
    const r = cmd === "show" ? await store.getReport(arg) : await store.setStatus(arg, cmd === "approve" ? "approved" : "rejected");
    if (!r) {
      log(`not found (or expired): ${arg}`);
      return 1;
    }
    log(JSON.stringify(r, null, 2));
    if (cmd === "approve")
      log(r.contact ? `APPROVED. NOT SENT: send by hand to ${r.contact.email}` : "APPROVED. No email on file: nothing to send.");
    return 0;
  }
  log("usage: list [status] | show <id> | approve <id> | reject <id>");
  return 2;
}

if (process.argv[1]?.endsWith("preview-review.ts")) {
  const store = getPreviewStore();
  if (!store) {
    console.error("Shared store not configured (UPSTASH_REDIS_REST_URL/TOKEN). Nothing done.");
    process.exit(2);
  }
  review(store, process.argv.slice(2)).then((c) => process.exit(c));
}
