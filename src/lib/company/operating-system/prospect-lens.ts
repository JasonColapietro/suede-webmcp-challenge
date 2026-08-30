import { z } from "zod";
import { runRealityLens } from "./reality-lens";
import {
  EvidenceReceiptSchema,
  OperatingProjectSchema,
  RealityFindingSchema,
  type EvidenceReceipt,
  type RealityFinding,
} from "./schema";

const BriefTextSchema = z.string().trim().min(1).max(700);
const BriefLineSchema = z.string().trim().min(1).max(300);

export const ProspectEvidenceTierSchema = z.enum([
  "verified",
  "operator-observed",
  "prospect-claimed",
]);

export const ProspectBriefInputSchema = z.object({
  prospectName: z.string().trim().min(1).max(160),
  buyerRole: z.string().trim().min(1).max(120).nullable(),
  objective: BriefTextSchema,
  primarySurface: z.string().trim().min(1).max(200),
  observedStatus: z.enum(["planned", "building", "blocked", "live", "paused"]),
  declaredStatus: z.enum(["planned", "building", "blocked", "live", "paused"]).nullable(),
  workstreams: z.array(BriefLineSchema).max(12),
  evidenceNotes: z.array(BriefLineSchema).max(12),
  evidenceObservedAt: z.string().datetime({ offset: true }).nullable(),
  evidenceTier: ProspectEvidenceTierSchema,
  productionEvidence: z.string().trim().min(1).max(500).nullable(),
  blockers: z.array(BriefLineSchema).max(12),
  pendingDecisions: z.array(BriefLineSchema).max(12),
  productionClaim: z.boolean(),
  nextAction: z.string().trim().min(1).max(500).nullable(),
}).strict();

export const ProspectFindingSchema = RealityFindingSchema.omit({
  id: true,
  projectId: true,
  evidenceIds: true,
}).extend({
  sourceEvidence: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
}).strict();

export const ProspectEngagementStepSchema = z.object({
  title: z.string().trim().min(1).max(160),
  outcome: z.string().trim().min(1).max(500),
}).strict();

export const ProspectBriefSchema = z.object({
  generatedAt: z.string().datetime({ offset: true }),
  prospectName: z.string().trim().min(1).max(160),
  buyerRole: z.string().trim().min(1).max(120).nullable(),
  headline: z.string().trim().min(1).max(240),
  objective: BriefTextSchema,
  primarySurface: z.string().trim().min(1).max(200),
  observedStatus: z.enum(["planned", "building", "blocked", "live", "paused"]),
  declaredStatus: z.enum(["planned", "building", "blocked", "live", "paused"]).nullable(),
  workstreams: z.array(BriefLineSchema).min(1).max(12),
  evidenceBoundary: z.string().trim().min(1).max(700),
  findings: z.array(ProspectFindingSchema).max(50),
  engagement: z.array(ProspectEngagementStepSchema).min(1).max(5),
  proposedNextStep: z.string().trim().min(1).max(500),
}).strict();

export type ProspectBriefInput = z.infer<typeof ProspectBriefInputSchema>;
export type ProspectFinding = z.infer<typeof ProspectFindingSchema>;
export type ProspectBrief = z.infer<typeof ProspectBriefSchema>;

const severityRank: Readonly<Record<RealityFinding["severity"], number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function receipt(input: EvidenceReceipt): EvidenceReceipt {
  return EvidenceReceiptSchema.parse(input);
}

function sourceFallback(
  finding: RealityFinding,
  input: ProspectBriefInput,
): string {
  if (finding.rule === "missing-evidence") {
    return "Operator input: no independently verified current evidence was supplied.";
  }
  if (finding.rule === "missing-next-action") {
    return "Operator input: the current next action was left blank.";
  }
  if (finding.rule === "unverified-production") {
    return "Operator input: a production claim was supplied without verified production evidence.";
  }
  if (finding.rule === "conflicting-status") {
    return `Operator input: observed ${input.observedStatus}; declared ${input.declaredStatus ?? "status not supplied"}.`;
  }
  return "Operator input: the finding is based on a supplied gap, not an independent source check.";
}

function prospectFindingCopy(
  finding: RealityFinding,
  input: ProspectBriefInput,
): RealityFinding {
  if (finding.rule === "missing-evidence") {
    return RealityFindingSchema.parse({
      ...finding,
      title: `${input.prospectName} has no independently verified current evidence`,
      explanation: "The operator supplied context, but no project-level source was both marked verified and given a current verification time.",
      nextAction: `Verify ${input.primarySurface} at its source and attach the smallest reproducible receipt.`,
    });
  }
  if (finding.rule === "conflicting-status") {
    return RealityFindingSchema.parse({
      ...finding,
      explanation: `The operator-observed state is ${input.observedStatus}, while the prospect-declared state is ${input.declaredStatus ?? "not supplied"}.`,
    });
  }
  if (finding.rule === "blocked-dependency") {
    const dependencyIndex = Number(finding.id.split(":").at(-1)?.replace("dependency", ""));
    const blocker = Number.isSafeInteger(dependencyIndex)
      ? input.blockers[dependencyIndex - 1]
      : undefined;
    if (blocker) {
      return RealityFindingSchema.parse({
        ...finding,
        title: `${input.prospectName} has a blocked dependency`,
        explanation: `Operator input identifies this blocked dependency: ${blocker}`,
        nextAction: `Verify the blocker, name its accountable owner, and clear only this dependency first: ${blocker}`,
      });
    }
  }
  if (finding.rule === "unverified-production") {
    return RealityFindingSchema.parse({
      ...finding,
      explanation: "The operator recorded a production-facing claim, but no project-level receipt is both production-specific and marked verified.",
    });
  }
  return finding;
}

