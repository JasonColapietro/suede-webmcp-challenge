import {
  canonicalOperationProjectionBytes,
  parseConnectorDefinitionVersionV1,
  parseOperationVersionV1,
} from "@/lib/connectors/schema";
import type {
} from "@/lib/connectors/types";
import type { ConnectorOperationClosure } from "@/lib/connectors/repository";
import {
  parseApiOperationReference,
  validateApiOperationReference,
} from "@/lib/connectors/operation-closure";
import type { FlowGraphV2 } from "@/lib/flow/types";
import { isProxy } from "node:util/types";
import {
  CONNECTOR_BUNDLE_VERSION,
  MAX_CONNECTOR_BUNDLE_BYTES,
  MAX_CONNECTOR_BUNDLES,
  portableReadinessRequirementKey,
  type ConnectorDependencyBundleV1,
} from "./connector-bundle-contract";

export {
  CONNECTOR_BUNDLE_VERSION,
  MAX_CONNECTOR_BUNDLE_BYTES,
  MAX_CONNECTOR_BUNDLES,
  portableReadinessRequirementKey,
};
export type { ConnectorDependencyBundleV1 };

function fail(): never {
  throw new TypeError("Invalid portable connector dependency bundle");
}

function assertPassiveBoundedJson(root: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  let bytes = 0;
  while (pending.length > 0) {
    const { value, depth } = pending.pop()!;
    if (depth > 64 || ++nodes > 100_000) fail();
    if (value === null || typeof value === "boolean") continue;
    if (typeof value === "string") {
      bytes += new TextEncoder().encode(value).byteLength;
      if (bytes > MAX_CONNECTOR_BUNDLE_BYTES) fail();
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) fail();
      continue;
    }
    if (typeof value !== "object" || isProxy(value)) fail();
    if (seen.has(value)) continue;
    seen.add(value);
    const prototype = Object.getPrototypeOf(value);
    const array = Array.isArray(value);
    if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null) fail();
    if (Object.getOwnPropertySymbols(value).length > 0) fail();
    const propertyNames = Object.getOwnPropertyNames(value);
    for (const key of propertyNames) {
      bytes += new TextEncoder().encode(key).byteLength;
      if (bytes > MAX_CONNECTOR_BUNDLE_BYTES) fail();
    }
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
    if (array) {
      const length = descriptors.length;
      if (!length || !("value" in length) || !Number.isSafeInteger(length.value) || length.value < 0) fail();
      const allowed = new Set(["length", ...Array.from({ length: length.value }, (_, i) => String(i))]);
      if (Object.keys(descriptors).some((key) => !allowed.has(key))) fail();
      for (let index = 0; index < length.value; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail();
        pending.push({ value: descriptor.value, depth: depth + 1 });
      }
    } else {
      for (const descriptor of Object.values(descriptors)) {
        if (!("value" in descriptor) || !descriptor.enumerable) fail();
        pending.push({ value: descriptor.value, depth: depth + 1 });
      }
    }
  }
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length > 0) fail();
  if (Object.keys(descriptors).sort().join("\u0000") !== [...keys].sort().join("\u0000")) fail();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail();
    result[key] = descriptor.value;
  }
  return result;
}

export function parseConnectorDependencyBundle(value: unknown): ConnectorDependencyBundleV1 {
  try {
    const source = exactRecord(value, ["bundleVersion", "definition", "operation"]);
    if (source.bundleVersion !== CONNECTOR_BUNDLE_VERSION) fail();
    const definition = parseConnectorDefinitionVersionV1(source.definition);
    const operation = parseOperationVersionV1(source.operation);
    const parent = definition.projection.operations.find(
      (entry) => entry.operationId === operation.operationId,
    );
    if (
      operation.connectorDefinitionVersionId !== definition.id ||
      !parent ||
      parent.operationProjectionHash !== operation.operationProjectionHash ||
      canonicalOperationProjectionBytes(parent.operationProjection).compare(
        canonicalOperationProjectionBytes(operation.projection),
      ) !== 0
    ) fail();
    return Object.freeze({ bundleVersion: 1, definition, operation });
  } catch {
    return fail();
  }
}

export function parseConnectorDependencyBundles(value: unknown): readonly ConnectorDependencyBundleV1[] {
  assertPassiveBoundedJson(value);
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      Object.getOwnPropertySymbols(value).length > 0) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
  const lengthDescriptor = descriptors["length"];
  const rawLength = lengthDescriptor && "value" in lengthDescriptor
    ? lengthDescriptor.value as unknown
    : undefined;
  if (typeof rawLength !== "number" || !Number.isSafeInteger(rawLength) || rawLength < 0 ||
      rawLength > MAX_CONNECTOR_BUNDLES) fail();
  const length = rawLength;
  const allowed = new Set(["length", ...Array.from({ length }, (_, index) => String(index))]);
  if (Object.keys(descriptors).some((key) => !allowed.has(key))) fail();
  const values: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail();
    values.push(descriptor.value);
  }
  const parsed = values.map(parseConnectorDependencyBundle);
  if (new TextEncoder().encode(JSON.stringify(parsed)).byteLength > MAX_CONNECTOR_BUNDLE_BYTES) fail();
  const seen = new Set<string>();
  for (const bundle of parsed) {
    if (seen.has(bundle.operation.id)) fail();
    seen.add(bundle.operation.id);
  }
  return Object.freeze(parsed);
}

