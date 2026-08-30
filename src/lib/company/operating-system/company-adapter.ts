import type { FlowRepo } from "@/lib/db/repo";
import type { ProjectRepo } from "@/lib/projects/repo";
import type { AgentRecord } from "@/lib/db/repo";
import type { ApprovalRecord, CompanyRecord, EmployeeRecord } from "@/lib/company/types";
import type { FlowLifecycle } from "@/lib/projects/types";
import {
  OperatingAdapterResultSchema,
  type EvidenceReceipt,
  type OperatingAdapterResult,
  type OperatingApproval,
  type OperatingDependencySchema,
  type OperatingLifecycle,
  type OperatingMilestone,
  type OperatingProject,
} from "./schema";
import type { z } from "zod";

export type CompanyOperatingRepo = Pick<
  FlowRepo,
  | "getAgent"
  | "listApprovals"
  | "listCompaniesByOwner"
  | "listCompanyActivity"
  | "listDepartments"
  | "listEmployees"
>;

interface CompanyAdapterContext {
  ownerId: string;
  now: Date;
  companyRepo: CompanyOperatingRepo;
  projectRepo: ProjectRepo | null;
}

type OperatingDependency = z.infer<typeof OperatingDependencySchema>;

function companyLifecycle(company: CompanyRecord): OperatingLifecycle {
  if (company.status === "draft") return "building";
  if (company.status === "paused") return "paused";
  return "live";
}

function deploymentLifecycle(status: FlowLifecycle): OperatingLifecycle {
  if (status === "live") return "live";
  if (status === "retired") return "complete";
  return "building";
}

function approvalTitle(approval: ApprovalRecord): string {
  if (approval.actionSummary) return approval.actionSummary;
  if (approval.kind === "enable_live_selling") return "Enable live selling";
  if (approval.kind === "fire_publish_gated") return "Run publish-gated work";
  if (approval.kind === "hire_employee") return "Hire a new employee";
  return "Run work above the company cost threshold";
}

function approvalCostLabel(approval: ApprovalRecord): string {
  const snapshot = approval.costSnapshot;
  if (!snapshot || snapshot.basis === "unavailable") return "Cost not available";
  const prefix = snapshot.basis === "quoted" ? "Quoted" : "Estimated";
  return `${prefix} · $${snapshot.amountUsdc.toFixed(3)} USDC`;
}

function companyNextAction(input: {
  company: CompanyRecord;
  employees: readonly EmployeeRecord[];
  pendingApprovals: readonly ApprovalRecord[];
}): string {
  if (input.pendingApprovals.length > 0) {
    return `Review ${input.pendingApprovals.length} pending ${input.pendingApprovals.length === 1 ? "approval" : "approvals"} before the next governed run.`;
  }
  if (input.employees.length === 0) return "Add one accountable employee before attempting a company run.";
  if (input.company.status === "draft") return "Review the company configuration and choose whether to activate it.";
  if (input.company.status === "paused") return "Confirm the pause is still intentional, then resume only when its dependencies are ready.";
  return "Run the next governed company cycle and review its persisted activity receipt.";
}

async function deploymentEvidence(input: {
  ownerId: string;
  agent: AgentRecord;
  projectRepo: ProjectRepo | null;
}): Promise<{ evidence: EvidenceReceipt[]; ids: string[]; partial: boolean }> {
  if (!input.projectRepo) return { evidence: [], ids: [], partial: true };
  try {
    const [versions, deployments] = await Promise.all([
      input.projectRepo.listFlowVersions({
        flowId: input.agent.flowId,
        ownerId: input.ownerId,
      }),
      input.projectRepo.listDeployments({
        flowId: input.agent.flowId,
        ownerId: input.ownerId,
      }),
    ]);
    const evidence: EvidenceReceipt[] = [];
    const latestVersion = versions[0];
    if (latestVersion) {
      evidence.push({
        id: `version:${latestVersion.id}`,
        source: "version",
        scope: "dependency",
        label: `Flow version ${latestVersion.versionNumber}`,
        claim: `Owner-scoped version ${latestVersion.versionNumber} is recorded for ${input.agent.slug}.`,
        observedAt: new Date(latestVersion.createdAt).toISOString(),
        verification: "verified",
        production: false,
        href: `/build/${encodeURIComponent(input.agent.flowId)}`,
      });
    }
    const latestDeployment = deployments[0];
    if (latestDeployment) {
      evidence.push({
        id: `deployment:${latestDeployment.id}`,
        source: "deployment",
        scope: "dependency",
        label: `${latestDeployment.status} deployment receipt`,
        claim: `Owner-scoped deployment ${latestDeployment.id} records ${latestDeployment.status} for ${input.agent.slug}.`,
        observedAt: new Date(latestDeployment.createdAt).toISOString(),
        verification: "verified",
        statusClaim: deploymentLifecycle(latestDeployment.status),
        production: latestDeployment.status === "live",
        href: `/build/${encodeURIComponent(input.agent.flowId)}`,
      });
    }
    return { evidence, ids: evidence.map((receipt) => receipt.id), partial: false };
  } catch {
    return { evidence: [], ids: [], partial: true };
  }
}

