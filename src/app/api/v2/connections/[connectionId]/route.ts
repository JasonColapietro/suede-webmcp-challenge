import { resolveReadOnlyOwnerId } from "@/lib/auth";
import {
  parseConnectionEnvelope,
  parseRenameBody,
  preflightConnectionMutation,
  preflightConnectionRead,
  type PrivateErrorEnvelope,
} from "@/lib/connections/api-contract";
import { getConnectionRepository } from "@/lib/connections/provider";
import type { CloseableConnectionRepository } from "@/lib/connections/repository";
import { adoptVerifiedConnectionOwner } from "@/lib/connections/route-owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CONNECTION_ID = /^[A-Za-z0-9._:-]{1,256}$/u;
type RouteContext = Readonly<{ params: Promise<{ connectionId: string }> }>;

function privateJson(body: Readonly<object>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "private, no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function fixedUnavailable(): Response {
  return privateJson({ error: "connection service unavailable" }, 503);
}

function preflightFailure(input: Readonly<{ status: number; error: PrivateErrorEnvelope }>): Response {
  return privateJson(input.error, input.status);
}

function closeRepository(repository: CloseableConnectionRepository | null): void {
  if (!repository) return;
  try {
    repository.close();
  } catch {
    try { repository.dispose(); } catch { /* disposal remains terminal and secret-free */ }
  }
}

async function routeConnectionId(context: RouteContext): Promise<string | null> {
  try {
    const value = (await context.params).connectionId;
    return typeof value === "string" && CONNECTION_ID.test(value) ? value : null;
  } catch {
    return null;
  }
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  let repository: CloseableConnectionRepository | null = null;
  try {
    const checked = await preflightConnectionRead({
      request,
      resolveOwner: async () => resolveReadOnlyOwnerId(),
      resolveProvider: async () => {
        repository = await getConnectionRepository();
        return repository;
      },
    });
    if (!checked.ok) return preflightFailure(checked);
    const connectionId = await routeConnectionId(context);
    if (!connectionId) return privateJson({ error: "not found" }, 404);
    await adoptVerifiedConnectionOwner(checked.ownerId);
    const connection = await checked.provider.get(checked.ownerId, connectionId);
    if (!connection) return privateJson({ error: "not found" }, 404);
    const envelope = parseConnectionEnvelope({ connection });
    return envelope ? privateJson(envelope) : fixedUnavailable();
  } catch {
    return fixedUnavailable();
  } finally {
    closeRepository(repository);
  }
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  let repository: CloseableConnectionRepository | null = null;
  try {
    const checked = await preflightConnectionMutation({
      request,
      resolveOwner: async () => resolveReadOnlyOwnerId(),
      resolveProvider: async () => {
        repository = await getConnectionRepository();
        return repository;
      },
      parseBody: parseRenameBody,
    });
    if (!checked.ok) return preflightFailure(checked);
    const connectionId = await routeConnectionId(context);
    if (!connectionId) return privateJson({ error: "not found" }, 404);
    await adoptVerifiedConnectionOwner(checked.ownerId);
    const result = await checked.provider.rename(
      checked.ownerId,
      connectionId,
      checked.body.expectedLifecycleRevision,
      checked.body.name,
      Date.now(),
    );
    if (result.status !== "updated") {
      return result.status === "not-found"
        ? privateJson({ error: "not found" }, 404)
        : privateJson({ error: "conflict" }, 409);
    }
    const envelope = parseConnectionEnvelope({ connection: result.connection });
    return envelope ? privateJson(envelope) : fixedUnavailable();
  } catch {
    return fixedUnavailable();
  } finally {
    closeRepository(repository);
  }
}