function buildEngagement(findings: readonly ProspectFinding[]): ProspectBrief["engagement"] {
  const rules = new Set(findings.map((finding) => finding.rule));
  const steps: ProspectBrief["engagement"] = [{
    title: "Map the execution spine",
    outcome: "Turn objectives, workstreams, accountable owners, dependencies, and one next action into a shared operating map.",
  }];

  if (
    rules.has("missing-evidence") ||
    rules.has("stale-evidence") ||
    rules.has("conflicting-status") ||
    rules.has("unverified-production")
  ) {
    steps.push({
      title: "Install evidence receipts",
      outcome: "Define the smallest reproducible source check for each status and production claim, with an explicit verification time.",
    });
  }

  if (
    rules.has("blocked-dependency") ||
    rules.has("unresolved-approval") ||
    rules.has("missing-next-action")
  ) {
    steps.push({
      title: "Run the decision cadence",
      outcome: "Expose blocked dependencies and pending decisions, then assign the smallest safe next action and accountable owner.",
    });
  }

  if (steps.length === 1) {
    steps.push({
      title: "Verify the operating cadence",
      outcome: "Review the map against current sources and establish when the next evidence-backed review should happen.",
    });
  }
  return steps;
}

export function buildProspectBrief(
  value: ProspectBriefInput,
  now: Date = new Date(),
): ProspectBrief {
  const input = ProspectBriefInputSchema.parse(value);
  if (!Number.isFinite(now.getTime())) {
    throw new Error("A valid review time is required.");
  }
  if (
    input.evidenceObservedAt !== null &&
    Date.parse(input.evidenceObservedAt) > now.getTime()
  ) {
    throw new Error("Evidence as-of date cannot be in the future.");
  }

  const projectId = "prospect:operating-brief";
  const evidence: EvidenceReceipt[] = input.evidenceNotes.map((note, index) => receipt({
    id: `prospect:evidence:${index + 1}`,
    source: "operator",
    scope: "project",
    label: `Supplied evidence note ${index + 1}`,
    claim: note,
    observedAt: input.evidenceObservedAt,
    verification: input.evidenceTier === "verified" ? "verified" : "declared",
    production: false,
  }));

  if (input.declaredStatus !== null) {
    evidence.push(receipt({
      id: "prospect:evidence:status-claim",
      source: "operator",
      scope: "project",
      label: "Supplied status claim",
      claim: `The prospect described the operating surface as ${input.declaredStatus}.`,
      observedAt: input.evidenceObservedAt,
      verification: "declared",
      statusClaim: input.declaredStatus,
      production: false,
    }));
  }

  if (input.productionEvidence !== null) {
    evidence.push(receipt({
      id: "prospect:evidence:production",
      source: "operator",
      scope: "project",
      label: "Supplied production evidence",
      claim: input.productionEvidence,
      observedAt: input.evidenceObservedAt,
      verification: input.evidenceTier === "verified" ? "verified" : "declared",
      production: true,
    }));
  }

  const dependencyReceipts = input.blockers.map((blocker, index) => receipt({
    id: `prospect:blocker:${index + 1}`,
    source: "operator",
    scope: "dependency",
    label: `Supplied blocker ${index + 1}`,
    claim: blocker,
    observedAt: input.evidenceObservedAt,
    verification: "declared",
    production: false,
  }));
  evidence.push(...dependencyReceipts);

  const project = OperatingProjectSchema.parse({
    id: projectId,
    name: input.prospectName,
    surface: input.primarySurface,
    objective: input.objective,
    owner: {
      kind: input.buyerRole ? "person" : "team",
      label: input.buyerRole ?? "Accountable owner not supplied",
    },
    status: input.observedStatus,
    dependencies: input.blockers.map((blocker, index) => ({
      id: `prospect:dependency:${index + 1}`,
      label: blocker,
      state: "blocked",
      projectId: null,
      evidenceIds: [dependencyReceipts[index]!.id],
    })),
    evidenceIds: evidence
      .filter((item) => item.scope === "project")
      .map((item) => item.id),
    lastVerifiedAt:
      input.evidenceTier === "verified" &&
      (input.evidenceNotes.length > 0 || input.productionEvidence !== null)
        ? input.evidenceObservedAt
        : null,
    nextAction: input.nextAction,
    productionClaim: input.productionClaim,
    sourceAdapter: "operator-prospect-input",
  });

  const operatingFindings = runRealityLens({
    projects: [project],
    evidence,
    approvals: [],
    now,
  }).map((finding) => prospectFindingCopy(finding, input));

  for (const [index, decision] of input.pendingDecisions.entries()) {
    const decisionReceipt = receipt({
      id: `prospect:decision:${index + 1}`,
      source: "operator",
      scope: "approval",
      label: `Supplied pending decision ${index + 1}`,
      claim: decision,
      observedAt: input.evidenceObservedAt,
      verification: "declared",
      production: false,
    });
    evidence.push(decisionReceipt);
    operatingFindings.push(RealityFindingSchema.parse({
      id: `unresolved-approval:${projectId}:${index + 1}`,
      rule: "unresolved-approval",
      projectId,
      title: `${input.prospectName} has a decision waiting`,
      explanation: `Operator input identifies a pending decision: ${decision}`,
      severity: "high",
      confidence: "high",
      evidenceIds: [decisionReceipt.id],
      nextAction: "Name the decision owner, review the exact evidence and constraints, then record approve, reject, or request changes.",
    }));
  }

  operatingFindings.sort((left, right) => {
    const severity = severityRank[left.severity] - severityRank[right.severity];
    return severity !== 0 ? severity : left.id.localeCompare(right.id);
  });

  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const findings: ProspectFinding[] = operatingFindings.map((finding) => {
    const citedReceipts = finding.evidenceIds
      .map((id) => evidenceById.get(id))
      .filter((item): item is EvidenceReceipt => item !== undefined);
    const receiptSources = citedReceipts.map((item) => `${item.label}: ${item.claim}`);
    let sourceEvidence = receiptSources;
    if (finding.rule === "missing-next-action") {
      sourceEvidence = [sourceFallback(finding, input)];
    } else if (finding.rule === "conflicting-status") {
      sourceEvidence = [sourceFallback(finding, input), ...receiptSources];
    } else if (finding.rule === "unverified-production") {
      const productionSources = citedReceipts
        .filter((item) => item.production)
        .map((item) => `${item.label}: ${item.claim}`);
      sourceEvidence = productionSources.length > 0
        ? productionSources
        : [sourceFallback(finding, input)];
    }
    return ProspectFindingSchema.parse({
      rule: finding.rule,
      title: finding.title,
      explanation: finding.explanation,
      severity: finding.severity,
      confidence: finding.confidence,
      nextAction: finding.nextAction,
      sourceEvidence: sourceEvidence.length > 0
        ? sourceEvidence
        : [sourceFallback(finding, input)],
    });
  });

  const verificationLabel = input.evidenceTier === "verified"
    ? "marked verified by the operator"
    : input.evidenceTier === "operator-observed"
      ? "recorded as operator observation"
      : "recorded as a prospect claim";

  return ProspectBriefSchema.parse({
    generatedAt: now.toISOString(),
    prospectName: input.prospectName,
    buyerRole: input.buyerRole,
    headline: `Where ${input.prospectName} needs operating certainty`,
    objective: input.objective,
    primarySurface: input.primarySurface,
    observedStatus: input.observedStatus,
    declaredStatus: input.declaredStatus,
    workstreams: input.workstreams.length > 0
      ? input.workstreams
      : [input.primarySurface],
    evidenceBoundary: `Draft from bounded operator input. Evidence was ${verificationLabel}. This brief trusts the selected tier and performs no independent source check. No quantified outcome is implied.`,
    findings,
    engagement: buildEngagement(findings),
    proposedNextStep: `Run a 45-minute operating review${input.buyerRole ? ` with the ${input.buyerRole}` : ""} to validate the source map, resolve the highest-severity gap, and agree on one evidence-backed next action.`,
  });
}

