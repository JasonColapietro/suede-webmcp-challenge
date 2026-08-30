import { resolveOwnerId, UnauthenticatedOwnerError } from "@/lib/auth";

const STRICT_BEARER = /^Bearer ([^\s]+)$/;

export async function resolveVersionReadOwnerId(request: Request): Promise<string> {
  const authorization = request.headers.get("authorization");
  if (authorization === null) return resolveOwnerId();
  const match = STRICT_BEARER.exec(authorization);
  if (!match) throw new UnauthenticatedOwnerError();
  return match[1];
}
