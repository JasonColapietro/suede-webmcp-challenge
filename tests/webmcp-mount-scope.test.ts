/**
 * Where the WebMCP storefront is allowed to exist.
 *
 * This is a Google Play containment test, not a styling one. Play treats
 * in-app commerce discovery as a removal-level exposure, and the Android shell
 * loads the same web app — so mounting the registrar globally would put buy
 * tools on every builder page reachable inside the binary. The mitigation is
 * structural (mount on two Play-denied pages only), so it needs a structural
 * pin: the source text of the layout and both pages, plus the actual allowlist
 * predicate the middleware enforces.
 *
 * Plain fs reads in the node environment. No browser, no render.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isGooglePlayAllowedApiPath,
  isGooglePlayAllowedAppPath,
} from "@/lib/google-play-access-only";

const root = process.cwd();
const read = (rel: string): string => readFileSync(join(root, rel), "utf8");

const REGISTRAR = "StorefrontTools";

describe("registrar mount scope", () => {
  it("is NOT mounted in the root layout", () => {
    // A RootLayout mount is the regression this whole test exists to catch.
    expect(read("src/app/layout.tsx")).not.toContain(REGISTRAR);
  });

  it("is mounted on the public directory and the public agent page", () => {
    expect(read("src/app/agents/page.tsx")).toContain(REGISTRAR);
    expect(read("src/app/a/[slug]/page.tsx")).toContain(REGISTRAR);
  });
});

describe("the mount pages are unreachable from the Google Play host", () => {
  it("keeps both storefront pages outside the Play app allowlist", () => {
    expect(isGooglePlayAllowedAppPath("/agents")).toBe(false);
    expect(isGooglePlayAllowedAppPath("/a/contract-review")).toBe(false);
  });

  it("confirms a global mount WOULD have reached the Play WebView", () => {
    // These are the builder paths a RootLayout mount would have covered. If
    // this ever flips to false the containment argument above changes, and the
    // mount decision should be revisited rather than silently inherited.
    for (const path of ["/flows", "/build", "/start", "/templates", "/runs", "/connections"]) {
      expect(isGooglePlayAllowedAppPath(path), path).toBe(true);
    }
  });

  it("keeps the cookie-session spend route off the Play host", () => {
    // Deny-by-default: absent from ALLOWED_API_PATH_PREFIXES means unreachable.
    expect(isGooglePlayAllowedApiPath("/api/webmcp/buy")).toBe(false);
  });
});
