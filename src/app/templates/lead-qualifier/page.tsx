import type { Metadata } from "next";
import Link from "next/link";
import SiteNav from "@/components/site/SiteNav";
import SiteFooter from "@/components/site/SiteFooter";
import TemplateFacts from "../TemplateFacts";
import "../../chrome.css";
import "../../site.css";

export const metadata: Metadata = {
  title: { absolute: "AI Lead Qualifier Agent: Score and Deliver Every Lead | Suede Agent Studio" },
  description:
    "Score inbound leads 1–10 against your ICP, explain the next action, and deliver the qualification through a reviewed CRM webhook Connection.",
  alternates: { canonical: "/templates/lead-qualifier" },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/templates/lead-qualifier",
    siteName: "Suede Agent Studio",
    title: "AI Lead Qualifier Agent: Score and Deliver Every Lead | Suede Agent Studio",
    description:
      "Score inbound leads against your ICP, explain the next action, and deliver the result through a reviewed CRM webhook Connection.",
  },
  twitter: {
    card: "summary_large_image",
    title: "AI Lead Qualifier Agent: Score and Deliver Every Lead | Suede Agent Studio",
    description:
      "Score inbound leads against your ICP, explain the next action, and deliver the result through a reviewed CRM webhook Connection.",
    site: "@AISUEDE",
    creator: "@johnnysuede",
  },
};

const WHAT_YOU_GET = [
  {
    color: "var(--primary)",
    label: "Fit score 1–10",
    body: "Every lead gets a numeric score against your ideal customer profile, plus a reason and next action. The CRM step delivers that complete qualification after you bind its Connection.",
  },
  {
    color: "var(--text-success)",
    label: "Next action",
    body: "The agent doesn't just score; it decides what to do next. Book a call, send a case study, or pass to nurture. The recommended action is included in every response.",
  },
  {
    color: "var(--text-warning)",
    label: "Reason why",
    body: "A one-sentence explanation accompanies every score so your team understands the logic and can override when context matters. No black-box outputs.",
  },
];

export default function LeadQualifierPage(): React.JSX.Element {
  return (
    <div className="lp">
      <SiteNav active="/templates" />
      <main id="main-content" className="lp-shell lp-page">
        <header className="lp-page-head">
          <span className="lp-eyebrow">Lead Scoring</span>
          <h1>Score each lead, then deliver the next action</h1>
          <p>
            The Lead Qualifier agent scores inbound leads against your ideal customer profile
            and returns a fit score, a plain-English reason, and a recommended next action.
            Its CRM Webhook step delivers the result after you bind a reviewed Connection;
            preview never calls the CRM.
          </p>
        </header>

        <TemplateFacts slug="lead-qualifier" />

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
            <span className="lp-eyebrow">What you get</span>
          </div>
          {WHAT_YOU_GET.map((item) => (
            <div key={item.label} className="card" style={{ padding: "1.5rem" }}>
              <span className="eyebrow" style={{ color: item.color }}>
                {item.label}
              </span>
              <p
                style={{
                  color: "var(--text-muted)",
                  lineHeight: 1.65,
                  fontSize: "var(--text-sm)",
                  marginTop: "0.6rem",
                }}
              >
                {item.body}
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
            Paste a lead. Get a score.
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
            {[
              {
                step: "01",
                text: "Paste the lead info: company name, size, and what they need. The agent accepts raw form data, CRM exports, or plain text.",
              },
              {
                step: "02",
                text: "The agent scores fit and intent using your ICP criteria: industry, headcount, budget signal, and use-case alignment.",
              },
              {
                step: "03",
                text: "Preview the score with no side effect. For live delivery, bind a custom-header webhook Connection and review the endpoint before deployment.",
              },
            ].map((item) => (
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
            Your first lead scored free
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
            Dry-run mode scores leads without paying. Go live whenever you&apos;re ready.
          </p>
          <Link href="/build/new?template=lead-qualifier" className="lp-btn lp-btn--primary">
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
