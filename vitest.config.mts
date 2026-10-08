import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: { alias: { "@": root.replace(/\/$/, "") } },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Each file gets a fresh module graph + process.env copy.
    pool: "forks",
    testTimeout: 30_000,
    // @x402/next imports "next/server" without an extension; let Vite resolve it.
    server: { deps: { inline: [/@x402\/next/] } },
  },
});
