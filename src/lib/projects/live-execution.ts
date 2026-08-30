import { hashFlowGraph } from "./hash";
import type { ProjectRepo } from "./repo";
import type { DependencyPinInput, DeploymentRecord, ReadonlyFlowGraph } from "./types";
import { isFlowGraphV2, parseSupportedFlowGraph } from "../flow/graph-schema";
import { normalizeSubflowReference } from "../flow/subflow-reference";
import {
  preflightPersistedRun,
  type RunSubflowSnapshot,
} from "../flow/run-subflow-preflight";
import type { SubflowReference, SupportedFlowGraph } from "../flow/types";
import {
  ApiOperationLiveUnavailableError,
  refuseApiOperationLive,
} from "../connectors/operation-closure";
import {
  resourceDependencyPinsFromGraph,
  type ResourcePackResolutionReference,
} from "./resource-dependency-contract";

export interface ActiveLiveExecution {
  readonly graph: ReadonlyFlowGraph;
  readonly subflowSnapshot: RunSubflowSnapshot;
  readonly usesConnections: boolean;
  /** Exact Resource Pack closure classified from the immutable root and pinned subflows. */
  readonly resourceDependencies: readonly ResourcePackResolutionReference[];
  readonly receipt: Readonly<{
    ownerId: string;
    flowId: string;
    deploymentId: string;
    environmentId: string;
    flowVersionId: string;
    semanticHash: string;
    fullHash: string;
  }>;
}

function graphUsesConnections(graph: SupportedFlowGraph): boolean {
  if (!isFlowGraphV2(graph)) return false;
  for (const node of graph.nodes) {
    const bindings = Object.getOwnPropertyDescriptor(node, "bindings");
    if (!bindings || !("value" in bindings) || bindings.value === null ||
        typeof bindings.value !== "object" || Array.isArray(bindings.value)) continue;
    for (const binding of Object.values(bindings.value as Record<string, unknown>)) {
      if (binding !== null && typeof binding === "object" && !Array.isArray(binding)) {
        const kind = Object.getOwnPropertyDescriptor(binding, "kind");
        if (kind && "value" in kind && kind.value === "secret") return true;
      }
    }
  }
  return false;
}

const EMPTY_SUBFLOW_SNAPSHOT: RunSubflowSnapshot = Object.freeze({
  loadSubflow: async (flowId: string): Promise<SupportedFlowGraph> => {
    throw new Error(`Subflow ${flowId} was not preflighted`);
  },
  resolveSubflow: async (reference: SubflowReference): Promise<never> => {
    throw new Error(`Subflow ${reference.flowId} was not preflighted`);
  },
});

function dependencyInputs(
  dependencies: readonly {
    readonly kind: DependencyPinInput["kind"];
    readonly resourceId: string;
    readonly version: string;
    readonly contentHash?: string;
  }[],
): readonly DependencyPinInput[] {
  return dependencies.map((dependency) => ({
    kind: dependency.kind,
    resourceId: dependency.resourceId,
    version: dependency.version,
    ...(dependency.contentHash === undefined ? {} : { contentHash: dependency.contentHash }),
  }));
}

function detachedFrozen<Value>(value: Value, seen = new WeakMap<object, object>()): Value {
  if (value === null || typeof value !== "object") return value;
  const source = value as object;
  const existing = seen.get(source);
  if (existing) return existing as Value;

  if (Array.isArray(source)) {
    const result: unknown[] = [];
    seen.set(source, result);
    for (const item of source) result.push(detachedFrozen(item, seen));
    return Object.freeze(result) as Value;
  }

  const prototype = Object.getPrototypeOf(source);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Live graph must contain only plain data");
  }
  if (Object.getOwnPropertySymbols(source).length !== 0) {
    throw new TypeError("Live graph must not contain symbol fields");
  }

  const result = Object.create(null) as Record<string, unknown>;
  seen.set(source, result);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(source))) {
    if (!("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError("Live graph must contain only enumerable data fields");
    }
    result[key] = detachedFrozen(descriptor.value, seen);
  }
  return Object.freeze(result) as Value;
}

