import { resolveReadOnlyOwnerId } from "@/lib/auth";
import {
  encodeConnectorHistoryCursor,
  connectorPrivateJson,
  parseConnectorEnvelope,
  parseConnectorHistoryPage,
  parseConnectorId,
  parseConnectorListEnvelope,
  parseConnectorMutationBody,
  preflightConnectorMutation,
  preflightConnectorRead,
  type ConnectorDefinitionSummary,
  type ConnectorPrivateErrorEnvelope,
} from "@/lib/connectors/api-contract";
import { CONNECTOR_LAB_ENABLED } from "@/lib/connectors/flags";
import { getConnectorRepository } from "@/lib/connectors/provider";
import type { CloseableConnectorRepository } from "@/lib/connectors/repository";
import type { ConnectorDefinitionVersionV1 } from "@/lib/connectors/types";

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

async function connectorId(context: RouteContext): Promise<string | null> {
  try { return parseConnectorId((await context.params).connectorId); } catch { return null; }
}

function definitionSummary(value: ConnectorDefinitionVersionV1): ConnectorDefinitionSummary {
  return Object.freeze({
    id: value.id,
    connectorId: value.connectorId,
    versionNumber: value.versionNumber,
    connectorProjectionHash: value.connectorProjectionHash,
    origin: value.projection.origin,
    operationCount: value.projection.operations.length,
    operations: Object.freeze(value.projection.operations.map((operation) => Object.freeze({
      operationId: operation.operationId,
      method: operation.method,
      path: operation.path,
      operationProjectionHash: operation.operationProjectionHash,
    }))),
    executionAvailability: "simulation_only",
  });
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
    if (!id) return connectorPrivateJson({ error: "not found" }, 404);
    const identity = checked.provider.getConnectorIdentity(checked.ownerId, id);
    if (!identity) return connectorPrivateJson({ error: "not found" }, 404);
    const page = parseConnectorHistoryPage(new URL(request.url).searchParams);
    if (!page) return connectorPrivateJson({ error: "invalid request" }, 400);
    const result = checked.provider.listDefinitionHistoryPage(checked.ownerId, id, page);
    const nextCursor = encodeConnectorHistoryCursor(result.nextBeforeVersionNumber);
    if (result.nextBeforeVersionNumber !== null && nextCursor === null) return connectorPrivateJson({ error: "connector service unavailable" }, 503);
    const envelope = parseConnectorEnvelope({
      connector: identity,
      history: result.items.map(definitionSummary),
      nextCursor,
    });
    return envelope ? connectorPrivateJson(envelope) : connectorPrivateJson({ error: "connector service unavailable" }, 503);
  } catch {
    return connectorPrivateJson({ error: "connector service unavailable" }, 503);
  } finally {
    close(repository);
  }
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
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
      parseBody: parseConnectorMutationBody,
    });
    if (!checked.ok) return preflightFailure(checked);
    const id = await connectorId(context);
    if (!id) return connectorPrivateJson({ error: "not found" }, 404);
    const result = checked.body.action === "rename"
      ? checked.provider.rename(checked.ownerId, id, checked.body.expectedLifecycleRevision, checked.body.displayLabel, Date.now())
      : checked.provider.archive(checked.ownerId, id, checked.body.expectedLifecycleRevision, Date.now());
    if (result.status !== "updated") {
      return result.status === "not-found"
        ? connectorPrivateJson({ error: "not found" }, 404)
        : connectorPrivateJson({ error: "conflict" }, 409);
    }
    const envelope = parseConnectorListEnvelope({ connectors: [result.identity], nextCursor: null });
    return envelope ? connectorPrivateJson({ connector: envelope.connectors[0] }) : connectorPrivateJson({ error: "connector service unavailable" }, 503);
  } catch {
    return connectorPrivateJson({ error: "connector service unavailable" }, 503);
  } finally {
    close(repository);
  }
}
