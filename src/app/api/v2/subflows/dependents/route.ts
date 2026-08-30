import { getRepo } from "@/lib/db/repo";
import { privateJson } from "@/lib/projects/api-response";
import { resolveReadOnlyOwnerId } from "@/lib/auth";
import {
  SubflowApiService,
  SubflowDependentPageSchema,
} from "@/lib/flow/subflow-api";
import {
  decodeSubflowCursor,
  encodeSubflowCursor,
  methodNotAllowed,
  optionalCanonicalLimit,
  optionalCursor,
  requiredOpaqueQueryId,
  shallowOpaqueQueryId,
  strictSearchParams,
  subflowApiErrorResponse,
} from "@/lib/flow/subflow-api-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const ownerId = await resolveReadOnlyOwnerId();
    const boundary = new SubflowApiService(await getRepo());
    const shallowFlowId = shallowOpaqueQueryId(request, "flowId");
    if (!(await boundary.owns({ ownerId, flowId: shallowFlowId }))) {
      return privateJson({ error: "not found" }, 404);
    }
    const params = strictSearchParams(request, ["flowId", "cursor", "limit"]);
    const flowId = requiredOpaqueQueryId(params, "flowId");
    const limit = optionalCanonicalLimit(params, 50, 20);
    const binding = [ownerId, flowId, "flow-id-asc"];
    const decoded = decodeSubflowCursor(optionalCursor(params), "dependents", binding);
    const cursor = decoded?.[0] as string | undefined;
    const result = await boundary.dependents({
      ownerId, flowId, cursor, limit,
    });
    if (!result) return privateJson({ error: "not found" }, 404);
    const nextCursor = result.last
      ? encodeSubflowCursor({ endpoint: "dependents", binding, last: [result.last] })
      : undefined;
    const body = SubflowDependentPageSchema.parse({
      ...result.page,
      ...(nextCursor ? { nextCursor } : {}),
    });
    return privateJson(body);
  } catch (error) {
    return subflowApiErrorResponse(error);
  }
}

export const POST = () => methodNotAllowed("GET");
export const PUT = POST;
export const PATCH = POST;
export const DELETE = POST;
export const HEAD = POST;
export const OPTIONS = POST;
