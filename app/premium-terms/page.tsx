import { notFound } from "next/navigation";
import { tierAllowed } from "@/lib/premium/tiers";
import { AI_PROVIDER_TERMS, BUYER_TERMS, NOT_CURRENTLY_OFFERED, TECHNICAL_NOTES } from "@/lib/premium/copy";
import { premiumLlmEnabled } from "@/lib/premium/synthesis";
import { listedTiers } from "@/lib/premium/tiers";
import { DD_DISPUTE_TERM, DD_PASS_NOTE, DD_RETENTION_TERM, sellerDdEnabled } from "@/lib/seller-dd/config";

export const dynamic = "force-dynamic";

/** Premium buyer terms (Counsel cond. 1). 404 while HP_PREMIUM_ENABLED is off. */
export default function PremiumTermsPage() {
  if (listedTiers().length === 0) notFound();
  return (
    <main style={{ maxWidth: 760, margin: "40px auto", padding: "0 20px", lineHeight: 1.6 }}>
      <h1>Horizon Pulse premium terms</h1>
      {!tierAllowed("standard") && !tierAllowed("extended") && <p><strong>{NOT_CURRENTLY_OFFERED}</strong></p>}
      {BUYER_TERMS.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
      {premiumLlmEnabled() && (
        <>
          <h2>AI-assisted quote selection</h2>
          {AI_PROVIDER_TERMS.map((p, i) => (
            <p key={`ai${i}`}>{p}</p>
          ))}
        </>
      )}
      {sellerDdEnabled() && (
        <>
          <h2>Seller due-diligence verdicts</h2>
          <p>{DD_PASS_NOTE}</p>
          <p>{DD_RETENTION_TERM}</p>
          <p>{DD_DISPUTE_TERM}</p>
        </>
      )}
      <h2>How the status link and redeem work</h2>
      {TECHNICAL_NOTES.map((p, i) => (
        <p key={`t${i}`}>{p}</p>
      ))}
    </main>
  );
}
