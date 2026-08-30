import { resolveOwnerId } from "@/lib/auth";
import {
  notFoundResponse,
  privateJson,
  projectApiErrorResponse,
} from "@/lib/projects/api-response";
import { getProjectRepo } from "@/lib/projects/provider";
import { isOpaquePathId } from "@/lib/projects/request-schema";
import type { ProjectDetail } from "@/lib/projects/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  try {
    const ownerId = await resolveOwnerId();
    const { projectId } = await params;
    if (!isOpaquePathId(projectId)) return notFoundResponse();
    const repo = await getProjectRepo();
    const record = await repo.getProject(projectId, ownerId);
    if (!record) return notFoundResponse();
    const [workbooks, environments] = await Promise.all([
      repo.listWorkbooks(record.id, ownerId),
      repo.listEnvironments(record.id, ownerId),
    ]);
    const project: ProjectDetail = { ...record, workbooks, environments };
    return privateJson({ project });
  } catch (error: unknown) {
    return projectApiErrorResponse(error);
  }
}
