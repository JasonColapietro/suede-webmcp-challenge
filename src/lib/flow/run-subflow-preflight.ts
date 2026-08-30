import type { FlowRepo } from "@/lib/db/repo";
import { hashFlowGraph } from "@/lib/projects/hash";
import type { FlowVersionRepo } from "@/lib/projects/repo";
import { preflightV2Execution, topoSort } from "./engine";
import type { NodeRegistry } from "./executor";
import { isFlowGraphV2, parseSupportedFlowGraph } from "./graph-schema";
import { getRegistry } from "./registry";
import { normalizeSubflowReference } from "./subflow-reference";
import {
  createSubflowResolver,
  type ResolvedSubflow,
  type SubflowResolver,
} from "./subflow-resolver";
import { assertCallableOutputSourcesExist } from "./subflow-validation";
import type { SubflowReference, SupportedFlowGraph } from "./types";
import { assertPortableSubflowDependencies } from "@/lib/projects/subflow-dependencies";

const MAX_CLOSURE_DEPTH = 64;
const MAX_UNIQUE_GRAPHS = 256;
const MAX_CLOSURE_NODES = 20_000;
const MAX_CLOSURE_EDGES = 40_000;
const MAX_CLOSURE_REFERENCES = 1_000;
const MAX_CLOSURE_BYTES = 16 * 1024 * 1024;

export interface RunSubflowSnapshot {
  readonly loadSubflow: (flowId: string) => Promise<SupportedFlowGraph>;
  readonly resolveSubflow: SubflowResolver;
}

export interface PreflightedPersistedRun {
  readonly graph: SupportedFlowGraph;
  readonly subflowSnapshot?: RunSubflowSnapshot;
}

export class PersistedRunPreflightError extends Error {
  readonly status: 409 | 422;
  readonly publicError: "reusable flow unavailable" | "flow is not runnable";

  constructor(
    status: 409 | 422,
    publicError: "reusable flow unavailable" | "flow is not runnable",
    options?: ErrorOptions,
  ) {
    super(publicError, options);
    this.name = "PersistedRunPreflightError";
    this.status = status;
    this.publicError = publicError;
  }
}

function refuseReference(cause: unknown): PersistedRunPreflightError {
  return new PersistedRunPreflightError(409, "reusable flow unavailable", { cause });
}

function refuseRoot(cause: unknown): PersistedRunPreflightError {
  return new PersistedRunPreflightError(422, "flow is not runnable", { cause });
}

function isInspectPolicyError(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    Reflect.get(error, "code") === "API_OPERATION_LIVE_UNAVAILABLE";
}

function referenceKey(reference: SubflowReference): string {
  return JSON.stringify(["typed", reference]);
}

function freezeSnapshot<Value>(value: Value): Value {
  if (value === null || typeof value !== "object") return value;
  const seen = new WeakSet<object>();
  const pending: object[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    for (const child of Object.values(current)) {
      if (child !== null && typeof child === "object") pending.push(child);
    }
    Object.freeze(current);
  }
  return value;
}

function assertRootReferencesResolved(graph: SupportedFlowGraph): void {
  if (graph === null || typeof graph !== "object") return;
  const candidate = graph as unknown as { schemaVersion?: unknown; nodes?: unknown };
  if (candidate.schemaVersion !== 2 || !Array.isArray(candidate.nodes)) return;
  for (const rawNode of candidate.nodes) {
    if (rawNode === null || typeof rawNode !== "object") continue;
    const node = rawNode as { type?: unknown; params?: unknown };
    if (node.type !== "subflow" && node.type !== "loop") continue;
    normalizeSubflowReference(node.params);
  }
}

/**
 * Validate a persisted v2 graph and its exact owner-scoped reusable-flow closure
 * before an SSE response is created. Root v1 graphs retain their existing run path.
 */
