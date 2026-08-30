/**
 * Tests for src/lib/auth.ts — resolveOwnerId().
 *
 * The regression under test: in production, a request that reaches
 * resolveOwnerId() with neither the `x-owner-id` header nor the `agx_owner`
 * cookie set (i.e. the owner middleware was somehow bypassed) must never
 * silently pool onto the shared "dev-user" identity. It must fail closed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const headersGet = vi.fn<(key: string) => string | null>();
const cookiesGet = vi.fn<(key: string) => { value: string } | undefined>();
const resolveIdentity = vi.fn<() => Promise<{ userId: string; email: string | null } | null>>();
const adoptOwner = vi.fn();
const HEADER_OWNER = "1c1f7a1e-0000-4000-8000-000000000001";
const COOKIE_OWNER = "1c1f7a1e-0000-4000-8000-000000000002";

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

vi.mock("next/headers", () => ({
  headers: async () => ({ get: (k: string) => headersGet(k) }),
  cookies: async () => ({ get: (k: string) => cookiesGet(k) }),
}));

vi.mock("@/lib/suede-identity", () => ({
  resolveSuedeIdentity: () => resolveIdentity(),
}));

vi.mock("@/lib/db/repo", () => ({
  getRepo: async () => ({ adoptOwner }),
}));

import {
  adoptAnonymousWorkspaceForVerifiedOwner,
  adoptAnonymousWorkspaceForVerifiedOwnerOrThrow,
  resolveOwnerId,
  resolveReadOnlyOwnerId,
  UnauthenticatedOwnerError,
} from "@/lib/auth";

describe("resolveOwnerId", () => {
  beforeEach(() => {
    headersGet.mockReset().mockReturnValue(null);
    cookiesGet.mockReset().mockReturnValue(undefined);
    resolveIdentity.mockReset().mockResolvedValue(null);
    adoptOwner.mockReset();
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the x-owner-id header when present", async () => {
    headersGet.mockImplementation((k) => (k === "x-owner-id" ? "header-owner" : null));
    expect(await resolveOwnerId()).toBe("header-owner");
  });

  it("falls back to the agx_owner cookie when no header is present", async () => {
    cookiesGet.mockImplementation((k) => (k === "agx_owner" ? { value: "cookie-owner" } : undefined));
    expect(await resolveOwnerId()).toBe("cookie-owner");
  });

  it("header wins over cookie when both are present", async () => {
    headersGet.mockImplementation((k) => (k === "x-owner-id" ? "header-owner" : null));
    cookiesGet.mockImplementation((k) => (k === "agx_owner" ? { value: "cookie-owner" } : undefined));
    expect(await resolveOwnerId()).toBe("header-owner");
  });

  it("outside production: falls back to dev-user when neither header nor cookie is present", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const prevDevOwnerId = process.env.DEV_OWNER_ID;
    delete process.env.DEV_OWNER_ID;
    try {
      expect(await resolveOwnerId()).toBe("dev-user");
    } finally {
      if (prevDevOwnerId !== undefined) process.env.DEV_OWNER_ID = prevDevOwnerId;
    }
  });

  it("outside production: honors a DEV_OWNER_ID override", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEV_OWNER_ID", "my-dev-user");
    expect(await resolveOwnerId()).toBe("my-dev-user");
  });

  it("production: throws UnauthenticatedOwnerError instead of pooling onto a shared identity", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(resolveOwnerId()).rejects.toBeInstanceOf(UnauthenticatedOwnerError);
  });

  it("production: the thrown error carries a 401 status for callers to surface", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(resolveOwnerId()).rejects.toMatchObject({ status: 401 });
  });

  it("production: never falls back to dev-user or DEV_OWNER_ID even if that env var is set", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEV_OWNER_ID", "should-never-be-used");
    await expect(resolveOwnerId()).rejects.toBeInstanceOf(UnauthenticatedOwnerError);
  });

  it("production: a real header still resolves normally (no regression for the legitimate path)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    headersGet.mockImplementation((k) => (k === "x-owner-id" ? HEADER_OWNER : null));
    expect(await resolveOwnerId()).toBe(HEADER_OWNER);
  });

  it("production: a real cookie still resolves normally (no regression for the legitimate path)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    cookiesGet.mockImplementation((k) => (k === "agx_owner" ? { value: COOKIE_OWNER } : undefined));
    expect(await resolveOwnerId()).toBe(COOKIE_OWNER);
  });

  it("production: ignores a malformed header and falls through to a canonical cookie", async () => {
    vi.stubEnv("NODE_ENV", "production");
    headersGet.mockImplementation((k) => (k === "x-owner-id" ? "attacker-controlled" : null));
    cookiesGet.mockImplementation((k) => (k === "agx_owner" ? { value: COOKIE_OWNER } : undefined));
    expect(await resolveOwnerId()).toBe(COOKIE_OWNER);
  });

  it.each(["attacker-controlled", HEADER_OWNER.toUpperCase(), "1c1f7a1e-0000-1000-8000-000000000001"])(
    "production: rejects a non-canonical anonymous owner %j",
    async (candidate) => {
      vi.stubEnv("NODE_ENV", "production");
      headersGet.mockImplementation((k) => (k === "x-owner-id" ? candidate : null));
      await expect(resolveOwnerId()).rejects.toBeInstanceOf(UnauthenticatedOwnerError);
    },
  );

  it("read-only resolution never adopts an anonymous workspace for a verified session", async () => {
    resolveIdentity.mockResolvedValue({ userId: "verified-user", email: "verified@example.test" });
    cookiesGet.mockImplementation((key) => key === "agx_owner" ? { value: "anonymous-workspace" } : undefined);
    expect(await resolveReadOnlyOwnerId()).toBe("sb:verified-user");
    expect(adoptOwner).not.toHaveBeenCalled();
  });

  it("deferred adoption is a no-op for anonymous owners", async () => {
    cookiesGet.mockImplementation((key) => key === "agx_owner" ? { value: "anonymous-workspace" } : undefined);
    await adoptAnonymousWorkspaceForVerifiedOwner("anonymous-owner");
    expect(adoptOwner).not.toHaveBeenCalled();
  });

  it("deferred adoption rejects an sb owner when there is no verified session", async () => {
    cookiesGet.mockImplementation((key) => key === "agx_owner" ? { value: "deferred-anonymous-workspace" } : undefined);
    await adoptAnonymousWorkspaceForVerifiedOwner("sb:deferred-verified-user");
    expect(adoptOwner).not.toHaveBeenCalled();
  });

  it("deferred adoption rejects an sb owner that does not match the verified session", async () => {
    resolveIdentity.mockResolvedValue({ userId: "verified-user", email: "verified@example.test" });
    cookiesGet.mockImplementation((key) => key === "agx_owner" ? { value: "deferred-anonymous-workspace" } : undefined);
    await adoptAnonymousWorkspaceForVerifiedOwner("sb:different-user");
    expect(adoptOwner).not.toHaveBeenCalled();
  });

  it("deferred adoption is a no-op when the cookie already names the verified owner", async () => {
    resolveIdentity.mockResolvedValue({ userId: "same-user", email: "verified@example.test" });
    cookiesGet.mockImplementation((key) => key === "agx_owner" ? { value: "sb:same-user" } : undefined);
    await adoptAnonymousWorkspaceForVerifiedOwner("sb:same-user");
    expect(adoptOwner).not.toHaveBeenCalled();
  });

  it("deferred adoption moves the anonymous workspace only for the exact verified owner", async () => {
    resolveIdentity.mockResolvedValue({ userId: "deferred-verified-user", email: "verified@example.test" });
    cookiesGet.mockImplementation((key) => key === "agx_owner" ? { value: "deferred-anonymous-workspace" } : undefined);
    await adoptAnonymousWorkspaceForVerifiedOwner("sb:deferred-verified-user");
    expect(adoptOwner).toHaveBeenCalledWith("deferred-anonymous-workspace", "sb:deferred-verified-user");
  });

  it("coalesces concurrent adoption for one pair and marks it complete only after success", async () => {
    const adoption = deferred();
    resolveIdentity.mockResolvedValue({ userId: "coalesced-user", email: "verified@example.test" });
    cookiesGet.mockImplementation((key) => key === "agx_owner" ? { value: "coalesced-anonymous-workspace" } : undefined);
    adoptOwner.mockImplementation(() => adoption.promise);

    const first = adoptAnonymousWorkspaceForVerifiedOwner("sb:coalesced-user");
    await vi.waitFor(() => expect(adoptOwner).toHaveBeenCalledOnce());
    const second = adoptAnonymousWorkspaceForVerifiedOwner("sb:coalesced-user");
    let secondSettled = false;
    void second.then(() => { secondSettled = true; });
    await vi.waitFor(() => expect(cookiesGet).toHaveBeenCalledTimes(2));

    expect(adoptOwner).toHaveBeenCalledOnce();
    expect(secondSettled).toBe(false);

    adoption.resolve();
    await Promise.all([first, second]);
    await adoptAnonymousWorkspaceForVerifiedOwner("sb:coalesced-user");
    expect(adoptOwner).toHaveBeenCalledOnce();
  });

  it("clears failed in-flight adoption so every waiter finishes and a later request retries", async () => {
    const adoption = deferred();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    resolveIdentity.mockResolvedValue({ userId: "retry-user", email: "verified@example.test" });
    cookiesGet.mockImplementation((key) => key === "agx_owner" ? { value: "retry-anonymous-workspace" } : undefined);
    adoptOwner.mockImplementationOnce(() => adoption.promise).mockResolvedValueOnce(undefined);

    try {
      const first = adoptAnonymousWorkspaceForVerifiedOwner("sb:retry-user");
      await vi.waitFor(() => expect(adoptOwner).toHaveBeenCalledOnce());
      const second = adoptAnonymousWorkspaceForVerifiedOwner("sb:retry-user");
      await vi.waitFor(() => expect(cookiesGet).toHaveBeenCalledTimes(2));
      adoption.reject(new Error("adoption-canary"));
      await Promise.all([first, second]);

      expect(adoptOwner).toHaveBeenCalledOnce();
      expect(consoleError).toHaveBeenCalledOnce();

      await adoptAnonymousWorkspaceForVerifiedOwner("sb:retry-user");
      expect(adoptOwner).toHaveBeenCalledTimes(2);
      expect(adoptOwner).toHaveBeenLastCalledWith("retry-anonymous-workspace", "sb:retry-user");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("fails the explicit bootstrap mutation closed when adoption persistence fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    resolveIdentity.mockResolvedValue({ userId: "strict-user", email: "verified@example.test" });
    cookiesGet.mockImplementation((key) => key === "agx_owner"
      ? { value: "strict-anonymous-workspace" }
      : undefined);
    adoptOwner.mockRejectedValueOnce(new Error("strict-adoption-canary"));

    try {
      await expect(adoptAnonymousWorkspaceForVerifiedOwnerOrThrow("sb:strict-user"))
        .rejects.toThrow("strict-adoption-canary");
      expect(adoptOwner).toHaveBeenCalledWith("strict-anonymous-workspace", "sb:strict-user");
    } finally {
      consoleError.mockRestore();
    }
  });
});
