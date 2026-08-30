import type { Metadata } from "next";
import { withDefaultSocialImages } from "@/lib/social-metadata";
import Link from "next/link";
import SiteNav from "@/components/site/SiteNav";
import SiteFooter from "@/components/site/SiteFooter";
import TemplateFacts from "../TemplateFacts";
import "../../chrome.css";
import "../../site.css";

export const metadata: Metadata = withDefaultSocialImages({
  title: { absolute: "AI Competitor Tracking Agent | Suede Agent Studio" },
  description:
    "An AI agent that runs weekly and returns a structured competitor brief: pricing changes, feature launches, messaging shifts. $0.15 per brief.",
  alternates: { canonical: "/templates/competitor-tracker" },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/templates/competitor-tracker",
    siteName: "Suede Agent Studio",
    title: "AI Competitor Tracking Agent | Suede Agent Studio",
    description:
      "An AI agent that runs weekly and returns a structured competitor brief: pricing changes, feature launches, messaging shifts. $0.15 per brief.",
  },
  twitter: {
    card: "summary_large_image",
    title: "AI Competitor Tracking Agent | Suede Agent Studio",
    description:
      "An AI agent that runs weekly and returns a structured competitor brief: pricing changes, feature launches, messaging shifts. $0.15 per brief.",
    site: "@AISUEDE",
    creator: "@johnnysuede",
  },
});

const TRACKS = [
  {
    color: "var(--text-warning)",
    label: "Pricing changes",
    body: "The agent flags any shift in published pricing pages, plan structures, or promotional offers across your competitor list. You see the old price, the new price, and when it changed.",
  },
  {
    color: "var(--text-success)",
    label: "Feature launches",
    body: "New product pages, changelog entries, and release announcements are surfaced and summarized the moment they go public. Know what shipped before your next sales call.",
  },
  {
    color: "var(--primary)",
    label: "Messaging shifts",
    body: "Homepage headlines, taglines, and positioning copy drift over time. The agent tracks those changes and tells you when a competitor repositions, so you can respond or exploit the gap.",
  },
];

const STEPS = [
  {
    step: "01",
    text: "Set your competitors list. Paste in the domains you want watched, as many as you need.",
  },
  {
    step: "02",
    text: "Agent analyzes publicly available signals every Monday at 8 AM. No logins, no scrapers to maintain.",
  },
  {
    step: "03",
    text: "Get a structured brief: new features, pricing deltas, messaging changes, and weaknesses to exploit, ready before your week starts.",
  },
];

export default function CompetitorTrackerPage(): React.JSX.Element {
  return (
    <div className="lp">
      <SiteNav active="/templates" />
      <main id="main-content" className="lp-shell lp-page">
        <header className="lp-page-head">
          <span className="lp-eyebrow">Competitive Intelligence</span>
          <h1>Know every competitor move before Monday</h1>
          <p>
            This agent runs weekly, scans your competitors&apos; public signals, and
            delivers a structured brief covering pricing changes, feature launches, and
            messaging shifts. Weekly competitive intelligence for $0.15 per brief, no
            analyst on retainer.
          </p>
        </header>

        <TemplateFacts slug="competitor-tracker" />

        <section
          style={{
            marginTop: "3.5rem",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
            gap: "1.25rem",
          }}
        >
          <div
            style={{
              gridColumn: "1 / -1",
              marginBottom: "0.25rem",
            }}
          >
            <span className="lp-eyebrow">What it tracks</span>
          </div>
          {TRACKS.map((t) => (
            <div key={t.label} className="card" style={{ padding: "1.5rem" }}>
              <span
                className="eyebrow"
                style={{ color: t.color }}
              >
                {t.label}
              </span>
              <p
                style={{
                  color: "var(--text-muted)",
                  lineHeight: 1.65,
                  fontSize: "var(--text-sm)",
                  marginTop: "0.6rem",
                }}
              >
                {t.body}
              </p>
            </div>
          ))}
        </section>

        <section style={{ marginTop: "3.5rem" }}>
          <span className="lp-eyebrow">How it works</span>
          <h2
            style={{
              fontFamily: "var(--font-display)",
              fontWeight: 400,
              fontSize: "var(--text-h2)",
              marginTop: "0.5rem",
              marginBottom: "1.5rem",
            }}
          >
            Set it once. Brief lands every Monday.
          </h2>
          <ol
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              display: "flex",
              flexDirection: "column",
              gap: "1rem",
              counterReset: "steps",
            }}
          >
            {STEPS.map((item) => (
              <li
                key={item.step}
                className="card"
                style={{
                  padding: "1.1rem 1.5rem",
                  display: "flex",
                  gap: "1.25rem",
                  alignItems: "flex-start",
                }}
              >
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "0.7rem",
                    letterSpacing: "0.1em",
                    color: "var(--primary)",
                    fontWeight: 700,
                    flexShrink: 0,
                    paddingTop: "2px",
                  }}
                >
                  {item.step}
                </span>
                <p
                  style={{
                    margin: 0,
                    color: "var(--text-muted)",
                    lineHeight: 1.6,
                    fontSize: "var(--text-sm)",
                  }}
                >
                  {item.text}
                </p>
              </li>
            ))}
          </ol>
        </section>

        <section
          style={{
            marginTop: "4rem",
            padding: "3rem",
            background: "var(--canvas-bg)",
            borderRadius: "var(--radius)",
            border: "1px solid var(--hairline)",
            textAlign: "center",
          }}
        >
          <span className="lp-eyebrow">Start building</span>
          <h2
            style={{
              fontFamily: "var(--font-display)",
              fontWeight: 400,
              fontSize: "var(--text-h2)",
              marginTop: "0.75rem",
              marginBottom: "1rem",
            }}
          >
            Your first brief is free
          </h2>
          <p
            style={{
              color: "var(--text-muted)",
              maxWidth: "44ch",
              marginInline: "auto",
              marginBottom: "1.75rem",
              lineHeight: 1.6,
            }}
          >
            Set up your tracker in minutes. First brief runs Monday at 8 AM so it&apos;s
            waiting when you open your laptop.
          </p>
          <Link href="/build/new?template=competitor-tracker" className="lp-btn lp-btn--primary">
            Open this template →
          </Link>
          <div className="tg-detail-back">
            <Link href="/templates" className="lp-tpl-more-link">
              Browse all templates →
            </Link>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