async function collectCompany(input: {
  ownerId: string;
  now: Date;
  company: CompanyRecord;
  companyRepo: CompanyOperatingRepo;
  projectRepo: ProjectRepo | null;
}): Promise<{
  project: OperatingProject;
  milestones: OperatingMilestone[];
  evidence: EvidenceReceipt[];
  approvals: OperatingApproval[];
  partial: boolean;
}> {
  const [departments, employees, pendingApprovals, activity] = await Promise.all([
    input.companyRepo.listDepartments(input.company.id),
    input.companyRepo.listEmployees(input.company.id),
    input.companyRepo.listApprovals(input.company.id, "pending"),
    input.companyRepo.listCompanyActivity({
      companyId: input.company.id,
      fromMs: 0,
      toMs: input.now.getTime() + 1,
      limit: 1,
    }),
  ]);
  const agents = await Promise.all(
    employees.map(async (employee) => ({
      employee,
      agent: await input.companyRepo.getAgent(employee.agentId),
    })),
  );
  const deploymentReceipts = await Promise.all(
    agents
      .filter((item): item is { employee: EmployeeRecord; agent: AgentRecord } => item.agent !== null)
      .map(async (item) => ({
        agentId: item.agent.id,
        receipts: await deploymentEvidence({
          ownerId: input.ownerId,
          agent: item.agent,
          projectRepo: input.projectRepo,
        }),
      })),
  );
  const deploymentByAgent = new Map(
    deploymentReceipts.map((item) => [item.agentId, item.receipts]),
  );
  const evidence: EvidenceReceipt[] = [
    {
      id: `company:${input.company.id}:status`,
      source: "company",
      scope: "project",
      label: `${input.company.name} stored status`,
      claim: `The authenticated Company record is ${input.company.status} with ${departments.length} departments and ${employees.length} active employees.`,
      observedAt: input.now.toISOString(),
      verification: "verified",
      statusClaim: companyLifecycle(input.company),
      production: false,
      href: `/company?id=${encodeURIComponent(input.company.id)}`,
    },
  ];
  const dependencies: OperatingDependency[] = [];
  for (const { employee, agent } of agents) {
    const agentEvidenceId = `agent:${employee.agentId}:status`;
    evidence.push({
      id: agentEvidenceId,
      source: "agent",
      scope: "dependency",
      label: employee.jobDescription,
      claim: agent
        ? `The employee agent is ${agent.status}; live selling is ${agent.settlementLive ? "enabled" : "disabled"}.`
        : "No agent record was found for this employee.",
      observedAt: input.now.toISOString(),
      verification: agent ? "verified" : "missing",
      ...(agent ? { statusClaim: agent.status === "live" ? "live" as const : "building" as const } : {}),
      production: Boolean(agent?.status === "live" && agent.settlementLive),
      href: `/company?id=${encodeURIComponent(input.company.id)}`,
    });
    const deployment = agent ? deploymentByAgent.get(agent.id) : undefined;
    if (deployment) evidence.push(...deployment.evidence);
    dependencies.push({
      id: `employee:${employee.agentId}`,
      label: employee.jobDescription,
      state: !agent ? "blocked" : agent.status === "live" ? "ready" : "blocked",
      projectId: null,
      evidenceIds: [agentEvidenceId, ...(deployment?.ids ?? [])],
    });
  }
  const latestActivity = activity.records[0];
  if (latestActivity) {
    evidence.push({
      id: `activity:${latestActivity.id}`,
      source: latestActivity.kind === "run" ? "run" : "approval",
      scope: "milestone",
      label: latestActivity.kind === "run" ? "Latest company run" : "Latest company decision",
      claim: `${latestActivity.kind === "run" ? "Run" : "Approval"} ${latestActivity.id} is recorded as ${latestActivity.status}.`,
      observedAt: new Date(latestActivity.occurredAt).toISOString(),
      verification: "verified",
      production: latestActivity.receipt !== null,
      href: `/company?id=${encodeURIComponent(input.company.id)}`,
    });
  }
  const queue = pendingApprovals.map((approval): OperatingApproval => {
    const employee = employees.find((candidate) => candidate.agentId === approval.subjectId);
    const evidenceId = `approval:${approval.id}`;
    evidence.push({
      id: evidenceId,
      source: "approval",
      scope: "approval",
      label: approvalTitle(approval),
      claim: `Approval ${approval.id} is pending in the owner-scoped Company ledger.`,
      observedAt: approval.createdAt,
      verification: "verified",
      production: false,
      href: `/company?id=${encodeURIComponent(input.company.id)}`,
    });
    return {
      id: approval.id,
      companyId: input.company.id,
      companyName: input.company.name,
      kind: approval.kind,
      title: approvalTitle(approval),
      subject: employee?.jobDescription ?? approval.subjectId,
      requestedAt: approval.createdAt,
      costLabel: approvalCostLabel(approval),
      evidenceIds: [evidenceId],
      href: `/company?id=${encodeURIComponent(input.company.id)}`,
    };
  });
  const projectId = `company:${input.company.id}`;
  const projectEvidenceIds = evidence.map((receipt) => receipt.id);
  const nextAction = companyNextAction({
    company: input.company,
    employees,
    pendingApprovals,
  });
  const project: OperatingProject = {
    id: projectId,
    name: input.company.name,
    surface: "Company v1",
    objective: input.company.mission,
    owner: { kind: "person", label: "Authenticated Company owner" },
    status: companyLifecycle(input.company),
    dependencies,
    evidenceIds: projectEvidenceIds,
    lastVerifiedAt: input.now.toISOString(),
    nextAction,
    productionClaim: false,
    sourceAdapter: "company-runtime",
  };
  const blockedEmployee = dependencies.find((dependency) => dependency.state === "blocked");
  const milestones: OperatingMilestone[] = [
    {
      id: `${projectId}:configuration`,
      projectId,
      title: "Review operating configuration",
      outcome: "Company mission, departments, employees, budgets, and gates have an owner review.",
      state: input.company.status === "draft" ? "in-progress" : "complete",
      target: null,
      blocker: null,
      owner: project.owner,
      evidenceIds: [`company:${input.company.id}:status`],
      href: `/company?id=${encodeURIComponent(input.company.id)}`,
    },
    {
      id: `${projectId}:next-run`,
      projectId,
      title: "Complete the next governed cycle",
      outcome: "The next company run or decision produces a persisted activity receipt.",
      state: pendingApprovals.length > 0 || blockedEmployee ? "blocked" : "in-progress",
      target: null,
      blocker: pendingApprovals.length > 0
        ? `${pendingApprovals.length} approval ${pendingApprovals.length === 1 ? "is" : "are"} waiting`
        : blockedEmployee?.label ?? null,
      owner: project.owner,
      evidenceIds: latestActivity
        ? [`activity:${latestActivity.id}`]
        : [`company:${input.company.id}:status`],
      href: `/company?id=${encodeURIComponent(input.company.id)}`,
    },
  ];
  return {
    project,
    milestones,
    evidence,
    approvals: queue,
    partial: deploymentReceipts.some((item) => item.receipts.partial),
  };
}

export async function collectCompanyRuntime(
  context: CompanyAdapterContext,
): Promise<OperatingAdapterResult> {
  const companies = await context.companyRepo.listCompaniesByOwner(context.ownerId);
  const collected = await Promise.all(
    companies.map((company) => collectCompany({
      ...context,
      company,
    })),
  );
  const result = {
    adapterId: "company-runtime",
    label: "Authenticated Company runtime",
    status: collected.some((item) => item.partial) ? "partial" as const : "ok" as const,
    checkedAt: context.now.toISOString(),
    note: collected.some((item) => item.partial)
      ? "Company state is current; one or more optional version/deployment receipt reads were unavailable."
      : "Current owner-scoped Company, employee, approval, activity, version, and deployment records.",
    projects: collected.map((item) => item.project),
    milestones: collected.flatMap((item) => item.milestones),
    evidence: collected.flatMap((item) => item.evidence),
    approvals: collected.flatMap((item) => item.approvals),
  };
  return OperatingAdapterResultSchema.parse(result);
}
