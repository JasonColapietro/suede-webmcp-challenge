import { getRepo } from "@/lib/db/repo";
import { privateJson } from "@/lib/projects/api-response";
import { resolveReadOnlyOwnerId } from "@/lib/auth";
import {
  SubflowApiService,
  SubflowVersionPageSchema,
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
    const shallowParentFlowId = shallowOpaqueQueryId(request, "parentFlowId");
    if (!(await boundary.owns({ ownerId, flowId: shallowParentFlowId }))) {
      return privateJson({ error: "not found" }, 404);
    }
    const params = strictSearchParams(request, ["parentFlowId", "childFlowId", "cursor", "limit"]);
    const parentFlowId = requiredOpaqueQueryId(params, "parentFlowId");
    const childFlowId = requiredOpaqueQueryId(params, "childFlowId");
    const limit = optionalCanonicalLimit(params, 20, 20);
    const binding = [ownerId, parentFlowId, childFlowId, "version-desc-id-desc"];
    const decoded = decodeSubflowCursor(optionalCursor(params), "versions", binding);
    const cursor = decoded as readonly [number, string] | undefined;
    const result = await boundary.versions({
      ownerId, parentFlowId, childFlowId, cursor, limit,
    });
    if (!result) return privateJson({ error: "not found" }, 404);
    const nextCursor = result.last
      ? encodeSubflowCursor({ endpoint: "versions", binding, last: result.last })
      : undefined;
    const body = SubflowVersionPageSchema.parse({
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
