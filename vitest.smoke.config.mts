import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

/** Read-only network smoke (not part of `npm test`): `npx vitest run -c vitest.smoke.config.mts`. */
export default defineConfig({
  resolve: { alias: { "@": root.replace(/\/$/, "") } },
  test: {
    include: ["tests/smoke/**/*.smoke.ts"],
    environment: "node",
    pool: "forks",
    testTimeout: 60_000,
    server: { deps: { inline: [/@x402\/next/] } },
  },
});
