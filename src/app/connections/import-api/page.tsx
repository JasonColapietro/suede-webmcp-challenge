import Link from "next/link";
import { notFound } from "next/navigation";
import ConnectorBrowser from "@/components/connectors/ConnectorBrowser";
import ConnectorImporter from "@/components/connectors/ConnectorImporter";
import SiteNav from "@/components/site/SiteNav";
import WorkspaceTabs from "@/components/workspace/WorkspaceTabs";
import { CONNECTOR_LAB_ENABLED } from "@/lib/connectors/flags";
import "../../chrome.css";
import "../../site.css";
import "../connections.css";

export default function ImportApiPage(): React.JSX.Element {
  if (!CONNECTOR_LAB_ENABLED) notFound();

  return (
    <div className="lp">
      <SiteNav active="/connections" />
      <WorkspaceTabs active="/connections" />
      <main id="main-content" className="lp-shell lp-page">
        <p className="cx-back">
          <Link href="/connections">← Connections</Link>
        </p>
        <div className="lp-page-head">
          <span className="lp-eyebrow">Prototype: simulation only</span>
          <h1>Connector Lab</h1>
          <p>
            Import local OpenAPI JSON into a sanitized, immutable operation index. Cannot run in published workflows.
          </p>
        </div>
        <div className="cx-lab-stack">
          <ConnectorImporter />
          <ConnectorBrowser mode="manage" />
        </div>
      </main>
    </div>
  );
}
