import { resolveReadOnlyOwnerId } from "@/lib/auth";
import {
  connectorPrivateJson,
  parseOperationClosuresEnvelope,
  parseResolveOperationsBody,
  preflightConnectorMutation,
  type ConnectorPrivateErrorEnvelope,
  type OperationClosureProjection,
} from "@/lib/connectors/api-contract";
import { CONNECTOR_LAB_ENABLED } from "@/lib/connectors/flags";
import { getConnectorRepository } from "@/lib/connectors/provider";
import type { CloseableConnectorRepository, ConnectorOperationClosure } from "@/lib/connectors/repository";
import {
  canonicalOperationProjectionBytes,
  parseConnectorDefinitionVersionV1,
  parseOperationVersionV1,
} from "@/lib/connectors/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RESPONSE_LIMIT = 256 * 1024;

function close(repository: CloseableConnectorRepository | null): void {
  if (!repository) return;
  try { repository.close(); } catch { try { repository.dispose(); } catch { /* terminal */ } }
}

function preflightFailure(value: Readonly<{ status: number; error: ConnectorPrivateErrorEnvelope }>): Response {
  return connectorPrivateJson(value.error, value.status);
}

function projectClosure(closure: ConnectorOperationClosure): OperationClosureProjection | null {
  let definition: ConnectorOperationClosure["definition"];
  let operation: ConnectorOperationClosure["operation"];
  try {
    definition = parseConnectorDefinitionVersionV1(closure.definition);
    operation = parseOperationVersionV1(closure.operation);
  } catch { return null; }
  if (closure.identity.id !== definition.connectorId || operation.connectorDefinitionVersionId !== definition.id) return null;
  const entry = definition.projection.operations.find((candidate) => candidate.operationId === operation.operationId);
  if (!entry || entry.operationProjectionHash !== operation.operationProjectionHash ||
      canonicalOperationProjectionBytes(entry.operationProjection).compare(canonicalOperationProjectionBytes(operation.projection)) !== 0) return null;
  return Object.freeze({
    reference: Object.freeze({
      connectorDefinitionVersionId: definition.id,
      operationVersionId: operation.id,
      operationId: operation.operationId,
      connectorProjectionHash: definition.connectorProjectionHash,
      operationProjectionHash: operation.operationProjectionHash,
      schemaHash: operation.schemaHash,
    }),
    connectorId: closure.identity.id,
    connectorDisplayLabel: closure.identity.displayLabel,
    lifecycleRevision: closure.identity.lifecycleRevision,
    archivedAt: closure.identity.archivedAt,
    definitionVersionNumber: definition.versionNumber,
    method: operation.projection.method,
    path: operation.projection.path,
    authentication: operation.projection.authentication,
    requestSchema: operation.projection.requestSchema,
    resultSchema: operation.projection.resultSchema,
    systemPolicy: operation.projection.systemPolicy,
    authorAnnotation: operation.authorAnnotation ?? null,
    executionAvailability: "simulation_only",
  });
}

export async function POST(request: Request): Promise<Response> {
  let repository: CloseableConnectorRepository | null = null;
  try {
    const checked = await preflightConnectorMutation({
      enabled: CONNECTOR_LAB_ENABLED,
      request,
      resolveOwner: async () => resolveReadOnlyOwnerId(),
      resolveProvider: async () => {
        repository = await getConnectorRepository();
        return repository;
      },
      parseBody: parseResolveOperationsBody,
    });
    if (!checked.ok) return preflightFailure(checked);
    const closures: OperationClosureProjection[] = [];
    for (const operationVersionId of checked.body.operationVersionIds) {
      const closure = checked.provider.getOperationClosure(checked.ownerId, operationVersionId);
      if (!closure) return connectorPrivateJson({ error: "not found" }, 404);
      const projection = projectClosure(closure);
      if (!projection) return connectorPrivateJson({ error: "connector service unavailable" }, 503);
      closures.push(projection);
    }
    const envelope = parseOperationClosuresEnvelope({ closures });
    if (!envelope || new TextEncoder().encode(JSON.stringify(envelope)).byteLength > RESPONSE_LIMIT) {
      return connectorPrivateJson({ error: "connector service unavailable" }, 503);
    }
    return connectorPrivateJson(envelope);
  } catch {
    return connectorPrivateJson({ error: "connector service unavailable" }, 503);
  } finally {
    close(repository);
  }
}
