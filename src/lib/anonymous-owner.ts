/**
 * Anonymous workspace ids are bearer secrets minted by `crypto.randomUUID()`.
 * Accept only its canonical lowercase RFC 4122 UUIDv4 representation so the
 * same secret cannot be rotated through alternate spellings or UUID versions.
 */
const CANONICAL_UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isCanonicalAnonymousOwnerId(
  value: string | null | undefined,
): value is string {
  return typeof value === "string" && CANONICAL_UUID_V4.test(value);
}

export function canonicalAnonymousOwnerId(
  value: string | null | undefined,
): string | null {
  return isCanonicalAnonymousOwnerId(value) ? value : null;
}
