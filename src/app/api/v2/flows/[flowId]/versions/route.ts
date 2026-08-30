import { resolveOwnerId } from "@/lib/auth";
import {
  invalidRequestResponse,
  notFoundResponse,
  parseJsonRequest,
  privateJson,
  projectApiErrorResponse,
} from "@/lib/projects/api-response";
import { ensureOwnedFlowContext, getProjectRepo } from "@/lib/projects/provider";
import {
  CreateFlowVersionRequestSchema,
  isOpaquePathId,
} from "@/lib/projects/request-schema";
import { VersionService } from "@/lib/projects/version-service";
import {
  publicFlowVersionRecord,
  publicFlowVersionSummary,
} from "@/lib/projects/public-version";
import { resolveVersionReadOwnerId } from "@/lib/projects/version-read-auth";
import { rejectAuthorizationMutation } from "@/lib/projects/mutation-auth";
import { parseSupportedFlowGraph } from "@/lib/flow/graph-schema";
import { FlowVersionMutationError } from "@/lib/projects/version-mutation-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  readonly params: Promise<{ flowId: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const ownerId = await resolveVersionReadOwnerId(request);
    const { flowId } = await context.params;
    if (!isOpaquePathId(flowId)) return notFoundResponse();
    const repo = await getProjectRepo();
    const flowContext = await ensureOwnedFlowContext({ repo, flowId, ownerId });
    if (!flowContext) return notFoundResponse();
    const versions = await new VersionService(repo).listFlowVersions({ flowId, ownerId });
    return privateJson({ versions: versions.map(publicFlowVersionSummary) });
  } catch (error: unknown) {
    return projectApiErrorResponse(error);
  }
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    rejectAuthorizationMutation(request);
    const ownerId = await resolveOwnerId();
    const { flowId } = await context.params;
    if (!isOpaquePathId(flowId)) return notFoundResponse();
    const repo = await getProjectRepo();
    if (!(await repo.ownsFlow(flowId, ownerId))) return notFoundResponse();
    const parsed = await parseJsonRequest(request, CreateFlowVersionRequestSchema);
    if (!parsed.ok) return invalidRequestResponse();
    const service = new VersionService(repo);
    const checkpointGraph = parsed.data.graph === undefined
      ? undefined
      : parseSupportedFlowGraph(parsed.data.graph);
    const version = checkpointGraph === undefined
      ? await service.createFlowVersion({ flowId, ownerId, ...parsed.data })
      : await service.createFlowCheckpoint({
          flowId,
          ownerId,
          ...parsed.data,
          graph: checkpointGraph,
        });
    return version
      ? privateJson({ version: publicFlowVersionRecord(version) })
      : notFoundResponse();
  } catch (error: unknown) {
    if (error instanceof FlowVersionMutationError) {
      if (error.result.status === "impact-required") {
        return privateJson({
          error: "impact confirmation required",
          receipt: error.result.receipt,
          impact: error.result.impact,
        }, 409);
      }
      if (error.result.status === "conflict") {
        return privateJson({ error: "mutation conflict" }, 409);
      }
      return invalidRequestResponse();
    }
    return projectApiErrorResponse(error);
  }
}
