"use client";

/**
 * Run history — the ledger of everything this workspace has executed. Same
 * private owner identity as /flows (the `/api/me` overview), grouped by day so
 * a week of scheduled fires reads as a few short lists instead of one wall.
 * Presentation only: no run is started, retried, or settled from here.
 */
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import SiteNav from "@/components/site/SiteNav";
import SiteFooter from "@/components/site/SiteFooter";
import WorkspaceTabs from "@/components/workspace/WorkspaceTabs";
import { runPillClass, runPillLabel } from "@/lib/runs/status";
import "../chrome.css";
import "../site.css";
import "../workspace.css";
import "./runs.css";

interface HistoryFlow {
  id: string;
  name: string;
}

interface HistoryRun {
  id: string;
  flowId: string;
  agentId: string | null;
  status: "running" | "done" | "error";
  trigger: string;
  totalCostUsdc: number;
  startedAt: number;
  finishedAt: number | null;
  settledAt: string | null;
}

interface HistoryResponse {
  flows: HistoryFlow[];
  runs: HistoryRun[];
}

type StatusFilter = "all" | "done" | "error" | "running";

const FILTERS: { readonly value: StatusFilter; readonly label: string }[] = [
  { value: "all", label: "All" },
  { value: "done", label: "Done" },
  { value: "error", label: "Errors" },
  { value: "running", label: "Running" },
];

function isHistoryResponse(v: unknown): v is HistoryResponse {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return Array.isArray(o.flows) && Array.isArray(o.runs);
}

function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function dayLabel(ts: number): string {
  const day = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  const sameDay = (a: Date, b: Date): boolean =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(day, today)) return "Today";
  if (sameDay(day, yesterday)) return "Yesterday";
  return day.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

function duration(run: HistoryRun): string {
  if (run.finishedAt === null) return "in progress";
  const ms = Math.max(0, run.finishedAt - run.startedAt);
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1_000)}s`;
}

/**
 * Everything below the compact header. Isolated so the one hook that needs
 * the query string (useSearchParams) sits behind its own Suspense boundary
 * instead of forcing the whole page to opt out of the static shell.
 */
function RunHistoryBody(): React.JSX.Element {
  const searchParams = useSearchParams();
  const flowParam = searchParams.get("flow");

  const [data, setData] = useState<HistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>("all");

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch("/api/me");
      if (!res.ok) throw new Error(`Failed to load (${res.status})`);
      const body: unknown = await res.json();
      if (!isHistoryResponse(body)) throw new Error("Malformed response.");
      setData(body);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const flowNames = useMemo(
    () => new Map((data?.flows ?? []).map((f) => [f.id, f.name])),
    [data],
  );

  const flowLabel = flowParam !== null ? flowNames.get(flowParam) ?? flowParam : null;

  const visible = useMemo(
    () =>
      (data?.runs ?? []).filter(
        (r) =>
          (filter === "all" || r.status === filter) &&
          (flowParam === null || r.flowId === flowParam),
      ),
    [data, filter, flowParam],
  );

  // Grouped by calendar day, newest first, preserving the API's own ordering
  // inside each day so nothing is silently re-sorted.
  const days = useMemo(() => {
    const groups: { label: string; runs: HistoryRun[] }[] = [];
    for (const run of visible) {
      const label = dayLabel(run.startedAt);
      const last = groups.at(-1);
      if (last && last.label === label) last.runs.push(run);
      else groups.push({ label, runs: [run] });
    }
    return groups;
  }, [visible]);

  const spend = visible.reduce((sum, r) => sum + r.totalCostUsdc, 0);
  const failures = visible.filter((r) => r.status === "error").length;

  return (
    <>
      {error && (
        <div className="state-panel state-panel--error" role="alert" style={{ marginBottom: "1.2rem" }}>
          {error}
        </div>
      )}

      {!data ? (
        <div className="lp-loading" role="status">Loading run history…</div>
      ) : data.runs.length === 0 ? (
        <div className="lp-empty" style={{ textAlign: "left" }}>
          <b>No runs recorded yet.</b>
          The moment an agent fires, from the canvas or a schedule or a paid
          call, its node-by-node cost ledger lands here.
          <div style={{ marginTop: "1.1rem", display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
            <Link href="/flows" className="lp-btn lp-btn--primary lp-btn--sm">
              Open an agent →
            </Link>
            <Link href="/templates" className="lp-btn lp-btn--ghost lp-btn--sm">
              Browse templates
            </Link>
          </div>
        </div>
      ) : (
        <>
          {flowLabel !== null && (
            <p className="rh-flow-note">
              Showing runs of {flowLabel} · <Link href="/runs">Show all</Link>
            </p>
          )}

          <div className="rh-filters" role="group" aria-label="Filter runs by status">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                className={`lp-iconbtn${filter === f.value ? " lp-iconbtn--active" : ""}`}
                aria-pressed={filter === f.value}
                onClick={() => setFilter(f.value)}
              >
                {f.label}
              </button>
            ))}
          </div>

          {visible.length === 0 ? (
            <div className="lp-empty" style={{ textAlign: "left" }}>
              No runs with that status in the recorded history.
            </div>
          ) : (
            <>
              {days.map((day) => (
                <section key={day.label} aria-label={`Runs on ${day.label}`}>
                  <h2 className="rh-day">
                    {day.label} · {day.runs.length}
                  </h2>
                  <div className="lp-rows">
                    {day.runs.map((run) => (
                      <Link key={run.id} href={`/runs/${run.id}`} className="lp-row rh-row">
                        <span className={runPillClass(run.status)}>{runPillLabel(run.status)}</span>
                        <div className="grow">
                          <div className="rh-name">
                            {flowNames.get(run.flowId) ?? "Deleted flow"}
                          </div>
                          <div className="rh-meta tabular">
                            {clockTime(run.startedAt)} · {run.trigger} · {duration(run)}
                            {run.settledAt !== null && " · settled"}
                          </div>
                        </div>
                        <span className="lp-pill tabular rh-cost">
                          ${run.totalCostUsdc.toFixed(3)}
                        </span>
                      </Link>
                    ))}
                  </div>
                </section>
              ))}
              {/* role="status": a filter click re-renders the list silently
                  otherwise — the counts line doubles as the announcement. */}
              <p className="rh-total tabular" role="status">
                <span>
                  <b>{visible.length}</b> runs shown
                </span>
                <span>
                  <b>${spend.toFixed(3)}</b> total cost
                </span>
                <span>
                  <b>{failures}</b> errored
                </span>
              </p>
              <p className="rc-note">
                History is capped at the most recent runs this workspace kept.
                Deleting a flow removes its runs with it.
              </p>
            </>
          )}
        </>
      )}
    </>
  );
}

export default function RunHistoryClient(): React.JSX.Element {
  return (
    <div className="lp">
      <SiteNav active="/runs" />
      <WorkspaceTabs active="/runs" />
      <main id="main-content" className="lp-shell lp-page lp-page-rail">
        <header className="ws-head">
          <h1>Run history</h1>
          <p className="ws-head-sub">
            Every run this workspace has recorded — trigger, duration, cost.
            Open any row for the node-by-node receipt.
          </p>
        </header>

        <Suspense fallback={<div className="lp-loading" role="status">Loading run history…</div>}>
          <RunHistoryBody />
        </Suspense>
      </main>
      <SiteFooter />
    </div>
  );
}
