import { resolveReadOnlyOwnerId } from "@/lib/auth";
import {
  parseAddOperationBody,
  connectorPrivateJson,
  encodeConnectorOperationListCursor,
  parseConnectorId,
  parseConnectorOperationEnvelope,
  parseConnectorOperationListPage,
  parseConnectorOperationsEnvelope,
  preflightConnectorRead,
  preflightConnectorMutation,
  type ConnectorPrivateErrorEnvelope,
} from "@/lib/connectors/api-contract";
import { CONNECTOR_LAB_ENABLED } from "@/lib/connectors/flags";
import { ConnectorImportService } from "@/lib/connectors/import-service";
import { getConnectorRepository } from "@/lib/connectors/provider";
import type { CloseableConnectorRepository } from "@/lib/connectors/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = Readonly<{ params: Promise<{ connectorId: string }> }>;

function close(repository: CloseableConnectorRepository | null): void {
  if (!repository) return;
  try { repository.close(); } catch { try { repository.dispose(); } catch { /* terminal */ } }
}

function preflightFailure(value: Readonly<{ status: number; error: ConnectorPrivateErrorEnvelope }>): Response {
  return connectorPrivateJson(value.error, value.status);
}

function importFailure(code: string, rawCorrelationId?: string): Response {
  const [error, status] = code === "CONNECTOR_NOT_FOUND" ? ["not found", 404] as const
    : code === "CONNECTOR_ANNOTATION_CONFLICT" ? ["conflict", 409] as const
      : code === "INVALID_IMPORT_REQUEST" ? ["invalid request", 400] as const
        : ["connector service unavailable", 503] as const;
  const correlationId = code === "AUDIT_UNAVAILABLE" ? null : parseConnectorId(rawCorrelationId);
  return connectorPrivateJson(correlationId ? { error, correlationId } : { error }, status);
}

async function connectorId(context: RouteContext): Promise<string | null> {
  try { return parseConnectorId((await context.params).connectorId); } catch { return null; }
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  let repository: CloseableConnectorRepository | null = null;
  try {
    const checked = await preflightConnectorRead({
      enabled: CONNECTOR_LAB_ENABLED,
      request,
      resolveOwner: async () => resolveReadOnlyOwnerId(),
      resolveProvider: async () => {
        repository = await getConnectorRepository();
        return repository;
      },
    });
    if (!checked.ok) return preflightFailure(checked);
    const id = await connectorId(context);
    if (!id || !checked.provider.getConnectorIdentity(checked.ownerId, id)) {
      return connectorPrivateJson({ error: "not found" }, 404);
    }
    const page = parseConnectorOperationListPage(new URL(request.url).searchParams);
    if (!page) return connectorPrivateJson({ error: "invalid request" }, 400);
    const result = checked.provider.listOperationVersions(checked.ownerId, id, page);
    const nextCursor = encodeConnectorOperationListCursor(result.nextCursor);
    if (result.nextCursor !== null && nextCursor === null) {
      return connectorPrivateJson({ error: "connector service unavailable" }, 503);
    }
    const envelope = parseConnectorOperationsEnvelope({ operations: result.items, nextCursor });
    return envelope
      ? connectorPrivateJson(envelope)
      : connectorPrivateJson({ error: "connector service unavailable" }, 503);
  } catch {
    return connectorPrivateJson({ error: "connector service unavailable" }, 503);
  } finally {
    close(repository);
  }
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
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
      parseBody: parseAddOperationBody,
    });
    if (!checked.ok) return preflightFailure(checked);
    let id: string | null;
    try { id = await connectorId(context); } catch { id = null; }
    if (!id) return connectorPrivateJson({ error: "not found" }, 404);
    const definition = checked.provider.getDefinitionVersion(checked.ownerId, checked.body.connectorDefinitionVersionId);
    if (!definition || definition.connectorId !== id) return connectorPrivateJson({ error: "not found" }, 404);
    const result = new ConnectorImportService(checked.provider).addStoredOperation({
      ownerId: checked.ownerId,
      actorId: checked.ownerId,
      connectorDefinitionVersionId: checked.body.connectorDefinitionVersionId,
      operationId: checked.body.operationId,
      ...(checked.body.authorAnnotation === undefined ? {} : { authorAnnotation: checked.body.authorAnnotation }),
      signal: request.signal,
    });
    if (!result.ok) return importFailure(result.code, result.correlationId);
    const envelope = parseConnectorOperationEnvelope({
      correlationId: result.correlationId,
      disposition: result.disposition,
      operation: {
        id: result.operation.id,
        connectorDefinitionVersionId: result.operation.connectorDefinitionVersionId,
        operationId: result.operation.operationId,
        connectorProjectionHash: definition.connectorProjectionHash,
        operationProjectionHash: result.operation.operationProjectionHash,
        schemaHash: result.operation.schemaHash,
        executionAvailability: result.operation.executionAvailability,
        ...(result.operation.authorAnnotation === undefined ? {} : { authorAnnotation: result.operation.authorAnnotation }),
      },
    });
    return envelope
      ? connectorPrivateJson(envelope, result.disposition === "created" ? 201 : 200)
      : connectorPrivateJson({ error: "connector service unavailable" }, 503);
  } catch {
    return connectorPrivateJson({ error: "connector service unavailable" }, 503);
  } finally {
    close(repository);
  }
}
