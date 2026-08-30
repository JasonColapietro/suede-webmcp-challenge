import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import ModerationQueue from "@/components/moderation/ModerationQueue";
import { getRepo } from "@/lib/db/repo";
import { resolveModerationReviewer } from "@/lib/moderation/reviewer";
import "../chrome.css";
import "../site.css";
import "./moderation.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Moderation queue | Suede Agent Studio",
  robots: { index: false, follow: false },
};

export default async function ModerationPage(): Promise<React.JSX.Element> {
  const reviewer = await resolveModerationReviewer();
  if (!reviewer) notFound();
  const repo = await getRepo();
  if (!repo.listModerationReports) {
    return (
      <main id="main-content" className="lp lp-shell lp-page">
        <div className="lp-page-head">
          <span className="lp-eyebrow">Suede · Server-only moderation</span>
          <h1>Moderation unavailable.</h1>
          <p>
            This deployment has no moderation report store, so there is no queue
            to show. Nothing is hidden here; there is nothing recorded to read.
          </p>
        </div>
      </main>
    );
  }
  const reports = await repo.listModerationReports({ limit: 100 });
  return (
    <main id="main-content" className="lp lp-shell lp-page">
      <div className="lp-page-head">
        <span className="lp-eyebrow">Suede · Server-only moderation</span>
        <h1>AI and agent safety queue.</h1>
        <p>
          Reports carry bounded record references, never copied generated output
          and never credentials.
        </p>
      </div>
      <p className="md-signin">
        Signed in as <code>{reviewer}</code>. {reports.length === 0
          ? "No reports are open right now."
          : `${reports.length} report${reports.length === 1 ? "" : "s"} loaded, newest first.`}
      </p>
      <div className="md-queue">
        <ModerationQueue initialReports={reports} />
      </div>
      <p className="md-back"><Link href="/">← Back to studio</Link></p>
    </main>
  );
}
