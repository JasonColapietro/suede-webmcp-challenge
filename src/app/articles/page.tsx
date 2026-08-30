/**
 * Articles index — long-form writing on agentic workflows, the x402
 * protocol, flow design, and endpoint economics. Content lives in
 * src/lib/articles.ts; each entry renders at /articles/[slug].
 */
import type { Metadata } from "next";
import Link from "next/link";
import SiteNav from "@/components/site/SiteNav";
import SiteFooter from "@/components/site/SiteFooter";
import { ARTICLES, readingTimeLabel } from "@/lib/articles";
import "../chrome.css";
import "../site.css";
import "./articles.css";

const PAGE_TITLE = "Articles | Suede Agent Studio";
const PAGE_DESCRIPTION =
  "Long-form writing on agentic workflows, the x402 pay-per-call protocol, designing flows that survive production, and the honest economics of selling an agent endpoint.";

export const metadata: Metadata = {
  title: { absolute: PAGE_TITLE },
  description: PAGE_DESCRIPTION,
  alternates: { canonical: "/articles" },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/articles",
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

export default function ArticlesIndexPage(): React.JSX.Element {
  return (
    <div className="lp">
      <SiteNav active="/articles" />
      <main id="main-content" className="lp-shell lp-page" style={{ maxWidth: 880 }}>
        <header className="lp-page-head">
          <span className="lp-eyebrow">Articles</span>
          <h1>Writing on agents that work and get paid.</h1>
          <p>
            No hype pieces. Each article explains one thing carefully: how
            agentic workflows are put together, how x402 settles a single API
            call, how to design a flow that survives unattended runs, and what
            the economics of a paid endpoint honestly look like.
          </p>
        </header>

        <section className="lp-block" style={{ marginTop: 0 }}>
          <div className="ar-list">
            {ARTICLES.map((article) => (
              <Link
                key={article.slug}
                href={`/articles/${article.slug}`}
                className="ar-card"
              >
                <span className="lp-eyebrow">
                  {article.eyebrow} · {readingTimeLabel(article)}
                </span>
                <h2>{article.title}</h2>
                <p>{article.description}</p>
                <span className="go" aria-hidden="true">
                  Read the article →
                </span>
              </Link>
            ))}
          </div>
        </section>

        <section className="lp-block ar-panel">
          <p>
            Looking for reference material instead? The{" "}
            <Link href="/docs">docs</Link> cover the canvas, the node
            reference, the architecture, launching, payments, and the
            caller-facing API in detail.
          </p>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
