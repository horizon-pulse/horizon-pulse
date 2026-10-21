/** LOCAL ONLY: `node scripts/test-redis-caps.mjs`. Not picked up by `npm test` (vitest.config.ts includes tests/** only). */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
const root = fileURLToPath(new URL(".", import.meta.url));
export default defineConfig({ resolve: { alias: { "@": root.replace(/\/$/, "") } }, test: { include: ["tests-local/redis-caps.test.ts"], environment: "node", pool: "forks", testTimeout: 30_000 } });
