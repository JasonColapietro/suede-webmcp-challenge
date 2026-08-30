import { createHash } from "node:crypto";
import type { ProjectRepo } from "@/lib/projects/repo";
import {
  collectOperatingAdapter,
  type OperatingSystemAdapter,
} from "./adapters";
import {
  collectCompanyRuntime,
  type CompanyOperatingRepo,
} from "./company-adapter";
import { collectSuedeEstateFixture } from "./fixture-adapter";
import { runRealityLens } from "./reality-lens";
import {
  OperatingSystemSnapshotSchema,
  type EvidenceReceipt,
  type ExecutiveSnapshot,
  type OperatingApproval,
  type OperatingMilestone,
  type OperatingProject,
  type OperatingSnapshotBaseline,
  type OperatingSystemSnapshot,
  type RealityFinding,
  type SnapshotChange,
} from "./schema";

interface BuildSnapshotInput {
  ownerId: string;
  companyRepo: CompanyOperatingRepo;
  projectRepo: ProjectRepo | null;
  baseline?: OperatingSnapshotBaseline;
  now?: Date;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function uniqueById<Item extends { readonly id: string }>(
  items: readonly Item[],
): Item[] {
  const byId = new Map<string, Item>();
  for (const item of items) {
    if (!byId.has(item.id)) byId.set(item.id, item);
  }
  return [...byId.values()];
}

function evidenceFingerprint(
  project: OperatingProject,
  evidenceById: ReadonlyMap<string, EvidenceReceipt>,
): string {
  const receipts = project.evidenceIds
    .map((id) => evidenceById.get(id))
    .filter((receipt): receipt is EvidenceReceipt => receipt !== undefined)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((receipt) => ({
      id: receipt.id,
      claim: receipt.claim,
      verification: receipt.verification,
      statusClaim: receipt.statusClaim ?? null,
      production: receipt.production,
    }));
  return sha256(receipts);
}

function buildBaseline(input: {
  scopeId: string;
  snapshotId: string;
  generatedAt: string;
  projects: readonly OperatingProject[];
  evidence: readonly EvidenceReceipt[];
  findings: readonly RealityFinding[];
}): OperatingSnapshotBaseline {
  const evidenceById = new Map(input.evidence.map((receipt) => [receipt.id, receipt]));
  return {
    scopeId: input.scopeId,
    snapshotId: input.snapshotId,
    generatedAt: input.generatedAt,
    projects: input.projects.map((project) => ({
      id: project.id,
      status: project.status,
      evidenceFingerprint: evidenceFingerprint(project, evidenceById),
      nextAction: project.nextAction,
    })),
    findings: input.findings.map((finding) => ({
      id: finding.id,
      severity: finding.severity,
    })),
  };
}

function compareBaseline(
  current: OperatingSnapshotBaseline,
  previous: OperatingSnapshotBaseline | undefined,
): SnapshotChange[] {
  if (!previous) {
    return [{
      kind: "finding",
      projectId: null,
      summary: "Initial review established; no prior snapshot was supplied for comparison.",
    }];
  }
  const changes: SnapshotChange[] = [];
  const previousProjects = new Map(previous.projects.map((project) => [project.id, project]));
  const currentProjects = new Map(current.projects.map((project) => [project.id, project]));
  for (const project of current.projects) {
    const before = previousProjects.get(project.id);
    if (!before) {
      changes.push({
        kind: "project-added",
        projectId: project.id,
        summary: `${project.id} entered the operating map as ${project.status}.`,
      });
      continue;
    }
    if (before.status !== project.status) {
      changes.push({
        kind: "status",
        projectId: project.id,
        summary: `${project.id} moved from ${before.status} to ${project.status}.`,
      });
    }
    if (before.evidenceFingerprint !== project.evidenceFingerprint) {
      changes.push({
        kind: "evidence",
        projectId: project.id,
        summary: `${project.id} has new or changed source evidence.`,
      });
    }
    if (before.nextAction !== project.nextAction) {
      changes.push({
        kind: "next-action",
        projectId: project.id,
        summary: `${project.id} has a different next action.`,
      });
    }
  }
  for (const project of previous.projects) {
    if (currentProjects.has(project.id)) continue;
    changes.push({
      kind: "project-removed",
      projectId: project.id,
      summary: `${project.id} is no longer present in the current adapter output.`,
    });
  }
  const previousFindings = new Map(previous.findings.map((item) => [item.id, item]));
  const currentFindings = new Map(current.findings.map((item) => [item.id, item]));
  for (const item of current.findings) {
    if (previousFindings.has(item.id)) continue;
    changes.push({
      kind: "finding",
      projectId: item.id.split(":").slice(1).join(":") || null,
      summary: `New ${item.severity} Reality Lens finding: ${item.id}.`,
    });
  }
  for (const item of previous.findings) {
    if (currentFindings.has(item.id)) continue;
    changes.push({
      kind: "finding",
      projectId: item.id.split(":").slice(1).join(":") || null,
      summary: `Resolved Reality Lens finding: ${item.id}.`,
    });
  }
  return changes.slice(0, 100);
}

function uniqueText(values: readonly (string | null | undefined)[], limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = raw?.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length === limit) break;
  }
  return out;
}

