/**
 * Owner resolution. Precedence:
 *
 * 1. A verified Suede ecosystem session (shared Supabase project cookie on
 *    the .suedeai.ai apex) — ownerId becomes `sb:<auth.users id>`, the same
 *    person as their Social/Muse account. On first authenticated touch, any
 *    anonymous `agx_owner` workspace this browser holds is adopted (rows
 *    re-owned) into the signed-in identity.
 * 2. The `x-owner-id` header — middleware folds the per-browser `agx_owner`
 *    cookie into it; programmatic callers (tests, agents) send it themselves.
 *    Anonymous owner ids double as bearer-style tokens: unguessable UUIDs,
 *    never listed publicly.
 * 3. The `agx_owner` cookie directly, then the dev fallback (dev only).
 *
 * SECURITY INVARIANT: `sb:`-prefixed owner ids are ONLY ever derived from a
 * verified session (step 1). They are rejected as bare header/cookie values,
 * because Supabase user ids are not secrets (they surface across the Suede
 * ecosystem) — accepting them as bearer tokens would let anyone claim any
 * signed-in user's workspace. pickAnonymousOwner enforces this at the single
 * dispatch point every route flows through.
 */
import { cookies, headers } from "next/headers";
import { resolveSuedeIdentity } from "./suede-identity";
import { getRepo } from "./db/repo";
import { canonicalAnonymousOwnerId } from "./anonymous-owner";

const OWNER_COOKIE = "agx_owner";

/** Namespace for ecosystem-authenticated owners. See SECURITY INVARIANT above. */
export const SUEDE_OWNER_PREFIX = "sb:";

/**
 * Thrown by resolveOwnerId() in production when neither the `x-owner-id`
 * header nor the `agx_owner` cookie is present. `status` mirrors the
 * RelayError pattern (src/lib/relay.ts) so callers with a generic catch
 * block can surface the right HTTP status by checking `error.status`.
 */
export class UnauthenticatedOwnerError extends Error {
  public readonly status = 401;

  constructor() {
    super("Authentication required");
    this.name = "UnauthenticatedOwnerError";
  }
}

// Per-instance dedupe so the idempotent adopt UPDATE doesn't run on every
// request. Cross-instance repeats are harmless (same UPDATE, same result).
// In-flight work is tracked separately: a pair is complete only after its
// repository transaction succeeds, and concurrent callers await that work.
const ADOPTION_STATE_MAX = 1000;
const completedAdoptions = new Set<string>();
const inFlightAdoptions = new Map<string, Promise<void>>();

function rememberCompletedAdoption(key: string): void {
  if (completedAdoptions.size >= ADOPTION_STATE_MAX) completedAdoptions.clear();
  completedAdoptions.add(key);
}

async function runAdoption(key: string, anonymousOwner: string, owner: string): Promise<void> {
  const repo = await getRepo();
  await repo.adoptOwner(anonymousOwner, owner);
  rememberCompletedAdoption(key);
}

function beginAdoption(key: string, anonymousOwner: string, owner: string): Promise<void> {
  const operation = runAdoption(key, anonymousOwner, owner).catch((error: unknown) => {
    console.error("[auth] workspace adopt failed (will retry):", error);
    throw error;
  });
  inFlightAdoptions.set(key, operation);
  const cleanup = (): void => {
    if (inFlightAdoptions.get(key) === operation) inFlightAdoptions.delete(key);
  };
  void operation.then(cleanup, cleanup);
  return operation;
}

/**
 * Pure precedence for the anonymous path (exported for tests): a canonical
 * UUIDv4 header wins over a canonical cookie. Alternate UUID spellings,
 * UUID versions, arbitrary strings, and `sb:` values are rejected.
 */
export function pickAnonymousOwner(
  fromHeader: string | null,
  fromCookie: string | undefined,
): string | null {
  return canonicalAnonymousOwnerId(fromHeader) ?? canonicalAnonymousOwnerId(fromCookie);
}

/** Preserve non-production test fixtures without weakening a deployed boundary. */
function pickTestOwner(fromHeader: string | null, fromCookie: string | undefined): string | null {
  if (process.env.NODE_ENV !== "test") return null;
  if (fromHeader && !fromHeader.startsWith(SUEDE_OWNER_PREFIX)) return fromHeader;
  if (fromCookie && !fromCookie.startsWith(SUEDE_OWNER_PREFIX)) return fromCookie;
  return null;
}

