import type { FlowVersionSummary, FlowWorkbookContext } from "@/lib/projects/types";
import { environmentRailView, projectContextView, type DeploymentHistoryState } from "@/lib/projects/ui-model";

export default function ProjectContext({
  context,
  versionCount,
  loading = false,
  error = null,
  showEnvironment = false,
  announce = true,
  versions = [],
  deploymentHistory = { status: "ready", deployments: [] },
}: {
  readonly context: FlowWorkbookContext | null;
  readonly versionCount: number;
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly showEnvironment?: boolean;
  readonly announce?: boolean;
  readonly versions?: readonly FlowVersionSummary[];
  readonly deploymentHistory?: DeploymentHistoryState;
}): React.JSX.Element {
  const model = projectContextView({ context, versionCount, loading, error });
  const receiptFallback = deploymentHistory.status === "loading"
    ? "Checking…"
    : deploymentHistory.status === "error"
      ? "Unavailable"
      : "Not promoted";
  const environmentRail = context && deploymentHistory.status === "ready"
    ? environmentRailView({
        versions,
        deployments: deploymentHistory.deployments,
        environments: context.environments,
      })
    : [
        { kind: "draft" as const, detail: "Mutable workspace" },
        { kind: "test" as const, detail: receiptFallback },
        { kind: "live" as const, detail: receiptFallback },
      ];

  return (
    <div
      className="project-context"
      role={announce ? "status" : undefined}
      aria-live={announce ? "polite" : undefined}
      aria-atomic={announce || undefined}
      aria-busy={model.busy || undefined}
    >
      <span className="project-context__label">{model.text}</span>
      {showEnvironment ? <ol className="environment-rail" aria-label="Environment status">
        {environmentRail.map((item) => <li key={item.kind} className={`environment-rail__item environment-rail__item--${item.kind}`}>
          <span>{item.kind}</span>
          <strong>{item.detail}</strong>
        </li>)}
      </ol> : null}
    </div>
  );
}
