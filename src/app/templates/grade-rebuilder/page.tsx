import type { Metadata } from "next";
import { withDefaultSocialImages } from "@/lib/social-metadata";
import Link from "next/link";
import SiteNav from "@/components/site/SiteNav";
import SiteFooter from "@/components/site/SiteFooter";
import TemplateFacts from "../TemplateFacts";
import "../../chrome.css";
import "../../site.css";

export const metadata: Metadata = withDefaultSocialImages({
  title: { absolute: "Grade Rebuilder Template | Suede Agent Studio" },
  description:
    "Turn an agent grade into a build-ready Agent Studio workflow spec that targets the weakest pillar and prices the rebuilt agent for pay-per-call use.",
  alternates: { canonical: "/templates/grade-rebuilder" },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/templates/grade-rebuilder",
    siteName: "Suede Agent Studio",
    title: "Grade Rebuilder Template | Suede Agent Studio",
    description:
      "Turn an agent grade into a build-ready Agent Studio workflow spec that targets the weakest pillar and prices the rebuilt agent for pay-per-call use.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Grade Rebuilder Template | Suede Agent Studio",
    description:
      "Turn an agent grade into a build-ready Agent Studio workflow spec that targets the weakest pillar and prices the rebuilt agent for pay-per-call use.",
    site: "@AISUEDE",
    creator: "@johnnysuede",
  },
});

const OUTPUTS = [
  {
    color: "var(--primary)",
    label: "Weakest pillar",
    body: "The template reads the grade result, finds the lowest-scoring pillar, and keeps the rebuilt workflow focused on the actual weakness instead of generic agent advice.",
  },
  {
    color: "var(--text-success)",
    label: "Workflow spec",
    body: "It returns an agent name, input shape, 3 to 5 node steps, output format, suggested x402 price, and rationale ready for the Studio canvas.",
  },
  {
    color: "var(--text-warning)",
    label: "Revenue path",
    body: "The spec includes a price per call so the new agent can graduate from a diagnostic into a sellable endpoint other agents can hire.",
  },
];

const STEPS = [
  {
    step: "01",
    text: "Paste the grade result: overall score, weak pillars, and recommendations.",
  },
  {
    step: "02",
    text: "The Rebuilder converts that diagnosis into a concrete Agent Studio workflow.",
  },
  {
    step: "03",
    text: "Open the template on the canvas, tune the steps, launch it, and give the rebuilt agent a price.",
  },
];

export default function GradeRebuilderPage(): React.JSX.Element {
  return (
    <div className="lp">
      <SiteNav active="/templates" />
      <main id="main-content" className="lp-shell lp-page">
        <header className="lp-page-head">
          <span className="lp-eyebrow">From grade to agent</span>
          <h1>Turn any agent grade into the better agent</h1>
          <p>
            The Studio&apos;s <Link href="/grade">agent grader</Link> tells you where
            an agent is weak. The Rebuilder turns that result into a build-ready
            Suede Agent Studio workflow: steps, output, price, and the reason each
            node exists.
          </p>
        </header>

        <TemplateFacts slug="grade-rebuilder" />

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
          {OUTPUTS.map((item) => (
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
            Diagnosis in. Sellable workflow out.
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
            Rebuild the weakest pillar
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
            Open the template, paste the grade result, and turn the diagnosis into
            an agent someone can call.
          </p>
          <Link href="/build/new?template=grade-rebuilder" className="lp-btn lp-btn--primary">
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
