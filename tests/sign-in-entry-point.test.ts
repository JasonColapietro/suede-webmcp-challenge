/**
 * Agent Studio must be able to START a sign-in, not only inherit one.
 *
 * The session is a Supabase cookie on the .suedeai.ai apex written by
 * app.suedeai.ai; this app only reads it (src/lib/suede-identity.ts). That
 * part is deliberate and stays. What was broken until 2026-07-26 is that the
 * handoff link existed on three pages with hardcoded returnTo values and
 * nowhere else, so a visitor on the landing page or a builder URL had no way
 * to sign in and no sign that they were signed out.
 *
 * These lock the entry point in place:
 * - the shared nav renders the control, so it exists on every page using it
 * - the URL shape matches what app.suedeai.ai's returnTo handoff expects
 * - no page hand-rolls the handoff URL anymore (the host stays in one place)
 * - the identity endpoint stays cheap and uncacheable
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_SIGN_IN_RETURN, SUEDE_SIGN_IN_ORIGIN, signInUrl } from "@/lib/sign-in-url";

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("sign-in URL", () => {
  it("targets the handoff origin with an encoded returnTo", () => {
    expect(signInUrl("https://agents.suedeai.ai/flows")).toBe(
      "https://app.suedeai.ai/?returnTo=https%3A%2F%2Fagents.suedeai.ai%2Fflows",
    );
  });

  it("encodes a returnTo that already carries a query string", () => {
    // An unencoded `&` here would silently truncate returnTo on the handoff
    // side and drop the visitor on the wrong page after signing in.
    const url = signInUrl("https://agents.suedeai.ai/build/abc?tab=live&x=1");
    expect(url).toContain("%3Ftab%3Dlive%26x%3D1");
    expect(url.split("returnTo=")).toHaveLength(2);
  });

  it("falls back to the site root when no context is given", () => {
    expect(signInUrl()).toBe(signInUrl(DEFAULT_SIGN_IN_RETURN));
  });
});

describe("sign-in entry point is reachable", () => {
  it("renders the control in the shared nav", () => {
    const nav = read("src/components/site/SiteNav.tsx");
    expect(nav).toContain('import SignInControl from "./SignInControl";');
    expect(nav).toContain("<SignInControl />");
  });

  it("returns the visitor to the page they were on without leaking fragments", () => {
    const control = read("src/components/site/SignInControl.tsx");
    expect(control).toContain("const returnUrl = new URL(window.location.href)");
    expect(control).toContain('returnUrl.hash = ""');
    expect(control).toContain("signInUrl(returnUrl.href)");
    expect(control).not.toContain("signInUrl(window.location.href)");
  });

  it("renders a usable link before the identity fetch resolves", () => {
    // The handoff hard-navigates an already-signed-in visitor straight back,
    // so an un-upgraded link is never a dead end — but it must still exist.
    const control = read("src/components/site/SignInControl.tsx");
    expect(control).toContain(`useState<string>(signInUrl(DEFAULT_SIGN_IN_RETURN))`);
  });

  it("keeps the handoff host in exactly one module", () => {
    for (const path of [
      "src/app/founding/page.tsx",
      "src/app/flows/dashboard.tsx",
      "src/app/company/page.tsx",
      "src/components/site/SignInControl.tsx",
    ]) {
      expect(read(path)).toContain("sign-in-url");
      expect(read(path)).not.toContain("app.suedeai.ai/?returnTo=");
    }
    expect(SUEDE_SIGN_IN_ORIGIN).toBe("https://app.suedeai.ai");
  });
});

describe("/api/identity", () => {
  const route = read("src/app/api/identity/route.ts");

  it("never caches — a shared entry would leak one visitor's email to another", () => {
    expect(route).toContain("no-store");
    expect(route).toContain('export const dynamic = "force-dynamic"');
  });

  it("stays off the database so it can back a nav on every page", () => {
    // /api/me answers a superset but runs nine repo queries. Match imports,
    // not bare words — the file's own comment names both of these.
    expect(route).not.toMatch(/import[^;]*\bgetRepo\b/u);
    expect(route).not.toMatch(/import[^;]*\bresolveOwnerId\b/u);
    expect(route).toMatch(/import\s*\{\s*resolveSuedeIdentity\s*\}/u);
  });

  it("fails closed to signed-out rather than erroring the nav", () => {
    expect(route).toContain("catch");
    expect(route).toContain("let signedIn = false");
  });
});
