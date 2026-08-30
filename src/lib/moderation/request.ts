/** Same-origin JSON boundary for cookie/anonymous-workspace browser mutations. */
export function validateModerationMutation(request: Request): 403 | 415 | null {
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
    .toLocaleLowerCase();
  return contentType === "application/json" ? null : 415;
}
