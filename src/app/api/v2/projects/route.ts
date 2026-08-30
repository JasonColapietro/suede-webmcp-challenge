import { resolveOwnerId } from "@/lib/auth";
import { privateJson, projectApiErrorResponse } from "@/lib/projects/api-response";
import { getProjectRepo } from "@/lib/projects/provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const ownerId = await resolveOwnerId();
    const repo = await getProjectRepo();
    await repo.ensurePersonalContext(ownerId);
    const projects = await repo.listProjects(ownerId);
    return privateJson({ projects });
  } catch (error: unknown) {
    return projectApiErrorResponse(error);
  }
}
