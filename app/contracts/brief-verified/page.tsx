import { notFound } from "next/navigation";
import { BRIEF_SCHEMA_VERSION, OUTCOME_CONTRACT } from "@/lib/premium/contract";
import { premiumEnabled } from "@/lib/premium/tiers";

export const dynamic = "force-dynamic";

/** Hardened brief spec §1 (published verbatim) + fixed schema version. 404 while HP_PREMIUM_ENABLED is off. */
export default function BriefVerifiedContractPage() {
  if (!premiumEnabled()) notFound();
  return (
    <main style={{ maxWidth: 760, margin: "40px auto", padding: "0 20px", lineHeight: 1.6 }}>
      <h1>Verified brief: outcome contract</h1>
      <p>Schema: <code>{BRIEF_SCHEMA_VERSION}</code></p>
      <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit" }}>{OUTCOME_CONTRACT}</pre>
      <h2>Why “official” is not single-source</h2>
      <p>For x402 specification facts, the specification's own publishers are the source of record. An official claim needs two different documents from those publishers stating the same fact (mirrored copies of one page count as one). Specification pages carry no effective date, so none is required.</p>
      <h2>Evidence array (per claim)</h2>
      <p>Quote evidence: <code>{"{ kind: \"quote\", quote, url, retrieved_at, publisher, body_sha256, offset, official_url? }"}</code>. On-chain evidence: <code>{"{ kind: \"onchain\", chain, block, block_timestamp, method, contract?, value, unit, node, retrieved_at }"}</code>, one entry per independent node. body_sha256 and offset are computed over the page text as extracted, markdown-stripped and whitespace-normalised.</p>
    </main>
  );
}
