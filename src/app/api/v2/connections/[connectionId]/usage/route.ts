import { resolveReadOnlyOwnerId } from "@/lib/auth";
import {
  CONNECTION_API_STATUS,
  PRIVATE_ERROR_STATUS,
  parseConnectionListPage,
  parseUsageEnvelope,
  preflightConnectionRead,
  type PrivateError,
} from "@/lib/connections/api-contract";
import { getConnectionRepository } from "@/lib/connections/provider";
import {
  InvalidConnectionPageError,
  type CloseableConnectionRepository,
} from "@/lib/connections/repository";
import { adoptVerifiedConnectionOwner } from "@/lib/connections/route-owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CONNECTION_ID = /^[A-Za-z0-9._:-]{1,256}$/u;

interface RouteContext {
  readonly params: Promise<{ readonly connectionId: string }>;
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

function closeRepository(repository: CloseableConnectionRepository | null): void {
  if (!repository) return;
  try {
    repository.close();
  } catch {
    try { repository.dispose(); } catch { /* fixed response already selected */ }
  }
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  let repository: CloseableConnectionRepository | null = null;
  try {
    const preflight = await preflightConnectionRead({
      request,
      resolveOwner: async () => resolveReadOnlyOwnerId(),
      resolveProvider: async () => {
        repository = await getConnectionRepository();
        return repository;
      },
    });
    if (!preflight.ok) return privateJson(preflight.error, preflight.status);
    let connectionId: string;
    try {
      ({ connectionId } = await context.params);
    } catch {
      return errorResponse("invalid request");
    }
    if (typeof connectionId !== "string" || !CONNECTION_ID.test(connectionId)) return errorResponse("not found");
    let page;
    try {
      page = parseConnectionListPage(new URL(request.url).searchParams, "usage");
    } catch {
      page = null;
    }
    if (!page) return errorResponse("invalid request");
    await adoptVerifiedConnectionOwner(preflight.ownerId);
    const result = await preflight.provider.usage(preflight.ownerId, connectionId, page);
    if (!result) return errorResponse("not found");
    const envelope = parseUsageEnvelope({
      usage: result.items,
      nextCursor: result.nextCursor,
      matchedLowerBound: result.matchedLowerBound,
      truncated: result.truncated,
      lifecycleRevision: result.lifecycleRevision,
    });
    return envelope
      ? privateJson(envelope, CONNECTION_API_STATUS.usage)
      : errorResponse("connection service unavailable");
  } catch (error) {
    return errorResponse(error instanceof InvalidConnectionPageError
      ? "invalid request"
      : "connection service unavailable");
  } finally {
    closeRepository(repository);
  }
}
