import { adoptAnonymousWorkspaceForVerifiedOwner } from "@/lib/auth";

/**
 * Adopt a verified signed-in owner's anonymous workspace at the connection
 * route boundary. The auth helper re-verifies the ecosystem session and is a
 * no-op for anonymous owners, so a bare `sb:` owner or provider credential can
 * never trigger adoption.
 */
export async function adoptVerifiedConnectionOwner(ownerId: string): Promise<void> {
  await adoptAnonymousWorkspaceForVerifiedOwner(ownerId);
}
