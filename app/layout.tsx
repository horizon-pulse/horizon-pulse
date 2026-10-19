import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { PUBLIC_BASE_URL, SERVICE_DESCRIPTION } from "@/lib/config";

export const metadata: Metadata = {
  metadataBase: new URL(PUBLIC_BASE_URL),
  title: "Horizon Pulse",
  description: SERVICE_DESCRIPTION,
  // Brand kit v1 (2026-10-12) §8: favicon set + manifest from favicon/; /icon.png kept for the Bazaar iconUrl.
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/hp-favicon.svg", type: "image/svg+xml" },
    ],
    apple: "/apple-touch-icon.png",
  },
  manifest: "/site.webmanifest",
  openGraph: {
    title: "Horizon Pulse",
    description: SERVICE_DESCRIPTION,
    url: PUBLIC_BASE_URL,
    siteName: "Horizon Pulse",
    type: "website",
  },
};

export const viewport: Viewport = { themeColor: "#08090A" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
          background: "#08090a",
          color: "#e8eefc",
          lineHeight: 1.55,
        }}
      >
        {children}
      </body>
    </html>
  );
}
