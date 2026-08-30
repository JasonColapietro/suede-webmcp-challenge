"use client";

/**
 * Persistent sign-in / account control for the shared nav.
 *
 * Client-side on purpose. SiteNav is a server component rendered on pages
 * that are statically generated; making it async to read the session would
 * turn the whole marketing surface dynamic. So this renders a working
 * sign-in link in the static HTML and upgrades it after hydration:
 *
 * 1. `returnTo` starts as the site root (correct in static HTML, where there
 *    is no current URL yet) and becomes the actual current URL on mount, so
 *    signing in returns you to the page you were on rather than the homepage.
 * 2. The signed-in email is fetched from /api/identity, so a signed-in
 *    visitor sees their account instead of a misleading "Sign in".
 *
 * Rendering the link before the fetch resolves is deliberate: the handoff
 * page hard-navigates an already-signed-in visitor straight back, so an
 * early click is never a dead end.
 */

import { useEffect, useState } from "react";
import { DEFAULT_SIGN_IN_RETURN, SUEDE_SIGN_IN_ORIGIN, signInUrl } from "@/lib/sign-in-url";

interface IdentityState {
  readonly signedIn: boolean;
  readonly email: string | null;
}

function parseIdentity(value: unknown): IdentityState | null {
  if (value === null || typeof value !== "object") return null;
  const signedIn = (value as { signedIn?: unknown }).signedIn;
  const email = (value as { email?: unknown }).email;
  if (typeof signedIn !== "boolean") return null;
  return { signedIn, email: typeof email === "string" ? email : null };
}

export default function SignInControl(): React.JSX.Element {
  const [href, setHref] = useState<string>(signInUrl(DEFAULT_SIGN_IN_RETURN));
  const [identity, setIdentity] = useState<IdentityState | null>(null);

  useEffect(() => {
    const returnUrl = new URL(window.location.href);
    returnUrl.hash = "";
    setHref(signInUrl(returnUrl.href));

    // The identity fetch (and the re-render it triggers) is deferred to idle:
    // it used to fire during hydration on every page, landing its no-store
    // round-trip and state update inside the post-FCP window that TBT
    // measures. Nothing above the fold depends on it — the static "Sign in"
    // link is already correct — so waiting for idle only means a signed-in
    // visitor's email appears a beat later.
    const controller = new AbortController();
    let idleId: number | undefined;
    let timerId: ReturnType<typeof setTimeout> | undefined;
    const loadIdentity = (): void => {
      fetch("/api/identity", {
        cache: "no-store",
        credentials: "include",
        signal: controller.signal,
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((body: unknown) => {
          const parsed = parseIdentity(body);
          if (parsed) setIdentity(parsed);
        })
        .catch(() => {
          // Signed-out is the safe render; the sign-in link is already correct.
        });
    };
    if ("requestIdleCallback" in window) {
      idleId = window.requestIdleCallback(loadIdentity, { timeout: 3000 });
    } else {
      timerId = setTimeout(loadIdentity, 1500);
    }
    return () => {
      if (idleId !== undefined) window.cancelIdleCallback(idleId);
      if (timerId !== undefined) clearTimeout(timerId);
      controller.abort();
    };
  }, []);

  if (identity?.signedIn) {
    return (
      <a
        className="lp-nav-account"
        href={`${SUEDE_SIGN_IN_ORIGIN}/profile`}
        title={identity.email ?? "Your Suede account"}
      >
        <span className="sr-only">Your Suede account: </span>
        {identity.email ?? "Account"}
      </a>
    );
  }

  return (
    <a className="lp-nav-account" href={href}>
      Sign in
    </a>
  );
}
