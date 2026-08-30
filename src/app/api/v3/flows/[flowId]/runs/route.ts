import { adoptAnonymousWorkspaceForVerifiedOwner, resolveReadOnlyOwnerId, UnauthenticatedOwnerError } from "@/lib/auth";
import { getRepo } from "@/lib/db/repo";
import { createSubflowResolver } from "@/lib/flow/subflow-resolver";
import { parseSupportedFlowGraph } from "@/lib/flow/graph-schema";
import { getProjectRepo } from "@/lib/projects/provider";
import { VersionService } from "@/lib/projects/version-service";
import { durableError, isCanonicalIdempotencyKey, isCanonicalOpaqueId, parseDurableRunBody, privateJson, readBoundedJson, validateMutationHeaders } from "@/lib/runtime/api-contract";
import { enqueueDurableExecution } from "@/lib/runtime/enqueue";
import { getDurableRuntimeRepository, DurableRuntimeUnavailableError } from "@/lib/runtime/provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ATTEMPTS = 3;
const DEADLINE_MS = 5 * 60_000;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;

export async function POST(request: Request, { params }: { params: Promise<{ flowId: string }> }): Promise<Response> {
  const headerFailure = validateMutationHeaders(request);
  if (headerFailure) return durableError(headerFailure);
  try {
    // Resolve identity without adoption first. Durable configuration must be
    // valid before this route may touch legacy/project storage.
    const ownerId = await resolveReadOnlyOwnerId();
    const { flowId } = await params;
    if (!isCanonicalOpaqueId(flowId)) return durableError(404);
    // Supabase currently supports exact-version streaming, not the queued
    // durable worker. Return the existing admission-refused signal so the UI
    // can fall back to the immutable v2 execution path without running the
    // mutable draft.
    if (process.env.DB_DRIVER === "supabase") return durableError(422);
    const repository = await getDurableRuntimeRepository();
    await adoptAnonymousWorkspaceForVerifiedOwner(ownerId);
    const flowRepo = await getRepo();
    const ownedFlow = await flowRepo.getOwnedFlow(flowId, ownerId);
    if (!ownedFlow) return durableError(404);

    const idempotencyKey = request.headers.get("idempotency-key");
    if (!isCanonicalIdempotencyKey(idempotencyKey)) return durableError(400);
    const body = parseDurableRunBody(await readBoundedJson(request));
    if (!body) return durableError(400);

    const projectRepo = await getProjectRepo();
    const version = await new VersionService(projectRepo).getFlowVersion({ flowId, versionId: body.flowVersionId, ownerId });
    if (!version) return durableError(404);
    const now = Date.now();
    const result = await enqueueDurableExecution({
      repository, ownerId, flowId, flowVersionId: version.id, definitionHash: version.fullHash,
      graph: parseSupportedFlowGraph(version.graph),
      resolvers: { resolveSubflow: createSubflowResolver({ ownerId, flowRepo, versionRepo: projectRepo }) },
      ...(body.triggerInput ? { triggerInput: body.triggerInput } : {}),
      ...(body.runVariables ? { runVariables: body.runVariables } : {}),
      trigger: { type: "api" }, idempotency: { namespace: "v3-enqueue", key: idempotencyKey, expiresAt: now + IDEMPOTENCY_TTL_MS },
      availableAt: now, maxAttempts: MAX_ATTEMPTS, createdAt: now, deadlineAt: now + DEADLINE_MS,
    });
    if (result.status === "created" || result.status === "duplicate") {
      const runId = result.execution.executionId;
      return privateJson({ runId, state: result.execution.state, statusUrl: `/api/v3/runs/${encodeURIComponent(runId)}`, eventsUrl: `/api/v3/runs/${encodeURIComponent(runId)}/events` }, 202);
    }
    if (result.status === "conflict") return durableError(409);
    if (result.status === "not-found") return durableError(404);
    if (result.status === "admission-refused") return durableError(422);
    return durableError(503);
  } catch (error) {
    if (error instanceof UnauthenticatedOwnerError) return durableError(401);
    if (error instanceof DurableRuntimeUnavailableError) return durableError(503);
    return durableError(503);
  }
}
