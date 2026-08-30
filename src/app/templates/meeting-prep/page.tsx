import type { Metadata } from "next";
import Link from "next/link";
import SiteNav from "@/components/site/SiteNav";
import SiteFooter from "@/components/site/SiteFooter";
import TemplateFacts from "../TemplateFacts";
import "../../chrome.css";
import "../../site.css";

export const metadata: Metadata = {
  title: { absolute: "AI Meeting Prep Agent: 1-Page Brief in Seconds | Suede Agent Studio" },
  description:
    "Automate meeting preparation with an AI agent that generates a 1-page brief: company summary, talking points, risks, and the single most important outcome. $0.08 per brief.",
  alternates: { canonical: "/templates/meeting-prep" },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/templates/meeting-prep",
    siteName: "Suede Agent Studio",
    title: "AI Meeting Prep Agent: 1-Page Brief in Seconds | Suede Agent Studio",
    description:
      "Automate meeting preparation with an AI agent that generates a 1-page brief: company summary, talking points, risks, and the single most important outcome. $0.08 per brief.",
  },
  twitter: {
    card: "summary_large_image",
    title: "AI Meeting Prep Agent: 1-Page Brief in Seconds | Suede Agent Studio",
    description:
      "Automate meeting preparation with an AI agent that generates a 1-page brief: company summary, talking points, risks, and the single most important outcome. $0.08 per brief.",
    site: "@AISUEDE",
    creator: "@johnnysuede",
  },
};

const BRIEF_CARDS = [
  {
    color: "var(--primary)",
    label: "Attendee background",
    body: "The agent surfaces the contact's role, recent public activity, and company context before you ever open your notes. You arrive knowing who you're talking to and what matters to them right now.",
  },
  {
    color: "var(--text-success)",
    label: "3 talking points",
    body: "Three sharp angles tuned to your stated goal, whether that's closing a deal, scoping a partnership, or landing a referral. Each point is one sentence so you can glance at it mid-call.",
  },
  {
    color: "var(--text-warning)",
    label: "2 risks to watch",
    body: "The brief flags the two most likely friction points based on the company's situation and your stated objective. Knowing the objection before it lands is the only real prep that matters.",
  },
];

const STEPS = [
  {
    step: "01",
    heading: "Paste the meeting context.",
    text: "Drop in the company name, the contact's title, and the one outcome you need from the call.",
  },
  {
    step: "02",
    heading: "Agent researches and formats.",
    text: "The agent pulls company signals, structures the brief around your goal, and returns a clean single-page document.",
  },
  {
    step: "03",
    heading: "Read it in 2 minutes. Walk in confident.",
    text: "The brief is designed to be skimmable in the elevator. No fluff, no filler, just what changes the outcome.",
  },
];

export default function MeetingPrepPage(): React.JSX.Element {
  return (
    <div className="lp">
      <SiteNav active="/templates" />
      <main id="main-content" className="lp-shell lp-page">
        <header className="lp-page-head">
          <span className="lp-eyebrow">Meeting Intelligence</span>
          <h1>Walk into every meeting with a full brief</h1>
          <p>
            Paste the company, the contact, and your goal. The agent generates a
            1-page prep brief: company summary, three talking points, two risks
            to watch, and the single most important outcome to drive. $0.08 per
            brief. No research tab open, no scrambling five minutes before.
          </p>
        </header>

        <TemplateFacts slug="meeting-prep" />

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
              marginBottom: "0.5rem",
              gridColumn: "1 / -1",
            }}
          >
            <span className="lp-eyebrow">What&apos;s in the brief</span>
          </div>
          {BRIEF_CARDS.map((card) => (
            <div key={card.label} className="card" style={{ padding: "1.5rem" }}>
              <span
                className="eyebrow"
                style={{ color: card.color }}
              >
                {card.label}
              </span>
              <p
                style={{
                  color: "var(--text-muted)",
                  lineHeight: 1.65,
                  fontSize: "var(--text-sm)",
                  marginTop: "0.6rem",
                }}
              >
                {card.body}
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
            Three steps from context to confidence
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
                  {item.heading} {item.text}
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
            First brief is free
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
            Dry-run your first meeting prep now. No wallet required.
          </p>
          <Link href="/build/new?template=meeting-prep" className="lp-btn lp-btn--primary">
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
