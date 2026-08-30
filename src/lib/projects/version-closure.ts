import { graphContainsApiOperation } from "@/lib/flow/api-operation-contract";
import { normalizeSubflowReference } from "@/lib/flow/subflow-reference";
import { parseSupportedFlowGraph } from "@/lib/flow/graph-schema";
import { isFlowGraphV2 } from "@/lib/flow/graph-schema";
import { hashCallableInterface } from "@/lib/flow/subflow-reference";
import { hashFlowGraph } from "./hash";
import { assertPortableSubflowDependencies } from "./subflow-dependencies";
import type { FlowVersionRepo } from "./repo";
import type { FlowVersionRecord } from "./types";
import { graphHasSafeHttpPublicationCredentials } from "@/lib/flow/http-publication-policy";
import { graphHasRequiredConnectionBindings } from "@/lib/flow/connection-requirements";

/**
 * Reuse the execution preflight's exact receipt checks, cycle detection, and
 * deterministic closure budgets. Any unresolved/mismatched closure refuses
 * deployment just as an API operation does; no partial closure is "safe".
 */
export type VersionClosureInspection = "available" | "api-operation" | "invalid";

const CLOSURE_LIMITS = Object.freeze({
  depth: 64,
  versions: 256,
  nodes: 20_000,
  edges: 40_000,
  references: 1_000,
  bytes: 16 * 1024 * 1024,
});

/** Synchronous exact scan used inside SQLite's deployment transaction. */
export function inspectVersionClosureSync(input: {
  readonly root: FlowVersionRecord;
  readonly load: (flowId: string, versionId: string) => FlowVersionRecord | null;
}): VersionClosureInspection {
  try {
    const pending: Array<{
      readonly version: FlowVersionRecord;
      readonly ancestry: readonly string[];
      readonly depth: number;
    }> = [{ version: input.root, ancestry: [input.root.flowId], depth: 0 }];
    const visited = new Set<string>();
    let nodes = 0;
    let edges = 0;
    let references = 0;
    let bytes = 0;
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (current.depth > CLOSURE_LIMITS.depth) return "invalid";
      const key = JSON.stringify([current.version.flowId, current.version.id]);
      const graph = parseSupportedFlowGraph(current.version.graph);
      if (!visited.has(key)) {
        visited.add(key);
        if (visited.size > CLOSURE_LIMITS.versions || current.version.dependencies.some(
          (dependency) => dependency.flowVersionId !== current.version.id,
        )) return "invalid";
        const dependencies = current.version.dependencies.map((dependency) => ({
          kind: dependency.kind,
          resourceId: dependency.resourceId,
          version: dependency.version,
          ...(dependency.contentHash === undefined ? {} : { contentHash: dependency.contentHash }),
        }));
        assertPortableSubflowDependencies(graph, dependencies);
        if (hashFlowGraph(graph, { semantic: true }, dependencies) !== current.version.semanticHash ||
            hashFlowGraph(graph, { semantic: false }, dependencies) !== current.version.fullHash) return "invalid";
        if (graphContainsApiOperation(graph)) return "api-operation";
        if (!graphHasSafeHttpPublicationCredentials(graph) ||
            !graphHasRequiredConnectionBindings(graph)) return "invalid";
        nodes += graph.nodes.length;
        edges += graph.edges.length;
        bytes += new TextEncoder().encode(JSON.stringify(graph)).byteLength;
        if (nodes > CLOSURE_LIMITS.nodes || edges > CLOSURE_LIMITS.edges || bytes > CLOSURE_LIMITS.bytes) {
          return "invalid";
        }
      }
      for (const node of graph.nodes) {
        if (node.type !== "subflow" && node.type !== "loop") continue;
        references += 1;
        if (references > CLOSURE_LIMITS.references) return "invalid";
        const normalized = normalizeSubflowReference(node.params);
        if (normalized.kind !== "typed" || normalized.reference.kind !== "pinned") return "invalid";
        const reference = normalized.reference;
        if (current.ancestry.includes(reference.flowId)) return "invalid";
        const child = input.load(reference.flowId, reference.versionId);
        if (!child || child.flowId !== reference.flowId || child.id !== reference.versionId ||
            child.semanticHash !== reference.contentHash) return "invalid";
        const childGraph = parseSupportedFlowGraph(child.graph);
        if (!isFlowGraphV2(childGraph) || !childGraph.callableInterface ||
            hashCallableInterface(childGraph.callableInterface) !== reference.interfaceHash ||
            JSON.stringify(childGraph.callableInterface) !== JSON.stringify(reference.interface)) return "invalid";
        pending.push({
          version: child,
          ancestry: [...current.ancestry, reference.flowId],
          depth: current.depth + 1,
        });
      }
    }
    return "available";
  } catch {
    return "invalid";
  }
}

