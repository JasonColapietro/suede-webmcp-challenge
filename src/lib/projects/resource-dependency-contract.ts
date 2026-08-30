import { isFlowGraphV2 } from "@/lib/flow/graph-schema";
import type { SupportedFlowGraph } from "@/lib/flow/types";
import { RESOURCE_QUERY_LIMIT, RESOURCE_QUERY_LIMITS } from "@/lib/resources/query-limits";
import type { DependencyPinInput } from "./types";
import { compareDependencyContent, normalizeDependencyPins } from "./version-input";

const SHA256 = /^[a-f0-9]{64}$/u;
const EXACT_PARAM_KEYS = [
  "filterFields",
  "limit",
  "packVersionId",
  "resourcePackContentHash",
  "resourceProductId",
  "returnFields",
] as const;
const REQUIRED_PARAM_KEYS = EXACT_PARAM_KEYS.filter((key) => key !== "limit");

export const RESOURCE_DEPENDENCY_ERROR = "Resource Pack dependency refused.";

export interface ResourcePackResolutionReference {
  readonly resourceProductId: string;
  readonly packVersionId: string;
  readonly contentHash: string;
}

function refused(): never {
  throw new TypeError(RESOURCE_DEPENDENCY_ERROR);
}

function exactQueryText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value ||
      /[\u0000-\u001f\u007f]/u.test(value)) refused();
  const normalized = value.normalize("NFC");
  if (new TextEncoder().encode(normalized).byteLength > RESOURCE_QUERY_LIMITS.idBytes) refused();
  return normalized;
}

function exactFieldList(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > RESOURCE_QUERY_LIMITS.filterFields) refused();
  const fields = value.map(exactQueryText);
  if (new Set(fields).size !== fields.length) refused();
  return fields;
}

function exactResourceReference(params: unknown): ResourcePackResolutionReference {
  if (params === null || typeof params !== "object" || Array.isArray(params)) refused();
  const source = params as Record<string, unknown>;
  const keys = Object.keys(source).sort();
  const expected = EXACT_PARAM_KEYS.filter((key) => source.limit !== undefined || key !== "limit").sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) refused();
  if (REQUIRED_PARAM_KEYS.some((key) => !Object.hasOwn(source, key))) refused();
  if (
    typeof source.resourcePackContentHash !== "string" || !SHA256.test(source.resourcePackContentHash) ||
    (source.limit !== undefined &&
      (typeof source.limit !== "number" || !Number.isSafeInteger(source.limit) || source.limit < 1 || source.limit > RESOURCE_QUERY_LIMIT))
  ) refused();
  const resourceProductId = exactQueryText(source.resourceProductId);
  const packVersionId = exactQueryText(source.packVersionId);
  exactFieldList(source.filterFields);
  exactFieldList(source.returnFields);
  return Object.freeze({
    resourceProductId,
    packVersionId,
    contentHash: source.resourcePackContentHash,
  });
}

export function resourceDependencyPinsFromGraph(
  graph: SupportedFlowGraph,
): readonly DependencyPinInput[] {
  if (!isFlowGraphV2(graph)) return [];
  const byProduct = new Map<string, DependencyPinInput>();
  for (const node of graph.nodes) {
    if (node.type !== "resource.query") continue;
    const reference = exactResourceReference(node.params);
    const pin: DependencyPinInput = {
      kind: "resource",
      resourceId: reference.resourceProductId,
      version: reference.packVersionId,
      contentHash: reference.contentHash,
    };
    const previous = byProduct.get(reference.resourceProductId);
    if (previous && compareDependencyContent(previous, pin) !== 0) {
      throw new TypeError("Conflicting Resource Pack versions for one product.");
    }
    byProduct.set(reference.resourceProductId, pin);
  }
  return Object.freeze([...byProduct.values()].sort(compareDependencyContent));
}

function resourcePins(dependencies: readonly DependencyPinInput[]): readonly DependencyPinInput[] {
  return normalizeDependencyPins(dependencies).filter((pin) => pin.kind === "resource");
}

function assertExactPins(graph: SupportedFlowGraph, dependencies: readonly DependencyPinInput[]): void {
  const expected = resourceDependencyPinsFromGraph(graph);
  const actual = resourcePins(dependencies);
  if (expected.length !== actual.length || expected.some((pin, index) => compareDependencyContent(pin, actual[index]!) !== 0)) refused();
}

export function assertPortableResourceDependencies(
  graph: SupportedFlowGraph,
  dependencies: readonly DependencyPinInput[],
): void {
  assertExactPins(graph, dependencies);
}

export function rejectCallerResourceDependencies(
  dependencies: readonly DependencyPinInput[] | undefined,
): void {
  if (dependencies?.some((pin) => pin.kind === "resource")) {
    throw new TypeError("Resource dependency pins are server-derived and cannot be caller supplied.");
  }
}
