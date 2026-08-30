import { createHash } from "node:crypto";
import type { DependencyPinInput, ReadonlyFlowGraph } from "@/lib/projects/types";
import { compareDependencyContent } from "@/lib/projects/version-input";

export const VISUAL_ONLY_META_KEYS = Object.freeze(
  ["canvas", "comments", "display", "groups", "viewport"] as const,
);

export interface CanonicalizeGraphOptions {
  readonly semantic: boolean;
}

type TraversalContext = "node" | "other";

const visualMetaKeys = new Set<string>(VISUAL_ONLY_META_KEYS);

function canonicalRecord(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

function compareCanonicalValues(left: unknown, right: unknown): number {
  const leftJson = JSON.stringify(left);
  const rightJson = JSON.stringify(right);
  if (leftJson < rightJson) return -1;
  if (leftJson > rightJson) return 1;
  return 0;
}

function canonicalizeMetaBoundary(value: unknown, semantic: boolean): unknown {
  if (!semantic || value === null || Array.isArray(value) || typeof value !== "object") {
    return canonicalizeValue(value, semantic, "other");
  }

  const source = value as Record<string, unknown>;
  const canonical = canonicalRecord();
  for (const key of Object.keys(source).sort()) {
    if (!visualMetaKeys.has(key)) {
      canonical[key] = canonicalizeValue(source[key], semantic, "other");
    }
  }
  return canonical;
}

function canonicalizeValue(
  value: unknown,
  semantic: boolean,
  context: TraversalContext,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeValue(item, semantic, "other"));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const source = value as Record<string, unknown>;
  const canonical = canonicalRecord();
  for (const key of Object.keys(source).sort()) {
    if (semantic && context === "node" && key === "position") {
      continue;
    }
    if (semantic && context === "node" && key === "meta") {
      const nodeMeta = canonicalizeMetaBoundary(source[key], semantic);
      if (
        nodeMeta !== null &&
        typeof nodeMeta === "object" &&
        !Array.isArray(nodeMeta) &&
        Object.keys(nodeMeta).length === 0
      ) {
        continue;
      }
      canonical[key] = nodeMeta;
      continue;
    }
    canonical[key] = canonicalizeValue(source[key], semantic, "other");
  }
  return canonical;
}

export function canonicalizeGraph(
  graph: ReadonlyFlowGraph,
  options: CanonicalizeGraphOptions,
): Record<string, unknown> {
  const source = graph as ReadonlyFlowGraph & Record<string, unknown>;
  const canonical = canonicalRecord();

  for (const key of Object.keys(source).sort()) {
    const value = source[key];
    if (options.semantic && (key === "groups" || key === "annotations")) {
      continue;
    }
    if (
      (key === "nodes" ||
        key === "edges" ||
        key === "variables" ||
        key === "groups" ||
        key === "annotations") &&
      Array.isArray(value)
    ) {
      canonical[key] = value
        .map((item) =>
          canonicalizeValue(item, options.semantic, key === "nodes" ? "node" : "other"),
        )
        .sort((left, right) => {
          const leftId = (left as { id?: unknown })?.id;
          const rightId = (right as { id?: unknown })?.id;
          if (typeof leftId === "string" && typeof rightId === "string") {
            return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
          }
          return compareCanonicalValues(left, right);
        });
      continue;
    }
    if (key === "meta" && options.semantic) {
      const graphMeta = canonicalizeMetaBoundary(value, options.semantic);
      if (
        graphMeta !== null &&
        typeof graphMeta === "object" &&
        !Array.isArray(graphMeta) &&
        Object.keys(graphMeta).length === 0
      ) {
        continue;
      }
      canonical[key] = graphMeta;
      continue;
    }
    canonical[key] = canonicalizeValue(value, options.semantic, "other");
  }

  return canonical;
}

export function hashFlowGraph(
  graph: ReadonlyFlowGraph,
  options: CanonicalizeGraphOptions,
  dependencies: readonly DependencyPinInput[] = [],
): string {
  const canonicalGraph = canonicalizeGraph(graph, options);
  const canonicalInput =
    dependencies.length === 0
      ? canonicalGraph
      : {
          graph: canonicalGraph,
          dependencies: [...dependencies]
            .sort(compareDependencyContent)
            .map((dependency) => canonicalizeValue(dependency, options.semantic, "other")),
        };
  const canonicalJson = JSON.stringify(canonicalInput);
  return createHash("sha256").update(canonicalJson, "utf8").digest("hex");
}
