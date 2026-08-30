import {
  notFoundResponse,
  privateJson,
  projectApiErrorResponse,
} from "@/lib/projects/api-response";
import { ensureOwnedFlowContext, getProjectRepo } from "@/lib/projects/provider";
import { isOpaquePathId } from "@/lib/projects/request-schema";
import { VersionService } from "@/lib/projects/version-service";
import { publicFlowVersionRecord } from "@/lib/projects/public-version";
import { resolveVersionReadOwnerId } from "@/lib/projects/version-read-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ flowId: string; versionId: string }> },
): Promise<Response> {
  try {
    const ownerId = await resolveVersionReadOwnerId(request);
    const { flowId, versionId } = await params;
    if (!isOpaquePathId(flowId) || !isOpaquePathId(versionId)) return notFoundResponse();
    const repo = await getProjectRepo();
    const flowContext = await ensureOwnedFlowContext({ repo, flowId, ownerId });
    if (!flowContext) return notFoundResponse();
    const version = await new VersionService(repo).getFlowVersion({
      flowId,
      versionId,
      ownerId,
    });
    return version
      ? privateJson({ version: publicFlowVersionRecord(version) })
      : notFoundResponse();
  } catch (error: unknown) {
    return projectApiErrorResponse(error);
  }
}
