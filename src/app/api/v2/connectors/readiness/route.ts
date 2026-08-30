import { resolveReadOnlyOwnerId } from "@/lib/auth";
import {
  CONNECTOR_METADATA_BODY_LIMIT_BYTES,
  connectorPrivateJson,
  preflightConnectorMutation,
  type ConnectorPrivateErrorEnvelope,
} from "@/lib/connectors/api-contract";
import { CONNECTOR_LAB_ENABLED } from "@/lib/connectors/flags";
import {
  READINESS_CANCELLED,
  TEST_CONNECTION_UNAVAILABLE,
  parseConnectorReadinessRequest,
} from "@/lib/connectors/readiness";
import {
  getConnectorReadinessBackend,
  type ConnectorReadinessBackend,
} from "@/lib/connectors/readiness-backend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function close(backend: ConnectorReadinessBackend | null): void {
  try { backend?.close(); } catch { /* terminal */ }
}

function preflightFailure(value: Readonly<{ status: number; error: ConnectorPrivateErrorEnvelope }>): Response {
  return connectorPrivateJson(value.error, value.status);
}

function cancelled(): Response {
  return connectorPrivateJson({ error: "request cancelled" }, 409);
}

export async function POST(request: Request): Promise<Response> {
  let backend: ConnectorReadinessBackend | null = null;
  try {
    if (CONNECTOR_LAB_ENABLED && request.signal.aborted) return cancelled();
    const checked = await preflightConnectorMutation({
      enabled: CONNECTOR_LAB_ENABLED,
      request,
      resolveOwner: async () => resolveReadOnlyOwnerId(),
      resolveProvider: async () => {
        backend = await getConnectorReadinessBackend();
        return backend;
      },
      parseBody: parseConnectorReadinessRequest,
      maxBytes: CONNECTOR_METADATA_BODY_LIMIT_BYTES,
    });
    if (!checked.ok) return CONNECTOR_LAB_ENABLED && request.signal.aborted
      ? cancelled()
      : preflightFailure(checked);
    if (request.signal.aborted) return cancelled();
    const result = checked.provider.check(checked.ownerId, checked.body, request.signal);
    if (result.ok) return connectorPrivateJson({ readiness: result.receipt });
    if (result.code === TEST_CONNECTION_UNAVAILABLE) {
      return connectorPrivateJson({ error: "test readiness unavailable", readiness: result.receipt }, 409);
    }
    if (result.code === READINESS_CANCELLED) {
      return cancelled();
    }
    return connectorPrivateJson({ error: "connector service unavailable" }, 503);
  } catch {
    return connectorPrivateJson({ error: "connector service unavailable" }, 503);
  } finally {
    close(backend);
  }
}
