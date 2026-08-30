import { resolveReadOnlyOwnerId } from "@/lib/auth";
import {
  encodeConnectorListCursor,
  connectorPrivateJson,
  parseConnectorListEnvelope,
  parseConnectorListPage,
  preflightConnectorRead,
  type ConnectorPrivateErrorEnvelope,
} from "@/lib/connectors/api-contract";
import { CONNECTOR_LAB_ENABLED } from "@/lib/connectors/flags";
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

export async function GET(request: Request): Promise<Response> {
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
    const page = parseConnectorListPage(new URL(request.url).searchParams);
    if (!page) return connectorPrivateJson({ error: "invalid request" }, 400);
    const result = checked.provider.listConnectorIdentities(checked.ownerId, page);
    const nextCursor = encodeConnectorListCursor(result.nextCursor);
    if (result.nextCursor !== null && nextCursor === null) return connectorPrivateJson({ error: "connector service unavailable" }, 503);
    const envelope = parseConnectorListEnvelope({ connectors: result.items, nextCursor });
    return envelope ? connectorPrivateJson(envelope) : connectorPrivateJson({ error: "connector service unavailable" }, 503);
  } catch {
    return connectorPrivateJson({ error: "connector service unavailable" }, 503);
  } finally {
    close(repository);
  }
}