function assertPinnedReferences(graph: SupportedFlowGraph): boolean {
  for (const node of graph.nodes) {
    if (node.type !== "subflow" && node.type !== "loop") continue;
    const normalized = normalizeSubflowReference(node.params);
    if (normalized.kind !== "typed" || normalized.reference.kind !== "pinned") return false;
  }
  return true;
}

function exactVersionDependencies(version: {
  readonly id: string;
  readonly dependencies: readonly {
    readonly flowVersionId: string;
    readonly kind: DependencyPinInput["kind"];
    readonly resourceId: string;
    readonly version: string;
    readonly contentHash?: string;
  }[];
}): readonly DependencyPinInput[] | null {
  if (version.dependencies.some((dependency) => dependency.flowVersionId !== version.id)) return null;
  return dependencyInputs(version.dependencies);
}

async function buildLiveSubflowSnapshot(input: {
  readonly rootFlowId: string;
  readonly ownerId: string;
  readonly graph: SupportedFlowGraph;
  readonly projectRepo: ProjectRepo;
}): Promise<Readonly<{
  graph: ReadonlyFlowGraph;
  subflowSnapshot: RunSubflowSnapshot;
  usesConnections: boolean;
  resourceDependencies: readonly ResourcePackResolutionReference[];
}> | null> {
  const root = detachedFrozen(parseSupportedFlowGraph(input.graph));
  let usesConnections = graphUsesConnections(root);
  const resourceDependencies = new Map<string, ResourcePackResolutionReference>();
  const classifyResourceDependencies = (graph: SupportedFlowGraph): void => {
    for (const dependency of resourceDependencyPinsFromGraph(graph)) {
      if (dependency.contentHash === undefined) {
        throw new TypeError("Resource Pack dependency refused.");
      }
      const reference = Object.freeze({
        resourceProductId: dependency.resourceId,
        packVersionId: dependency.version,
        contentHash: dependency.contentHash,
      });
      const previous = resourceDependencies.get(reference.resourceProductId);
      if (previous && (
        previous.packVersionId !== reference.packVersionId ||
        previous.contentHash !== reference.contentHash
      )) {
        throw new TypeError("Conflicting Resource Pack versions for one product.");
      }
      resourceDependencies.set(reference.resourceProductId, reference);
    }
  };
  const exactResourceDependencies = (): readonly ResourcePackResolutionReference[] =>
    Object.freeze([...resourceDependencies.values()].sort((left, right) =>
      left.resourceProductId.localeCompare(right.resourceProductId) ||
      left.packVersionId.localeCompare(right.packVersionId) ||
      left.contentHash.localeCompare(right.contentHash)));
  classifyResourceDependencies(root);
  if (!assertPinnedReferences(root)) return null;
  const hasReferences = root.nodes.some((node) => node.type === "subflow" || node.type === "loop");
  if (!isFlowGraphV2(root)) {
    return hasReferences ? null : Object.freeze({
      graph: root,
      subflowSnapshot: EMPTY_SUBFLOW_SNAPSHOT,
      usesConnections,
      resourceDependencies: exactResourceDependencies(),
    });
  }

  const checkedVersionRepo = {
    getFlowVersion: async (request: {
      readonly flowId: string;
      readonly versionId: string;
      readonly ownerId: string;
    }) => {
      if (request.ownerId !== input.ownerId) return null;
      const version = await input.projectRepo.getFlowVersion(request);
      if (!version || version.id !== request.versionId || version.flowId !== request.flowId) return null;
      const graph = detachedFrozen(parseSupportedFlowGraph(version.graph));
      refuseApiOperationLive(graph);
      usesConnections ||= graphUsesConnections(graph);
      classifyResourceDependencies(graph);
      if (!assertPinnedReferences(graph)) return null;
      const dependencies = exactVersionDependencies(version);
      if (!dependencies) return null;
      const semanticHash = hashFlowGraph(graph, { semantic: true }, dependencies);
      const fullHash = hashFlowGraph(graph, { semantic: false }, dependencies);
      if (semanticHash !== version.semanticHash || fullHash !== version.fullHash) return null;
      return detachedFrozen({
        ...version,
        graph,
        dependencies: version.dependencies.map((dependency) => ({ ...dependency })),
      });
    },
  };
  const preflighted = await preflightPersistedRun({
    rootFlowId: input.rootFlowId,
    ownerId: input.ownerId,
    graph: root,
    flowRepo: { getOwnedFlow: async () => null },
    versionRepo: checkedVersionRepo,
  });
  if (!preflighted.subflowSnapshot) return null;
  return Object.freeze({
    graph: detachedFrozen(preflighted.graph),
    subflowSnapshot: Object.freeze(preflighted.subflowSnapshot),
    usesConnections,
    resourceDependencies: exactResourceDependencies(),
  });
}

