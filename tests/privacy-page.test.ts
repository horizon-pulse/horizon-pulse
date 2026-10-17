import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ROUTE_LOG_PRIVACY_LINE } from "@/lib/privacy-copy";

// Counsel's line, required by Odin before prod. Word for word; do not edit without Counsel.
const COUNSEL_TEXT =
  "For paid API calls we log the timestamp, route, method and outcome, and for settled payments the network, amount, transaction hash and payer wallet address (already public on-chain). We do not store IP addresses, user agents, headers or request content. Records are kept for 30 days (aggregate per-route counts without payer data for 90 days), used only for our own usage analytics, and never sold or shared.";

describe("/privacy page (route-log disclosure)", () => {
  it("renders Counsel's text exactly", () => {
    expect(ROUTE_LOG_PRIVACY_LINE).toBe(COUNSEL_TEXT);
  });
  it("the /privacy page renders that constant", () => {
    const page = fs.readFileSync(path.join(process.cwd(), "app", "privacy", "page.tsx"), "utf8");
    expect(page).toContain("{ROUTE_LOG_PRIVACY_LINE}");
  });
  it("is linked from the site footer", () => {
    const footer = fs.readFileSync(path.join(process.cwd(), "components", "SiteFooter.tsx"), "utf8");
    expect(footer).toContain('<Link href="/privacy">Privacy</Link>');
  });
});
