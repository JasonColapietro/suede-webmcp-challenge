import { resolveReadOnlyOwnerId, UnauthenticatedOwnerError } from "@/lib/auth";
import { durableError, isCanonicalIdempotencyKey, isCanonicalOpaqueId, parseDurableActionBody, privateJson, publicDurableExecutionView, publicDurableProjection, readBoundedJson, validateMutationHeaders } from "@/lib/runtime/api-contract";
import { applyDurableAction } from "@/lib/runtime/control";
import { getDurableRuntimeRepository, DurableRuntimeUnavailableError } from "@/lib/runtime/provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;

export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }): Promise<Response> {
  const headerFailure = validateMutationHeaders(request);
  if (headerFailure) return durableError(headerFailure);
  try {
    // Mutation identity resolution is read-only. This route must prove the
    // explicit durable store is available before it touches any storage.
    const ownerId = await resolveReadOnlyOwnerId();
    const { runId } = await params;
    if (!isCanonicalOpaqueId(runId, 256)) return durableError(404);
    const repository = await getDurableRuntimeRepository();
    if (!await repository.hasExecution(ownerId, runId)) return durableError(404);
    const key = request.headers.get("idempotency-key");
    if (key !== null && !isCanonicalIdempotencyKey(key)) return durableError(400);
    const body = parseDurableActionBody(await readBoundedJson(request));
    if (!body || (body.action === "retry" && !key) || (body.action !== "retry" && key !== null)) return durableError(400);
    const result = await applyDurableAction({ repository, ownerId, executionId: runId, action: body.action, ...(key ? { idempotencyKey: key, expiresAt: Date.now() + IDEMPOTENCY_TTL_MS } : {}) });
    if (result.status === "applied" || result.status === "idempotent") return privateJson({ action: body.action, run: publicDurableProjection(result.execution) });
    if (result.status === "created" || result.status === "duplicate") {
      const child = result.execution;
      const safe = publicDurableExecutionView(child);
      return privateJson({ action: "retry", runId: safe.executionId, state: safe.projection.state, statusUrl: `/api/v3/runs/${encodeURIComponent(safe.executionId)}`, eventsUrl: `/api/v3/runs/${encodeURIComponent(safe.executionId)}/events` }, 202);
    }
    if (result.status === "not-found") return durableError(404);
    if (result.status === "conflict") return durableError(409);
    return durableError(503);
  } catch (error) {
    if (error instanceof UnauthenticatedOwnerError) return durableError(401);
    if (error instanceof DurableRuntimeUnavailableError) return durableError(503);
    return durableError(503);
  }
}
