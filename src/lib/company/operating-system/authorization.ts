import { SUEDE_OWNER_PREFIX } from "@/lib/auth";
import { resolveSuedeIdentity } from "@/lib/suede-identity";

export type OperatingSystemAccess =
  | { readonly kind: "authorized"; readonly ownerId: string }
  | { readonly kind: "signed-out" }
  | { readonly kind: "forbidden" };

function allowedOperatorEmails(): ReadonlySet<string> {
  return new Set(
    (process.env.SUEDE_OPERATING_SYSTEM_EMAILS ?? "")
      .split(",")
      .map((value) => value.trim().toLocaleLowerCase())
      .filter((value) => value.length > 0),
  );
}

/**
 * Resolve the internal console boundary from a verified shared-Suede session.
 * The allowlist fails closed when production has not configured the feature.
 */
export async function resolveOperatingSystemAccess(): Promise<OperatingSystemAccess> {
  const identity = await resolveSuedeIdentity();
  if (!identity) return { kind: "signed-out" };
  const email = identity.email?.trim().toLocaleLowerCase() ?? null;
  if (!email || !allowedOperatorEmails().has(email)) return { kind: "forbidden" };
  return {
    kind: "authorized",
    ownerId: `${SUEDE_OWNER_PREFIX}${identity.userId}`,
  };
}
