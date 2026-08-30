/**
 * Cross-app sign-in entry point.
 *
 * Agent Studio deliberately has no auth stack of its own. The session is a
 * Supabase cookie written at the `.suedeai.ai` apex, and `app.suedeai.ai`
 * owns the sign-in flow (SignInModal + the `?returnTo=` handoff). This app
 * only READS that cookie — see `src/lib/suede-identity.ts`, whose header
 * records why it hand-parses the cookie instead of using `@supabase/ssr`: the
 * two cookie formats on the apex already caused a production outage in
 * Suede-AI-App. A second app writing auth cookies would walk straight back
 * into that, so linking to the handoff IS the whole integration.
 *
 * `agents.suedeai.ai` is already allow-listed on the handoff page with its
 * own headline copy, so no change is needed on the Suede-AI-App side.
 *
 * What was missing until 2026-07-26 was any way to REACH it: the link existed
 * on /founding, /flows and /company with a hardcoded per-page returnTo, and
 * nowhere else — so a visitor on the landing page, a builder URL, or the
 * directory had no way to sign in and no indication they were signed out.
 */
import { SITE_URL } from "./site";

/** Origin that owns the Suede sign-in modal and the returnTo handoff. */
export const SUEDE_SIGN_IN_ORIGIN = "https://app.suedeai.ai";

/** Where to return a visitor who signs in without a more specific context. */
export const DEFAULT_SIGN_IN_RETURN = `${SITE_URL}/`;

/**
 * Build the sign-in URL that returns the visitor to `returnTo` afterwards.
 *
 * Already-signed-in visitors are hard-navigated straight back by the handoff
 * page, so this is safe to render unconditionally — it is never a dead end
 * for someone who already has a session.
 */
export function signInUrl(returnTo: string = DEFAULT_SIGN_IN_RETURN): string {
  return `${SUEDE_SIGN_IN_ORIGIN}/?returnTo=${encodeURIComponent(returnTo)}`;
}
