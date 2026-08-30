import type { FlowRepo } from "@/lib/db/repo";
import type { ModerationReportSubmission } from "./report-contract";
import type { ModerationReportRecord } from "./types";

export type CreateModerationReportResult =
  | { readonly status: "created"; readonly report: ModerationReportRecord }
  | { readonly status: "not-found" }
  | { readonly status: "unavailable" };

/**
 * Resolve every subject server-side. Client code supplies opaque references,
 * never an owner id or generated content, so it cannot redirect a report into
 * another workspace or copy secrets into the moderation queue.
 */
export async function createModerationReport(
  repo: FlowRepo,
  reporterOwnerId: string,
  submission: ModerationReportSubmission,
): Promise<CreateModerationReportResult> {
  if (!repo.createModerationReport) return { status: "unavailable" };

  if (submission.subjectType === "run_output") {
    const flow = await repo.getOwnedFlow(submission.flowId, reporterOwnerId);
    if (!flow) return { status: "not-found" };
    const legacyRun = await repo.getRun(submission.runId);
    if (legacyRun && legacyRun.flowId !== flow.id) return { status: "not-found" };
    const report = await repo.createModerationReport({
      reporterOwnerId,
      subjectOwnerId: flow.ownerId,
      subjectType: submission.subjectType,
      flowId: flow.id,
      runId: submission.runId,
      nodeId: submission.nodeId ?? null,
      reason: submission.reason,
    });
    return { status: "created", report };
  }

  const agent = await repo.getAgent(submission.agentId);
  if (!agent || agent.status !== "live") return { status: "not-found" };
  const flow = await repo.getFlow(agent.flowId);
  if (!flow) return { status: "not-found" };
  const report = await repo.createModerationReport({
    reporterOwnerId,
    subjectOwnerId: flow.ownerId,
    subjectType: submission.subjectType,
    flowId: flow.id,
    agentId: agent.id,
    runId: submission.subjectType === "agent_output" ? submission.runId ?? null : null,
    reason: submission.reason,
  });
  return { status: "created", report };
}
