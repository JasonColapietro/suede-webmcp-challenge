/**
 * Privacy policy — discloses the agx_owner cookie (set in src/middleware.ts),
 * PostHog analytics (src/lib/posthog.ts), and how wallet/x402 payment data is
 * handled. Every claim below is grounded in the actual implementation; see
 * the inline references if this ever needs re-verifying against the code.
 */
import type { Metadata } from "next";
import Link from "next/link";
import SiteNav from "@/components/site/SiteNav";
import SiteFooter from "@/components/site/SiteFooter";
import { SITE_URL } from "@/lib/site";
import "../chrome.css";
import "../site.css";
import "./privacy.css";

const PAGE_TITLE = "Privacy Policy";
const PAGE_DESCRIPTION =
  "How Suede Agent Studio handles cookies, agent inputs and outputs, and wallet addresses used for x402/USDC payments.";
const PAGE_URL = `${SITE_URL}/privacy`;
const LAST_UPDATED = "2026-07-20";
const CONTACT_EMAIL = "support@suedeai.ai";

export const metadata: Metadata = {
  title: { absolute: `${PAGE_TITLE} | Suede Agent Studio` },
  description: PAGE_DESCRIPTION,
  alternates: { canonical: "/privacy" },
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/privacy",
    siteName: "Suede Agent Studio",
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    site: "@AISUEDE",
    creator: "@johnnysuede",
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
  },
};

const privacyPageJsonLd = {
  "@context": "https://schema.org",
  "@type": "WebPage",
  "@id": `${PAGE_URL}#webpage`,
  url: PAGE_URL,
  name: `${PAGE_TITLE} | Suede Agent Studio`,
  description: PAGE_DESCRIPTION,
  dateModified: `${LAST_UPDATED}T00:00:00Z`,
  isPartOf: { "@id": `${SITE_URL}/#website` },
};

export default function PrivacyPage(): React.JSX.Element {
  return (
    <div className="lp">
      <SiteNav active="/privacy" />

      <div id="main-content" className="lp-shell lp-page pv-page">
        <div className="lp-page-head">
          <span className="lp-eyebrow">Privacy</span>
          <h1>Privacy Policy.</h1>
          <p>
            Suede Agent Studio (agents.suedeai.ai) is a product of Suede Labs
            AI. This page explains what we collect, why, and who we share it
            with.
          </p>
        </div>

        <section className="lp-section" style={{ paddingTop: 0 }}>
          <h2>What we collect</h2>
          <ul className="pv-list">
            <li>
              A first-party cookie (<code>agx_owner</code>) that identifies
              your browser so you can come back to the flows and agents
              you&apos;ve built. It&apos;s HttpOnly and SameSite=Lax, set for
              up to one year, and carries no personal information, just a
              random identifier.
            </li>
            <li>
              Product analytics on page views and in-app usage, via PostHog,
              so we can see what&apos;s working and what&apos;s confusing. We
              don&apos;t record session replays, and analytics respects your
              browser&apos;s Do Not Track setting.
            </li>
            <li>
              Agent inputs and outputs you submit when you dry-run or run a
              flow, so the flow can execute and so you can see your own run
              history.
            </li>
            <li>
              Wallet addresses used to receive or send x402/USDC payments, if
              you launch a paid agent or call one.
            </li>
          </ul>
        </section>

        <section className="lp-section">
          <h2>How we use it</h2>
          <ul className="pv-list">
            <li>To associate your flows, launched agents, and runs with your browser or account.</li>
            <li>To route x402 payments to the correct wallet when an agent you launched gets called.</li>
            <li>To operate, debug, and improve the product.</li>
            <li>We do not sell personal data.</li>
          </ul>
        </section>

        <section className="lp-section">
          <h2>Third parties</h2>
          <ul className="pv-list">
            <li>
              <strong>Hosting:</strong>{" "}
              Vercel.
            </li>
            <li>
              <strong>Database:</strong>{" "}
              Supabase, for flows, agents, and run records.
            </li>
            <li>
              <strong>Analytics:</strong>{" "}
              PostHog, for product usage.
            </li>
            <li>
              <strong>Payment settlement:</strong>{" "}
              USDC on Base. Settlement happens on a public blockchain: wallet
              addresses and transaction amounts involved in a payment are
              visible on-chain by the design of the network, independent of
              anything we do.
            </li>
            <li>
              <strong>Model calls:</strong>{" "}
              agent flows you run may call third-party LLM providers to
              produce their output. We don&apos;t use your inputs to train
              models.
            </li>
          </ul>
        </section>

        <section className="lp-section">
          <h2>Your choices</h2>
          <p className="pv-prose">
            Use the <Link href="/account-deletion">account and data deletion page</Link>{" "}
            to request removal of an Agent Studio workspace and, if applicable,
            delete the optional shared Suede account. You can also contact{" "}
            <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>{" "}
            to request export of your data or with any privacy question. Public
            blockchain transactions cannot be deleted. We typically reply within
            one business day; see the <Link href="/contact">contact page</Link>.
          </p>
        </section>

        <p className="pv-updated">
          Last updated <time dateTime={LAST_UPDATED}>{LAST_UPDATED}</time>.
        </p>
      </div>

      <SiteFooter />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(privacyPageJsonLd) }}
      />
    </div>
  );
}
