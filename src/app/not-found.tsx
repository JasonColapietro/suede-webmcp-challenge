import type { Metadata } from "next";
import Link from "next/link";
import SiteNav from "@/components/site/SiteNav";
import SiteFooter from "@/components/site/SiteFooter";
import "./chrome.css";
import "./site.css";

export const metadata: Metadata = {
  title: { absolute: "Page not found | Suede Agent Studio" },
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return (
    <div className="lp">
      <SiteNav />

      <section id="main-content" className="lp-hero">
        <div className="lp-shell">
          <span className="lp-eyebrow">404</span>
          <h1 className="lp-h1" style={{ marginTop: "0.6rem", maxWidth: "20ch" }}>
            This page didn&rsquo;t <em>ship</em>.
          </h1>
          <p className="lp-lede">
            Nothing&rsquo;s wired to this route. Suede Agent Studio is the canvas where you wire
            AI agents out of labeled blocks and publish them as callable services. Head back to
            the front page, or pick a page from the nav above.
          </p>
          <div className="lp-hero-actions">
            <Link href="/" className="lp-btn lp-btn--primary">
              Back to Suede Agent Studio
            </Link>
            <Link href="/agents" className="lp-btn lp-btn--ghost">
              Browse the directory
            </Link>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
