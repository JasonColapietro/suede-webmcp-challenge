import {
  adoptAnonymousWorkspaceForVerifiedOwnerOrThrow,
  resolveReadOnlyOwnerId,
} from "@/lib/auth";
import { privateJson } from "@/lib/projects/api-response";
import {
  googlePlayResourceMutationRefusal,
  rejectAuthorizationMutation,
} from "@/lib/projects/mutation-auth";
import {
  assertResourceFoundryEnabled,
  resourceApiErrorResponse,
} from "@/lib/resources/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const playRefusal = googlePlayResourceMutationRefusal(request);
    if (playRefusal) return playRefusal;
    assertResourceFoundryEnabled();
    rejectAuthorizationMutation(request);
    const ownerId = await resolveReadOnlyOwnerId();
    await adoptAnonymousWorkspaceForVerifiedOwnerOrThrow(ownerId);
    return privateJson({ adopted: true });
  } catch (error: unknown) {
    return resourceApiErrorResponse(error);
  }
}
