/**
 * Shared request-auth checks for the site-agent routes (/api/site-agent and
 * /api/site-agent/verify): a Bearer workspace key for programmatic callers,
 * or a cookie session that must prove exact same-origin JSON. Extracted
 * from the /api/guided pattern rather than importing it, so the guided
 * route's contract stays self-contained.
 */

export function extractBearer(authHeader: string | null): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const key = authHeader.slice(7).trim();
  return key.length > 0 ? key : null;
}

/**
 * Cookie-authenticated mutations must prove exact same-origin JSON.
 * Returns the failing status (403 cross-origin, 415 wrong media type) or
 * null when the request passes.
 */
export function validateSessionMutation(request: Request): 403 | 415 | null {
  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(request.url).origin;
  } catch {
    return 403;
  }
  if (request.headers.get("origin") !== expectedOrigin) return 403;
  if (request.headers.get("sec-fetch-site") !== "same-origin") return 403;
  if (request.headers.has("content-encoding")) return 415;
  const contentType = request.headers.get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  return contentType === "application/json" ? null : 415;
}
