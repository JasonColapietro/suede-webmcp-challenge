/**
 * PostHog client, lazy-loaded off the critical path.
 *
 * posthog-js is ~217KB of script that used to sit in the shared first-load
 * bundle (statically imported here and re-exported through every page that
 * tracks an event), where its parse + eval cost landed inside the Lighthouse
 * TBT window on every route. It is now pulled in via a dynamic import that is
 * scheduled behind requestIdleCallback, so the chunk downloads and evaluates
 * after hydration has settled. Events captured before the client is ready are
 * queued and flushed on load; nothing is dropped.
 *
 * Usage (client components only):
 *   import { capture } from "@/lib/posthog";
 *   capture("event_name", { key: "value" });
 *
 * initPosthog() stays idempotent and is still driven from PostHogProvider's
 * useEffect rather than module-eval time: posthog.init() mutates the live DOM,
 * and doing that before hydration finishes corrupts the tree React is
 * reconciling against, producing hydration mismatches on unrelated nodes.
 */
import type { PostHog } from "posthog-js";

const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY ?? "";
const POSTHOG_HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com";
const PROSPECT_LENS_PATH = "/company/operations/prospect";

let client: PostHog | null = null;
let loadStarted = false;
const pending: Array<{ name: string; properties: Record<string, unknown> }> = [];

/** Run `fn` when the main thread is quiet (bounded, so events still flush
 * promptly on busy pages or browsers without requestIdleCallback). */
function whenIdle(fn: () => void): void {
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(() => fn(), { timeout: 3000 });
  } else {
    window.setTimeout(fn, 300);
  }
}

/** Idempotent; safe to call from every effect that needs PostHog ready. */
export function initPosthog(): void {
  if (typeof window === "undefined" || !POSTHOG_KEY || loadStarted) return;
  loadStarted = true;
  whenIdle(() => {
    import("posthog-js")
      .then(({ default: posthog }) => {
        if (!posthog.__loaded) {
          posthog.init(POSTHOG_KEY, {
            api_host: POSTHOG_HOST,
            // Pageviews are captured manually via the PostHogProvider router hook.
            capture_pageview: false,
            // Prospect Lens contains local-only evidence and generated drafts.
            autocapture: {
              url_ignorelist: [new RegExp(`${PROSPECT_LENS_PATH}(?:[/?#]|$)`)],
            },
            // Fragments may carry bounded client handoffs and never belong in events.
            disable_capture_url_hashes: true,
            // Respect Do Not Track.
            respect_dnt: true,
            // Don't capture individual session recordings by default.
            disable_session_recording: true,
            // Persistence: local storage is fine for a SaaS tool.
            persistence: "localStorage+cookie",
          });
        }
        client = posthog;
        for (const event of pending.splice(0)) {
          client.capture(event.name, event.properties);
        }
      })
      .catch(() => {
        // Analytics must never break the page.
      });
  });
}

/** Capture an event, queueing it until the lazy client has loaded. */
export function capture(
  name: string,
  properties: Record<string, unknown> = {},
): void {
  if (typeof window === "undefined" || !POSTHOG_KEY) return;
  initPosthog();
  if (client) {
    client.capture(name, properties);
  } else {
    pending.push({ name, properties });
  }
}
