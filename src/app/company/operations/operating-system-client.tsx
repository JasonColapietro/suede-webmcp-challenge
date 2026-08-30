"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  OperatingSnapshotBaselineSchema,
  OperatingSystemSnapshotSchema,
  type EvidenceReceipt,
  type OperatingLifecycle,
  type OperatingMilestone,
  type OperatingProject,
  type OperatingSnapshotBaseline,
  type OperatingSystemSnapshot,
  type RealityFinding,
} from "@/lib/company/operating-system/schema";

const BASELINE_STORAGE_KEY = "suede-operating-system-baseline-v1";

interface OperatingSystemClientProps {
  readonly signInUrl: string;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function lifecycleClass(status: OperatingLifecycle): string {
  if (status === "live" || status === "complete") return "sos-status sos-status--good";
  if (status === "blocked") return "sos-status sos-status--danger";
  if (status === "building") return "sos-status sos-status--active";
  return "sos-status";
}

function severityClass(severity: RealityFinding["severity"]): string {
  return `sos-severity sos-severity--${severity}`;
}

function responseError(body: unknown, fallback: string): string {
  if (typeof body !== "object" || body === null) return fallback;
  const value = (body as { error?: unknown }).error;
  return typeof value === "string" ? value : fallback;
}

function readStoredBaseline(): OperatingSnapshotBaseline | undefined {
  try {
    const raw = window.localStorage.getItem(BASELINE_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = OperatingSnapshotBaselineSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
    window.localStorage.removeItem(BASELINE_STORAGE_KEY);
  } catch {
    // Storage may be disabled by browser policy; fall back to an initial review.
  }
  return undefined;
}

function storeBaseline(baseline: OperatingSnapshotBaseline): void {
  try {
    window.localStorage.setItem(BASELINE_STORAGE_KEY, JSON.stringify(baseline));
  } catch {
    // The snapshot remains usable when storage is disabled.
  }
}

function EvidenceCitations({
  ids,
  evidenceById,
}: {
  readonly ids: readonly string[];
  readonly evidenceById: ReadonlyMap<string, EvidenceReceipt>;
}): React.JSX.Element {
  const receipts = ids
    .map((id) => evidenceById.get(id))
    .filter((receipt): receipt is EvidenceReceipt => receipt !== undefined);
  if (receipts.length === 0) {
    return <span className="sos-no-proof">No attached receipt</span>;
  }
  return (
    <ul className="sos-citations">
      {receipts.map((receipt) => (
        <li key={receipt.id}>
          {receipt.href ? (
            <a href={receipt.href}>{receipt.label}</a>
          ) : (
            <span>{receipt.label}</span>
          )}
          <small>
            {receipt.verification}
            {receipt.observedAt ? ` · ${formatDate(receipt.observedAt)}` : " · undated"}
          </small>
        </li>
      ))}
    </ul>
  );
}

function ProjectCard({
  project,
  milestones,
  evidenceById,
}: {
  readonly project: OperatingProject;
  readonly milestones: readonly OperatingMilestone[];
  readonly evidenceById: ReadonlyMap<string, EvidenceReceipt>;
}): React.JSX.Element {
  return (
    <article className="sos-project" id={`project-${project.id.replaceAll(":", "-")}`}>
      <header className="sos-project__head">
        <div>
          <span className="sos-kicker">{project.surface}</span>
          <h3>{project.name}</h3>
        </div>
        <span className={lifecycleClass(project.status)}>{project.status}</span>
      </header>
      <div className="sos-rail">
        <section className="sos-rail__stop">
          <span className="sos-rail__label">Objective</span>
          <p>{project.objective}</p>
          <small>{project.owner.label}</small>
        </section>
        <section className="sos-rail__stop">
          <span className="sos-rail__label">Dependencies</span>
          {project.dependencies.length === 0 ? (
            <p className="sos-muted">No declared dependencies.</p>
          ) : (
            <ul className="sos-dependencies">
              {project.dependencies.map((dependency) => (
                <li key={dependency.id}>
                  <span className={`sos-dot sos-dot--${dependency.state}`} aria-hidden="true" />
                  <span>{dependency.label}</span>
                  <small>{dependency.state}</small>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="sos-rail__stop">
          <span className="sos-rail__label">Evidence</span>
          <EvidenceCitations ids={project.evidenceIds} evidenceById={evidenceById} />
          <p className="sos-verified">
            {project.lastVerifiedAt
              ? `Last verified ${formatDate(project.lastVerifiedAt)}`
              : "No source has set a verified time."}
          </p>
        </section>
        <section className="sos-rail__stop sos-rail__stop--next">
          <span className="sos-rail__label">Next action</span>
          <p>{project.nextAction ?? "Missing. Reality Lens has raised this gap."}</p>
        </section>
      </div>
      {milestones.length > 0 && (
        <details className="sos-milestones">
          <summary>{milestones.length} execution {milestones.length === 1 ? "item" : "items"}</summary>
          <ul>
            {milestones.map((milestone) => (
              <li key={milestone.id}>
                <div>
                  <b>{milestone.title}</b>
                  <p>{milestone.outcome}</p>
                  {milestone.blocker && <small>Blocked by {milestone.blocker}</small>}
                </div>
                <span className={`sos-status sos-status--milestone-${milestone.state}`}>
                  {milestone.state}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
}

function FindingCard({
  finding,
  evidenceById,
}: {
  readonly finding: RealityFinding;
  readonly evidenceById: ReadonlyMap<string, EvidenceReceipt>;
}): React.JSX.Element {
  return (
    <article className="sos-finding">
      <div className="sos-finding__meta">
        <span className={severityClass(finding.severity)}>{finding.severity}</span>
        <span>{finding.rule.replaceAll("-", " ")}</span>
        <span>{finding.confidence} confidence</span>
      </div>
      <h3>{finding.title}</h3>
      <p>{finding.explanation}</p>
      <div className="sos-finding__next">
        <span>Smallest safe next action</span>
        <b>{finding.nextAction}</b>
      </div>
      <details>
        <summary>Source evidence</summary>
        <EvidenceCitations ids={finding.evidenceIds} evidenceById={evidenceById} />
      </details>
    </article>
  );
}

export default function OperatingSystemClient({
  signInUrl,
}: OperatingSystemClientProps): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<OperatingSystemSnapshot | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [reviewing, setReviewing] = useState<boolean>(false);
  const [signedOut, setSignedOut] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const loadSnapshot = useCallback(async (
    baseline: OperatingSnapshotBaseline | undefined,
    manual: boolean,
  ): Promise<void> => {
    if (manual) {
      setReviewing(true);
    } else {
      setLoading(true);
    }
    setError(null);
    try {
      const response = await fetch("/api/companies/operating-system", baseline
        ? {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ baseline }),
          }
        : undefined);
      const body: unknown = await response.json().catch(() => null);
      if (response.status === 401) {
        setSignedOut(true);
        setSnapshot(null);
        return;
      }
      const parsed = OperatingSystemSnapshotSchema.safeParse(body);
      if (!response.ok || !parsed.success) {
        throw new Error(responseError(body, `Could not review operations (${response.status}).`));
      }
      setSignedOut(false);
      setSnapshot(parsed.data);
      storeBaseline(parsed.data.baseline);
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Could not review operations.");
    } finally {
      setLoading(false);
      setReviewing(false);
    }
  }, []);

  useEffect(() => {
    void loadSnapshot(readStoredBaseline(), false);
  }, [loadSnapshot]);

  const evidenceById = useMemo(
    () => new Map(snapshot?.evidence.map((receipt) => [receipt.id, receipt]) ?? []),
    [snapshot],
  );
  const milestonesByProject = useMemo(() => {
    const grouped = new Map<string, OperatingMilestone[]>();
    for (const milestone of snapshot?.milestones ?? []) {
      const current = grouped.get(milestone.projectId) ?? [];
      current.push(milestone);
      grouped.set(milestone.projectId, current);
    }
    return grouped;
  }, [snapshot]);
  const projectsById = useMemo(
    () => new Map(snapshot?.projects.map((project) => [project.id, project]) ?? []),
    [snapshot],
  );

  if (signedOut) {
    return (
      <section className="sos-signed-out">
        <span className="sos-kicker">Authenticated operations</span>
        <h1>One evidence-backed view of what moves next.</h1>
        <p>
          The Operating System reads owner-scoped Company records and internal
          portfolio context. Sign in with the shared Suede account to open it.
        </p>
        <a className="lp-btn lp-btn--primary" href={signInUrl}>Sign in with Suede</a>
      </section>
    );
  }

  if (loading && !snapshot) {
    return <div className="sos-loading">Reviewing portfolio evidence…</div>;
  }

  if (!snapshot) {
    return (
      <div className="sos-error" role="alert">
        <b>Operating review unavailable.</b>
        <p>{error ?? "No snapshot was returned."}</p>
        <button type="button" className="lp-btn lp-btn--ghost" onClick={() => void loadSnapshot(undefined, true)}>
          Try again
        </button>
      </div>
    );
  }

  return (
    <>
      <header className="sos-hero">
        <div>
          <span className="sos-kicker">Suede Company · internal</span>
          <h1>One truth for what moves next.</h1>
          <p>
            Portfolio status is only as strong as its receipts. This view keeps
            the objective, accountable owner, blocker, evidence, and next action
            in one operating chain.
          </p>
        </div>
        <div className="sos-review">
          <button
            type="button"
            className="lp-btn lp-btn--primary"
            disabled={reviewing}
            onClick={() => void loadSnapshot(snapshot.baseline, true)}
          >
            {reviewing ? "Reviewing…" : "Review now"}
          </button>
          <span role="status" aria-live="polite">
            Reviewed <time dateTime={snapshot.generatedAt}>{formatDate(snapshot.generatedAt)}</time>
          </span>
          <code>{snapshot.snapshotId.slice(0, 10)}</code>
        </div>
      </header>

      {error && <div className="sos-error" role="alert">{error}</div>}

      <section className="sos-executive" aria-labelledby="executive-heading">
        <div className="sos-section-heading">
          <span className="sos-kicker">Executive snapshot</span>
          <h2 id="executive-heading">What changed. What is blocked. What needs you.</h2>
        </div>
        <div className="sos-metrics">
          {[
            ["Changed", snapshot.executive.changed.length],
            ["Blocked", snapshot.executive.blockedProjectIds.length],
            ["Needs Jason", snapshot.executive.needsJason.length],
            ["Next", snapshot.executive.nextActions.length],
          ].map(([label, value]) => (
            <div key={String(label)}>
              <b>{value}</b>
              <span>{label}</span>
            </div>
          ))}
        </div>
        <div className="sos-executive__lists">
          <div>
            <h3>Since the prior review</h3>
            <ul>
              {snapshot.executive.changed.map((change) => (
                <li key={`${change.kind}:${change.projectId ?? "portfolio"}:${change.summary}`}>
                  {change.summary}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3>Needs Jason</h3>
            {snapshot.executive.needsJason.length === 0 ? (
              <p>No owner-only decision is currently evidenced.</p>
            ) : (
              <ul>{snapshot.executive.needsJason.map((item) => <li key={item}>{item}</li>)}</ul>
            )}
          </div>
          <div>
            <h3>Do next</h3>
            <ol>{snapshot.executive.nextActions.slice(0, 5).map((item) => <li key={item}>{item}</li>)}</ol>
          </div>
        </div>
      </section>

      <section className="sos-adapters" aria-label="Source adapters">
        {snapshot.adapters.map((adapter) => (
          <div key={adapter.adapterId}>
            <span className={`sos-dot sos-dot--${adapter.status === "ok" ? "ready" : adapter.status === "partial" ? "unknown" : "blocked"}`} aria-hidden="true" />
            <div>
              <b>{adapter.label}</b>
              <small>{adapter.status} · {adapter.note}</small>
            </div>
          </div>
        ))}
        <p>{snapshot.coverageNote}</p>
      </section>

      <div className="sos-columns">
        <section aria-labelledby="portfolio-heading">
          <div className="sos-section-heading">
            <span className="sos-kicker">Portfolio + execution</span>
            <h2 id="portfolio-heading">{snapshot.projects.length} operating surfaces</h2>
            <p>Imported estate context sits beside current owner-scoped Company runtime evidence.</p>
          </div>
          <div className="sos-projects">
            {snapshot.projects.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                milestones={milestonesByProject.get(project.id) ?? []}
                evidenceById={evidenceById}
              />
            ))}
          </div>
        </section>

        <aside className="sos-lens" aria-labelledby="lens-heading">
          <div className="sos-section-heading">
            <span className="sos-kicker">Reality Lens</span>
            <h2 id="lens-heading">{snapshot.findings.length} explainable findings</h2>
            <p>Rules only. No model-generated summary.</p>
          </div>
          <div className="sos-findings">
            {snapshot.findings.map((finding) => (
              <FindingCard key={finding.id} finding={finding} evidenceById={evidenceById} />
            ))}
          </div>

          <section className="sos-approvals" aria-labelledby="approvals-heading">
            <span className="sos-kicker">Decision queue</span>
            <h2 id="approvals-heading">{snapshot.approvals.length} pending</h2>
            {snapshot.approvals.length === 0 ? (
              <p>No Company approvals are waiting.</p>
            ) : (
              <ul>
                {snapshot.approvals.map((approval) => (
                  <li key={approval.id}>
                    <div>
                      <b>{approval.title}</b>
                      <span>{approval.companyName} · {approval.subject}</span>
                      <small>{approval.costLabel} · requested {formatDate(approval.requestedAt)}</small>
                    </div>
                    <a className="lp-btn lp-btn--ghost lp-btn--sm" href={approval.href}>
                      Review in Company
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {snapshot.executive.blockedProjectIds.length > 0 && (
            <section className="sos-blocked-index">
              <span className="sos-kicker">Blocked index</span>
              <ul>
                {snapshot.executive.blockedProjectIds.map((projectId) => {
                  const project = projectsById.get(projectId);
                  return (
                    <li key={projectId}>
                      <a href={`#project-${projectId.replaceAll(":", "-")}`}>
                        {project?.name ?? projectId}
                      </a>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </aside>
      </div>
    </>
  );
}
