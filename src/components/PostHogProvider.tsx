"use client";

/**
 * PostHog pageview tracker.
 *
 * Fires a manual pageview on every Next.js route change (capture_pageview is
 * disabled in the posthog.init config; we control timing so the page title is
 * already updated before the event fires). The posthog-js bundle itself is
 * lazy-loaded off the critical path (see src/lib/posthog.ts), and events
 * fired before it arrives are queued there, so nothing statically imports
 * posthog-js into the shared first-load bundle. The react context wrapper
 * (posthog-js/react) was dropped for the same reason: nothing in the app
 * consumes usePostHog(), and the provider alone pinned the full library into
 * every page's JS.
 */
import { Suspense, useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { capture, initPosthog } from "@/lib/posthog";

const PROSPECT_LENS_PATH = "/company/operations/prospect";

function PostHogPageview(): null {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!pathname) return;
    if (
      pathname === PROSPECT_LENS_PATH ||
      pathname.startsWith(`${PROSPECT_LENS_PATH}/`)
    ) {
      return;
    }
    // init() first (no-op after the first call) so this never races init.
    initPosthog();
    const url =
      searchParams.toString()
        ? `${pathname}?${searchParams.toString()}`
        : pathname;
    capture("$pageview", { $current_url: url });
  }, [pathname, searchParams]);

  return null;
}

export default function PostHogProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <>
      <Suspense fallback={null}>
        <PostHogPageview />
      </Suspense>
      {children}
    </>
  );
}
