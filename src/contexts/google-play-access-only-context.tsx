"use client";

/**
 * Client-side view of the Google Play access-only runtime.
 *
 * Middleware already denies every payment and commerce-discovery route on the
 * Play host, so this is not the security boundary — it is the reason a user
 * never sees a control that would only fail. Purchase affordances are hidden
 * on that host and left completely intact on the web and iOS builds.
 */

import { createContext, useContext, type ReactNode } from "react";

const GooglePlayAccessOnlyContext = createContext(false);

export function GooglePlayAccessOnlyProvider({
  enabled,
  children,
}: {
  enabled: boolean;
  children: ReactNode;
}) {
  return (
    <GooglePlayAccessOnlyContext.Provider value={enabled}>
      {children}
    </GooglePlayAccessOnlyContext.Provider>
  );
}

export function useGooglePlayAccessOnly(): boolean {
  return useContext(GooglePlayAccessOnlyContext);
}