export async function resolveOwnerId(): Promise<string> {
  const identity = await resolveSuedeIdentity();
  if (identity) {
    const owner = SUEDE_OWNER_PREFIX + identity.userId;
    await adoptAnonymousWorkspace(owner);
    return owner;
  }

  const h = await headers();
  const c = await cookies();
  const fromHeader = h.get("x-owner-id");
  const fromCookie = c.get(OWNER_COOKIE)?.value;
  const anonymous = pickAnonymousOwner(fromHeader, fromCookie) ?? pickTestOwner(fromHeader, fromCookie);
  if (anonymous) return anonymous;

  // No identity on the request at all. In production this must never
  // silently pool the caller onto a shared "dev-user" identity — that would
  // let any route that bypasses the owner middleware (a bug, a new route
  // that forgets it, a misconfigured matcher) leak every such caller's data
  // into one account. The middleware (src/middleware.ts) sets `x-owner-id`
  // on every request it matches, so a legitimate production request should
  // never reach this branch; if it does, fail closed.
  if (process.env.NODE_ENV === "production") {
    throw new UnauthenticatedOwnerError();
  }
  return process.env.DEV_OWNER_ID ?? "dev-user";
}

/** Verified owner resolution for read-only APIs; never adopts or rewrites rows. */
export async function resolveReadOnlyOwnerId(): Promise<string> {
  const identity = await resolveSuedeIdentity();
  if (identity) return SUEDE_OWNER_PREFIX + identity.userId;
  const h = await headers();
  const c = await cookies();
  const fromHeader = h.get("x-owner-id");
  const fromCookie = c.get(OWNER_COOKIE)?.value;
  const anonymous = pickAnonymousOwner(fromHeader, fromCookie) ?? pickTestOwner(fromHeader, fromCookie);
  if (anonymous) return anonymous;
  if (process.env.NODE_ENV === "production") throw new UnauthenticatedOwnerError();
  return process.env.DEV_OWNER_ID ?? "dev-user";
}

/**
 * Re-own this browser's anonymous workspace under the signed-in identity.
 * Also covers /api/me/claim while signed in: pasting a workspace key sets the
 * cookie, and the next request folds that workspace into the account.
 * Never blocks the request — a failed adopt retries on a later request.
 */
async function adoptAnonymousWorkspaceExact(owner: string): Promise<void> {
  const c = await cookies();
  const cookieOwner = c.get(OWNER_COOKIE)?.value;
  const anon = pickAnonymousOwner(null, cookieOwner) ?? pickTestOwner(null, cookieOwner);
  if (!anon || anon === owner) return;
  const key = `${owner}|${anon}`;
  while (true) {
    if (completedAdoptions.has(key)) return;
    const existing = inFlightAdoptions.get(key);
    if (existing) {
      await existing;
      return;
    }
    if (inFlightAdoptions.size < ADOPTION_STATE_MAX) {
      await beginAdoption(key, anon, owner);
      return;
    }
    const oldest = inFlightAdoptions.values().next().value;
    if (oldest) await oldest;
  }
}

async function adoptAnonymousWorkspace(owner: string): Promise<void> {
  try {
    await adoptAnonymousWorkspaceExact(owner);
  } catch { /* best-effort legacy mutation path retries on a later request */ }
}

/**
 * Perform the optional signed-in workspace adoption after a route has made
 * its own fail-closed storage checks. Callers must pass an owner returned by
 * one of the verified owner resolvers; bare `sb:` values are never accepted
 * from request headers or cookies by those resolvers.
 */
export async function adoptAnonymousWorkspaceForVerifiedOwner(owner: string): Promise<void> {
  if (!owner.startsWith(SUEDE_OWNER_PREFIX)) return;
  const identity = await resolveSuedeIdentity();
  if (!identity || owner !== SUEDE_OWNER_PREFIX + identity.userId) return;
  await adoptAnonymousWorkspace(owner);
}

/**
 * Explicit bootstrap mutation for a signed-in browser. Unlike the legacy
 * best-effort resolver hook, this fails closed so no owner read can race ahead
 * of an incomplete workspace adoption.
 */
export async function adoptAnonymousWorkspaceForVerifiedOwnerOrThrow(owner: string): Promise<void> {
  if (!owner.startsWith(SUEDE_OWNER_PREFIX)) return;
  const identity = await resolveSuedeIdentity();
  if (!identity || owner !== SUEDE_OWNER_PREFIX + identity.userId) {
    throw new UnauthenticatedOwnerError();
  }
  await adoptAnonymousWorkspaceExact(owner);
}
