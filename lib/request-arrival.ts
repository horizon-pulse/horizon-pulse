/**
 * Request-arrival clock for routes whose handler runs after other work
 * (x402 verify, MCP setup) inside the same platform maxDuration.
 *
 * The route entry point wraps the whole request in withRequestArrival(); a
 * handler deep inside (after withX402 verify, or inside an MCP tool call)
 * reads requestArrivedAt() to budget from when the request actually arrived,
 * not from when the handler started. AsyncLocalStorage carries it through
 * awaits; nothing comes from the client (no header), so it cannot be spoofed.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const arrival = new AsyncLocalStorage<number>();

export function withRequestArrival<T>(fn: () => T, now: () => number = Date.now): T {
  return arrival.run(now(), fn);
}

/** Epoch ms when the current request arrived, or undefined outside a wrapped request. */
export function requestArrivedAt(): number | undefined {
  return arrival.getStore();
}
