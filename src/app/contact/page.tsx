/**
 * Contact page — real, indexable contact route with a support email and
 * ContactPage JSON-LD carrying a ContactPoint for the org.
 */
import type { Metadata } from "next";
import Link from "next/link";
import SiteNav from "@/components/site/SiteNav";
import SiteFooter from "@/components/site/SiteFooter";
import { SITE_URL } from "@/lib/site";
import "../chrome.css";
import "../site.css";
import "./contact.css";

const PAGE_TITLE = "Contact Suede Agent Studio";
const PAGE_DESCRIPTION =
  "Contact the Suede Agent Studio team by email for support, partnerships, or press inquiries.";
const PAGE_URL = `${SITE_URL}/contact`;
const CONTACT_EMAIL = "support@suedeai.ai";
const SECURITY_EMAIL = "security@suedeai.ai";
const LAST_UPDATED = "2026-08-03";

export const metadata: Metadata = {
  title: { absolute: `${PAGE_TITLE} | Suede Agent Studio` },
  description: PAGE_DESCRIPTION,
  alternates: { canonical: "/contact" },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/contact",
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

/** Canonical @id — same node suedeai.ai publishes; see layout.tsx note. */
const SUEDE_ORG_ID = "https://suedeai.ai/#organization";

const contactPageJsonLd = {
  "@context": "https://schema.org",
  "@type": "ContactPage",
  "@id": `${PAGE_URL}#contactpage`,
  url: PAGE_URL,
  name: PAGE_TITLE,
  description: PAGE_DESCRIPTION,
  dateModified: `${LAST_UPDATED}T00:00:00Z`,
  isPartOf: { "@id": `${SITE_URL}/#website` },
  mainEntity: {
    "@id": SUEDE_ORG_ID,
    contactPoint: {
      "@type": "ContactPoint",
      email: CONTACT_EMAIL,
      contactType: "customer support",
      areaServed: "Worldwide",
      availableLanguage: ["English"],
    },
  },
};

const CHANNELS: {
  kicker: string;
  title: string;
  body: string;
  email: string;
}[] = [
  {
    kicker: "Support",
    title: "Product and launch help",
    body: "Stuck on a flow, a launch, a payout setting, or anything else in the studio. This inbox also covers partnerships and press.",
    email: CONTACT_EMAIL,
  },
  {
    kicker: "Security",
    title: "Vulnerability reports",
    body: "Found a security issue? Report it privately and give us a chance to respond before public disclosure. Our disclosure policy lives at /.well-known/security.txt.",
    email: SECURITY_EMAIL,
  },
  {
    kicker: "Data",
    title: "Account and data deletion",
    body: "You can request deletion of a workspace and its data at any time. The account deletion page walks through exactly what is removed.",
    email: CONTACT_EMAIL,
  },
];

export default function ContactPage(): React.JSX.Element {
  return (
    <div className="lp">
      <SiteNav active="/contact" />

      <div id="main-content" className="lp-shell lp-page">
        <div className="lp-page-head">
          <span className="lp-eyebrow">Contact</span>
          <h1>Get in touch.</h1>
          <p>
            We&apos;re a small team and we read every message. Expect a reply
            within one business day.
          </p>
        </div>

        <section className="lp-section" style={{ paddingTop: 0 }}>
          <div className="ct-channels">
            {CHANNELS.map((channel) => (
              <div key={channel.title} className="ct-channel">
                <span className="k">{channel.kicker}</span>
                <h2>{channel.title}</h2>
                <p>{channel.body}</p>
                <a className="addr" href={`mailto:${channel.email}`}>
                  {channel.email}
                </a>
              </div>
            ))}
          </div>
          <p className="ct-note">
            Deletion requests start at the{" "}
            <Link href="/account-deletion">account and data deletion page</Link>;
            the full disclosure policy is on the{" "}
            <Link href="/security">security page</Link>.
          </p>
        </section>

        <section className="lp-section">
          <span className="lp-eyebrow">Before you write</span>
          <h2 className="lp-section-title">Most answers are already public.</h2>
          <p className="ct-browse" style={{ marginTop: "0.9rem" }}>
            The <Link href="/docs">docs</Link> cover how launches, pricing, and
            payouts work, the <Link href="/agents">agent directory</Link> lists
            everything live right now, the <Link href="/status">status page</Link>{" "}
            answers &ldquo;is it up?&rdquo; with real checks, and the{" "}
            <Link href="/about">about page</Link> and{" "}
            <Link href="/founder">founder page</Link> cover who builds this.
          </p>
        </section>

        <section className="lp-cta-band">
          <span className="lp-eyebrow" style={{ color: "var(--primary)" }}>
            Ready to build
          </span>
          <h2>Launch an agent that earns.</h2>
          <Link href="/start" className="lp-btn lp-btn--primary">
            Start building →
          </Link>
        </section>

        <p className="ct-updated">
          Page last updated <time dateTime={LAST_UPDATED}>{LAST_UPDATED}</time>.
        </p>
      </div>

      <SiteFooter />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(contactPageJsonLd) }}
      />
    </div>
  );
}
