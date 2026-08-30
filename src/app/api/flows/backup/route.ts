import { NextResponse } from "next/server";
import { resolveOwnerId, UnauthenticatedOwnerError } from "@/lib/auth";
import { getRepo } from "@/lib/db/repo";
import {
  createFlowBackup,
  FlowBackupInvalidError,
  FlowBackupRestoreConflictError,
  FlowBackupTooLargeError,
  restoreFlowBackup,
} from "@/lib/flow/backup";
import {
  invalidRequestResponse,
  privateJson,
  readBoundedJsonRequest,
} from "@/lib/projects/api-response";

export const runtime = "nodejs";

function backupFilename(createdAt: string): string {
  return `suede-agent-studio-flows-${createdAt.slice(0, 10)}.json`;
}

export async function GET(): Promise<NextResponse> {
  try {
    const ownerId = await resolveOwnerId();
    const archive = await createFlowBackup(ownerId, await getRepo());
    return new NextResponse(JSON.stringify(archive), {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename="${backupFilename(archive.createdAt)}"`,
        "Content-Type": "application/json; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error: unknown) {
    if (error instanceof UnauthenticatedOwnerError) {
      return privateJson({ error: "Authentication required" }, error.status);
    }
    if (error instanceof FlowBackupTooLargeError) {
      return privateJson({ error: "backup too large" }, 413);
    }
    return privateJson({ error: "internal server error" }, 500);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const ownerId = await resolveOwnerId();
    const body = await readBoundedJsonRequest(request);
    if (!body.ok) return invalidRequestResponse();
    const result = await restoreFlowBackup(ownerId, body.data, await getRepo());
    return privateJson(result);
  } catch (error: unknown) {
    if (error instanceof UnauthenticatedOwnerError) {
      return privateJson({ error: "Authentication required" }, error.status);
    }
    if (error instanceof FlowBackupInvalidError) return invalidRequestResponse();
    if (error instanceof FlowBackupRestoreConflictError) {
      return privateJson({ error: "backup could not be restored safely" }, 409);
    }
    return privateJson({ error: "internal server error" }, 500);
  }
}
