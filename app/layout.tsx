import type { Metadata } from "next";
import type { ReactNode } from "react";
import { PUBLIC_BASE_URL, SERVICE_DESCRIPTION } from "@/lib/config";

export const metadata: Metadata = {
  metadataBase: new URL(PUBLIC_BASE_URL),
  title: "Horizon Pulse",
  description: SERVICE_DESCRIPTION,
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/brand/favicon-16.png", type: "image/png", sizes: "16x16" },
      { url: "/brand/favicon-32.png", type: "image/png", sizes: "32x32" },
      { url: "/brand/hp-icon-dark.svg", type: "image/svg+xml" },
      { url: "/icon.png", type: "image/png", sizes: "256x256" },
    ],
    apple: { url: "/brand/apple-touch-icon.png", sizes: "180x180" },
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
