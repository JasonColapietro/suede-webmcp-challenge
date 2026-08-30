/**
 * /grade — public agent grading page. Enter an agent handle or URL; the
 * server grades it (LLM or deterministic fallback) and returns pillar scores.
 * After results, a conversion CTA links to Agent Studio to build a better one.
 */
import type { Metadata } from "next";
import SiteNav from "@/components/site/SiteNav";
import SiteFooter from "@/components/site/SiteFooter";
import GradeClient from "./grade-client";
import "../chrome.css";
import "../site.css";
import "./grade.css";

export const metadata: Metadata = {
  title: { absolute: "Grade an AI Agent | Suede Agent Studio" },
  description:
    "Score any agentic AI app across acceleration, traction, credibility, and niche position. Free, instant, no login. Then build the better version in Agent Studio.",
  alternates: { canonical: "/grade" },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/grade",
    siteName: "Suede Agent Studio",
    title: "Grade an AI Agent | Suede Agent Studio",
    description:
      "Score any agentic AI app across acceleration, traction, credibility, and niche position. Free, instant, no login.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Grade an AI Agent | Suede Agent Studio",
    description:
      "Score any agentic AI app across acceleration, traction, credibility, and niche position. Free, instant, no login.",
    site: "@AISUEDE",
    creator: "@johnnysuede",
  },
};

export default function GradePage(): React.JSX.Element {
  return (
    <div className="lp">
      <SiteNav active="/grade" />
      <main id="main-content" className="lp-shell lp-page">
        <header className="lp-page-head">
          <span className="lp-eyebrow">Agent Grade</span>
          <h1>How does this agent stack up?</h1>
          <p className="lp-lede">
            Enter a handle or URL. The grader scores it across five pillars and
            tells you where it stands: free, instant, no login required. Then
            build the agent that fixes what it found.
          </p>
          <div className="grade-caps" aria-label="What you can do on this page">
            <b>Instant scorecard</b>
            <span>paste a handle or URL</span>
            <span>scores across five pillars</span>
            <span>momentum read and flags</span>
            <span>free, no login</span>
            <span>rebuild the weak pillar</span>
          </div>
        </header>

        <GradeClient />
      </main>
      <SiteFooter />
    </div>
  );
}
