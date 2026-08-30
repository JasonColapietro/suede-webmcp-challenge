import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import PromoClaimQueue from "@/components/moderation/PromoClaimQueue";
import { resolveModerationReviewer } from "@/lib/moderation/reviewer";
import "../../chrome.css";
import "../../site.css";
import "../moderation.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Promo review queue | Suede Agent Studio",
  robots: { index: false, follow: false },
};

export default async function PromoModerationPage(): Promise<React.JSX.Element> {
  const reviewer = await resolveModerationReviewer();
  if (!reviewer) notFound();
  return (
    <main id="main-content" className="lp lp-shell lp-page">
      <div className="lp-page-head">
        <span className="lp-eyebrow">Suede · Promo human review</span>
        <h1>Claims automation could not decide.</h1>
        <p>
          Suede Promo is the system of record. This page reads live claims and
          writes decisions back to Promo. Nothing about the claim lifecycle is
          stored here.
        </p>
      </div>
      <p className="md-signin">Signed in as <code>{reviewer}</code>.</p>
      <div className="md-queue">
        <PromoClaimQueue />
      </div>
      <p className="md-back"><Link href="/moderation">← Back to safety queue</Link></p>
    </main>
  );
}
