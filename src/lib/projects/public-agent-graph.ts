import {
  ApiOperationLiveUnavailableError,
  graphContainsApiOperation,
} from "../connectors/operation-closure";
import { resolveActiveLiveExecution } from "./live-execution";
import type { ProjectRepo } from "./repo";
import type { DeploymentRecord, ReadonlyFlowGraph } from "./types";
import type { SupportedFlowGraph } from "../flow/types";
import { projectPublicHttpCredentials } from "../flow/http-publication-policy";
import type { ResourcePackResolutionReference } from "./resource-dependency-contract";

export interface PublicAgentFlowSnapshot {
  readonly id: string;
  readonly ownerId: string;
  readonly graph: SupportedFlowGraph;
}

type ExactResolver = typeof resolveActiveLiveExecution;
export interface ResolvePublicAgentGraphInput {
  readonly flow: PublicAgentFlowSnapshot;
  readonly projectRepo: ProjectRepo | null;
  readonly resolveExact?: ExactResolver;
  /** Fresh bulk-read state. Null means no active Live deployment at read time. */
  readonly activeDeployment?: DeploymentRecord | null;
}

export interface PublicAgentRelease {
  readonly graph: ReadonlyFlowGraph;
  readonly resourceDependencies: readonly ResourcePackResolutionReference[];
  readonly release: {
    readonly ownerId: string;
    readonly flowId: string;
    readonly deploymentId: string;
    readonly environmentId: string;
    readonly flowVersionId: string;
    readonly semanticHash: string;
    readonly fullHash: string;
  };
}

const ACTIVE_DEPLOYMENT_NOT_PRELOADED = Symbol("active-deployment-not-preloaded");

function deepFreeze<Value>(value: Value, seen = new WeakSet<object>()): Value {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function matchesActiveRelease(
  deployment: DeploymentRecord,
  release: PublicAgentRelease["release"],
  flow: PublicAgentFlowSnapshot,
): boolean {
  return release.ownerId === flow.ownerId &&
    release.flowId === flow.id &&
    release.deploymentId === deployment.id &&
    release.environmentId === deployment.environmentId &&
    release.flowVersionId === deployment.flowVersionId;
}

/** Resolve one exact immutable Live release. Every public caller fails closed without it. */
export async function resolvePublicAgentRelease(
  input: ResolvePublicAgentGraphInput,
): Promise<PublicAgentRelease | null> {
  if (!input.projectRepo) return null;
  try {
    const preloaded = Object.prototype.hasOwnProperty.call(input, "activeDeployment")
      ? input.activeDeployment
      : ACTIVE_DEPLOYMENT_NOT_PRELOADED;
    const active = preloaded === ACTIVE_DEPLOYMENT_NOT_PRELOADED
      ? await input.projectRepo.getActiveDeployment({
          flowId: input.flow.id,
          ownerId: input.flow.ownerId,
          environmentKind: "live",
        })
      : preloaded;
    if (!active) return null;
    const exact = await (input.resolveExact ?? resolveActiveLiveExecution)({
      flowId: input.flow.id,
      ownerId: input.flow.ownerId,
      projectRepo: input.projectRepo,
      initialDeployment: active,
    });
    if (!exact || graphContainsApiOperation(exact.graph) ||
        !matchesActiveRelease(active, exact.receipt, input.flow)) return null;
    return Object.freeze({
      graph: deepFreeze(projectPublicHttpCredentials(exact.graph as SupportedFlowGraph)),
      resourceDependencies: exact.resourceDependencies,
      release: Object.freeze({ ...exact.receipt }),
    });
  } catch (error) {
    if (error instanceof ApiOperationLiveUnavailableError ||
        (typeof error === "object" && error !== null &&
          Reflect.get(error, "code") === "API_OPERATION_LIVE_UNAVAILABLE")) return null;
    return null;
  }
}

/** Compatibility projection for callers that only need a public graph. */
export async function resolvePublicAgentGraph(
  input: ResolvePublicAgentGraphInput,
): Promise<SupportedFlowGraph | null> {
  const release = await resolvePublicAgentRelease(input);
  return release ? release.graph as SupportedFlowGraph : null;
}
