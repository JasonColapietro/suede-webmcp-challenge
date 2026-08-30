import { UnauthenticatedOwnerError } from "@/lib/auth";
import {
  isGooglePlayAccessOnlyHost,
  isGooglePlayBlockedResourceMutation,
} from "@/lib/google-play-access-only";
import { privateJson } from "@/lib/projects/api-response";

export function rejectAuthorizationMutation(request: Request): void {
  if (request.headers.has("authorization")) {
    throw new UnauthenticatedOwnerError();
  }
}

/** Route-level defense in depth for handlers invoked without middleware. */
export function googlePlayResourceMutationRefusal(
  request: Request,
): Response | null {
  if (!isGooglePlayAccessOnlyHost(request.headers.get("host"))) return null;
  const pathname = new URL(request.url).pathname;
  if (!isGooglePlayBlockedResourceMutation(pathname, request.method)) return null;
  return privateJson(
    { error: "This endpoint is unavailable in this Google Play build." },
    403,
  );
}
