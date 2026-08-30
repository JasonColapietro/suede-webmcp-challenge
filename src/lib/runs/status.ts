/**
 * Run-row status dialect — one mapping for every surface that renders a run
 * ROW pill (/flows recent runs, /runs history, the per-agent hub). The run
 * receipt's per-STEP chip (runs/[runId] statusStyle) is a different concept
 * with more states (skipped/pending) and intentionally stays separate.
 */
export type RunRowStatus = "running" | "done" | "error";

export function runPillClass(status: RunRowStatus): string {
  if (status === "done") return "lp-pill lp-pill--live";
  if (status === "error") return "lp-pill lp-pill--error";
  return "lp-pill lp-pill--running";
}

export function runPillLabel(status: RunRowStatus): string {
  return status;
}
