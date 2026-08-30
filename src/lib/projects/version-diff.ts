import { canonicalizeGraph, hashFlowGraph } from "./hash";
import type {
  DependencyPin,
  DependencyPinInput,
  FlowVersionRecord,
  FlowVersionSemanticDiff,
  ReadonlyFlowGraph,
  VersionDiffEntry,
} from "./types";

const MAX_DIFF_ENTRIES = 200;
const KIND_ORDER: Readonly<Record<VersionDiffEntry["kind"], number>> = {
  node: 0,
  edge: 1,
  variable: 2,
  dependency: 3,
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function equalValues(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function dependencyInput(dependency: DependencyPin): DependencyPinInput {
  return {
    kind: dependency.kind,
    resourceId: dependency.resourceId,
    version: dependency.version,
    ...(dependency.contentHash === undefined ? {} : { contentHash: dependency.contentHash }),
  };
}

function dependencyKey(dependency: Pick<DependencyPin, "kind" | "resourceId">): string {
  return JSON.stringify([dependency.kind, dependency.resourceId]);
}

function entityArray(graph: ReadonlyFlowGraph, key: "nodes" | "edges" | "variables"): readonly unknown[] {
  const value = (graph as ReadonlyFlowGraph & Record<string, unknown>)[key];
  return Array.isArray(value) ? value : [];
}

function indexEntities(
  values: readonly unknown[],
  label: VersionDiffEntry["kind"],
): Map<string, unknown> {
  const indexed = new Map<string, unknown>();
  for (const value of values) {
    if (value === null || typeof value !== "object" || typeof (value as { id?: unknown }).id !== "string") {
      throw new TypeError(`Invalid ${label} id`);
    }
    const id = (value as { id: string }).id;
    if (indexed.has(id)) throw new TypeError(`Duplicate ${label} id: ${id}`);
    indexed.set(id, value);
  }
  return indexed;
}

function indexDependencies(dependencies: readonly DependencyPin[]): Map<string, DependencyPinInput> {
  const indexed = new Map<string, DependencyPinInput>();
  for (const dependency of dependencies) {
    const id = dependencyKey(dependency);
    if (indexed.has(id)) throw new TypeError(`Duplicate dependency id: ${id}`);
    indexed.set(id, dependencyInput(dependency));
  }
  return indexed;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function collectChangedFields(left: unknown, right: unknown, prefix = ""): string[] {
  if (equalValues(left, right)) return [];
  if (!isRecord(left) || !isRecord(right)) return prefix ? [prefix] : [];
  const fields: string[] = [];
  const keys = Array.from(new Set([...Object.keys(left), ...Object.keys(right)])).sort(compareText);
  for (const key of keys) {
    if (key === "id" && prefix === "") continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (!Object.prototype.hasOwnProperty.call(left, key) || !Object.prototype.hasOwnProperty.call(right, key)) {
      fields.push(path);
      continue;
    }
    fields.push(...collectChangedFields(left[key], right[key], path));
  }
  return fields.sort(compareText);
}

function compareIndexed(
  kind: VersionDiffEntry["kind"],
  left: ReadonlyMap<string, unknown>,
  right: ReadonlyMap<string, unknown>,
): VersionDiffEntry[] {
  const ids = Array.from(new Set([...left.keys(), ...right.keys()])).sort(compareText);
  const entries: VersionDiffEntry[] = [];
  for (const id of ids) {
    const hasLeft = left.has(id);
    const hasRight = right.has(id);
    if (!hasLeft) {
      entries.push({ kind, id, change: "added", fields: [] });
      continue;
    }
    if (!hasRight) {
      entries.push({ kind, id, change: "removed", fields: [] });
      continue;
    }
    const fields = collectChangedFields(left.get(id), right.get(id));
    if (fields.length > 0) entries.push({ kind, id, change: "changed", fields });
  }
  return entries;
}

function canonicalEntityIndex(
  graph: ReadonlyFlowGraph,
  key: "nodes" | "edges" | "variables",
  kind: VersionDiffEntry["kind"],
): Map<string, unknown> {
  indexEntities(entityArray(graph, key), kind);
  const semantic = canonicalizeGraph(graph, { semantic: true });
  const canonical = Array.isArray(semantic[key]) ? semantic[key] as readonly unknown[] : [];
  return indexEntities(canonical, kind);
}

function changedGraphSections(left: ReadonlyFlowGraph, right: ReadonlyFlowGraph): string[] {
  const leftGraph = canonicalizeGraph(left, { semantic: true });
  const rightGraph = canonicalizeGraph(right, { semantic: true });
  return Array.from(new Set([...Object.keys(leftGraph), ...Object.keys(rightGraph)]))
    .filter((section) => !equalValues(leftGraph[section], rightGraph[section]))
    .sort(compareText);
}

function compareEntries(left: VersionDiffEntry, right: VersionDiffEntry): number {
  return KIND_ORDER[left.kind] - KIND_ORDER[right.kind] || compareText(left.id, right.id);
}

export function compareFlowVersionDetails(
  left: FlowVersionRecord,
  right: FlowVersionRecord,
): FlowVersionSemanticDiff {
  const leftDependencies = indexDependencies(left.dependencies);
  const rightDependencies = indexDependencies(right.dependencies);
  const entries = [
    ...compareIndexed("node", canonicalEntityIndex(left.graph, "nodes", "node"), canonicalEntityIndex(right.graph, "nodes", "node")),
    ...compareIndexed("edge", canonicalEntityIndex(left.graph, "edges", "edge"), canonicalEntityIndex(right.graph, "edges", "edge")),
    ...compareIndexed("variable", canonicalEntityIndex(left.graph, "variables", "variable"), canonicalEntityIndex(right.graph, "variables", "variable")),
    ...compareIndexed("dependency", leftDependencies, rightDependencies),
  ].sort(compareEntries);
  const leftDependencyInputs = left.dependencies.map(dependencyInput);
  const rightDependencyInputs = right.dependencies.map(dependencyInput);
  const leftSemanticHash = hashFlowGraph(left.graph, { semantic: true }, leftDependencyInputs);
  const rightSemanticHash = hashFlowGraph(right.graph, { semantic: true }, rightDependencyInputs);
  const leftFullHash = hashFlowGraph(left.graph, { semantic: false }, leftDependencyInputs);
  const rightFullHash = hashFlowGraph(right.graph, { semantic: false }, rightDependencyInputs);
  const semanticEqual = leftSemanticHash === rightSemanticHash;
  const fullEqual = leftFullHash === rightFullHash;
  const dependenciesEqual = equalValues(
    [...leftDependencies.entries()].sort(([a], [b]) => compareText(a, b)),
    [...rightDependencies.entries()].sort(([a], [b]) => compareText(a, b)),
  );
  const changedSections = changedGraphSections(left.graph, right.graph);
  if (!dependenciesEqual) changedSections.push("dependencies");
  changedSections.sort(compareText);
  const counts = entries.reduce(
    (total, entry) => ({ ...total, [entry.change]: total[entry.change] + 1 }),
    { added: 0, removed: 0, changed: 0 },
  );

  return {
    from: { id: left.id, versionNumber: left.versionNumber, semanticHash: leftSemanticHash },
    to: { id: right.id, versionNumber: right.versionNumber, semanticHash: rightSemanticHash },
    semanticEqual,
    fullEqual,
    visualOnly: !fullEqual && semanticEqual && entries.length === 0,
    changedSections,
    counts,
    entries: entries.slice(0, MAX_DIFF_ENTRIES),
    truncated: entries.length > MAX_DIFF_ENTRIES,
  };
}
