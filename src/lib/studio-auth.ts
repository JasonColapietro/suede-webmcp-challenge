import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  adoptAnonymousWorkspaceForVerifiedOwnerOrThrow,
  SUEDE_OWNER_PREFIX,
} from "./auth";
import { isGooglePlayAccessOnlyHost } from "./google-play-access-only";
import { REQUEST_TARGET_HEADER } from "./native-shell";
import { signInUrl } from "./sign-in-url";
import { SITE_URL } from "./site";
import { resolveSuedeIdentity } from "./suede-identity";

export { REQUEST_TARGET_HEADER } from "./native-shell";

function absoluteStudioPath(path: string): string {
  const site = new URL(SITE_URL);
  const target = new URL(path, site);
  return `${site.origin}${target.pathname}${target.search}`;
}

/**
 * Convert a middleware-provided same-origin path into a canonical return URL.
 * Request targets must be rooted paths so a caller cannot introduce an origin.
 */
export function safeStudioReturnTo(raw: string | null, fallback: string): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) {
    return absoluteStudioPath(fallback);
  }

  const site = new URL(SITE_URL);
  const target = new URL(raw, site);
  if (target.origin !== site.origin) return absoluteStudioPath(fallback);

  return `${site.origin}${target.pathname}${target.search}`;
}

/**
 * Gate canonical-web operator pages on a verified shared Suede identity.
 * The Android access-only host is the sole native exception until a verified
 * iOS authentication handoff exists.
 */
export async function requireStudioAccount(
  fallbackPath: string,
): Promise<{ readonly ownerId: string } | null> {
  const requestHeaders = await headers();
  if (isGooglePlayAccessOnlyHost(requestHeaders.get("host"))) return null;

  const identity = await resolveSuedeIdentity();
  if (!identity) {
    const target = safeStudioReturnTo(
      requestHeaders.get(REQUEST_TARGET_HEADER),
      fallbackPath,
    );
    redirect(signInUrl(target));
  }

  const ownerId = `${SUEDE_OWNER_PREFIX}${identity.userId}`;
  await adoptAnonymousWorkspaceForVerifiedOwnerOrThrow(ownerId);
  return { ownerId };
}
