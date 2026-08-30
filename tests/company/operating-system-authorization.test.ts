import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  identity: null as { userId: string; email: string | null } | null,
}));

vi.mock("@/lib/suede-identity", () => ({
  resolveSuedeIdentity: vi.fn(async () => state.identity),
}));

import { resolveOperatingSystemAccess } from "@/lib/company/operating-system/authorization";

const originalAllowlist = process.env.SUEDE_OPERATING_SYSTEM_EMAILS;

beforeEach(() => {
  state.identity = null;
  delete process.env.SUEDE_OPERATING_SYSTEM_EMAILS;
});

afterEach(() => {
  if (originalAllowlist === undefined) {
    delete process.env.SUEDE_OPERATING_SYSTEM_EMAILS;
  } else {
    process.env.SUEDE_OPERATING_SYSTEM_EMAILS = originalAllowlist;
  }
});

describe("Operating System authorization", () => {
  it("fails closed for a missing session or missing allowlist", async () => {
    expect(await resolveOperatingSystemAccess()).toEqual({ kind: "signed-out" });

    state.identity = { userId: "user-one", email: "operator@suede.test" };
    expect(await resolveOperatingSystemAccess()).toEqual({ kind: "forbidden" });
  });

  it("matches normalized emails and derives the owner only from verified identity", async () => {
    process.env.SUEDE_OPERATING_SYSTEM_EMAILS = " OTHER@SUEDE.TEST, operator@suede.test ";
    state.identity = { userId: "user-one", email: "OPERATOR@SUEDE.TEST" };

    expect(await resolveOperatingSystemAccess()).toEqual({
      kind: "authorized",
      ownerId: "sb:user-one",
    });
  });
});
