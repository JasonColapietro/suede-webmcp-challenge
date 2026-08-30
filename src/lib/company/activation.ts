/**
 * Draft-company activation through the immutable project control plane.
 *
 * Every employee flow is checkpointed, deployed to Test, then promoted from
 * that exact Test deployment to Live before the company can become active.
 * Employee selling remains disabled; enabling settlement is a separate,
 * approval-gated action.
 */
import type { AgentRecord, FlowRepo } from "@/lib/db/repo";
import { DeploymentService } from "@/lib/projects/deployment-service";
import { ensureOwnedFlowContext } from "@/lib/projects/provider";
import type { ProjectRepo } from "@/lib/projects/repo";
import type { DeploymentRecord, EnvironmentKind, EnvironmentRecord } from "@/lib/projects/types";
import { VersionService } from "@/lib/projects/version-service";
import type { CompanyRecord, CompanyStatus } from "./types";

type CompanyActivationRepo = Pick<
  FlowRepo,
  "getCompany" | "listEmployees" | "getAgent" | "updateAgent" | "updateCompany"
>;

export type CompanyActivationStage =
  | "employee"
  | "flow-context"
  | "environment"
  | "version"
  | "test-deployment"
  | "live-deployment"
  | "agent"
  | "company";

export type CompanyActivationResult =
  | { readonly status: "activated"; readonly company: CompanyRecord }
  | { readonly status: "not-found" }
  | { readonly status: "invalid-state"; readonly companyStatus: Exclude<CompanyStatus, "draft" | "active"> }
  | {
      readonly status: "activation-failed";
      readonly agentId: string | null;
      readonly stage: CompanyActivationStage;
    };

function environment(
  environments: readonly EnvironmentRecord[],
  kind: Extract<EnvironmentKind, "test" | "live">,
): EnvironmentRecord | null {
  return environments.find((candidate) => candidate.kind === kind) ?? null;
}

function exactDeployment(
  deployment: DeploymentRecord | null,
  versionId: string,
  environmentId: string,
  status: "test" | "live",
): boolean {
  return deployment !== null &&
    deployment.flowVersionId === versionId &&
    deployment.environmentId === environmentId &&
    deployment.status === status;
}

async function deployExactVersion(input: {
  readonly service: DeploymentService;
  readonly flowId: string;
  readonly ownerId: string;
  readonly versionId: string;
  readonly semanticHash: string;
  readonly fullHash: string;
  readonly environment: EnvironmentRecord;
  readonly sourceTestDeploymentId: string | null;
}): Promise<DeploymentRecord | null> {
  const kind = input.environment.kind;
  if (kind !== "test" && kind !== "live") return null;

  const current = await input.service.getActiveDeployment({
    flowId: input.flowId,
    environmentKind: kind,
    ownerId: input.ownerId,
  });
  if (exactDeployment(current, input.versionId, input.environment.id, kind)) return current;

  const result = await input.service.deployVersion({
    flowId: input.flowId,
    versionId: input.versionId,
    versionSemanticHash: input.semanticHash,
    versionFullHash: input.fullHash,
    environmentId: input.environment.id,
    environmentKind: kind,
    expectedActiveDeploymentId: current?.id ?? null,
    sourceTestDeploymentId: input.sourceTestDeploymentId,
    confirmation: kind === "test" ? "PROMOTE TEST" : "PROMOTE LIVE",
    ownerId: input.ownerId,
  });
  if (
    result.status === "deployed" &&
    exactDeployment(result.deployment, input.versionId, input.environment.id, kind)
  ) {
    return result.deployment;
  }

  // A concurrent or retried activation may have won the promotion between
  // our read and write. Accept only the exact immutable target now active.
  const reconciled = await input.service.getActiveDeployment({
    flowId: input.flowId,
    environmentKind: kind,
    ownerId: input.ownerId,
  });
  return exactDeployment(reconciled, input.versionId, input.environment.id, kind)
    ? reconciled
    : null;
}

async function restoreAgentStates(
  repo: CompanyActivationRepo,
  agents: readonly AgentRecord[],
): Promise<void> {
  // Restore in reverse update order. Compensation is intentionally
  // best-effort because FlowRepo has no cross-agent transaction boundary,
  // but every normal repository implementation can restore these exact
  // pre-activation values.
  for (const agent of [...agents].reverse()) {
    try {
      await repo.updateAgent(agent.id, {
        status: agent.status,
        settlementLive: agent.settlementLive,
      });
    } catch {
      // Continue restoring the remaining employees instead of leaving more
      // residue because one compensation write failed.
    }
  }
}

