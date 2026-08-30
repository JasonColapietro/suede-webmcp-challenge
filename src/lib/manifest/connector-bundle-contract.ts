import type {
  ConnectorDefinitionVersionV1,
  OperationVersionV1,
} from "@/lib/connectors/types";
import { parseApiOperationReference } from "@/lib/flow/api-operation-reference";
import type { FlowGraphV2 } from "@/lib/flow/types";

export const CONNECTOR_BUNDLE_VERSION = 1 as const;
export const MAX_CONNECTOR_BUNDLES = 250;
export const MAX_CONNECTOR_BUNDLE_BYTES = 1024 * 1024;

export interface ConnectorDependencyBundleV1 {
  readonly bundleVersion: 1;
  readonly definition: ConnectorDefinitionVersionV1;
  readonly operation: OperationVersionV1;
}

export function portableReadinessRequirementKey(nodeId: string): string {
  return `api.operation:${nodeId}:http.headers`;
}

function fail(): never {
  throw new TypeError("Invalid portable connector dependency bundle");
}

/** Browser-safe transport/reference law. Full hashes and closure are verified server-side. */
export function assertPortableConnectorDependencyReferences(
  graph: FlowGraphV2,
  bundles: readonly ConnectorDependencyBundleV1[] | undefined,
): void {
  const values = bundles ?? [];
  if (!Array.isArray(values) || values.length > MAX_CONNECTOR_BUNDLES) fail();
  const byOperation = new Map<string, ConnectorDependencyBundleV1>();
  for (const bundle of values) {
    if (bundle?.bundleVersion !== CONNECTOR_BUNDLE_VERSION ||
        typeof bundle.definition?.id !== "string" ||
        typeof bundle.definition?.connectorProjectionHash !== "string" ||
        typeof bundle.operation?.id !== "string" ||
        typeof bundle.operation?.operationId !== "string" ||
        typeof bundle.operation?.operationProjectionHash !== "string" ||
        typeof bundle.operation?.schemaHash !== "string" ||
        bundle.operation.connectorDefinitionVersionId !== bundle.definition.id ||
        byOperation.has(bundle.operation.id)) fail();
    byOperation.set(bundle.operation.id, bundle);
  }
  const referenced = new Set<string>();
  for (const node of graph.nodes) {
    if (node.type !== "api.operation") continue;
    const reference = parseApiOperationReference(node.params);
    const bundle = byOperation.get(reference.operationVersionId);
    if (!bundle) fail();
    const expectedBinding = bundle.operation.projection?.authentication?.kind === "none"
      ? undefined
      : {
          kind: "unresolved" as const,
          requirementKey: portableReadinessRequirementKey(node.id),
          capability: "http.headers" as const,
        };
    if (reference.connectorDefinitionVersionId !== bundle.definition.id ||
        reference.operationId !== bundle.operation.operationId ||
        reference.connectorProjectionHash !== bundle.definition.connectorProjectionHash ||
        reference.operationProjectionHash !== bundle.operation.operationProjectionHash ||
        reference.schemaHash !== bundle.operation.schemaHash ||
        JSON.stringify(reference.readinessBinding) !== JSON.stringify(expectedBinding)) fail();
    referenced.add(bundle.operation.id);
  }
  if (referenced.size !== values.length) fail();
}
