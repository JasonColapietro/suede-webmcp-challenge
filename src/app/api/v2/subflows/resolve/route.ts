import { resolveReadOnlyOwnerId } from "@/lib/auth";
import { getRepo } from "@/lib/db/repo";
import { SubflowApiService, SubflowResolveProjectionSchema, SubflowResolveRequestSchema } from "@/lib/flow/subflow-api";
import { methodNotAllowed, subflowApiErrorResponse } from "@/lib/flow/subflow-api-route";
import { parsedJsonWithinBudget, privateJson, readCappedJsonRequest } from "@/lib/projects/api-response";
import { rejectAuthorizationMutation } from "@/lib/projects/mutation-auth";
import { SubflowReferenceSchema } from "@/lib/flow/subflow-reference";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    rejectAuthorizationMutation(request);
    const ownerId = await resolveReadOnlyOwnerId();
    const read = await readCappedJsonRequest(request);
    if (!read.ok || read.data === null || typeof read.data !== "object" || Array.isArray(read.data)) {
      return privateJson({ error: "invalid request" }, 400);
    }
    const descriptor = Object.getOwnPropertyDescriptor(read.data, "parentFlowId");
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string" ||
        descriptor.value.length < 1 || descriptor.value.length > 512 ||
        Buffer.byteLength(descriptor.value, "utf8") > 512) {
      return privateJson({ error: "invalid request" }, 400);
    }
    const boundary = new SubflowApiService(await getRepo());
    if (!(await boundary.owns({ ownerId, flowId: descriptor.value }))) {
      return privateJson({ error: "not found" }, 404);
    }
    if (!parsedJsonWithinBudget(read.data)) return privateJson({ error: "invalid request" }, 400);
    const parsed = SubflowResolveRequestSchema.safeParse(read.data);
    if (!parsed.success) return privateJson({ error: "invalid request" }, 400);
    const result = await boundary.resolve({
      ownerId,
      parentFlowId: parsed.data.parentFlowId,
      nodeId: parsed.data.nodeId,
      reference: SubflowReferenceSchema.parse(parsed.data.reference),
    });
    if (!result) return privateJson({ error: "not found" }, 404);
    return privateJson(SubflowResolveProjectionSchema.parse(result));
  } catch (error) {
    return subflowApiErrorResponse(error);
  }
}

export const GET = () => methodNotAllowed("POST");
export const PUT = GET;
export const PATCH = GET;
export const DELETE = GET;
export const HEAD = GET;
export const OPTIONS = GET;