async function restoreDraftCompany(
  repo: CompanyActivationRepo,
  companyId: string,
): Promise<void> {
  try {
    await repo.updateCompany(companyId, { status: "draft" });
  } catch {
    // The caller still returns activation-failed; there is no stronger
    // transaction primitive in FlowRepo to use here.
  }
}

/**
 * Activates an owned draft company without bypassing immutable Live.
 * Partial Test/Live deployments are safe residue. No employee status changes
 * until every immutable deployment succeeds, and later activation failures
 * compensate any agent rows already changed before returning.
 */
export async function activateCompany(input: {
  readonly companyId: string;
  readonly ownerId: string;
  readonly companyRepo: CompanyActivationRepo;
  readonly projectRepo: ProjectRepo;
}): Promise<CompanyActivationResult> {
  const company = await input.companyRepo.getCompany(input.companyId);
  if (!company || company.ownerId !== input.ownerId) return { status: "not-found" };
  if (company.status === "active") return { status: "activated", company };
  if (company.status !== "draft") {
    return { status: "invalid-state", companyStatus: company.status };
  }

  const versionService = new VersionService(input.projectRepo);
  const deploymentService = new DeploymentService(input.projectRepo);
  const employees = await input.companyRepo.listEmployees(company.id);
  const preparedAgents: AgentRecord[] = [];

  for (const employee of employees) {
    const agent = await input.companyRepo.getAgent(employee.agentId);
    if (!agent) {
      return { status: "activation-failed", agentId: employee.agentId, stage: "employee" };
    }

    const context = await ensureOwnedFlowContext({
      repo: input.projectRepo,
      flowId: agent.flowId,
      ownerId: input.ownerId,
    });
    if (!context) {
      return { status: "activation-failed", agentId: agent.id, stage: "flow-context" };
    }
    const testEnvironment = environment(context.environments, "test");
    const liveEnvironment = environment(context.environments, "live");
    if (!testEnvironment || !liveEnvironment) {
      return { status: "activation-failed", agentId: agent.id, stage: "environment" };
    }

    const version = await versionService.createFlowVersion({
      flowId: agent.flowId,
      ownerId: input.ownerId,
    });
    if (!version) {
      return { status: "activation-failed", agentId: agent.id, stage: "version" };
    }

    const testDeployment = await deployExactVersion({
      service: deploymentService,
      flowId: agent.flowId,
      ownerId: input.ownerId,
      versionId: version.id,
      semanticHash: version.semanticHash,
      fullHash: version.fullHash,
      environment: testEnvironment,
      sourceTestDeploymentId: null,
    });
    if (!testDeployment) {
      return { status: "activation-failed", agentId: agent.id, stage: "test-deployment" };
    }

    const liveDeployment = await deployExactVersion({
      service: deploymentService,
      flowId: agent.flowId,
      ownerId: input.ownerId,
      versionId: version.id,
      semanticHash: version.semanticHash,
      fullHash: version.fullHash,
      environment: liveEnvironment,
      sourceTestDeploymentId: testDeployment.id,
    });
    if (!liveDeployment) {
      return { status: "activation-failed", agentId: agent.id, stage: "live-deployment" };
    }

    preparedAgents.push(agent);
  }

  const changedAgents: AgentRecord[] = [];
  for (const agent of preparedAgents) {
    let activatedAgent: AgentRecord | null;
    try {
      activatedAgent = await input.companyRepo.updateAgent(agent.id, {
        status: "live",
        settlementLive: false,
      });
    } catch {
      await restoreAgentStates(input.companyRepo, [...changedAgents, agent]);
      return { status: "activation-failed", agentId: agent.id, stage: "agent" };
    }
    if (!activatedAgent || activatedAgent.status !== "live" || activatedAgent.settlementLive) {
      await restoreAgentStates(input.companyRepo, [...changedAgents, agent]);
      return { status: "activation-failed", agentId: agent.id, stage: "agent" };
    }
    changedAgents.push(agent);
  }

  let activated: CompanyRecord | null;
  try {
    activated = await input.companyRepo.updateCompany(company.id, { status: "active" });
  } catch {
    await restoreDraftCompany(input.companyRepo, company.id);
    await restoreAgentStates(input.companyRepo, changedAgents);
    return { status: "activation-failed", agentId: null, stage: "company" };
  }
  if (!activated || activated.status !== "active") {
    await restoreDraftCompany(input.companyRepo, company.id);
    await restoreAgentStates(input.companyRepo, changedAgents);
    return { status: "activation-failed", agentId: null, stage: "company" };
  }
  return { status: "activated", company: activated };
}