/** Resolve the exact immutable version currently promoted to this owner's bound Live environment. */
export async function resolveActiveLiveExecution(input: {
  readonly flowId: string;
  readonly ownerId: string;
  readonly projectRepo: ProjectRepo;
  /** Fresh catalog preflight; the active row is still confirmed again below. */
  readonly initialDeployment?: DeploymentRecord;
}): Promise<ActiveLiveExecution | null> {
  try {
    const deployment = input.initialDeployment ??
      await input.projectRepo.getActiveDeployment({
        flowId: input.flowId,
        environmentKind: "live",
        ownerId: input.ownerId,
      });
    if (!deployment || deployment.status !== "live" || deployment.retiredAt !== undefined ||
        deployment.flowId !== input.flowId) return null;

    const context = await input.projectRepo.getFlowContext(input.flowId, input.ownerId);
    if (!context || context.binding.flowId !== input.flowId ||
        context.binding.projectId !== context.project.id ||
        context.binding.workbookId !== context.workbook.id ||
        context.workbook.projectId !== context.project.id ||
        context.project.workspaceId !== context.workspace.id ||
        context.workspace.organizationId !== context.organization.id ||
        context.organization.personalOwnerId !== input.ownerId) return null;

    const boundEnvironments = context.environments.filter(
      (candidate) => candidate.id === deployment.environmentId,
    );
    if (boundEnvironments.length !== 1) return null;
    const [environment] = boundEnvironments;
    if (!environment || environment.kind !== "live" || environment.projectId !== context.project.id) return null;

    const version = await input.projectRepo.getFlowVersion({
      flowId: input.flowId,
      versionId: deployment.flowVersionId,
      ownerId: input.ownerId,
    });
    if (!version || version.id !== deployment.flowVersionId || version.flowId !== input.flowId) return null;

    const dependencies = exactVersionDependencies(version);
    if (!dependencies) return null;
    const semanticHash = hashFlowGraph(version.graph, { semantic: true }, dependencies);
    const fullHash = hashFlowGraph(version.graph, { semantic: false }, dependencies);
    if (semanticHash !== version.semanticHash || fullHash !== version.fullHash) return null;
    refuseApiOperationLive(version.graph as SupportedFlowGraph);

    const closure = await buildLiveSubflowSnapshot({
      rootFlowId: input.flowId,
      ownerId: input.ownerId,
      graph: version.graph as SupportedFlowGraph,
      projectRepo: input.projectRepo,
    });
    if (!closure) return null;

    const confirmedDeployment = await input.projectRepo.getActiveDeployment({
      flowId: input.flowId,
      environmentKind: "live",
      ownerId: input.ownerId,
    });
    if (!confirmedDeployment || confirmedDeployment.id !== deployment.id ||
        confirmedDeployment.flowId !== deployment.flowId ||
        confirmedDeployment.flowVersionId !== deployment.flowVersionId ||
        confirmedDeployment.environmentId !== deployment.environmentId ||
        confirmedDeployment.status !== "live" || confirmedDeployment.retiredAt !== undefined) return null;

    return detachedFrozen({
      graph: closure.graph,
      subflowSnapshot: closure.subflowSnapshot,
      usesConnections: closure.usesConnections,
      resourceDependencies: closure.resourceDependencies,
      receipt: {
        ownerId: input.ownerId,
        flowId: input.flowId,
        deploymentId: deployment.id,
        environmentId: environment.id,
        flowVersionId: version.id,
        semanticHash,
        fullHash,
      },
    });
  } catch (error) {
    if (error instanceof ApiOperationLiveUnavailableError) throw error;
    return null;
  }
}
