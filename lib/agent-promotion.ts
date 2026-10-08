/**
 * Agent promotion service: shared copy for /agent-promotion, /agent-promotion/spec
 * and /agent-promotion/start. Copy is from Forge's site-spec-and-copy-v1.md
 * (2026-10-08); prices and refund copy are class A (Odin signed 2026-10-07 11:40 PM ET).
 * Docs only: no payment logic, no storage. Intake is a prefilled mailto.
 */
import { CONTACT_EMAIL } from "./config";

/**
 * Service fees go to the same address as /listing-fix fees (the owner's Ledger),
 * not the API payTo. Must equal FEE_ADDRESS in app/listing-fix/page.tsx.
 */
export const SERVICE_FEE_ADDRESS = "0x330055d2b9B509079992Bb5712f1C9DcE32eb547";

/** CDP doc that states the Bazaar description limit (verified 2026-10-08). */
export const CDP_DESCRIPTION_LIMIT_DOC = "https://docs.cdp.coinbase.com/x402/validate-endpoint#my-endpoint-is-indexed-but-ranks-poorly";

export const INTAKE_SUBJECT_PREFIX = "Agent promotion intake: ";

/** Refund copy, verbatim (Forge proposal + Odin's appended sentence). */
export const REFUND_LINES = [
  { k: "Setup", v: "If we can't deliver the setup, you get the $149 back in full." },
  {
    k: "Directories",
    v: "Directory acceptance and ranking are decided by each directory, so they aren't refundable once the pack and submissions are delivered.",
  },
  { k: "Monitoring", v: "Cancel monitoring anytime; the current month isn't refunded." },
  { k: "Declined jobs", v: "If we decline a job after reviewing your intake, nothing is charged, or the payment is returned in full." },
] as const;

export const HONESTY_LINE =
  "Where a directory needs the owner's own account or namespace proof (for example the MCP Registry or npm), we prepare a ready-to-submit pack and you submit it under your account. We submit directly only where a directory allows third-party submissions.";

export const TURNAROUND_LINE = "Target: setup delivered within 5 business days of payment and a complete intake.";

export const WE_DONT = [
  "No fake reviews",
  "No paid rankings",
  "No bulk or spam submissions",
  "No sock-puppet accounts",
  "No guaranteed placement or ranking",
  "No guaranteed traffic or revenue",
];

export function intakeHost(apiUrl: string): string {
  const s = apiUrl.trim();
  if (!s) return "{host}";
  try {
    return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).host || s;
  } catch {
    return s;
  }
}

export type IntakeFields = { apiUrl: string; email: string; description: string; routes: string };

export function intakeMailto(f: IntakeFields): string {
  const subject = `${INTAKE_SUBJECT_PREFIX}${intakeHost(f.apiUrl)}`;
  const body = [
    `API URL: ${f.apiUrl.trim() || "{https://api.example.com}"}`,
    `Contact email: ${f.email.trim() || "{you@example.com}"}`,
    `Number of paid routes (optional): ${f.routes.trim()}`,
    "",
    "Short description:",
    f.description.trim() || "{what your API does and who calls it}",
  ].join("\n");
  return `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
