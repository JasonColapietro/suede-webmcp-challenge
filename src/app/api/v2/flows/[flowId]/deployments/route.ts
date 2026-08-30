import { resolveOwnerId, resolveReadOnlyOwnerId } from "@/lib/auth";
import { DeploymentService } from "@/lib/projects/deployment-service";
import {
  invalidRequestResponse,
  notFoundResponse,
  parseJsonRequest,
  privateJson,
  projectApiErrorResponse,
} from "@/lib/projects/api-response";
import { getProjectRepo } from "@/lib/projects/provider";
import {
  DeployFlowVersionRequestSchema,
  isOpaquePathId,
} from "@/lib/projects/request-schema";
import { rejectAuthorizationMutation } from "@/lib/projects/mutation-auth";
import { API_OPERATION_LIVE_UNAVAILABLE } from "@/lib/connectors/operation-closure";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  readonly params: Promise<{ flowId: string }>;
}

export async function GET(
  _request: Request,
  { params }: RouteContext,
): Promise<Response> {
  try {
    const ownerId = await resolveReadOnlyOwnerId();
    const { flowId } = await params;
    if (!isOpaquePathId(flowId)) return notFoundResponse();
    const repo = await getProjectRepo();
    if (!(await repo.getFlowContext(flowId, ownerId))) return notFoundResponse();
    const deployments = await new DeploymentService(repo).listDeployments({ flowId, ownerId });
    return privateJson({ deployments });
  } catch (error: unknown) {
    return projectApiErrorResponse(error);
  }
}

export async function POST(
  request: Request,
  { params }: RouteContext,
): Promise<Response> {
  try {
    rejectAuthorizationMutation(request);
    const ownerId = await resolveOwnerId();
    const { flowId } = await params;
    if (!isOpaquePathId(flowId)) return notFoundResponse();
    const parsed = await parseJsonRequest(request, DeployFlowVersionRequestSchema);
    if (!parsed.ok) return invalidRequestResponse();
    const repo = await getProjectRepo();
    const flowContext = await repo.getFlowContext(flowId, ownerId);
    if (!flowContext) return notFoundResponse();
    const result = await new DeploymentService(repo).deployVersion({
      flowId,
      ownerId,
      ...parsed.data,
    });
    if (result.status === "deployed") return privateJson({ deployment: result.deployment });
    if (result.status === "not-found") return notFoundResponse();
    if (result.status === "conflict") {
      return privateJson({ error: "promotion conflict" }, 409);
    }
    if (result.status === API_OPERATION_LIVE_UNAVAILABLE) {
      return privateJson({ error: API_OPERATION_LIVE_UNAVAILABLE }, 409);
    }
    return invalidRequestResponse();
  } catch (error: unknown) {
    return projectApiErrorResponse(error);
  }
}
