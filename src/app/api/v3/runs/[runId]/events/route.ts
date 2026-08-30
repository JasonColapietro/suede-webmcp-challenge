import { resolveReadOnlyOwnerId, UnauthenticatedOwnerError } from "@/lib/auth";
import { durableError, isCanonicalOpaqueId, parseEventCursor, PRIVATE_SSE_HEADERS } from "@/lib/runtime/api-contract";
import { createPersistedEventStream } from "@/lib/runtime/control";
import { getDurableRuntimeRepository, DurableRuntimeUnavailableError } from "@/lib/runtime/provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }): Promise<Response> {
  try {
    const ownerId = await resolveReadOnlyOwnerId();
    const { runId } = await params;
    if (!isCanonicalOpaqueId(runId, 256)) return durableError(404);
    const repository = await getDurableRuntimeRepository();
    if (!await repository.hasExecution(ownerId, runId)) return durableError(404);
    const after = parseEventCursor(request);
    if (after === "invalid" || after === null) return durableError(400);
    const view = await repository.getExecutionView(ownerId, runId);
    if (!view) return durableError(503);
    if (after > view.projection.sequence) return durableError(400);
    if (request.signal.aborted) return new Response(null, { status: 204, headers: PRIVATE_SSE_HEADERS });
    return new Response(createPersistedEventStream({ repository, ownerId, executionId: runId, after, signal: request.signal }), { status: 200, headers: PRIVATE_SSE_HEADERS });
  } catch (error) {
    if (error instanceof UnauthenticatedOwnerError) return durableError(401);
    if (error instanceof DurableRuntimeUnavailableError) return durableError(503);
    return durableError(503);
  }
}
