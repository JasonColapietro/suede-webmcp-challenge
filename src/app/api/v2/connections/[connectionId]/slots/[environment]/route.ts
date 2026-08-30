import { resolveReadOnlyOwnerId } from "@/lib/auth";
import {
  CONNECTION_API_STATUS,
  PRIVATE_ERROR_STATUS,
  parseConfigureSlotBody,
  parseConnectionEnvelope,
  parseConnectionEnvironmentPath,
  preflightConnectionMutation,
  type PrivateError,
} from "@/lib/connections/api-contract";
import { getConnectionRepository } from "@/lib/connections/provider";
import type { CloseableConnectionRepository } from "@/lib/connections/repository";
import { adoptVerifiedConnectionOwner } from "@/lib/connections/route-owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CONNECTION_ID = /^[A-Za-z0-9._:-]{1,256}$/u;

interface RouteContext {
  readonly params: Promise<{ readonly connectionId: string; readonly environment: string }>;
}

function privateJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "cache-control": "private, no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function errorResponse(error: PrivateError): Response {
  return privateJson({ error }, PRIVATE_ERROR_STATUS[error]);
}

function parseRevokeBody(value: unknown): Readonly<{ expectedLifecycleRevision: number }> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.keys(descriptors).length !== 1) return null;
    const revision = descriptors.expectedLifecycleRevision;
    if (!revision || !("value" in revision) || !revision.enumerable ||
        !Number.isSafeInteger(revision.value) || (revision.value as number) < 1) return null;
    return Object.freeze({ expectedLifecycleRevision: revision.value as number });
  } catch {
    return null;
  }
}

function closeRepository(repository: CloseableConnectionRepository | null): void {
  if (!repository) return;
  try {
    repository.close();
  } catch {
    try { repository.dispose(); } catch { /* fixed response already selected */ }
  }
}

async function routeParams(context: RouteContext): Promise<Readonly<{
  connectionId: string;
  environment: "test" | "live";
}> | null> {
  try {
    const { connectionId, environment } = await context.params;
    const parsedEnvironment = parseConnectionEnvironmentPath(environment);
    if (typeof connectionId !== "string" || !CONNECTION_ID.test(connectionId) || !parsedEnvironment) return null;
    return Object.freeze({ connectionId, environment: parsedEnvironment });
  } catch {
    return null;
  }
}

export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  let repository: CloseableConnectionRepository | null = null;
  try {
    const preflight = await preflightConnectionMutation({
      request,
      resolveOwner: async () => resolveReadOnlyOwnerId(),
      resolveProvider: async () => {
        repository = await getConnectionRepository();
        return repository;
      },
      parseBody: parseConfigureSlotBody,
    });
    if (!preflight.ok) return privateJson(preflight.error, preflight.status);
    const params = await routeParams(context);
    if (!params) return errorResponse("invalid request");
    await adoptVerifiedConnectionOwner(preflight.ownerId);
    const result = await preflight.provider.configureSlot(
      preflight.ownerId,
      params.connectionId,
      params.environment,
      preflight.body.expectedLifecycleRevision,
      preflight.body.secret,
      Date.now(),
    );
    if (result.status !== "updated") {
      return result.status === "not-found" ? errorResponse("not found") : errorResponse("conflict");
    }
    const envelope = parseConnectionEnvelope({ connection: result.connection });
    if (!envelope) return errorResponse("connection service unavailable");
    const status = result.connection.slots[params.environment].secretVersion === 1
      ? CONNECTION_API_STATUS.firstSlotConfigure
      : CONNECTION_API_STATUS.rotate;
    return privateJson(envelope, status);
  } catch (error) {
    return error instanceof TypeError
      ? errorResponse("invalid request")
      : errorResponse("connection service unavailable");
  } finally {
    closeRepository(repository);
  }
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  let repository: CloseableConnectionRepository | null = null;
  try {
    const preflight = await preflightConnectionMutation({
      request,
      resolveOwner: async () => resolveReadOnlyOwnerId(),
      resolveProvider: async () => {
        repository = await getConnectionRepository();
        return repository;
      },
      parseBody: parseRevokeBody,
    });
    if (!preflight.ok) return privateJson(preflight.error, preflight.status);
    const params = await routeParams(context);
    if (!params) return errorResponse("invalid request");
    await adoptVerifiedConnectionOwner(preflight.ownerId);
    const result = await preflight.provider.revokeSlot(
      preflight.ownerId,
      params.connectionId,
      params.environment,
      preflight.body.expectedLifecycleRevision,
      Date.now(),
    );
    if (result.status !== "updated") {
      return result.status === "not-found" ? errorResponse("not found") : errorResponse("conflict");
    }
    const envelope = parseConnectionEnvelope({ connection: result.connection });
    return envelope
      ? privateJson(envelope, CONNECTION_API_STATUS.revoke)
      : errorResponse("connection service unavailable");
  } catch {
    return errorResponse("connection service unavailable");
  } finally {
    closeRepository(repository);
  }
}
