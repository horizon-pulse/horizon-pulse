import type { MetadataRoute } from "next";
import { DEMO_ROUTES } from "@/lib/demo-catalog";

const BASE = "https://horizonpulse.dev";

// Public, free pages only. Paid routes are discoverable via /.well-known/x402.
export default function sitemap(): MetadataRoute.Sitemap {
  const pages = ["/", "/docs", "/try", "/status", "/listing-fix", "/llms.txt", "/openapi.json", "/.well-known/x402"];
  return [
    ...pages.map((p) => ({ url: `${BASE}${p}`, changeFrequency: "daily" as const })),
    ...DEMO_ROUTES.map((d) => ({ url: `${BASE}/api/demo/${d.route}`, changeFrequency: "daily" as const })),
  ];
}
