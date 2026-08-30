/**
 * Shared promote-to-live sequence for launch surfaces.
 *
 * Publishing an agent is not enough to make its paid endpoint work: a
 * non-dry-run call resolves the immutable version currently promoted to the
 * owner's Live environment (src/lib/run-service.ts
 * preparePublishedLiveExecution) and 503s when none exists. Every launch path
 * therefore has to walk the same promotion the company-activation service
 * walks: ensureOwnedFlowContext -> VersionService.createFlowVersion ->
 * DeploymentService.deployVersion "PROMOTE TEST" -> deployVersion
 * "PROMOTE LIVE" with the Test deployment as the required source (the deploy
 * request schema rejects a Live promotion without one).
 *
 * The promotion mechanics are deliberately duplicated from
 * src/lib/company/activation.ts (deployExactVersion + the stage sequence)
 * rather than refactoring activation.ts, which carries its own compensation
 * semantics; a later pass can converge the two on this helper. Partial
 * Test/Live deployments left behind by a failed promotion are safe residue,
 * exactly as in activation.
 *
 * Server-only: pulls the project control plane. Never import into a client
 * component.
 */
import { DeploymentService } from "@/lib/projects/deployment-service";
import { ensureOwnedFlowContext } from "@/lib/projects/provider";
import type { ProjectRepo } from "@/lib/projects/repo";
import type {
  DeploymentRecord,
  EnvironmentKind,
  EnvironmentRecord,
} from "@/lib/projects/types";
import { VersionService } from "@/lib/projects/version-service";

export type PromoteLiveStage =
  | "flow-context"
  | "environment"
  | "version"
  | "test-deployment"
  | "live-deployment";

export type PromoteLiveResult =
  | {
      readonly status: "promoted";
      readonly versionId: string;
      readonly testDeployment: DeploymentRecord;
      readonly liveDeployment: DeploymentRecord;
    }
  | { readonly status: "failed"; readonly stage: PromoteLiveStage };

function environmentOfKind(
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

  // A concurrent or retried launch may have won the promotion between our
  // read and write. Accept only the exact immutable target now active.
  const reconciled = await input.service.getActiveDeployment({
    flowId: input.flowId,
    environmentKind: kind,
    ownerId: input.ownerId,
  });
  return exactDeployment(reconciled, input.versionId, input.environment.id, kind)
    ? reconciled
    : null;
}

/**
 * Checkpoint the flow's current draft graph as an immutable version and
 * promote it Test -> Live in the owner's bound project context. Idempotent in
 * effect: relaunching re-checkpoints and re-promotes, and an exact already-
 * active deployment is accepted as-is. Never throws for expected control-plane
 * refusals; callers must treat any non-"promoted" result as launch failure so
 * a half-launched, unpayable agent is never left behind silently.
 */
export async function promoteFlowToLive(input: {
  readonly flowId: string;
  readonly ownerId: string;
  readonly projectRepo: ProjectRepo;
  readonly expectedVersion?: {
    readonly semanticHash: string;
    readonly fullHash: string;
  };
}): Promise<PromoteLiveResult> {
  const context = await ensureOwnedFlowContext({
    repo: input.projectRepo,
    flowId: input.flowId,
    ownerId: input.ownerId,
  });
  if (!context) return { status: "failed", stage: "flow-context" };

  const testEnvironment = environmentOfKind(context.environments, "test");
  const liveEnvironment = environmentOfKind(context.environments, "live");
  if (!testEnvironment || !liveEnvironment) {
    return { status: "failed", stage: "environment" };
  }

  const version = await new VersionService(input.projectRepo).createFlowVersion({
    flowId: input.flowId,
    ownerId: input.ownerId,
  });
  if (!version) return { status: "failed", stage: "version" };
  if (input.expectedVersion &&
      (version.semanticHash !== input.expectedVersion.semanticHash ||
       version.fullHash !== input.expectedVersion.fullHash)) {
    return { status: "failed", stage: "version" };
  }

  const service = new DeploymentService(input.projectRepo);
  const testDeployment = await deployExactVersion({
    service,
    flowId: input.flowId,
    ownerId: input.ownerId,
    versionId: version.id,
    semanticHash: version.semanticHash,
    fullHash: version.fullHash,
    environment: testEnvironment,
    sourceTestDeploymentId: null,
  });
  if (!testDeployment) return { status: "failed", stage: "test-deployment" };

  const liveDeployment = await deployExactVersion({
    service,
    flowId: input.flowId,
    ownerId: input.ownerId,
    versionId: version.id,
    semanticHash: version.semanticHash,
    fullHash: version.fullHash,
    environment: liveEnvironment,
    sourceTestDeploymentId: testDeployment.id,
  });
  if (!liveDeployment) return { status: "failed", stage: "live-deployment" };

  return { status: "promoted", versionId: version.id, testDeployment, liveDeployment };
}
