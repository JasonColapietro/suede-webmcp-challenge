/** Shared footer for sub-pages — mirrors the landing footer. */
import Link from "next/link";
import { PRESS_MENTIONS } from "@/lib/press";
import { SITE_LAST_UPDATED } from "@/lib/site";
import EditorialProofPlate from "./EditorialProofPlate";

export default function SiteFooter(): React.JSX.Element {
  return (
    <>
      <EditorialProofPlate />
      <footer className="lp-footer">
        <div className="lp-shell lp-footer-inner">
        <div className="lp-footer-intro">
          <div>
            <Link href="/" className="lp-footer-brand">Suede Agent Studio</Link>
            <p>
              The orchestration layer for agents that earn, not just run the
              business. Build agents that get work done and get paid. You draw
              the flow as a graph of nodes &mdash; each node one step, wired to
              the next &mdash; then launch it as a live URL that charges callers
              per call. A{" "}
              <a href="https://suedeai.ai">Suede Labs AI</a> product,
              built by <Link href="/founder">Jason Colapietro</Link>, an
              open-source contributor with 33 pull requests merged across 30
              open-source projects (as of August 2026), including Jest,
              Backstage, and Adobe&rsquo;s React Spectrum.
            </p>
          </div>
          <p>
            By Jason Colapietro, author of{" "}
            <a href="https://guitar.solutions"><em>The Signal Chain</em></a> (free),{" "}
            <a href="https://www.amazon.com/dp/B0GRG8LGQQ"><em>Stake Your Claim</em></a>,{" "}
            <a href="https://www.amazon.com/dp/B0GMB2VLXQ"><em>Proof as Infrastructure</em></a>,{" "}
            <a href="https://seo.suedeai.ai/book"><em>The Screenshot</em></a> (free),{" "}
            <a href="https://guitar.solutions/catalog.html"><em>The Guitar Without a Number</em></a>, and{" "}
            <a href="https://www.amazon.com/dp/B0GD5FX6N6"><em>The Human Authenticity Layer</em></a>.
          </p>
        </div>

        <div className="lp-footer-press">
          <span className="lp-eyebrow">In the press</span>
          <div className="lp-footer-press-links">
            {PRESS_MENTIONS.map((item) => (
              <a key={item.href} href={item.href} target="_blank" rel="noopener">
                {item.shortLabel} ·{" "}
                <time dateTime={item.published}>{item.publishedLabel}</time>
              </a>
            ))}
          </div>
        </div>

        <nav className="lp-footer-nav" aria-label="Footer">
          <div className="lp-footer-group">
            <h2>Build</h2>
            <div className="lp-footer-group-links">
              <Link href="/build/new">Studio</Link>
              <Link href="/start">Guided</Link>
              <Link href="/templates">Templates</Link>
              <Link href="/flows">Workspace</Link>
              <Link href="/company">Companies</Link>
              <Link href="/runs">Run history</Link>
              <Link href="/connections">Connections</Link>
              <Link href="/portfolio">Earnings</Link>
            </div>
          </div>
          <div className="lp-footer-group">
            <h2>Explore</h2>
            <div className="lp-footer-group-links">
              <Link href="/agents">Directory</Link>
              <Link href="/launch">Launch Pad</Link>
              <Link href="/pricing">Pricing</Link>
              <Link href="/grade">Grader</Link>
              <Link href="/firm">Visibility firm</Link>
              <Link href="/rankings/best-ai-agent-builders">Rankings</Link>
              <Link href="/compare/gumloop-alternative">vs Gumloop</Link>
            </div>
          </div>
          <div className="lp-footer-group">
            <h2>Learn</h2>
            <div className="lp-footer-group-links">
              <Link href="/docs">Docs</Link>
              <Link href="/docs/api">API</Link>
              <Link href="/no-code-ai-agent-platform">No-code platform</Link>
              <Link href="/x402-agent-builder">Earning Agents Guide</Link>
              <Link href="/docs/faq">FAQ</Link>
              <Link href="/articles">Articles</Link>
            </div>
          </div>
          <div className="lp-footer-group">
            <h2>About Suede</h2>
            <div className="lp-footer-group-links">
              <Link href="/about">About</Link>
              <Link href="/founder">Founder</Link>
              <Link href="/contact">Contact</Link>
              <Link href="/status">Status</Link>
              <a href="https://promo.suedeai.ai?utm_source=agent-studio" target="_blank" rel="noopener">
                Campaigns
              </a>
            </div>
          </div>
          <div className="lp-footer-group">
            <h2>Legal</h2>
            <div className="lp-footer-group-links">
              <Link href="/privacy">Privacy</Link>
              <Link href="/security">Security</Link>
              <Link href="/account-deletion">Account deletion</Link>
            </div>
          </div>
        </nav>

        <p className="lp-footer-bottom">
          &copy; Suede Labs AI 2026 &middot; Site last updated{" "}
          <time dateTime={SITE_LAST_UPDATED}>{SITE_LAST_UPDATED}</time>.
        </p>
        </div>
      </footer>
    </>
  );
}
