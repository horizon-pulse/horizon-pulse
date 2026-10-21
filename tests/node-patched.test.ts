import { describe, it, expect } from "vitest";
import { nodePatchedFor } from "@/lib/node-patched";

describe("nodePatchedFor (Sentinel LOW-1)", () => {
  it.each([
    ["v24.21.0", false], ["v24.22.0", false], ["v24.22.1", true], ["v24.23.0", true],
    ["v26.12.0", false], ["v26.12.1", true], ["v26.13.0", true],
    ["v22.23.3", false], ["v22.23.4", true], ["v22.24.0", true],
    ["v20.19.2", false], ["v25.9.9", false], ["v28.0.0", false], ["garbage", false],
  ])("%s -> %s", (v, want) => expect(nodePatchedFor(v)).toBe(want));
});
