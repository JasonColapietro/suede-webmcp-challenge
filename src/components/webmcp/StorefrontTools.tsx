"use client";

/**
 * Registers the WebMCP storefront tools on the page an agent is standing on.
 *
 * PAGE-SCOPED ON PURPOSE — do not move this to RootLayout. A global mount would
 * register commerce tools on /flows, /build, /start, /templates, /runs and
 * /connections, which are exactly the paths ALLOWED_APP_PATH_PREFIXES makes
 * reachable inside the Google Play WebView. Play treats in-app commerce
 * discovery as a removal-level exposure. /agents and /a/<slug> are absent from
 * that allowlist and therefore unreachable from the Play host, which is why
 * they are the only two mounts. tests/webmcp-mount-scope.test.ts pins this.
 *
 * The component holds nothing but namespace resolution, registration, and
 * same-origin fetches. All authority stays server-side: it re-checks no gate,
 * recomputes no price, and passes no `exposedTo`, so the tools default to
 * same-origin visibility only. It imports types only, so no engine, viem or
 * node:crypto reaches the browser bundle.
 */
import { useEffect } from "react";
import { clampText, resolveModelContext, WEBMCP_BUDGETS } from "@/lib/webmcp/protocol";
import type { WebMcpToolDescriptor, WebMcpExecuteContext } from "@/lib/webmcp/protocol";
import { parseShelf, type ShelfEntry } from "@/lib/webmcp/shelf-contract";
import {
  formatServiceDetail,
  formatServiceList,
  matchServices,
  storefrontToolSpecs,
  WEBMCP_TOOL_NAMES,
} from "@/lib/webmcp/storefront";

/** Read the Suede-curated shelf. Same-origin, so the session cookie rides along. */
async function loadShelf(signal: AbortSignal): Promise<readonly ShelfEntry[] | string> {
  const response = await fetch("/api/services", {
    signal,
    headers: { accept: "application/json" },
  });
  if (!response.ok) return "The Suede shelf is unavailable right now.";
  const parsed = parseShelf(await response.json());
  return parsed.ok ? parsed.shelf.services : parsed.reason;
}

function findEntry(
  entries: readonly ShelfEntry[],
  slug: unknown,
): ShelfEntry | undefined {
  return typeof slug === "string"
    ? entries.find((entry) => entry.slug === slug)
    : undefined;
}

function unknownSlug(slug: unknown): string {
  return `No service with slug ${JSON.stringify(slug)}. Call ${WEBMCP_TOOL_NAMES.find} first.`;
}

/** Post JSON same-origin and render the reply inside the output budget. */
async function postJson(
  url: string,
  body: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(url, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const payload: unknown = await response.json().catch(() => null);
  const text =
    payload !== null && typeof payload === "object"
      ? JSON.stringify(payload)
      : `HTTP ${response.status}`;
  return clampText(text, WEBMCP_BUDGETS.toolOutput);
}

function buildDescriptors(): readonly WebMcpToolDescriptor[] {
  const specs = storefrontToolSpecs();
  const executors: Record<
    string,
    (input: Readonly<Record<string, unknown>>, context: WebMcpExecuteContext) => Promise<string>
  > = {
    [WEBMCP_TOOL_NAMES.find]: async (input, { signal }) => {
      const shelf = await loadShelf(signal);
      if (typeof shelf === "string") return shelf;
      const need = typeof input.need === "string" ? input.need : "";
      const limit = typeof input.limit === "number" ? input.limit : 5;
      const matched = matchServices(shelf, need, limit);
      return formatServiceList(matched, shelf.length);
    },

    [WEBMCP_TOOL_NAMES.get]: async (input, { signal }) => {
      const shelf = await loadShelf(signal);
      if (typeof shelf === "string") return shelf;
      const entry = findEntry(shelf, input.slug);
      return entry ? formatServiceDetail(entry) : unknownSlug(input.slug);
    },

    [WEBMCP_TOOL_NAMES.preview]: async (input, { signal }) => {
      const shelf = await loadShelf(signal);
      if (typeof shelf === "string") return shelf;
      const entry = findEntry(shelf, input.slug);
      if (!entry) return unknownSlug(input.slug);
      // dryRun is the server's own free-preview flag; it decides whether this
      // agent offers one, not us.
      return postJson(
        `/api/agents/${encodeURIComponent(entry.slug)}/run`,
        { input: input.input ?? {}, dryRun: true },
        signal,
      );
    },

    [WEBMCP_TOOL_NAMES.buy]: async (input, { signal }) => {
      // Every guard that matters runs server-side on /api/webmcp/buy: the
      // same-origin check, the rate limit, the price echo against a freshly
      // read price, and buyability. Nothing is pre-approved here.
      return postJson(
        "/api/webmcp/buy",
        {
          slug: input.slug,
          input: input.input ?? {},
          confirmedPriceUsdc: input.confirmedPriceUsdc,
        },
        signal,
      );
    },
  };

  return specs.map((spec) => ({
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    annotations: spec.annotations,
    execute: async (input, context) => {
      const run = executors[spec.name];
      if (!run) return null;
      try {
        return await run(input, context);
      } catch (error: unknown) {
        // An aborted execute is an unmount or a cancelled call, not a failure
        // worth reporting back to the model.
        if (error instanceof DOMException && error.name === "AbortError") return null;
        return "That call could not be completed. Try again shortly.";
      }
    },
  }));
}

export default function StorefrontTools(): null {
  useEffect(() => {
    const modelContext = resolveModelContext({
      document: typeof document === "undefined" ? undefined : document,
      navigator: typeof navigator === "undefined" ? undefined : navigator,
    });
    if (!modelContext) return;

    const controller = new AbortController();
    for (const descriptor of buildDescriptors()) {
      // No exposedTo: the tools stay same-origin under the default policy.
      void modelContext
        .registerTool(descriptor, { signal: controller.signal })
        .catch(() => {
          /* A browser that rejects one descriptor still gets the others. */
        });
    }
    return () => controller.abort();
  }, []);

  return null;
}
