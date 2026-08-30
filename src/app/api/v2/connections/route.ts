import { resolveReadOnlyOwnerId } from "@/lib/auth";
import {
  parseConnectionListEnvelope,
  parseConnectionListPage,
  parseConnectionEnvelope,
  parseCreateBody,
  preflightConnectionMutation,
  preflightConnectionRead,
  type PrivateErrorEnvelope,
} from "@/lib/connections/api-contract";
import { getConnectionRepository } from "@/lib/connections/provider";
import {
  InvalidConnectionPageError,
  type CloseableConnectionRepository,
} from "@/lib/connections/repository";
import { adoptVerifiedConnectionOwner } from "@/lib/connections/route-owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

export async function GET(request: Request): Promise<Response> {
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
    const page = parseConnectionListPage(new URL(request.url).searchParams, "list");
    if (!page) return privateJson({ error: "invalid request" }, 400);
    await adoptVerifiedConnectionOwner(checked.ownerId);
    const result = await checked.provider.list(checked.ownerId, page);
    const envelope = parseConnectionListEnvelope({
      connections: result.items,
      nextCursor: result.nextCursor,
    });
    return envelope ? privateJson(envelope) : fixedUnavailable();
  } catch (error) {
    return error instanceof InvalidConnectionPageError
      ? privateJson({ error: "invalid request" }, 400)
      : fixedUnavailable();
  } finally {
    closeRepository(repository);
  }
}

export async function POST(request: Request): Promise<Response> {
  let repository: CloseableConnectionRepository | null = null;
  try {
    const checked = await preflightConnectionMutation({
      request,
      resolveOwner: async () => resolveReadOnlyOwnerId(),
      resolveProvider: async () => {
        repository = await getConnectionRepository();
        return repository;
      },
      parseBody: parseCreateBody,
    });
    if (!checked.ok) return preflightFailure(checked);
    await adoptVerifiedConnectionOwner(checked.ownerId);
    const connection = await checked.provider.create(checked.ownerId, checked.body, Date.now());
    const envelope = parseConnectionEnvelope({ connection });
    return envelope ? privateJson(envelope, 201) : fixedUnavailable();
  } catch {
    return fixedUnavailable();
  } finally {
    closeRepository(repository);
  }
}
