import ConnectionManager from "@/components/connections/ConnectionManager";
import SiteNav from "@/components/site/SiteNav";
import SiteFooter from "@/components/site/SiteFooter";
import WorkspaceTabs from "@/components/workspace/WorkspaceTabs";
import { CONNECTOR_LAB_ENABLED } from "@/lib/connectors/flags";
import "../chrome.css";
import "../site.css";
import "../workspace.css";
import "./connections.css";

export default function ConnectionsPage(): React.JSX.Element {
  return (
    <div className="lp">
      <SiteNav active="/connections" />
      <WorkspaceTabs active="/connections" />
      <ConnectionManager connectorLabEnabled={CONNECTOR_LAB_ENABLED} />
      <SiteFooter />
    </div>
  );
}
