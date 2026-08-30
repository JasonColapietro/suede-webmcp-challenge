import type { Metadata } from "next";
import SiteFooter from "@/components/site/SiteFooter";
import SiteNav from "@/components/site/SiteNav";
import WorkspaceTabs from "@/components/workspace/WorkspaceTabs";
import { RESOURCE_FOUNDRY_ENABLED } from "@/lib/resources/flags";
import { noIndexFollowMetadata } from "@/lib/seo-metadata";
import { requireStudioAccount } from "@/lib/studio-auth";
import "../chrome.css";
import "../site.css";
import "../workspace.css";
import "./resources.css";

export const metadata: Metadata = {
  ...noIndexFollowMetadata("/resources"),
  title: "Resource Foundry",
  description: "Build, test, and publish an immutable resource-backed service.",
};

export default async function ResourcesLayout({
  children,
}: {
  readonly children: React.ReactNode;
}): Promise<React.JSX.Element> {
  await requireStudioAccount("/resources");
  return (
    <div className="lp">
      <SiteNav active="/resources" />
      <WorkspaceTabs active="/resources" />
      <main id="main-content" className="lp-shell lp-page resource-page">
        {RESOURCE_FOUNDRY_ENABLED ? children : (
          <section className="state-panel state-panel--error" role="status">
            <h1>Resource Foundry is unavailable</h1>
            <p>The emergency operational switch is active. Existing flows are unchanged.</p>
          </section>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
