/**
 * Owner identity middleware. Every browser gets a private, httpOnly owner id
 * cookie on first touch — no signup. The id is folded into the `x-owner-id`
 * request header so the very first request (before the cookie round-trips) is
 * already scoped to the new owner. Programmatic callers may send `x-owner-id`
 * directly; a browser cookie always wins over a spoofed header.
 *
 * This file is also where the Google Play access-only runtime is enforced.
 * See src/lib/google-play-access-only.ts for why the Android shell gets its
 * own host and what is denied on it.
 */
import { NextResponse, type NextRequest } from "next/server";
import {
  isGooglePlayAccessOnlyHost,
  isGooglePlayAllowedApiPath,
  isGooglePlayAllowedAppPath,
  isGooglePlayBlockedCommerceDiscoveryPath,
  isGooglePlayBlockedPaymentPath,
  isGooglePlayBlockedResourceMutation,
  isGooglePlayInfrastructurePath,
  sanitizeGooglePlaySearchParams,
  GOOGLE_PLAY_HOME_PATH,
} from "@/lib/google-play-access-only";
import { canonicalAnonymousOwnerId } from "@/lib/anonymous-owner";
import { isReleasedIosShell, REQUEST_TARGET_HEADER } from "@/lib/native-shell";

const OWNER_COOKIE = "agx_owner";
const ONE_YEAR_S = 60 * 60 * 24 * 365;

/** Files served straight out of public/ (images, fonts). Never commerce. */
const STATIC_ASSET_PATH = /\.(png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|css|js|map)$/i;

function withGooglePlayNoIndex(response: NextResponse): NextResponse {
  response.headers.set("X-Robots-Tag", "noindex, nofollow");
  return response;
}

function googlePlayDenied(message: string): NextResponse {
  return withGooglePlayNoIndex(
    NextResponse.json(
      { error: message },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    ),
  );
}

/**
 * Everything denied here is denied because it is a way to pay for, or to
 * discover how to pay for, digital content inside a Play-distributed binary.
 * Returns null when the request is not on the Play host or is permitted.
 */
function enforceGooglePlayAccessOnly(
  request: NextRequest,
): NextResponse | null {
  const { pathname } = request.nextUrl;

  if (isGooglePlayBlockedPaymentPath(pathname)) {
    return googlePlayDenied(
      "Purchases are unavailable in this Google Play build.",
    );
  }

  if (isGooglePlayBlockedCommerceDiscoveryPath(pathname)) {
    return googlePlayDenied(
      "Commerce discovery is unavailable in this Google Play build.",
    );
  }

  if (isGooglePlayBlockedResourceMutation(pathname, request.method)) {
    return googlePlayDenied(
      "This endpoint is unavailable in this Google Play build.",
    );
  }

  if (isGooglePlayInfrastructurePath(pathname) || STATIC_ASSET_PATH.test(pathname)) {
    return null;
  }

  // Strip purchase intent and unsafe return destinations from the query
  // before anything renders. A redirect (not a rewrite) so the address the
  // WebView holds is the sanitized one.
  const target = request.nextUrl.clone();
  const { changed } = sanitizeGooglePlaySearchParams(target.searchParams);
  if (changed) {
    return withGooglePlayNoIndex(NextResponse.redirect(target, 307));
  }

  if (pathname.startsWith("/api/")) {
    if (isGooglePlayAllowedApiPath(pathname)) return null;
    return googlePlayDenied("This endpoint is unavailable in this Google Play build.");
  }

  if (!isGooglePlayAllowedAppPath(pathname)) {
    const home = request.nextUrl.clone();
    home.pathname = GOOGLE_PLAY_HOME_PATH;
    home.search = "";
    return withGooglePlayNoIndex(NextResponse.redirect(home, 307));
  }

  return null;
}

export function middleware(request: NextRequest): NextResponse {
  const isGooglePlayAccessOnly = isGooglePlayAccessOnlyHost(
    request.headers.get("host"),
  );

  if (isGooglePlayAccessOnly) {
    const denial = enforceGooglePlayAccessOnly(request);
    if (denial) return denial;
  }

  // The claim endpoint owns its Set-Cookie; don't mint a fresh id over it.
  if (request.nextUrl.pathname === "/api/me/claim") {
    return NextResponse.next();
  }

  if (
    request.nextUrl.pathname === "/"
    && isReleasedIosShell(request.headers.get("user-agent"))
  ) {
    const flows = request.nextUrl.clone();
    flows.pathname = "/flows";
    flows.search = "";
    return NextResponse.redirect(flows, 307);
  }

  const fromCookie = canonicalAnonymousOwnerId(request.cookies.get(OWNER_COOKIE)?.value);
  const fromHeader = canonicalAnonymousOwnerId(request.headers.get("x-owner-id"));
  const owner = fromCookie ?? fromHeader ?? crypto.randomUUID();

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(
    REQUEST_TARGET_HEADER,
    `${request.nextUrl.pathname}${request.nextUrl.search}`,
  );
  requestHeaders.set("x-owner-id", owner);

  const response = NextResponse.next({ request: { headers: requestHeaders } });

  if (fromCookie === null) {
    response.cookies.set({
      name: OWNER_COOKIE,
      value: owner,
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: ONE_YEAR_S,
    });
  }
  return isGooglePlayAccessOnly ? withGooglePlayNoIndex(response) : response;
}

export const config = {
  /*
   * Everything except Next internals and static assets.
   *
   * `llms.txt` used to be excluded here. It is a static file in public/ that
   * advertises this studio's paid agent endpoints, so leaving it out of the
   * matcher would have made it the one commerce-discovery surface the Play
   * gate below could not reach. It is matched now and denied on the Play
   * host; on every other host the only change is that it, like every other
   * matched path, mints the anonymous owner cookie.
   */
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico).*)"],
};
