import { isFlowGraphV2 } from "@/lib/flow/graph-schema";
import { normalizeSubflowReference } from "@/lib/flow/subflow-reference";
import type { SupportedFlowGraph } from "@/lib/flow/types";
import type { DependencyPinInput } from "./types";
import { compareDependencyContent, normalizeDependencyPins } from "./version-input";

const MAX_PINNED_FLOW_REFERENCES = 1_000;

export function rejectCallerFlowDependencies(
  dependencies: readonly DependencyPinInput[] | undefined,
): void {
  if (dependencies?.some((dependency) => dependency.kind === "flow")) {
    throw new TypeError("Flow dependency pins are server-derived and cannot be caller supplied");
  }
}

export function derivePinnedFlowDependencies(
  graph: SupportedFlowGraph,
): DependencyPinInput[] {
  if (!isFlowGraphV2(graph)) return [];
  const byFlowId = new Map<string, DependencyPinInput>();
  let referenceCount = 0;

  for (const node of graph.nodes) {
    if (node.type !== "subflow" && node.type !== "loop") continue;
    const normalized = normalizeSubflowReference(node.params);
    if (normalized.kind !== "typed") continue;
    referenceCount += 1;
    if (referenceCount > MAX_PINNED_FLOW_REFERENCES) {
      throw new TypeError("Too many pinned flow references");
    }
    if (normalized.reference.kind === "draft") {
      throw new TypeError("Typed draft references are not portable immutable dependencies");
    }
    const dependency: DependencyPinInput = {
      kind: "flow",
      resourceId: normalized.reference.flowId,
      version: normalized.reference.versionId,
      contentHash: normalized.reference.contentHash,
    };
    const existing = byFlowId.get(dependency.resourceId);
    if (existing === undefined) {
      byFlowId.set(dependency.resourceId, dependency);
      continue;
    }
    if (
      existing.version !== dependency.version ||
      existing.contentHash !== dependency.contentHash
    ) {
      throw new TypeError(
        `One parent flow cannot depend on multiple versions of flow ${dependency.resourceId}`,
      );
    }
  }

  return [...byFlowId.values()].sort(compareDependencyContent);
}

export function mergeServerDerivedFlowDependencies(
  graph: SupportedFlowGraph,
  callerDependencies: readonly DependencyPinInput[] = [],
): DependencyPinInput[] {
  rejectCallerFlowDependencies(callerDependencies);
  return normalizeDependencyPins([
    ...callerDependencies.map((dependency) => ({ ...dependency })),
    ...derivePinnedFlowDependencies(graph),
  ]);
}

export function assertPortableSubflowDependencies(
  graph: SupportedFlowGraph,
  dependencies: readonly DependencyPinInput[] = [],
): void {
  const normalizedDependencies = normalizeDependencyPins(dependencies);
  const expected = normalizeDependencyPins(derivePinnedFlowDependencies(graph));
  const actual = normalizedDependencies
    .filter((dependency) => dependency.kind === "flow")
    .map((dependency) => ({ ...dependency }));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new TypeError("Manifest flow dependencies do not match embedded pinned references");
  }
}
