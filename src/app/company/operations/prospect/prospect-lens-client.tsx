"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  buildProspectBrief,
  formatProspectBriefText,
  ProspectBriefInputSchema,
  type ProspectBrief,
  type ProspectFinding,
} from "@/lib/company/operating-system/prospect-lens";
import {
  parsePendingScanHandoff,
  parseScanDiagnosticHash,
  SCAN_HANDOFF_FRAGMENT_PREFIX,
  SCAN_HANDOFF_STORAGE_KEY,
  type ScanDiagnosticHandoff,
} from "@/lib/company/operating-system/outbound-diagnostic";
import OutboundDiagnosticWorkspace from "./outbound-diagnostic-workspace";
import ProspectEngineWorkbench from "./prospect-engine-workbench";

type CopyState = "idle" | "copied" | "error";
type Workspace = "operating-brief" | "outbound-diagnostic";

function formText(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function nullableText(data: FormData, name: string): string | null {
  const value = formText(data, name);
  return value.length > 0 ? value : null;
}

function formLines(data: FormData, name: string): string[] {
  return formText(data, name)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function dateInputToIso(value: string): string | null {
  if (!value) return null;
  const parsed = new Date(`${value}T12:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : value;
}

function findingClass(finding: ProspectFinding): string {
  return `sos-severity sos-severity--${finding.severity}`;
}

function BriefView({
  brief,
  copyState,
  onCopy,
}: {
  readonly brief: ProspectBrief;
  readonly copyState: CopyState;
  readonly onCopy: () => void;
}): React.JSX.Element {
  return (
    <article className="spl-brief" id="prospect-brief" aria-labelledby="brief-heading">
      <header className="spl-brief__head">
        <div>
          <span className="spl-draft-mark">Draft · internal · review before sharing</span>
          <p className="sos-kicker">Suede Company · Prospect Lens</p>
          <h2 id="brief-heading">{brief.headline}</h2>
        </div>
        <div className="spl-actions spl-actions--screen">
          <button type="button" className="lp-btn lp-btn--ghost lp-btn--sm" onClick={onCopy}>
            {copyState === "copied" ? "Copied" : "Copy draft"}
          </button>
          <button
            type="button"
            className="lp-btn lp-btn--primary lp-btn--sm"
            onClick={() => window.print()}
          >
            Print / save PDF
          </button>
          <span role="status" aria-live="polite">
            {copyState === "copied"
              ? "Draft brief copied to the clipboard."
              : copyState === "error"
                ? "Clipboard access failed. Select the brief text or print it instead."
                : ""}
          </span>
        </div>
      </header>

      <aside className="spl-boundary" aria-label="Evidence boundary">
        <b>Evidence boundary</b>
        <p>{brief.evidenceBoundary}</p>
      </aside>

      <section className="spl-brief__overview" aria-labelledby="heard-heading">
        <span className="sos-kicker">What the operator supplied</span>
        <h3 id="heard-heading">The operating situation</h3>
        <dl>
          <div>
            <dt>Objective</dt>
            <dd>{brief.objective}</dd>
          </div>
          <div>
            <dt>Primary surface</dt>
            <dd>{brief.primarySurface}</dd>
          </div>
          <div>
            <dt>Observed</dt>
            <dd>{brief.observedStatus}</dd>
          </div>
          <div>
            <dt>Declared</dt>
            <dd>{brief.declaredStatus ?? "Not supplied"}</dd>
          </div>
        </dl>
        <div className="spl-workstreams">
          <b>Workstreams in view</b>
          <ul>{brief.workstreams.map((workstream) => <li key={workstream}>{workstream}</li>)}</ul>
        </div>
      </section>

      <section className="spl-brief__findings" aria-labelledby="prospect-findings-heading">
        <div className="spl-section-title">
          <div>
            <span className="sos-kicker">Reality Lens</span>
            <h3 id="prospect-findings-heading">
              {brief.findings.length} explainable {brief.findings.length === 1 ? "gap" : "gaps"}
            </h3>
          </div>
          <small>Deterministic rules only</small>
        </div>
        {brief.findings.length === 0 ? (
          <p className="spl-no-findings">
            No deterministic gap was raised from the supplied fields. That does
            not independently verify execution health.
          </p>
        ) : (
          <ol>
            {brief.findings.map((finding, index) => (
              <li key={`${finding.rule}:${finding.title}`}>
                <div className="spl-finding__meta">
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <span className={findingClass(finding)}>{finding.severity}</span>
                  <span>{finding.confidence} confidence</span>
                </div>
                <h4>{finding.title}</h4>
                <p>{finding.explanation}</p>
                <div className="spl-source">
                  <b>Source evidence</b>
                  <ul>
                    {finding.sourceEvidence.map((source) => <li key={source}>{source}</li>)}
                  </ul>
                </div>
                <div className="spl-next">
                  <span>Smallest safe next action</span>
                  <b>{finding.nextAction}</b>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="spl-engagement" aria-labelledby="engagement-heading">
        <span className="sos-kicker">Proposed Suede operating engagement</span>
        <h3 id="engagement-heading">Install the missing operating chain.</h3>
        <ol>
          {brief.engagement.map((step, index) => (
            <li key={step.title}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div>
                <b>{step.title}</b>
                <p>{step.outcome}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <footer className="spl-brief__next">
        <span className="sos-kicker">Suggested next step</span>
        <p>{brief.proposedNextStep}</p>
        <small>
          Prepared <time dateTime={brief.generatedAt}>{new Date(brief.generatedAt).toLocaleString()}</time>.
          Draft copy requires operator review before any external use.
        </small>
      </footer>
    </article>
  );
}

export default function ProspectLensClient(): React.JSX.Element {
  const [brief, setBrief] = useState<ProspectBrief | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [workspace, setWorkspace] = useState<Workspace>("operating-brief");
  const [scanHandoff, setScanHandoff] = useState<ScanDiagnosticHandoff | null>(null);
  const [scanImportError, setScanImportError] = useState<string | null>(null);

  useEffect(() => {
    try {
      let imported: ScanDiagnosticHandoff | null = null;
      if (window.location.hash.startsWith(SCAN_HANDOFF_FRAGMENT_PREFIX)) {
        const rawHash = window.location.hash;
        window.history.replaceState(
          null,
          "",
          `${window.location.pathname}${window.location.search}`,
        );
        imported = parseScanDiagnosticHash(rawHash);
      } else {
        const pending = sessionStorage.getItem(SCAN_HANDOFF_STORAGE_KEY);
        sessionStorage.removeItem(SCAN_HANDOFF_STORAGE_KEY);
        if (pending) imported = parsePendingScanHandoff(pending);
      }
      if (!imported) return;

      setScanHandoff(imported);
      setScanImportError(null);
      setWorkspace("outbound-diagnostic");
    } catch (caught: unknown) {
      try {
        sessionStorage.removeItem(SCAN_HANDOFF_STORAGE_KEY);
      } catch {
        // Storage can be unavailable; the manual operating brief still works.
      }
      if (window.location.hash.startsWith(SCAN_HANDOFF_FRAGMENT_PREFIX)) {
        window.history.replaceState(
          null,
          "",
          `${window.location.pathname}${window.location.search}`,
        );
      }
      setScanHandoff(null);
      setScanImportError(
        caught instanceof Error ? caught.message : "The Scan handoff is invalid.",
      );
      setWorkspace("outbound-diagnostic");
    }
  }, []);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setError(null);
    setCopyState("idle");
    const data = new FormData(event.currentTarget);
    const parsed = ProspectBriefInputSchema.safeParse({
      prospectName: formText(data, "prospectName"),
      buyerRole: nullableText(data, "buyerRole"),
      objective: formText(data, "objective"),
      primarySurface: formText(data, "primarySurface"),
      observedStatus: formText(data, "observedStatus"),
      declaredStatus: nullableText(data, "declaredStatus"),
      workstreams: formLines(data, "workstreams"),
      evidenceNotes: formLines(data, "evidenceNotes"),
      evidenceObservedAt: dateInputToIso(formText(data, "evidenceObservedAt")),
      evidenceTier: formText(data, "evidenceTier"),
      productionEvidence: nullableText(data, "productionEvidence"),
      blockers: formLines(data, "blockers"),
      pendingDecisions: formLines(data, "pendingDecisions"),
      productionClaim: data.get("productionClaim") === "on",
      nextAction: nullableText(data, "nextAction"),
    });
    if (!parsed.success) {
      setBrief(null);
      setError(parsed.error.issues[0]?.message ?? "Review the bounded prospect inputs.");
      return;
    }
    try {
      setBrief(buildProspectBrief(parsed.data));
    } catch (caught: unknown) {
      setBrief(null);
      setError(caught instanceof Error ? caught.message : "Could not build the brief.");
    }
  }

  async function copyBrief(): Promise<void> {
    if (!brief) return;
    try {
      await navigator.clipboard.writeText(formatProspectBriefText(brief));
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  }

  return (
    <>
      <header className="spl-hero">
        <div>
          <span className="sos-kicker">Suede Company · internal sales operations</span>
          <h1>Show the operating gap. Cite the evidence. Earn the next conversation.</h1>
          <p>
            Turn a discovery conversation or a public-site Scan into a bounded,
            operator-reviewed diagnostic. The same evidence rules that govern
            Suede&apos;s portfolio govern the sales story.
          </p>
        </div>
        <aside>
          <b>Private operator workspace</b>
          <p>
            Prospect Engine records are owner-scoped and saved. The legacy
            operating-brief scratch forms below stay in this page; copying and
            printing happen only when you choose them.
          </p>
          <small>Do not paste secrets, credentials, signed URLs, recipient email addresses, or unnecessary personal data.</small>
        </aside>
      </header>

      <ProspectEngineWorkbench />

      <nav className="spl-workspace-tabs" aria-label="Prospect Lens workspace">
        <button
          type="button"
          className={workspace === "operating-brief" ? "is-active" : ""}
          aria-current={workspace === "operating-brief" ? "page" : undefined}
          onClick={() => setWorkspace("operating-brief")}
        >
          <span>01</span>
          Operating brief
        </button>
        <button
          type="button"
          className={workspace === "outbound-diagnostic" ? "is-active" : ""}
          aria-current={workspace === "outbound-diagnostic" ? "page" : undefined}
          onClick={() => setWorkspace("outbound-diagnostic")}
        >
          <span>02</span>
          Outbound diagnostic
          {scanHandoff && <small>{scanHandoff.findings.length} imported</small>}
        </button>
      </nav>

      {workspace === "outbound-diagnostic" ? (
        <OutboundDiagnosticWorkspace
          handoff={scanHandoff}
          importError={scanImportError}
        />
      ) : (
        <div className="spl-grid">
        <section className="spl-intake" aria-labelledby="intake-heading">
          <div className="spl-section-title">
            <div>
              <span className="sos-kicker">Operator input</span>
              <h2 id="intake-heading">Build the evidence boundary.</h2>
            </div>
            <span>01</span>
          </div>

          <form onSubmit={submit} autoComplete="off">
            <fieldset>
              <legend>Situation</legend>
              <div className="spl-field-row">
                <label>
                  Prospect or company
                  <input name="prospectName" required maxLength={160} placeholder="Acme" />
                </label>
                <label>
                  Buyer role
                  <input name="buyerRole" maxLength={120} placeholder="COO, founder, CTO…" />
                </label>
              </div>
              <label>
                Current objective
                <textarea
                  name="objective"
                  required
                  maxLength={700}
                  placeholder="What outcome are they trying to move?"
                />
              </label>
              <label>
                Primary operating surface
                <input
                  name="primarySurface"
                  required
                  maxLength={200}
                  placeholder="Product portfolio, release process, sales operations…"
                />
              </label>
              <label>
                Workstreams in view <small>One per line, up to 12</small>
                <textarea
                  name="workstreams"
                  maxLength={3_600}
                  placeholder={"Product\nDelivery\nApprovals"}
                />
              </label>
            </fieldset>

            <fieldset>
              <legend>Claims + evidence</legend>
              <div className="spl-field-row spl-field-row--three">
                <label>
                  Operator-observed state
                  <select name="observedStatus" defaultValue="building">
                    <option value="planned">Planned</option>
                    <option value="building">Building</option>
                    <option value="blocked">Blocked</option>
                    <option value="live">Live</option>
                    <option value="paused">Paused</option>
                  </select>
                </label>
                <label>
                  Prospect-declared state
                  <select name="declaredStatus" defaultValue="">
                    <option value="">Not supplied</option>
                    <option value="planned">Planned</option>
                    <option value="building">Building</option>
                    <option value="blocked">Blocked</option>
                    <option value="live">Live</option>
                    <option value="paused">Paused</option>
                  </select>
                </label>
                <label>
                  Evidence tier
                  <select name="evidenceTier" defaultValue="prospect-claimed">
                    <option value="prospect-claimed">Prospect claimed</option>
                    <option value="operator-observed">Operator observed</option>
                    <option value="verified">Verified at source</option>
                  </select>
                </label>
              </div>
              <label>
                Evidence notes <small>One source-backed observation per line, up to 12</small>
                <textarea
                  name="evidenceNotes"
                  maxLength={3_600}
                  placeholder={"Deployment dashboard was shown during discovery.\nApproval ledger has three open items."}
                />
              </label>
              <div className="spl-field-row">
                <label>
                  Evidence as of
                  <input name="evidenceObservedAt" type="date" />
                </label>
                <label className="spl-checkbox">
                  <input name="productionClaim" type="checkbox" />
                  <span>
                    A live or production claim was made
                    <small>This requires verified production evidence.</small>
                  </span>
                </label>
              </div>
              <label>
                Production evidence
                <textarea
                  name="productionEvidence"
                  maxLength={500}
                  placeholder="Exact live route, deployment receipt, or source check supporting the production claim."
                />
                <small>
                  Generic evidence notes do not verify a production claim.
                </small>
              </label>
            </fieldset>

            <fieldset>
              <legend>Execution gaps</legend>
              <label>
                Blocked dependencies <small>One per line, up to 12</small>
                <textarea
                  name="blockers"
                  maxLength={3_600}
                  placeholder="Verified release receipt from the delivery owner"
                />
              </label>
              <label>
                Pending decisions or approvals <small>One per line, up to 12</small>
                <textarea
                  name="pendingDecisions"
                  maxLength={3_600}
                  placeholder="Executive sponsor must approve the rollout sequence."
                />
              </label>
              <label>
                Current explicit next action
                <textarea
                  name="nextAction"
                  maxLength={500}
                  placeholder="Leave blank when discovery did not establish one."
                />
              </label>
            </fieldset>

            {error && <div className="spl-form-error" role="alert">{error}</div>}

            <div className="spl-submit">
              <button type="submit" className="lp-btn lp-btn--primary">
                Build draft brief
              </button>
              <p>No model call. No CRM write. No outreach.</p>
            </div>
          </form>
        </section>

        <section className="spl-output" aria-label="Draft prospect brief">
          {brief ? (
            <BriefView
              brief={brief}
              copyState={copyState}
              onCopy={() => void copyBrief()}
            />
          ) : (
            <div className="spl-empty">
              <span>02</span>
              <p className="sos-kicker">Draft brief</p>
              <h2>The sales story starts after the evidence boundary.</h2>
              <p>
                Complete the operating inputs to generate explainable findings,
                cited source notes, the smallest safe next actions, and a
                proposed Suede engagement.
              </p>
              <ol>
                <li>Situation, not generic persona copy</li>
                <li>Mechanism, not invented outcome claims</li>
                <li>Operator review before external use</li>
              </ol>
            </div>
          )}
        </section>
        </div>
      )}
    </>
  );
}
