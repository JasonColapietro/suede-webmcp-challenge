import SiteFooter from "@/components/site/SiteFooter";
import SiteNav from "@/components/site/SiteNav";
import { signInUrl } from "@/lib/sign-in-url";
import OperatingSystemClient from "./operating-system-client";
import "../../chrome.css";
import "../../site.css";
import "./operating-system.css";

const SIGN_IN_URL = signInUrl("https://agents.suedeai.ai/company/operations");

export default function CompanyOperationsPage(): React.JSX.Element {
  return (
    <div className="lp sos-page">
      <SiteNav active="/company" />
      <main id="main-content" className="lp-shell lp-page sos-shell">
        <nav className="sos-subnav" aria-label="Company views">
          <a href="/company">Company</a>
          <span aria-hidden="true">/</span>
          <a href="/company/operations" aria-current="page">Operating System</a>
          <span aria-hidden="true">/</span>
          <a href="/company/operations/prospect">Prospect Lens</a>
        </nav>
        <OperatingSystemClient signInUrl={SIGN_IN_URL} />
      </main>
      <SiteFooter />
    </div>
  );
}
