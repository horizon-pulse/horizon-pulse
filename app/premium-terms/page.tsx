import { notFound } from "next/navigation";
import { BUYER_TERMS } from "@/lib/premium/copy";
import { premiumEnabled } from "@/lib/premium/tiers";

export const dynamic = "force-dynamic";

/** Premium buyer terms (Counsel cond. 1). 404 while HP_PREMIUM_ENABLED is off. */
export default function PremiumTermsPage() {
  if (!premiumEnabled()) notFound();
  return (
    <main style={{ maxWidth: 760, margin: "40px auto", padding: "0 20px", lineHeight: 1.6 }}>
      <h1>Horizon Pulse premium terms</h1>
      {BUYER_TERMS.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
    </main>
  );
}