function matchingBundleReference(
  nodeId: string,
  params: unknown,
  bundle: ConnectorDependencyBundleV1,
): void {
  const reference = parseApiOperationReference(params);
  const expectedBinding = bundle.operation.projection.authentication.kind === "none"
    ? undefined
    : {
        kind: "unresolved" as const,
        requirementKey: portableReadinessRequirementKey(nodeId),
        capability: "http.headers" as const,
      };
  if (
    reference.connectorDefinitionVersionId !== bundle.definition.id ||
    reference.operationVersionId !== bundle.operation.id ||
    reference.operationId !== bundle.operation.operationId ||
    reference.connectorProjectionHash !== bundle.definition.connectorProjectionHash ||
    reference.operationProjectionHash !== bundle.operation.operationProjectionHash ||
    reference.schemaHash !== bundle.operation.schemaHash ||
    JSON.stringify(reference.readinessBinding) !== JSON.stringify(expectedBinding)
  ) fail();
}

export function assertPortableConnectorDependencies(
  graph: FlowGraphV2,
  bundlesValue: unknown,
): readonly ConnectorDependencyBundleV1[] {
  const apiNodes = graph.nodes.filter((node) => node.type === "api.operation");
  const bundles = bundlesValue === undefined
    ? Object.freeze([] as ConnectorDependencyBundleV1[])
    : parseConnectorDependencyBundles(bundlesValue);
  const byOperation = new Map(bundles.map((bundle) => [bundle.operation.id, bundle]));
  const referenced = new Set<string>();
  for (const node of apiNodes) {
    const reference = parseApiOperationReference(node.params);
    const bundle = byOperation.get(reference.operationVersionId);
    if (!bundle) fail();
    matchingBundleReference(node.id, node.params, bundle);
    referenced.add(reference.operationVersionId);
  }
  if (referenced.size !== bundles.length) fail();
  return bundles;
}

export type ApiOperationClosureResolver = (
  reference: ReturnType<typeof parseApiOperationReference>,
  nodeId: string,
) => ConnectorOperationClosure;

export function buildPortableConnectorExport(
  graph: FlowGraphV2,
  resolve: ApiOperationClosureResolver,
): { readonly graph: FlowGraphV2; readonly bundles: readonly ConnectorDependencyBundleV1[] } {
  const apiNodes = graph.nodes.filter((node) => node.type === "api.operation");
  if (apiNodes.length === 0) return Object.freeze({ graph, bundles: Object.freeze([]) });
  const bundles = new Map<string, ConnectorDependencyBundleV1>();
  const rewrittenNodes = graph.nodes.map((node) => {
    if (node.type !== "api.operation") return node;
    const reference = parseApiOperationReference(node.params);
    const closure = resolve(reference, node.id);
    const snapshot = validateApiOperationReference(reference, closure);
    const bundle = parseConnectorDependencyBundle({
      bundleVersion: 1,
      definition: snapshot.definition,
      operation: snapshot.operation,
    });
    const existing = bundles.get(bundle.operation.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(bundle)) fail();
    bundles.set(bundle.operation.id, bundle);
    const readinessBinding = snapshot.authentication.kind === "none"
      ? undefined
      : {
          kind: "unresolved" as const,
          requirementKey: portableReadinessRequirementKey(node.id),
          capability: "http.headers" as const,
        };
    return {
      ...node,
      params: {
        connectorDefinitionVersionId: reference.connectorDefinitionVersionId,
        operationVersionId: reference.operationVersionId,
        operationId: reference.operationId,
        connectorProjectionHash: reference.connectorProjectionHash,
        operationProjectionHash: reference.operationProjectionHash,
        schemaHash: reference.schemaHash,
        ...(readinessBinding === undefined ? {} : { readinessBinding }),
      },
    };
  });
  const portableGraph: FlowGraphV2 = { ...graph, nodes: rewrittenNodes };
  const sortedBundles = [...bundles.values()].sort((left, right) =>
    left.operation.id.localeCompare(right.operation.id));
  assertPortableConnectorDependencies(portableGraph, sortedBundles);
  return Object.freeze({ graph: portableGraph, bundles: Object.freeze(sortedBundles) });
}

export function closureFromConnectorBundle(bundleValue: unknown): ConnectorOperationClosure {
  const bundle = parseConnectorDependencyBundle(bundleValue);
  return Object.freeze({
    identity: Object.freeze({
      id: bundle.definition.connectorId,
      displayLabel: "Portable connector",
      archivedAt: null,
      lifecycleRevision: 1,
      createdAt: 0,
      updatedAt: 0,
    }),
    definition: bundle.definition,
    operation: bundle.operation,
  });
}
