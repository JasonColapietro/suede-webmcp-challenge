import type { Metadata } from "next";
import { withDefaultSocialImages } from "@/lib/social-metadata";
import Link from "next/link";
import SiteNav from "@/components/site/SiteNav";
import SiteFooter from "@/components/site/SiteFooter";
import TemplateFacts from "../TemplateFacts";
import "../../chrome.css";
import "../../site.css";

export const metadata: Metadata = withDefaultSocialImages({
  title: { absolute: "AI Review Response Agent: Reply to Every Review | Suede Agent Studio" },
  description:
    "Draft a specific review reply only after approval, then send it to your team through a reviewed Slack webhook Connection.",
  alternates: { canonical: "/templates/review-responder" },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/templates/review-responder",
    siteName: "Suede Agent Studio",
    title: "AI Review Response Agent: Reply to Every Review | Suede Agent Studio",
    description:
      "Draft a specific review reply only after approval, then deliver it through a reviewed Slack webhook Connection.",
  },
  twitter: {
    card: "summary_large_image",
    title: "AI Review Response Agent: Reply to Every Review | Suede Agent Studio",
    description:
      "Draft a specific review reply only after approval, then deliver it through a reviewed Slack webhook Connection.",
    site: "@AISUEDE",
    creator: "@johnnysuede",
  },
});

const WHY_IT_WORKS = [
  {
    color: "var(--text-info)",
    label: "Reads the specific review",
    body: "The agent parses the exact language the reviewer used (star rating, specific complaint, specific praise) and reflects it back. The response addresses what they actually said, not a template category.",
  },
  {
    color: "var(--text-success)",
    label: "Matches your brand voice",
    body: "You supply your product name and a sentence or two about your tone. The agent adapts, whether that's warm and casual, direct and professional, or somewhere in between. It sounds like you, not a support bot.",
  },
  {
    color: "var(--text-warning)",
    label: "Under 80 words every time",
    body: "App Store and G2 reviewers don't want an essay. The agent keeps every response tight, scannable, and useful: the kind of reply that makes future readers trust the product, not just placate the reviewer.",
  },
];

const STEPS = [
  {
    step: "01",
    text: "Paste the review text and your product name. Optionally add a voice note: one sentence describing your brand tone.",
  },
  {
    step: "02",
    text: "The agent drafts a warm, specific response in your voice, referencing the reviewer's exact words and addressing their experience directly.",
  },
  {
    step: "03",
    text: "The approved branch sends the draft to Slack for the team. Preview never posts; live delivery requires a reviewed Slack webhook Connection.",
  },
];

export default function ReviewResponderPage(): React.JSX.Element {
  return (
    <div className="lp">
      <SiteNav active="/templates" />
      <main id="main-content" className="lp-shell lp-page">
        <header className="lp-page-head">
          <span className="lp-eyebrow">Reputation Management</span>
          <h1>Respond to every review without sounding like a robot</h1>
          <p>
            The Review Responder agent reads each review (App Store, G2, or product page)
            and drafts a specific, on-brand reply. It references what the reviewer
            actually said. It never writes &ldquo;we apologize for the inconvenience.&rdquo;
            An approval branch gates the draft before Slack delivery.
          </p>
        </header>

        <TemplateFacts slug="review-responder" />

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
            <span className="lp-eyebrow">Why it works</span>
          </div>
          {WHY_IT_WORKS.map((card) => (
            <div key={card.label} className="card" style={{ padding: "1.5rem" }}>
              <span className="eyebrow" style={{ color: card.color }}>
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
            From raw review to ready-to-post reply in seconds
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
            First response is free
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
            Try it on a real review. Takes 10 seconds.
          </p>
          <Link href="/build/new?template=review-responder" className="lp-btn lp-btn--primary">
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
