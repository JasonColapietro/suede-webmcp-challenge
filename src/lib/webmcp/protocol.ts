/**
 * WebMCP browser API types, namespace resolution, and Chrome's character budgets.
 *
 * WebMCP (W3C Web Machine Learning CG draft, Chrome 149+ origin trial) lets a
 * page register tools that an agent running inside the visitor's browser can
 * call. It is the browser-side twin of the HTTP MCP surface in src/lib/mcp/*:
 * same idea, different transport, and crucially a different auth model. The
 * HTTP surface needs a bearer key; WebMCP rides the page's own session cookie,
 * so an agent operating in a signed-in browser is already the right workspace
 * without an API key ever being minted.
 *
 * Chrome 150 moved the namespace from `navigator.modelContext` to
 * `document.modelContext` while the origin trial kept shipping the old alias,
 * so resolution has to check both. `resolveModelContext` takes the host object
 * as an argument rather than touching globals, which keeps this module pure
 * and importable from the node-environment test suite.
 */
import type { JsonObjectSchema } from "@/lib/flow/input-contract";

/** Hints agents use to decide whether a tool is safe to call unattended. */
export interface WebMcpToolAnnotations {
  /** True only when calling the tool changes nothing and spends nothing. */
  readonly readOnlyHint?: boolean;
  /**
   * True when the tool's OUTPUT carries text this site did not author —
   * customer-written agent names and pitches, in our case. Flags the payload
   * as data rather than instructions, which is the documented mitigation for
   * indirect prompt injection through a tool result.
   */
  readonly untrustedContentHint?: boolean;
}

/** Second argument Chrome passes to `execute`. */
export interface WebMcpExecuteContext {
  readonly signal: AbortSignal;
}

/**
 * One registered tool. `execute` resolves with the string the agent sees, or
 * null when the page navigated and there is nothing to report back.
 */
export interface WebMcpToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObjectSchema;
  readonly execute: (
    input: Readonly<Record<string, unknown>>,
    context: WebMcpExecuteContext,
  ) => Promise<string | null>;
  readonly annotations?: WebMcpToolAnnotations;
}

export interface WebMcpRegisterOptions {
  /** Aborting this signal unregisters the tool without killing in-flight calls. */
  readonly signal?: AbortSignal;
  /** Secure origins allowed to see the tool. Omitted means same-origin only. */
  readonly exposedTo?: readonly string[];
}

export interface WebMcpModelContext {
  registerTool(
    descriptor: WebMcpToolDescriptor,
    options?: WebMcpRegisterOptions,
  ): void | PromiseLike<void>;
}

/**
 * Register every descriptor without assuming how the host reports completion.
 *
 * Chrome's native API returns a promise, while some agent-browser bridges
 * complete registration synchronously and return void. Normalizing both
 * shapes also keeps a synchronous throw or rejected registration from
 * preventing later tools from being offered.
 */
export function registerWebMcpTools(
  modelContext: WebMcpModelContext,
  descriptors: readonly WebMcpToolDescriptor[],
  options?: WebMcpRegisterOptions,
): void {
  for (const descriptor of descriptors) {
    try {
      void Promise.resolve(modelContext.registerTool(descriptor, options)).catch(() => {
        /* One rejected descriptor must not block the remaining tools. */
      });
    } catch {
      /* One synchronous host failure must not block the remaining tools. */
    }
  }
}

/**
 * The two places a `modelContext` can live across shipping Chrome versions.
 *
 * Both slots are `unknown` rather than a shape carrying `modelContext`. WebMCP
 * is an origin-trial API, so the DOM lib declares no such property on `Document`
 * or `Navigator` — a structural type here would trip TypeScript's weak-type
 * check at every real call site and force a cast in the one place that must not
 * have one.
 */
export interface ModelContextHost {
  readonly document?: unknown;
  readonly navigator?: unknown;
}

/** Read a `modelContext` slot off a host object without asserting its type. */
function readModelContext(host: unknown): unknown {
  return host !== null && typeof host === "object" && "modelContext" in host
    ? (host as { readonly modelContext?: unknown }).modelContext
    : undefined;
}

function isModelContext(value: unknown): value is WebMcpModelContext {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { registerTool?: unknown }).registerTool === "function"
  );
}

/**
 * The live `modelContext`, or null when the browser has no WebMCP support.
 *
 * `document` wins because Chrome 150 deprecated the `navigator` alias; the
 * alias stays in the lookup because the origin trial still serves it to
 * Chrome 149.
 */
export function resolveModelContext(
  host: ModelContextHost,
): WebMcpModelContext | null {
  const fromDocument = readModelContext(host.document);
  if (isModelContext(fromDocument)) return fromDocument;
  const fromNavigator = readModelContext(host.navigator);
  if (isModelContext(fromNavigator)) return fromNavigator;
  return null;
}

/**
 * Chrome's published per-field character budgets.
 *
 * These are hard product constraints, not style guidance: a description that
 * overruns is truncated by the browser, and a truncated description is how a
 * price or a review-policy caveat silently disappears from what the buying
 * agent reads. Everything user-visible goes through `clampText` first.
 */
export const WEBMCP_BUDGETS = {
  toolName: 30,
  toolDescription: 500,
  parameterName: 30,
  parameterDescription: 150,
  toolOutput: 1_500,
} as const;

/**
 * Truncate to `limit` characters, marking the cut so neither the agent nor a
 * human reading a transcript mistakes a clipped list for a complete one.
 */
export function clampText(value: string, limit: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= limit) return collapsed;
  const ellipsis = "…";
  return `${collapsed.slice(0, Math.max(0, limit - ellipsis.length)).trimEnd()}${ellipsis}`;
}

/** True when every budget this descriptor is subject to is respected. */
export function withinBudgets(descriptor: {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObjectSchema;
}): boolean {
  if (descriptor.name.length > WEBMCP_BUDGETS.toolName) return false;
  if (descriptor.description.length > WEBMCP_BUDGETS.toolDescription) return false;
  const properties = descriptor.inputSchema.properties ?? {};
  return Object.entries(properties).every(([key, schema]) => {
    if (key.length > WEBMCP_BUDGETS.parameterName) return false;
    const description = (schema as { description?: unknown }).description;
    return (
      typeof description !== "string" ||
      description.length <= WEBMCP_BUDGETS.parameterDescription
    );
  });
}
