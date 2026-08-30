import { describe, expect, it } from "vitest";
import { assembleCookieValue, extractAccessToken } from "@/lib/suede-identity";
import { pickAnonymousOwner, SUEDE_OWNER_PREFIX } from "@/lib/auth";

describe("extractAccessToken", () => {
  it("reads the auth-helpers JSON-tuple format Social's browser writes", () => {
    const raw = encodeURIComponent(JSON.stringify(["access-jwt", "refresh-jwt", null, null]));
    expect(extractAccessToken(raw)).toBe("access-jwt");
  });

  it("reads the un-encoded JSON-tuple format", () => {
    expect(extractAccessToken(JSON.stringify(["tok", "ref"]))).toBe("tok");
  });

  it("reads the @supabase/ssr base64 object format", () => {
    const payload = Buffer.from(
      JSON.stringify({ access_token: "ssr-jwt", refresh_token: "r" }),
      "utf8",
    ).toString("base64url");
    expect(extractAccessToken(`base64-${payload}`)).toBe("ssr-jwt");
  });

  it("fails closed on garbage, empty tuples, and objects without a token", () => {
    expect(extractAccessToken("not json at all")).toBeNull();
    expect(extractAccessToken(encodeURIComponent(JSON.stringify([])))).toBeNull();
    expect(extractAccessToken(encodeURIComponent(JSON.stringify([""])))).toBeNull();
    expect(extractAccessToken(encodeURIComponent(JSON.stringify({ foo: 1 })))).toBeNull();
    expect(extractAccessToken("base64-%%%%")).toBeNull();
  });
});

describe("assembleCookieValue", () => {
  it("prefers the whole cookie when present", () => {
    const jar: Record<string, string> = { "sb-x-auth-token": "whole" };
    expect(assembleCookieValue((n) => jar[n], "sb-x-auth-token")).toBe("whole");
  });

  it("reassembles chunked cookies in order", () => {
    const jar: Record<string, string> = {
      "sb-x-auth-token.0": "part-a",
      "sb-x-auth-token.1": "part-b",
    };
    expect(assembleCookieValue((n) => jar[n], "sb-x-auth-token")).toBe("part-apart-b");
  });

  it("returns null when nothing is set", () => {
    expect(assembleCookieValue(() => undefined, "sb-x-auth-token")).toBeNull();
  });
});

describe("pickAnonymousOwner — sb: namespace is never a bearer token", () => {
  const uuid = "1c1f7a1e-0000-4000-8000-000000000001";

  it("accepts a normal header owner id (programmatic callers)", () => {
    expect(pickAnonymousOwner(uuid, undefined)).toBe(uuid);
  });

  it("accepts a normal cookie owner id when no header is present", () => {
    expect(pickAnonymousOwner(null, uuid)).toBe(uuid);
  });

  it("rejects sb:-prefixed values from the header — a Supabase user id is not a secret", () => {
    expect(pickAnonymousOwner(`${SUEDE_OWNER_PREFIX}${uuid}`, undefined)).toBeNull();
  });

  it("rejects sb:-prefixed values from the cookie", () => {
    expect(pickAnonymousOwner(null, `${SUEDE_OWNER_PREFIX}${uuid}`)).toBeNull();
  });

  it("falls through a spoofed sb: header to a legitimate anonymous cookie", () => {
    expect(pickAnonymousOwner(`${SUEDE_OWNER_PREFIX}${uuid}`, uuid)).toBe(uuid);
  });

  it("returns null when both channels are sb:-spoofed (caller fails closed)", () => {
    expect(
      pickAnonymousOwner(`${SUEDE_OWNER_PREFIX}a`, `${SUEDE_OWNER_PREFIX}b`),
    ).toBeNull();
  });
});
