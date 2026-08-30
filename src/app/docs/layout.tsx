/**
 * Docs shell — one layout for every /docs page: site nav, a persistent
 * sidebar (collapsible on mobile), the page content, a prev/next pager that
 * walks the reading path, and the site footer. Pages render content only.
 */
import SiteNav from "@/components/site/SiteNav";
import SiteFooter from "@/components/site/SiteFooter";
import DocsSidebar from "./DocsSidebar";
import DocsPager from "./DocsPager";
import "../chrome.css";
import "../site.css";
import "./docs.css";

export default function DocsLayout({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="lp">
      <SiteNav active="/docs" />
      <div className="lp-shell lp-page docs-shell">
        <DocsSidebar />
        <main id="main-content" className="docs-main">
          {children}
          <DocsPager />
        </main>
      </div>
      <SiteFooter />
    </div>
  );
}
