import { resolveReadOnlyOwnerId } from "@/lib/auth";
import {
  CONNECTOR_SOURCE_TRANSPORT_BODY_LIMIT_BYTES,
  connectorPrivateJson,
  parseConnectorId,
  parseOpenApiReviewBody,
  parseOpenApiReviewEnvelope,
  preflightConnectorMutation,
  type ConnectorPrivateErrorEnvelope,
} from "@/lib/connectors/api-contract";
import { CONNECTOR_LAB_ENABLED } from "@/lib/connectors/flags";
import { ConnectorImportService } from "@/lib/connectors/import-service";
import { getConnectorRepository } from "@/lib/connectors/provider";
import type { CloseableConnectorRepository } from "@/lib/connectors/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
      : code === "RATE_REFUSED" ? ["rate limited", 429] as const
        : code === "INPUT_BYTES_LIMIT" ? ["payload too large", 413] as const
          : code === "INVALID_IMPORT_REQUEST" ? ["invalid request", 400] as const
            : code === "AUDIT_UNAVAILABLE" || code === "PERSISTENCE_REFUSED"
              ? ["connector service unavailable", 503] as const
              : ["import refused", 422] as const;
  const correlationId = code === "AUDIT_UNAVAILABLE" ? null : parseConnectorId(rawCorrelationId);
  return connectorPrivateJson(correlationId ? { error, correlationId } : { error }, status);
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
      parseBody: parseOpenApiReviewBody,
      maxBytes: CONNECTOR_SOURCE_TRANSPORT_BODY_LIMIT_BYTES,
    });
    if (!checked.ok) return preflightFailure(checked);
    const result = new ConnectorImportService(checked.provider).reviewOpenApi({
      ownerId: checked.ownerId,
      actorId: checked.ownerId,
      source: checked.body.source,
      displayLabel: checked.body.displayLabel,
      ...(checked.body.connectorId === undefined ? {} : { connectorId: checked.body.connectorId }),
      signal: request.signal,
    });
    if (!result.ok) return importFailure(result.code, result.correlationId);
    const envelope = parseOpenApiReviewEnvelope({
      review: {
        correlationId: result.correlationId,
        identity: result.identity,
        definition: result.definition,
        identityDisposition: result.identityDisposition,
        definitionDisposition: result.definitionDisposition,
        drift: result.drift,
        operations: result.operations,
        refusedOperationCount: result.refusedOperations.length,
      },
    });
    return envelope
      ? connectorPrivateJson(envelope, result.identityDisposition === "created" ? 201 : 200)
      : connectorPrivateJson({ error: "connector service unavailable" }, 503);
  } catch {
    return connectorPrivateJson({ error: "connector service unavailable" }, 503);
  } finally {
    close(repository);
  }
}