function executiveSnapshot(input: {
  projects: readonly OperatingProject[];
  approvals: readonly OperatingApproval[];
  findings: readonly RealityFinding[];
  changes: readonly SnapshotChange[];
}): ExecutiveSnapshot {
  const projectsById = new Map(input.projects.map((project) => [project.id, project]));
  const blockedProjectIds = input.projects
    .filter(
      (project) =>
        project.status === "blocked" ||
        project.dependencies.some((dependency) => dependency.state === "blocked"),
    )
    .map((project) => project.id);
  const needsJason = uniqueText([
    ...input.approvals.map(
      (approval) => `${approval.companyName}: ${approval.title} (${approval.costLabel}).`,
    ),
    ...input.findings
      .filter((finding) => {
        if (finding.severity !== "critical" && finding.severity !== "high") return false;
        const project = finding.projectId ? projectsById.get(finding.projectId) : undefined;
        return project?.owner.kind === "person";
      })
      .map((finding) => finding.nextAction),
  ], 8);
  const nextActions = uniqueText([
    ...input.findings.map((finding) => finding.nextAction),
    ...input.projects.map((project) => project.nextAction),
  ], 8);
  return {
    changed: [...input.changes],
    blockedProjectIds,
    needsJason,
    nextActions,
  };
}

export async function buildOperatingSystemSnapshot(
  input: BuildSnapshotInput,
): Promise<OperatingSystemSnapshot> {
  const now = input.now ?? new Date();
  const checkedAt = now.toISOString();
  const adapters: OperatingSystemAdapter[] = [
    {
      adapterId: "suede-estate-fixture",
      label: "Suede estate import",
      collect: async () => collectSuedeEstateFixture(now),
    },
    {
      adapterId: "company-runtime",
      label: "Authenticated Company runtime",
      collect: async () => collectCompanyRuntime({
        ownerId: input.ownerId,
        now,
        companyRepo: input.companyRepo,
        projectRepo: input.projectRepo,
      }),
    },
  ];
  const results = await Promise.all(
    adapters.map((adapter) => collectOperatingAdapter(adapter, checkedAt)),
  );
  const projects = uniqueById(results.flatMap((result) => result.projects));
  const milestones = uniqueById<OperatingMilestone>(
    results.flatMap((result) => result.milestones),
  );
  const evidence = uniqueById<EvidenceReceipt>(
    results.flatMap((result) => result.evidence),
  );
  const approvals = uniqueById<OperatingApproval>(
    results.flatMap((result) => result.approvals),
  );
  const findings = runRealityLens({ projects, evidence, approvals, now });
  const scopeId = sha256(input.ownerId);
  const snapshotId = sha256({
    projects,
    milestones,
    evidence,
    approvals,
    findings,
  });
  const baseline = buildBaseline({
    scopeId,
    snapshotId,
    generatedAt: checkedAt,
    projects,
    evidence,
    findings,
  });
  const changes = compareBaseline(
    baseline,
    input.baseline?.scopeId === scopeId ? input.baseline : undefined,
  );
  const snapshot = {
    snapshotId,
    generatedAt: checkedAt,
    coverageNote: "Coverage combines an explicit Suede estate starter fixture with current authenticated Company records. GitHub, Vercel, Drive-vault, GSC, and platform-store adapters remain unconnected and must not be inferred from fixture status.",
    adapters: results.map(({ adapterId, label, status, checkedAt: adapterCheckedAt, note }) => ({
      adapterId,
      label,
      status,
      checkedAt: adapterCheckedAt,
      note,
    })),
    projects,
    milestones,
    evidence,
    approvals,
    findings,
    executive: executiveSnapshot({ projects, approvals, findings, changes }),
    baseline,
  };
  return OperatingSystemSnapshotSchema.parse(snapshot);
}
