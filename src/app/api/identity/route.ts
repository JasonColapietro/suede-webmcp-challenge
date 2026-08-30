/**
 * GET /api/identity — is this browser signed in to Suede, and as whom.
 *
 * Backs the nav's sign-in control. Deliberately minimal: it resolves the
 * shared Suede session cookie and nothing else. It does NOT call
 * resolveOwnerId() and touches no database, because the nav renders on every
 * page — /api/me answers a superset of this but runs nine repo queries, which
 * is not something to put behind a nav on a static marketing page.
 *
 * Fails closed: any problem resolving the identity reports signed-out rather
 * than erroring, so a nav control can never break a page. Never cached — a
 * shared cache entry here would show one visitor's email to another.
 */
import { NextResponse } from "next/server";
import { resolveSuedeIdentity } from "@/lib/suede-identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  let signedIn = false;
  let email: string | null = null;
  try {
    const identity = await resolveSuedeIdentity();
    if (identity) {
      signedIn = true;
      email = identity.email;
    }
  } catch {
    // Fail closed to signed-out; the sign-in link still works.
  }
  return NextResponse.json(
    { signedIn, email },
    { headers: { "cache-control": "no-store, private" } },
  );
}
