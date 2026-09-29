import type { MetadataRoute } from "next";

// Let every crawler and AI agent index the public docs and discovery files.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/" }],
    sitemap: "https://horizonpulse.dev/sitemap.xml",
    host: "https://horizonpulse.dev",
  };
}
