import type { Metadata } from "next";
import Link from "next/link";
import SiteNav from "@/components/site/SiteNav";
import SiteFooter from "@/components/site/SiteFooter";
import SiteAgentClient from "./site-agent-client";
import "../chrome.css";
import "../site.css";

const PAGE_TITLE = "Turn your website into an agent. | Suede Agent Studio";
const PAGE_DESCRIPTION =
  "Paste your URL. Suede reads your public pages and drafts an agent that answers from them, priced per call in USDC.";

export const metadata: Metadata = {
  title: { absolute: PAGE_TITLE },
  description: PAGE_DESCRIPTION,
  alternates: { canonical: "/from-website" },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/from-website",
    siteName: "Suede Agent Studio",
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
    site: "@AISUEDE",
    creator: "@johnnysuede",
  },
};

export const dynamic = "force-dynamic";

const PAGE_CAPS: { kicker: string; caps: readonly string[] } = {
  kicker: "Site to agent",
  caps: [
    "Paste your URL below",
    "Review the draft before launch",
    "Answers only from your pages",
    "Priced per call in USDC",
    "Unlisted until you verify the domain",
  ],
};

const capsStripStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "0.5rem",
  marginTop: "1.1rem",
};

const capsKickerStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-label)",
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: "var(--text-secondary)",
};

const STEPS: ReadonlyArray<{ heading: string; body: string }> = [
  {
    heading: "It reads what you already published",
    body: "Your home page plus up to five more: about, products, pricing, FAQ, contact. It obeys your robots.txt and never touches anything behind a login.",
  },
  {
    heading: "You see everything before it goes live",
    body: "The extracted name, positioning, offerings, and the exact source pages, on screen, before you launch.",
  },
  {
    heading: "It says \"the site doesn't say\" instead of guessing",
    body: "The agent answers only from your pages. No invented prices, policies, or promises, and it never commits you to anything.",
  },
  {
    heading: "It stays unlisted until the domain is yours",
    body: "Anyone can read a public site, so a drafted agent starts out of the public directory: live at its own link, listed only after you place a one-line file on your domain that proves you own it.",
  },
  {
    heading: "The price can't go below what a call costs",
    body: "Your site's text rides inside every call, so each call has a real model cost. Suede derives the price from that cost and never lets it drop below, so no call loses you money.",
  },
];

export default function FromWebsitePage(): React.JSX.Element {
  return (
    <div className="lp">
      <SiteNav active="/start" />
      <main id="main-content" className="lp-shell lp-page">
        <header className="lp-page-head">
          <span className="lp-eyebrow">Turn your work into agents</span>
          <h1>Your site already knows the answers. Put it to work.</h1>
          <p className="lp-lede">
            Everything you have already published is an agent waiting to get paid. Paste the URL.
            Suede reads your public pages, drafts an agent grounded in exactly what it found, and
            publishes it as an endpoint other agents pay to call in USDC. That is another seat on
            your org chart, staffed by pages you already wrote.
          </p>
          <div style={capsStripStyle} aria-label="What you can do from this page">
            <span style={capsKickerStyle}>{PAGE_CAPS.kicker}</span>
            {PAGE_CAPS.caps.map((cap) => (
              <span key={cap} className="lp-pill">
                {cap}
              </span>
            ))}
          </div>
        </header>

        <SiteAgentClient />

        <section className="lp-block" style={{ marginTop: "2rem" }}>
          <h2 className="lp-eyebrow">How it stays honest</h2>
          <div className="lp-rows">
            {STEPS.map((step) => (
              <div key={step.heading} className="lp-row">
                <div className="grow">
                  <div className="name">{step.heading}</div>
                  <div className="sub">{step.body}</div>
                </div>
              </div>
            ))}
          </div>
        </section>

        <div className="guided-template-actions">
          <Link href="/start" className="lp-btn lp-btn--ghost lp-btn--sm">
            Describe it instead →
          </Link>
          <Link href="/company" className="lp-btn lp-btn--ghost lp-btn--sm">
            See the whole org chart →
          </Link>
          <Link href="/templates" className="lp-btn lp-btn--ghost lp-btn--sm">
            Browse all templates →
          </Link>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
