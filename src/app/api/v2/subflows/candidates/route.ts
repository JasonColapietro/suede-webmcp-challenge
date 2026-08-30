import { getRepo } from "@/lib/db/repo";
import { privateJson } from "@/lib/projects/api-response";
import { resolveReadOnlyOwnerId } from "@/lib/auth";
import {
  normalizeSubflowQuery,
  SubflowApiService,
  SubflowCandidatePageSchema,
} from "@/lib/flow/subflow-api";
import {
  decodeSubflowCursor,
  encodeSubflowCursor,
  InvalidSubflowApiRequestError,
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
    const params = strictSearchParams(request, ["parentFlowId", "query", "cursor", "limit"]);
    const parentFlowId = requiredOpaqueQueryId(params, "parentFlowId");
    const rawQuery = params.get("query") ?? "";
    if (rawQuery.length > 100) throw new InvalidSubflowApiRequestError();
    const query = normalizeSubflowQuery(rawQuery);
    if (Buffer.byteLength(query, "utf8") > 400) throw new InvalidSubflowApiRequestError();
    const limit = optionalCanonicalLimit(params, 50, 20);
    const binding = [ownerId, parentFlowId, query, "name-id-asc"];
    const decoded = decodeSubflowCursor(optionalCursor(params), "candidates", binding);
    const cursor = decoded as readonly [string, string] | undefined;
    const result = await boundary.candidates({
      ownerId, parentFlowId, query, cursor, limit,
    });
    if (!result) return privateJson({ error: "not found" }, 404);
    const nextCursor = result.last
      ? encodeSubflowCursor({ endpoint: "candidates", binding, last: result.last })
      : undefined;
    const body = SubflowCandidatePageSchema.parse({
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
