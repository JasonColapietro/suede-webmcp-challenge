/**
 * Run detail — the receipt for a single flow run. Reads the run record plus
 * its persisted steps and renders the node-by-node USDC ledger.
 *
 * Written to be read by whoever has to sign off on the spend: what ran, in
 * what order, what each node cost, what failed and with which message. Nothing
 * here is styled to look tidier than the data actually is — a skipped node
 * says skipped, a failed node carries its error text, and an unfinished run
 * says so rather than implying a total.
 */
import React from "react";
import Link from "next/link";
import { resolveReadOnlyOwnerId } from "@/lib/auth";
import { DurableRunMonitor } from "@/components/canvas/RunDock";
import { getRepo } from "@/lib/db/repo";
import type { RunRecord, RunStepRecord } from "@/lib/db/repo";
import { getDurableRuntimeRepository, DurableRuntimeUnavailableError } from "@/lib/runtime/provider";
import type { DurableExecutionEventV1 } from "@/lib/runtime/types";
import type { DurableExecutionOwnerView } from "@/lib/runtime/repository";
import { publicDurableExecutionView } from "@/lib/runtime/api-contract";
import SiteNav from "@/components/site/SiteNav";
import SiteFooter from "@/components/site/SiteFooter";
import WorkspaceTabs from "@/components/workspace/WorkspaceTabs";
import ReportContentButton from "@/components/moderation/ReportContentButton";
import RunAgainButton from "@/components/runs/RunAgainButton";
import ArtifactDownloadButton from "@/components/runs/ArtifactDownloadButton";
import { artifactDescriptor } from "@/lib/artifacts/download";
import "../../chrome.css";
import "../../site.css";
import "../../workspace.css";
import "../runs.css";

interface PageProps {
  params: Promise<{ runId: string }>;
}

interface StatusStyle {
  label: string;
  color: string;
  /** Drives the pulsing dot and the row tint, same keys as the canvas dock. */
  key: "done" | "error" | "running" | "skipped" | "pending";
}

/**
 * Every status a step can carry gets its own answer. The old mapping folded
 * "skipped" and "pending" into RUNNING, which told an operator a node was
 * still working when the engine had already halted the branch.
 */
function statusStyle(status: string): StatusStyle {
  if (status === "done") return { label: "DONE", color: "var(--text-success)", key: "done" };
  if (status === "error") return { label: "ERROR", color: "var(--rights-red)", key: "error" };
  if (status === "skipped") return { label: "SKIPPED", color: "var(--text-muted)", key: "skipped" };
  if (status === "pending") return { label: "PENDING", color: "var(--text-muted)", key: "pending" };
  return { label: "RUNNING", color: "var(--text-info)", key: "running" };
}

function formatUsdc(value: number): string {
  return `$${value.toFixed(4)}`;
}

function formatTime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace("Z", " UTC");
}

