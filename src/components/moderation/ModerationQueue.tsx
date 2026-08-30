"use client";

import React, { useState } from "react";
import type { ModerationReportRecord, ModerationStatus } from "@/lib/moderation/types";

const STATUSES: readonly ModerationStatus[] = ["open", "reviewing", "resolved", "dismissed"];

const control: React.CSSProperties = {
  minHeight: 38,
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--hairline)",
  background: "var(--ink-control)",
  color: "var(--text-primary)",
  padding: "8px 10px",
  fontFamily: "var(--font-ui)",
  fontSize: "var(--text-xs)",
};

export default function ModerationQueue({
  initialReports,
}: {
  readonly initialReports: readonly ModerationReportRecord[];
}): React.JSX.Element {
  const [reports, setReports] = useState<readonly ModerationReportRecord[]>(initialReports);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const update = async (report: ModerationReportRecord): Promise<void> => {
    if (busyId) return;
    setBusyId(report.id);
    setMessage(null);
    try {
      const response = await fetch(`/api/moderation/reports/${encodeURIComponent(report.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: report.status, reviewerNotes: report.reviewerNotes }),
      });
      const body: unknown = await response.json().catch(() => null);
      const updated = body && typeof body === "object"
        ? Reflect.get(body, "report") as ModerationReportRecord | undefined
        : undefined;
      if (!response.ok || !updated) throw new Error("Review update could not be saved.");
      setReports((current) => current.map((item) => item.id === updated.id ? updated : item));
      setMessage(`Saved ${updated.id}.`);
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "Review update could not be saved.");
    } finally {
      setBusyId(null);
    }
  };

  return <section aria-labelledby="moderation-queue-heading">
    <h2 id="moderation-queue-heading">Reports</h2>
    {message ? <p role="status" aria-live="polite">{message}</p> : null}
    {reports.length === 0 ? <p>No reports are queued.</p> : <div style={{ display: "grid", gap: 16 }}>
      {reports.map((report) => <article key={report.id} className="border hairline rounded-sm p-5" style={{ display: "grid", gap: 12, background: "var(--ink-panel)" }}>
        <header style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <strong className="mono">{report.subjectType} · {report.reason}</strong>
          <span className="mono">{new Date(report.createdAt).toLocaleString()}</span>
        </header>
        <dl className="mono" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8, fontSize: "var(--text-xs)" }}>
          <div><dt>Report</dt><dd>{report.id}</dd></div>
          <div><dt>Reporter</dt><dd>{report.reporterOwnerId}</dd></div>
          <div><dt>Subject owner</dt><dd>{report.subjectOwnerId}</dd></div>
          <div><dt>Flow</dt><dd>{report.flowId ?? "—"}</dd></div>
          <div><dt>Run</dt><dd>{report.runId ?? "—"}</dd></div>
          <div><dt>Node</dt><dd>{report.nodeId ?? "—"}</dd></div>
          <div><dt>Agent</dt><dd>{report.agentId ?? "—"}</dd></div>
        </dl>
        <label style={{ display: "grid", gap: 6 }}>
          <span className="eyebrow">Status</span>
          <select
            style={{ ...control, width: "100%" }}
            value={report.status}
            disabled={busyId === report.id}
            onChange={(event) => setReports((current) => current.map((item) => item.id === report.id ? { ...item, status: event.target.value as ModerationStatus } : item))}
          >
            {STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
          </select>
        </label>
        <label style={{ display: "grid", gap: 6 }}>
          <span className="eyebrow">Reviewer notes</span>
          <textarea
            style={{ ...control, width: "100%", minHeight: 72, resize: "vertical" }}
            value={report.reviewerNotes ?? ""}
            maxLength={2_000}
            disabled={busyId === report.id}
            onChange={(event) => setReports((current) => current.map((item) => item.id === report.id ? { ...item, reviewerNotes: event.target.value || null } : item))}
          />
        </label>
        <div><button type="button" className="lp-btn lp-btn--primary lp-btn--sm" disabled={busyId !== null} onClick={() => void update(report)}>{busyId === report.id ? "Saving…" : "Save review"}</button></div>
      </article>)}
    </div>}
  </section>;
}
