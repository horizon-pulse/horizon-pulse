// node_patched per major line (CVE-2026-111497 + TLS fixes): 24 >= 24.22.1,
// 26 >= 26.12.1, 22 >= 22.23.4; any other line = no. Exact version not disclosed.
const NODE_PATCHED_MIN: Record<number, [number, number]> = { 22: [23, 4], 24: [22, 1], 26: [12, 1] };
export function nodePatchedFor(version: string): boolean {
  const [maj, min, pat] = version.replace(/^v/, "").split(".").map((n) => parseInt(n, 10));
  const req = NODE_PATCHED_MIN[maj];
  if (!req || Number.isNaN(min) || Number.isNaN(pat)) return false;
  return min > req[0] || (min === req[0] && pat >= req[1]);
}