export async function preflightPersistedRun(input: {
  readonly rootFlowId: string;
  readonly ownerId: string;
  readonly graph: SupportedFlowGraph;
  readonly flowRepo: Pick<FlowRepo, "getOwnedFlow">;
  readonly versionRepo?: Pick<FlowVersionRepo, "getFlowVersion">;
  readonly registry?: NodeRegistry;
  /** Server-only closure policy evaluated for root and every exact descendant. */
  readonly inspectGraph?: (graph: SupportedFlowGraph) => void;
}): Promise<PreflightedPersistedRun> {
  let root: SupportedFlowGraph;
  try {
    try {
      assertRootReferencesResolved(input.graph);
    } catch (error) {
      throw refuseReference(error);
    }
    root = freezeSnapshot(parseSupportedFlowGraph(input.graph));
  } catch (error) {
    if (error instanceof PersistedRunPreflightError) throw error;
    throw refuseRoot(error);
  }
  if (!isFlowGraphV2(root)) return { graph: input.graph };
  if (!input.versionRepo) throw refuseRoot(new Error("Flow version store is unavailable"));

  const registry = input.registry ?? getRegistry();
  const versionRepo = input.versionRepo;
  const typedResolutionCache = new Map<string, Promise<ResolvedSubflow>>();
  const legacyResolutionCache = new Map<string, Promise<SupportedFlowGraph>>();
  const validatedGraphs = new Set<string>();
  const countedGraphs = new Set<string>();
  let nodeCount = 0;
  let edgeCount = 0;
  let referenceCount = 0;
  let serializedBytes = 0;

  const checkedFlowRepo: Pick<FlowRepo, "getOwnedFlow"> = {
    getOwnedFlow: async (flowId, ownerId) => {
      const flow = await input.flowRepo.getOwnedFlow(flowId, ownerId);
      if (!flow) return null;
      return freezeSnapshot({ ...flow, graph: freezeSnapshot(parseSupportedFlowGraph(flow.graph)) });
    },
  };

  const checkedVersionRepo: Pick<FlowVersionRepo, "getFlowVersion"> = {
    getFlowVersion: async (request) => {
      const version = await versionRepo.getFlowVersion(request);
      if (!version) return null;
      const graph = freezeSnapshot(parseSupportedFlowGraph(version.graph));
      const dependencies = version.dependencies.map((dependency) => ({
        kind: dependency.kind,
        resourceId: dependency.resourceId,
        version: dependency.version,
        ...(dependency.contentHash === undefined ? {} : { contentHash: dependency.contentHash }),
      }));
      assertPortableSubflowDependencies(graph, dependencies);
      const recomputed = hashFlowGraph(graph, { semantic: true }, dependencies);
      if (recomputed !== version.semanticHash) {
        throw new Error("Pinned flow version content hash is invalid");
      }
      return freezeSnapshot({
        ...version,
        graph,
        dependencies: version.dependencies.map((dependency) => ({ ...dependency })),
      });
    },
  };
  const resolveTyped = createSubflowResolver({
    ownerId: input.ownerId,
    flowRepo: checkedFlowRepo,
    versionRepo: checkedVersionRepo,
  });

  const resolveReference = (
    reference: SubflowReference,
  ): Promise<ResolvedSubflow> => {
    const key = referenceKey(reference);
    const cached = typedResolutionCache.get(key);
    if (cached) return cached;
    const pending = resolveTyped(reference).then((resolved) => {
      const graph = freezeSnapshot(parseSupportedFlowGraph(resolved.graph));
      if (!isFlowGraphV2(graph) || !graph.callableInterface) {
        throw new Error(`Subflow ${resolved.flowId} has no callable interface`);
      }
      return freezeSnapshot({ ...resolved, graph, callableInterface: graph.callableInterface });
    });
    typedResolutionCache.set(key, pending);
    return pending;
  };

  const resolveLegacy = (
    flowId: string,
  ): Promise<SupportedFlowGraph> => {
    const cached = legacyResolutionCache.get(flowId);
    if (cached) return cached;
    const pending = checkedFlowRepo.getOwnedFlow(flowId, input.ownerId).then((flow) => {
      if (!flow) throw new Error(`Reusable flow ${flowId} not found`);
      return freezeSnapshot(parseSupportedFlowGraph(flow.graph));
    });
    legacyResolutionCache.set(flowId, pending);
    return pending;
  };

  const visit = async (
    graph: SupportedFlowGraph,
    graphKey: string,
    ancestry: readonly string[],
    depth: number,
    rootGraph: boolean,
  ): Promise<void> => {
    try {
      if (depth > MAX_CLOSURE_DEPTH) {
        throw refuseReference(new Error("Reusable flow closure is too deep"));
      }
      if (!countedGraphs.has(graphKey)) {
        countedGraphs.add(graphKey);
        if (countedGraphs.size > MAX_UNIQUE_GRAPHS) {
          throw refuseReference(new Error("Reusable flow closure is too large"));
        }
        nodeCount += graph.nodes.length;
        edgeCount += graph.edges.length;
        serializedBytes += new TextEncoder().encode(JSON.stringify(graph)).byteLength;
        if (nodeCount > MAX_CLOSURE_NODES) {
          throw refuseReference(new Error("Reusable flow closure has too many nodes"));
        }
        if (edgeCount > MAX_CLOSURE_EDGES) {
          throw refuseReference(new Error("Reusable flow closure has too many edges"));
        }
        if (serializedBytes > MAX_CLOSURE_BYTES) {
          throw refuseReference(new Error("Reusable flow closure uses too many bytes"));
        }
      }
      const firstValidation = !validatedGraphs.has(graphKey);
      if (firstValidation) input.inspectGraph?.(graph);

      for (const node of graph.nodes) {
        if (node.type !== "subflow" && node.type !== "loop") continue;
        try {
          referenceCount += 1;
          if (referenceCount > MAX_CLOSURE_REFERENCES) {
            throw new Error("Reusable flow closure has too many references");
          }
          const normalized = normalizeSubflowReference(node.params);
          const flowId = normalized.kind === "typed" ? normalized.reference.flowId : normalized.flowId;
          if (ancestry.includes(flowId)) throw new Error("Recursive reusable flow reference refused");
          const typed = normalized.kind === "typed"
            ? await resolveReference(normalized.reference)
            : null;
          const resolvedGraph = typed
            ? typed.graph
            : await resolveLegacy(flowId);
          if (typed) {
            if (!isFlowGraphV2(resolvedGraph) || !resolvedGraph.callableInterface) {
              throw new Error("Typed reusable flow has no callable interface");
            }
            assertCallableOutputSourcesExist(resolvedGraph, resolvedGraph.callableInterface, registry);
          }
          const childKey = normalized.kind === "typed"
            ? referenceKey(normalized.reference)
            : JSON.stringify(["legacy", flowId]);
          await visit(resolvedGraph, childKey, [...ancestry, flowId], depth + 1, false);
        } catch (error) {
          if (isInspectPolicyError(error)) throw error;
          if (error instanceof PersistedRunPreflightError) throw error;
          throw refuseReference(error);
        }
      }

      if (firstValidation) {
        if (isFlowGraphV2(graph)) preflightV2Execution(graph, registry);
        topoSort(graph);
        validatedGraphs.add(graphKey);
      }
    } catch (error) {
      if (isInspectPolicyError(error)) throw error;
      if (error instanceof PersistedRunPreflightError) throw error;
      throw rootGraph ? refuseRoot(error) : refuseReference(error);
    }
  };

  await visit(root, JSON.stringify(["root", input.rootFlowId]), [input.rootFlowId], 0, true);
  return {
    graph: root,
    subflowSnapshot: {
      loadSubflow: async (flowId) => {
        const cached = legacyResolutionCache.get(flowId);
        if (!cached) throw new Error(`Subflow ${flowId} was not preflighted`);
        return cached;
      },
      resolveSubflow: async (reference) => {
        const cached = typedResolutionCache.get(referenceKey(reference));
        if (!cached) throw new Error(`Subflow ${reference.flowId} was not preflighted`);
        return cached;
      },
    },
  };
}
