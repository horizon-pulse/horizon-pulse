import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Horizon Pulse",
  description:
    "Pay-per-call crypto market pulse and signals for AI agents via x402 on Base",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
          background: "#0b1020",
          color: "#e8eefc",
          lineHeight: 1.55,
        }}
      >
        {children}
      </body>
    </html>
  );
}
