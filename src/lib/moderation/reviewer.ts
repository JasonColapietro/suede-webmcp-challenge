import { resolveSuedeIdentity } from "@/lib/suede-identity";

function allowedReviewerEmails(): ReadonlySet<string> {
  return new Set(
    (process.env.MODERATION_REVIEWER_EMAILS ?? "")
      .split(",")
      .map((value) => value.trim().toLocaleLowerCase())
      .filter((value) => value.length > 0),
  );
}

/** Verified shared-Suede identity gated by an explicit production allowlist. */
export async function resolveModerationReviewer(): Promise<string | null> {
  const identity = await resolveSuedeIdentity();
  const email = identity?.email?.trim().toLocaleLowerCase() ?? null;
  if (!email || !allowedReviewerEmails().has(email)) return null;
  return email;
}
