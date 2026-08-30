import { describe, expect, it } from "vitest";
import {
  canonicalAnonymousOwnerId,
  isCanonicalAnonymousOwnerId,
} from "@/lib/anonymous-owner";

const CANONICAL = "1c1f7a1e-0000-4000-8000-000000000001";

describe("canonical anonymous owner ids", () => {
  it("accepts only the exact lowercase RFC 4122 UUIDv4 form minted by randomUUID", () => {
    expect(isCanonicalAnonymousOwnerId(CANONICAL)).toBe(true);
    expect(canonicalAnonymousOwnerId(CANONICAL)).toBe(CANONICAL);
  });

  it.each([
    undefined,
    null,
    "",
    ` ${CANONICAL}`,
    `${CANONICAL} `,
    CANONICAL.toUpperCase(),
    "1c1f7a1e-0000-1000-8000-000000000001",
    "1c1f7a1e-0000-4000-7000-000000000001",
    "00000000-0000-0000-0000-000000000000",
    `sb:${CANONICAL}`,
  ])("rejects non-canonical owner value %j", (candidate) => {
    expect(isCanonicalAnonymousOwnerId(candidate)).toBe(false);
    expect(canonicalAnonymousOwnerId(candidate)).toBeNull();
  });
});