export function formatProspectBriefText(brief: ProspectBrief): string {
  const parsed = ProspectBriefSchema.parse(brief);
  const lines = [
    `${parsed.prospectName} — Prospect Lens`,
    "DRAFT · INTERNAL · REVIEW BEFORE SHARING",
    "",
    parsed.headline,
    "",
    `Objective: ${parsed.objective}`,
    `Primary operating surface: ${parsed.primarySurface}`,
    `Observed status: ${parsed.observedStatus}`,
    `Declared status: ${parsed.declaredStatus ?? "not supplied"}`,
    `Workstreams: ${parsed.workstreams.join("; ")}`,
    "",
    "Reality Lens",
    ...parsed.findings.flatMap((finding, index) => [
      `${index + 1}. [${finding.severity.toUpperCase()}] ${finding.title}`,
      `   ${finding.explanation}`,
      `   Source: ${finding.sourceEvidence.join(" | ")}`,
      `   Smallest safe next action: ${finding.nextAction}`,
    ]),
    "",
    "Proposed Suede operating engagement",
    ...parsed.engagement.map((step, index) => (
      `${index + 1}. ${step.title}: ${step.outcome}`
    )),
    "",
    `Suggested next step: ${parsed.proposedNextStep}`,
    "",
    `Evidence boundary: ${parsed.evidenceBoundary}`,
  ];
  return lines.join("\n");
}
