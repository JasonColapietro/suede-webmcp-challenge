/**
 * Thin analytics wrapper — routes to PostHog, with optional Segment /
 * Mixpanel window globals as secondary sinks.
 *
 * Safe no-op on the server (SSR guard at top of function).
 *
 * Usage (client components only):
 *   import { trackEvent } from "@/lib/analytics";
 *   trackEvent("agentix_studio_cta_clicked", { weak_pillar: "Traction" });
 */
import { capture } from "@/lib/posthog";

export function trackEvent(name: string, properties?: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  try {
    // PostHog — primary sink (lazy-loaded; events queue until it arrives)
    capture(name, properties ?? {});

    // Segment — secondary sink (optional, only if loaded externally)
    // @ts-expect-error external global optional
    if (window.analytics?.track) {
      // @ts-expect-error external global optional
      window.analytics.track(name, properties ?? {});
    }

    // Mixpanel — secondary sink (optional, only if loaded externally)
    // @ts-expect-error external global optional
    if (window.mixpanel?.track) {
      // @ts-expect-error external global optional
      window.mixpanel.track(name, properties ?? {});
    }
  } catch {
    // swallow — never break UI for analytics
  }
}
