import { resolveReadOnlyOwnerId, UnauthenticatedOwnerError } from "@/lib/auth";
import { durableError, isCanonicalOpaqueId, privateJson, publicDurableExecutionView } from "@/lib/runtime/api-contract";
import { getDurableRuntimeRepository, DurableRuntimeUnavailableError } from "@/lib/runtime/provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ runId: string }> }): Promise<Response> {
  try {
    const ownerId = await resolveReadOnlyOwnerId();
    const { runId } = await params;
    if (!isCanonicalOpaqueId(runId, 256)) return durableError(404);
    const view = await (await getDurableRuntimeRepository()).getExecutionView(ownerId, runId);
    if (!view) return durableError(404);
    return privateJson({ run: publicDurableExecutionView(view) });
  } catch (error) {
    if (error instanceof UnauthenticatedOwnerError) return durableError(401);
    if (error instanceof DurableRuntimeUnavailableError) return durableError(503);
    return durableError(503);
  }
}
