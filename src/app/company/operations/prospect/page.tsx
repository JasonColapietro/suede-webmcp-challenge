import type { Metadata } from "next";
import { notFound } from "next/navigation";
import SiteFooter from "@/components/site/SiteFooter";
import SiteNav from "@/components/site/SiteNav";
import { resolveOperatingSystemAccess } from "@/lib/company/operating-system/authorization";
import { signInUrl } from "@/lib/sign-in-url";
import ProspectLensClient from "./prospect-lens-client";
import ScanHandoffCapture from "./scan-handoff-capture";
import "../../../chrome.css";
import "../../../site.css";
import "../operating-system.css";
import "./prospect-lens.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Prospect Lens | Suede Agent Studio",
  description: "Internal, evidence-backed operating briefs for authorized Suede operators.",
  robots: { index: false, follow: false },
};

const SIGN_IN_URL = signInUrl(
  "https://agents.suedeai.ai/company/operations/prospect",
);

function CompanyViews(): React.JSX.Element {
  return (
    <nav className="sos-subnav" aria-label="Company views">
      <a href="/company">Company</a>
      <span aria-hidden="true">/</span>
      <a href="/company/operations">Operating System</a>
      <span aria-hidden="true">/</span>
      <a href="/company/operations/prospect" aria-current="page">Prospect Lens</a>
    </nav>
  );
}

export default async function CompanyProspectLensPage(): Promise<React.JSX.Element> {
  const access = await resolveOperatingSystemAccess();
  if (access.kind === "forbidden") notFound();

  return (
    <div className="lp sos-page spl-page">
      <SiteNav active="/company" />
      <main id="main-content" className="lp-shell lp-page sos-shell spl-shell">
        <CompanyViews />
        {access.kind === "signed-out" ? (
          <>
            <ScanHandoffCapture />
            <section className="sos-signed-out">
              <span className="sos-kicker">Authenticated sales operations</span>
              <h1>Turn observed friction into an evidence-backed brief.</h1>
              <p>
                Prospect Lens is an internal Company tool for explicitly authorized
                Suede operators. Sign in with an authorized Suede account to open it.
                A bounded Scan handoff stays in this browser tab during sign-in.
              </p>
              <a className="lp-btn lp-btn--primary" href={SIGN_IN_URL}>
                Sign in with Suede
              </a>
            </section>
          </>
        ) : (
          <ProspectLensClient />
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
