import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isReleasedIosShell } from "@/lib/native-shell";
import { safeStudioReturnTo } from "@/lib/studio-auth";
import { SITE_URL } from "@/lib/site";

const source = (path: string): string =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const IOS_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IOS_WKWEBVIEW =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

describe("Studio account return targets", () => {
  it("converts same-origin paths into absolute canonical return targets", () => {
    expect(safeStudioReturnTo("/build/flow-1?tab=live", "/enter")).toBe(
      `${SITE_URL}/build/flow-1?tab=live`,
    );
  });

  it.each([
    "https://attacker.test/x",
    "//attacker.test/x",
    "\\\\attacker.test/x",
  ])("falls back when the target is unsafe: %s", (target) => {
    expect(safeStudioReturnTo(target, "/enter")).toBe(`${SITE_URL}/enter`);
  });
});

describe("released iOS shell", () => {
  it("exempts the bounded WKWebView shape, but not ordinary Safari", () => {
    expect(isReleasedIosShell(IOS_WKWEBVIEW)).toBe(true);
    expect(isReleasedIosShell(IOS_SAFARI)).toBe(false);
  });
});

describe("Studio account guard source boundary", () => {
  it("uses verified identity, strict adoption, and the shared sign-in handoff", () => {
    const auth = source("src/lib/studio-auth.ts");

    expect(auth).toContain("resolveSuedeIdentity");
    expect(auth).toContain("adoptAnonymousWorkspaceForVerifiedOwnerOrThrow");
    expect(auth).toContain("signInUrl");
    expect(auth).not.toContain("isReleasedIosShell");
    expect(auth).not.toContain("resolveOwnerId");
  });
});
