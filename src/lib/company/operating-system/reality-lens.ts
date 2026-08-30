import {
  RealityFindingSchema,
  type EvidenceReceipt,
  type OperatingApproval,
  type OperatingProject,
  type RealityFinding,
} from "./schema";

export const DEFAULT_EVIDENCE_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1_000;

interface RealityLensInput {
  projects: readonly OperatingProject[];
  evidence: readonly EvidenceReceipt[];
  approvals: readonly OperatingApproval[];
  now: Date;
  staleAfterMs?: number;
}

const severityRank: Readonly<Record<RealityFinding["severity"], number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function finding(
  value: RealityFinding,
): RealityFinding {
  return RealityFindingSchema.parse(value);
}

function evidenceFor(
  ids: readonly string[],
  evidenceById: ReadonlyMap<string, EvidenceReceipt>,
): EvidenceReceipt[] {
  return ids
    .map((id) => evidenceById.get(id))
    .filter((receipt): receipt is EvidenceReceipt => receipt !== undefined);
}

function projectFindings(input: {
  project: OperatingProject;
  evidenceById: ReadonlyMap<string, EvidenceReceipt>;
  nowMs: number;
  staleAfterMs: number;
}): RealityFinding[] {
  const out: RealityFinding[] = [];
  const receipts = evidenceFor(input.project.evidenceIds, input.evidenceById);
  const projectReceipts = receipts.filter((receipt) => receipt.scope === "project");
  const usableProjectReceipts = projectReceipts.filter(
    (receipt) => receipt.verification !== "missing",
  );

  if (usableProjectReceipts.length === 0 || input.project.lastVerifiedAt === null) {
    out.push(finding({
      id: `missing-evidence:${input.project.id}`,
      rule: "missing-evidence",
      projectId: input.project.id,
      title: `${input.project.name} has no current verification`,
      explanation: usableProjectReceipts.length === 0
        ? "The project has no project-level evidence receipt that supports its current state."
        : "The imported record has context, but no source has established when the current state was last verified.",
      severity: "high",
      confidence: "high",
      evidenceIds: projectReceipts.map((receipt) => receipt.id),
      nextAction: `Verify ${input.project.surface} at its source and attach the smallest reproducible receipt.`,
    }));
  } else {
    const verifiedAt = Date.parse(input.project.lastVerifiedAt);
    if (
      Number.isFinite(verifiedAt) &&
      input.nowMs - verifiedAt > input.staleAfterMs
    ) {
      out.push(finding({
        id: `stale-evidence:${input.project.id}`,
        rule: "stale-evidence",
        projectId: input.project.id,
        title: `${input.project.name} evidence is stale`,
        explanation: `The last project verification is older than ${Math.round(input.staleAfterMs / 86_400_000)} days.`,
        severity: "medium",
        confidence: "high",
        evidenceIds: projectReceipts.map((receipt) => receipt.id),
        nextAction: `Re-run the source check for ${input.project.surface} and replace the stale receipt.`,
      }));
    }
  }

  const statusClaims = new Set(
    projectReceipts
      .filter((receipt) => receipt.verification !== "missing")
      .map((receipt) => receipt.statusClaim)
      .filter((status): status is OperatingProject["status"] => status !== undefined),
  );
  if (
    statusClaims.size > 1 ||
    (statusClaims.size === 1 && !statusClaims.has(input.project.status))
  ) {
    out.push(finding({
      id: `conflicting-status:${input.project.id}`,
      rule: "conflicting-status",
      projectId: input.project.id,
      title: `${input.project.name} has conflicting status claims`,
      explanation: `The project says ${input.project.status}, while cited project receipts say ${[...statusClaims].join(" and ")}.`,
      severity: "high",
      confidence: "high",
      evidenceIds: projectReceipts
        .filter((receipt) => receipt.statusClaim !== undefined)
        .map((receipt) => receipt.id),
      nextAction: "Resolve the discrepancy at the freshest source, then update the project state without deleting the conflicting receipt.",
    }));
  }

  for (const dependency of input.project.dependencies) {
    if (dependency.state !== "blocked") continue;
    out.push(finding({
      id: `blocked-dependency:${input.project.id}:${dependency.id}`,
      rule: "blocked-dependency",
      projectId: input.project.id,
      title: `${input.project.name} is blocked by ${dependency.label}`,
      explanation: "A required dependency is explicitly blocked, so downstream execution should not be represented as clear.",
      severity: "high",
      confidence: "high",
      evidenceIds: dependency.evidenceIds,
      nextAction: `Verify the blocker for ${dependency.label}, name its owner, and clear only that dependency first.`,
    }));
  }

  if (input.project.productionClaim) {
    const productionProof = projectReceipts.some(
      (receipt) => receipt.production && receipt.verification === "verified",
    );
    if (!productionProof) {
      out.push(finding({
        id: `unverified-production:${input.project.id}`,
        rule: "unverified-production",
        projectId: input.project.id,
        title: `${input.project.name} has an unverified production claim`,
        explanation: "The portfolio marks this surface as production-facing, but no verified project-level production receipt supports that claim.",
        severity: "high",
        confidence: "high",
        evidenceIds: projectReceipts.map((receipt) => receipt.id),
        nextAction: "Verify the exact live route or deployment and attach the resulting production receipt before repeating the claim.",
      }));
    }
  }

  if (
    input.project.status !== "complete" &&
    (input.project.nextAction === null || input.project.nextAction.trim() === "")
  ) {
    out.push(finding({
      id: `missing-next-action:${input.project.id}`,
      rule: "missing-next-action",
      projectId: input.project.id,
      title: `${input.project.name} has no next action`,
      explanation: "An active operating record without one explicit next action cannot be handed off or sequenced safely.",
      severity: "medium",
      confidence: "high",
      evidenceIds: projectReceipts.map((receipt) => receipt.id),
      nextAction: "Assign one accountable owner and write the smallest source-verifiable next action.",
    }));
  }

  return out;
}

export function runRealityLens(input: RealityLensInput): RealityFinding[] {
  const evidenceById = new Map(input.evidence.map((receipt) => [receipt.id, receipt]));
  const findings = input.projects.flatMap((project) => projectFindings({
    project,
    evidenceById,
    nowMs: input.now.getTime(),
    staleAfterMs: input.staleAfterMs ?? DEFAULT_EVIDENCE_STALE_AFTER_MS,
  }));
  for (const approval of input.approvals) {
    findings.push(finding({
      id: `unresolved-approval:${approval.id}`,
      rule: "unresolved-approval",
      projectId: `company:${approval.companyId}`,
      title: `${approval.companyName} needs a decision`,
      explanation: `${approval.title} is still pending in the Company approval ledger (${approval.costLabel}).`,
      severity: "high",
      confidence: "high",
      evidenceIds: approval.evidenceIds,
      nextAction: `Review ${approval.subject} in Company and approve or reject the exact queued action.`,
    }));
  }
  return findings.sort((left, right) => {
    const severity = severityRank[left.severity] - severityRank[right.severity];
    if (severity !== 0) return severity;
    return left.id.localeCompare(right.id);
  });
}
