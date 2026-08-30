import type { Metadata } from "next";
import Link from "next/link";
import SiteNav from "@/components/site/SiteNav";
import SiteFooter from "@/components/site/SiteFooter";
import { OG_IMAGE, SITE_URL } from "@/lib/site";
import "../chrome.css";
import "../site.css";
import "./account-deletion.css";

const PAGE_TITLE = "Delete your Suede Agent Studio data";
const PAGE_DESCRIPTION =
  "Request deletion of a Suede Agent Studio workspace and delete an optional shared Suede account.";
const PAGE_URL = `${SITE_URL}/account-deletion`;
const SUPPORT_EMAIL = "support@suedeai.ai";
const DELETE_WORKSPACE_MAILTO =
  `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Delete my Suede Agent Studio workspace")}` +
  `&body=${encodeURIComponent(
    "Please delete my Suede Agent Studio workspace and its associated flows, agents, runs, company records, connections, and payment metadata. I am sending this request from the email on my Suede account. If this is an anonymous workspace, I will add the private workspace key below.\n\nWorkspace key (anonymous workspaces only):\n",
  )}`;

export const metadata: Metadata = {
  title: { absolute: `${PAGE_TITLE} | Suede Agent Studio` },
  description: PAGE_DESCRIPTION,
  alternates: { canonical: "/account-deletion" },
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/account-deletion",
    siteName: "Suede Agent Studio",
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
    images: [
      {
        url: OG_IMAGE,
        width: 1200,
        height: 630,
        alt: "Suede Agent Studio account and data deletion",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    site: "@AISUEDE",
    creator: "@johnnysuede",
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
    images: [OG_IMAGE],
  },
};

export default function AccountDeletionPage(): React.JSX.Element {
  return (
    <div className="lp">
      <SiteNav active="/account-deletion" />

      <main id="main-content" className="lp-shell lp-page ad-page">
        <div className="lp-page-head">
          <span className="lp-eyebrow">Account and data deletion</span>
          <h1>Delete your account and workspace.</h1>
          <p>
            Agent Studio works anonymously by default. If you chose to sign in,
            it also uses your shared Suede account. These are two data stores,
            so this page gives you the deletion path for both.
          </p>
        </div>

        <section className="lp-section">
          <span className="lp-eyebrow">1 · Agent Studio workspace</span>
          <h2>Request deletion of your studio data.</h2>
          <p className="ad-prose">
            Send the request from the email on your Suede account. We will delete
            the Agent Studio workspace associated with that identity, including
            its flows, agents, run history, company records, saved connections,
            and non-required payment metadata. Public blockchain transactions
            cannot be removed from the Base network.
          </p>
          <p className="ad-prose">
            Anonymous workspace? Open your <Link href="/flows">workspace</Link>, reveal
            the private workspace key, and place it in the email. Treat that key
            like a password and send it only to the support address below.
          </p>
          <p className="ad-action">
            <a className="lp-btn lp-btn--primary" href={DELETE_WORKSPACE_MAILTO}>
              Request workspace deletion
            </a>
          </p>
        </section>

        <section className="lp-section">
          <span className="lp-eyebrow">2 · Shared Suede account</span>
          <h2>Delete the optional login.</h2>
          <p className="ad-prose">
            If you signed in with Suede, open the shared profile and use its
            two-step <strong>Delete account</strong> control. That permanently
            removes the shared account and its associated Suede profile and
            content. Request the Agent Studio workspace deletion above as well,
            because the studio uses a separate operational database.
          </p>
          <p className="ad-action">
            <a className="lp-btn lp-btn--ghost" href="https://app.suedeai.ai/profile">
              Open Suede account settings
            </a>
          </p>
        </section>

        <section className="lp-section">
          <h2>Need help?</h2>
          <p className="ad-prose">
            Email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> with
            questions or if you cannot access either deletion path. We may keep
            the minimum records required for fraud prevention, security, tax,
            accounting, dispute resolution, or another legal obligation.
          </p>
        </section>
      </main>

      <SiteFooter />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "WebPage",
            "@id": `${PAGE_URL}#webpage`,
            url: PAGE_URL,
            name: PAGE_TITLE,
            description: PAGE_DESCRIPTION,
            dateModified: "2026-07-19T00:00:00Z",
            isPartOf: { "@id": `${SITE_URL}/#website` },
          }),
        }}
      />
    </div>
  );
}