export async function inspectVersionClosure(input: {
  readonly root: FlowVersionRecord;
  readonly ownerId: string;
  readonly repo: Pick<FlowVersionRepo, "getFlowVersion">;
}): Promise<VersionClosureInspection> {
  try {
    const pending: Array<{
      readonly version: FlowVersionRecord;
      readonly ancestry: readonly string[];
      readonly depth: number;
    }> = [{ version: input.root, ancestry: [input.root.flowId], depth: 0 }];
    const visited = new Set<string>();
    let nodes = 0;
    let edges = 0;
    let references = 0;
    let bytes = 0;
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (current.depth > CLOSURE_LIMITS.depth) return "invalid";
      const key = JSON.stringify([current.version.flowId, current.version.id]);
      const graph = parseSupportedFlowGraph(current.version.graph);
      if (!visited.has(key)) {
        visited.add(key);
        if (visited.size > CLOSURE_LIMITS.versions || current.version.dependencies.some(
          (dependency) => dependency.flowVersionId !== current.version.id,
        )) return "invalid";
        const dependencies = current.version.dependencies.map((dependency) => ({
          kind: dependency.kind,
          resourceId: dependency.resourceId,
          version: dependency.version,
          ...(dependency.contentHash === undefined ? {} : { contentHash: dependency.contentHash }),
        }));
        assertPortableSubflowDependencies(graph, dependencies);
        if (hashFlowGraph(graph, { semantic: true }, dependencies) !== current.version.semanticHash ||
            hashFlowGraph(graph, { semantic: false }, dependencies) !== current.version.fullHash) return "invalid";
        if (graphContainsApiOperation(graph)) return "api-operation";
        if (!graphHasSafeHttpPublicationCredentials(graph) ||
            !graphHasRequiredConnectionBindings(graph)) return "invalid";
        nodes += graph.nodes.length;
        edges += graph.edges.length;
        bytes += new TextEncoder().encode(JSON.stringify(graph)).byteLength;
        if (nodes > CLOSURE_LIMITS.nodes || edges > CLOSURE_LIMITS.edges || bytes > CLOSURE_LIMITS.bytes) {
          return "invalid";
        }
      }
      for (const node of graph.nodes) {
        if (node.type !== "subflow" && node.type !== "loop") continue;
        references += 1;
        if (references > CLOSURE_LIMITS.references) return "invalid";
        const normalized = normalizeSubflowReference(node.params);
        if (normalized.kind !== "typed" || normalized.reference.kind !== "pinned") return "invalid";
        const reference = normalized.reference;
        if (current.ancestry.includes(reference.flowId)) return "invalid";
        const child = await input.repo.getFlowVersion({
          flowId: reference.flowId,
          versionId: reference.versionId,
          ownerId: input.ownerId,
        });
        if (!child || child.flowId !== reference.flowId || child.id !== reference.versionId ||
            child.semanticHash !== reference.contentHash) return "invalid";
        const childGraph = parseSupportedFlowGraph(child.graph);
        if (!isFlowGraphV2(childGraph) || !childGraph.callableInterface ||
            hashCallableInterface(childGraph.callableInterface) !== reference.interfaceHash ||
            JSON.stringify(childGraph.callableInterface) !== JSON.stringify(reference.interface)) return "invalid";
        pending.push({
          version: child,
          ancestry: [...current.ancestry, reference.flowId],
          depth: current.depth + 1,
        });
      }
    }
    return "available";
  } catch {
    return "invalid";
  }
}