/** Durations read as engineers write them: sub-second in ms, then seconds. */
function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(2)} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.round((ms % 60_000) / 1_000)}s`;
}

function formatMicroUsdc(value: number): string {
  return `${Math.floor(value / 1_000_000)}.${String(value % 1_000_000).padStart(6, "0")} USDC`;
}

function boundedOutput(value: unknown): string {
  if (value === null) return "None";
  if (typeof value === "string") return value.slice(0, 4_096);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try { const encoded = JSON.stringify(value); return encoded.length > 4_096 ? `${encoded.slice(0, 4_096)}…` : encoded; }
  catch { return "Output could not be displayed."; }
}

/**
 * Orientation rail beneath the shared nav: a receipt is a leaf, so it names
 * the path that reached it rather than leaving Back as the only exit.
 */
function Breadcrumb({ current }: { current: string }): React.ReactElement {
  return (
    <nav className="rc-crumbs" aria-label="Breadcrumb">
      <Link href="/flows">Workspace</Link>
      <span aria-hidden="true">/</span>
      <Link href="/runs">Run history</Link>
      <span aria-hidden="true">/</span>
      <span aria-current="page">{current}</span>
    </nav>
  );
}

function StatusChip({ status }: { status: string }): React.ReactElement {
  const s = statusStyle(status);
  return (
    <span className="rc-status" data-status={s.key} style={{ color: s.color }}>
      <span className="rc-status__dot" aria-hidden="true" />
      {s.label}
    </span>
  );
}

function NotFound(): React.ReactElement {
  return (
    <div className="lp">
      <SiteNav />
      <WorkspaceTabs active="/runs" />
      <main id="main-content" className="lp-shell lp-page lp-page-rail lp-page-rail--reading">
        <Breadcrumb current="Unknown run" />
        <header className="lp-page-head">
          <span className="lp-eyebrow">Suede · Run Ledger</span>
          <h1>RUN NOT FOUND</h1>
          <p>
            No run matches that id in this workspace. It may have been pruned
            with its flow, or the id belongs to someone else.
          </p>
          <div className="lp-page-head-actions">
            <Link href="/runs" className="lp-btn lp-btn--primary">
              Run history →
            </Link>
            <Link href="/flows" className="lp-btn lp-btn--ghost">
              Back to my flows
            </Link>
          </div>
        </header>
      </main>
      <SiteFooter />
    </div>
  );
}

/**
 * The per-node cost ledger: genuinely tabular billing data, so a real table.
 * The wrapper is a focusable scrolling region because at phone widths the
 * table is wider than the viewport, and a scroll container that keyboard users
 * cannot reach is a trap.
 */
function LedgerTable({ run, steps }: { run: RunRecord; steps: RunStepRecord[] }): React.ReactElement {
  return (
    <div className="rc-ledger-scroll" role="region" aria-label="Per-node cost ledger" tabIndex={0}>
      <table className="rc-ledger">
        <caption className="sr-only">Per-node cost ledger</caption>
        <thead>
          <tr>
            <th scope="col">Node</th>
            <th scope="col">Type</th>
            <th scope="col">Status</th>
            <th scope="col" className="rc-num">USDC</th>
          </tr>
        </thead>
        <tbody>
          {steps.length === 0 ? (
            <tr>
              <td colSpan={4} className="rc-ledger-empty">NO STEPS RECORDED</td>
            </tr>
          ) : (
            steps.map((step) => {
              const s = statusStyle(step.status);
              return (
                <tr key={step.id} data-status={s.key}>
                  <td className="rc-ledger-node">{step.nodeId}</td>
                  <td className="rc-ledger-type">{step.nodeType}</td>
                  <td style={{ color: s.color }}>
                    {s.label}
                    {step.error !== null && (
                      <code className="rc-ledger-error">{step.error}</code>
                    )}
                  </td>
                  <td className="rc-num ledger-figure">{formatUsdc(step.costUsdc)}</td>
                </tr>
              );
            })
          )}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={3} style={{ textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--text-muted)", fontSize: "var(--text-label)" }}>
              Total charged
            </td>
            <td className="rc-num ledger-figure" style={{ color: "var(--text-success)" }}>
              {formatUsdc(run.totalCostUsdc)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function LegacyOutputs({ run, steps }: { run: RunRecord; steps: RunStepRecord[] }): React.ReactElement | null {
  const outputs = steps.filter((step) => step.output !== null);
  if (outputs.length === 0) return null;
  return <section aria-labelledby="legacy-output-heading" className="rc-section">
    <h2 id="legacy-output-heading" className="lp-eyebrow">Generated outputs</h2>
    <p className="rc-section-note">
      What each node handed to the next one, truncated for display. Download
      keeps the full value.
    </p>
    <div className="rc-outputs">
      {outputs.slice(0, 100).map((step) => <article key={step.id} className="rc-output">
        <strong className="rc-output-name">{step.nodeId}</strong>
        <code className="durable-output">{boundedOutput(step.output)}</code>
        <div className="rc-output-actions">
          <ArtifactDownloadButton artifact={artifactDescriptor(step.output)} />
          <ReportContentButton subject={{
            subjectType: "run_output",
            flowId: run.flowId,
            runId: run.id,
            nodeId: step.nodeId,
          }} />
        </div>
      </article>)}
    </div>
  </section>;
}

function DurableReceipt({ run, events }: { run: DurableExecutionOwnerView; events: readonly DurableExecutionEventV1[] }): React.ReactElement {
  const projection = run.projection;
  const nodes = Object.entries(projection.nodes).slice(0, 100);
  const publicRun = publicDurableExecutionView(run);
  const eventSummary = events.map((event) => ({ sequence: event.sequence, label: `${event.sequence} ${event.type}` }));
  const claimedAt = events.find((event) => event.type === "job.claimed")?.at ?? null;
  const terminalAt = [...events].reverse().find((event) => event.type.startsWith("execution.") && ["execution.succeeded", "execution.failed", "execution.cancelled", "execution.dead_lettered"].includes(event.type))?.at ?? run.finishedAt;
  return <div className="lp">
    <SiteNav />
    <WorkspaceTabs active="/runs" />
    <main id="main-content" className="durable-run-page lp-shell lp-page">
    <Breadcrumb current="Execution" />
    <p className="lp-eyebrow">Suede · Durable execution</p>
    <header className="durable-run-page-card">
      <div className="flex items-baseline justify-between flex-wrap gap-3"><h1>Execution receipt</h1><strong>{projection.state}</strong></div>
      <p className="mono">{run.executionId}</p>
      <dl>
        <div><dt>Immutable version</dt><dd>{run.flowVersionId}</dd></div>
        <div><dt>Attempt</dt><dd>{projection.attempt}</dd></div>
        <div><dt>Desired state</dt><dd>{projection.desiredState}</dd></div>
        <div><dt>Cost</dt><dd>{formatMicroUsdc(projection.costMicroUsdc)}</dd></div>
        <div><dt>Tokens</dt><dd>{projection.tokens}</dd></div>
        <div><dt>Created</dt><dd>{formatTime(run.createdAt)}</dd></div>
        <div><dt>Updated</dt><dd>{formatTime(run.updatedAt)}</dd></div>
        <div><dt>Finished</dt><dd>{run.finishedAt === null ? "Not finished" : formatTime(run.finishedAt)}</dd></div>
        <div><dt>Deadline</dt><dd>{run.deadlineAt === null ? "No deadline" : formatTime(run.deadlineAt)}</dd></div>
        <div><dt>Elapsed</dt><dd>{formatDuration(Math.max(0, (run.finishedAt ?? run.updatedAt) - run.createdAt))}</dd></div>
        <div><dt>Queue wait</dt><dd>{claimedAt === null ? projection.attempt > 0 ? "Claim is outside the retained event tail" : "Waiting for claim" : formatDuration(Math.max(0, claimedAt - run.createdAt))}</dd></div>
        <div><dt>Execution time</dt><dd>{claimedAt === null ? projection.attempt > 0 ? "Start is outside the retained event tail" : "Not started" : terminalAt === null ? "In progress" : formatDuration(Math.max(0, terminalAt - claimedAt))}</dd></div>
      </dl>
      <p>The mutable Draft may have changed. This receipt always points to the immutable version shown above.</p>
      {run.parentExecutionId ? <p>Retry of <Link href={`/runs/${encodeURIComponent(run.parentExecutionId)}`}>{run.parentExecutionId}</Link>.</p> : null}
      {projection.error ? <p role="alert">Execution error: {projection.error}</p> : null}
      {projection.output !== null ? <div style={{ display: "grid", gap: 10 }}><h2>Final output</h2><code className="durable-output">{boundedOutput(projection.output)}</code><ArtifactDownloadButton artifact={artifactDescriptor(projection.output)} /><ReportContentButton subject={{ subjectType: "run_output", flowId: run.flowId, runId: run.executionId }} /></div> : null}
    </header>
    <section aria-labelledby="durable-controls-heading"><h2 id="durable-controls-heading" className="lp-eyebrow">Live monitor and controls</h2><div className="durable-run-page-monitor"><DurableRunMonitor compact flowId={run.flowId} immutableVersion={{ id: run.flowVersionId }} initialRunId={run.executionId} initialRun={publicRun} initialEventSummary={eventSummary} /></div></section>
    <div className="durable-run-page-grid">
      <section className="durable-run-page-card"><h2>Node results</h2>{nodes.length ? <dl>{nodes.map(([nodeId, node]) => <div key={nodeId}><dt>{nodeId} · attempt {node.attempt}</dt><dd>{node.state}{node.error ? ` · ${node.error}` : ""}{node.output !== null ? <span style={{ display: "grid", gap: 8 }}><code className="durable-output">{boundedOutput(node.output)}</code><ArtifactDownloadButton artifact={artifactDescriptor(node.output)} /><ReportContentButton subject={{ subjectType: "run_output", flowId: run.flowId, runId: run.executionId, nodeId }} /></span> : null}</dd></div>)}</dl> : <p>No node results yet.</p>}{projection.deadLetter ? <p>Dead letter after attempt {projection.deadLetter.attempt}: {projection.deadLetter.error}</p> : projection.retry ? <p>Retry attempt {projection.retry.attempt} scheduled for {formatTime(projection.retry.availableAt)}: {projection.retry.error}</p> : null}</section>
    </div>
    <div className="rc-actions">
      <Link href={`/build/${encodeURIComponent(run.flowId)}`} className="lp-btn lp-btn--ghost lp-btn--sm">← Back to flow</Link>
      <Link href="/runs" className="lp-iconbtn" style={{ textDecoration: "none" }}>Run history</Link>
    </div>
    </main>
    <SiteFooter />
  </div>;
}

export default async function RunPage({ params }: PageProps): Promise<React.ReactElement> {
  const { runId } = await params;
  let ownerId: string;
  try { ownerId = await resolveReadOnlyOwnerId(); } catch { return <NotFound />; }

  try {
    const durableRepo = await getDurableRuntimeRepository();
    const durable = await durableRepo.getExecutionView(ownerId, runId);
    if (durable) {
      const after = Math.max(0, durable.projection.sequence - 100);
      const events = await durableRepo.listEvents(ownerId, runId, after, 100);
      return <DurableReceipt run={durable} events={events} />;
    }
  } catch (error) {
    if (!(error instanceof DurableRuntimeUnavailableError)) return <NotFound />;
  }

  const repo = await getRepo();
  const run = await repo.getRun(runId);

  if (run === null) {
    return <NotFound />;
  }
  // Legacy run rows predate durable owner views. Verify their flow owner before
  // hydrating steps so missing and foreign runs stay indistinguishable.
  const flow = await repo.getOwnedFlow(run.flowId, ownerId);
  if (!flow) return <NotFound />;
  const steps = await repo.listRunSteps(runId);
  // A run that never finished has no honest duration to quote.
  const elapsedMs = run.finishedAt === null ? null : Math.max(0, run.finishedAt - run.startedAt);
  const failedStep = steps.find((step) => step.status === "error") ?? null;

  return (
    <div className="lp">
      <SiteNav />
      <WorkspaceTabs active="/runs" />
      <main id="main-content" className="lp-shell lp-page lp-page-rail">
        <Breadcrumb current={flow.name || "Run"} />
        <p className="lp-eyebrow">Suede · Run Ledger</p>

        <header className="rc-card" style={{ marginTop: "0.6rem" }}>
          <div className="rc-head">
            <div className="rc-title">
              <h1>{flow.name || run.flowId}</h1>
              <span className="rc-id">run {run.id}</span>
            </div>
            <StatusChip status={run.status} />
          </div>

          <dl className="rc-facts">
            <div>
              <dt>Trigger</dt>
              <dd>{run.trigger}</dd>
            </div>
            <div>
              <dt>Started</dt>
              <dd className="ledger-figure">{formatTime(run.startedAt)}</dd>
            </div>
            <div>
              <dt>Finished</dt>
              <dd className="ledger-figure">
                {run.finishedAt === null ? "Still running" : formatTime(run.finishedAt)}
              </dd>
            </div>
            <div>
              <dt>Elapsed</dt>
              <dd className="ledger-figure">
                {elapsedMs === null ? "In progress" : formatDuration(elapsedMs)}
              </dd>
            </div>
            <div>
              <dt>Steps</dt>
              <dd className="ledger-figure">{steps.length}</dd>
            </div>
            <div>
              <dt>Settled</dt>
              <dd className="ledger-figure">{run.settledAt === null ? "Not settled" : run.settledAt}</dd>
            </div>
            <div>
              <dt>Total</dt>
              <dd className="ledger-figure rc-figure--total">{formatUsdc(run.totalCostUsdc)}</dd>
            </div>
          </dl>

          {run.status === "error" && (
            <div className="rc-failure" role="alert">
              <strong>Run failed</strong>
              {failedStep ? (
                <code>
                  {failedStep.nodeId} ({failedStep.nodeType}):{" "}
                  {failedStep.error ?? "no error message was recorded"}
                </code>
              ) : (
                <code>
                  The engine halted this run, but no step recorded an error message.
                </code>
              )}
            </div>
          )}
        </header>

        <section className="rc-section" aria-labelledby="cost-ledger-heading">
          <div className="rc-section-head">
            <h2 id="cost-ledger-heading" className="lp-eyebrow">Cost ledger</h2>
            <Link href={`/build/${encodeURIComponent(run.flowId)}`} className="lp-iconbtn" style={{ textDecoration: "none" }}>
              Open flow
            </Link>
          </div>
          <p className="rc-section-note">
            One line per node, in execution order, priced in USDC at the moment
            it ran. The total is what this run charged, not an estimate.
          </p>
          <LedgerTable run={run} steps={steps} />
        </section>

        <LegacyOutputs run={run} steps={steps} />

        {run.status !== "running" && run.triggerInput !== null ? (
          <div className="rc-actions">
            <RunAgainButton flowId={run.flowId} triggerInput={run.triggerInput} />
            <Link href="/runs" className="lp-iconbtn" style={{ textDecoration: "none" }}>
              Run history
            </Link>
          </div>
        ) : (
          <>
            <p className="rc-note">
              {run.status === "running"
                ? "Still executing. Resubmitting the same input unlocks once this run finishes."
                : "This run predates trigger-input storage, so it can’t be resubmitted from here."}
            </p>
            <div className="rc-actions">
              <Link href="/runs" className="lp-iconbtn" style={{ textDecoration: "none" }}>
                Run history
              </Link>
            </div>
          </>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
