/**
 * Projects the public agent catalog into MCP tool descriptors.
 *
 * One MCP-eligible published agent becomes one tool. Everything a calling model needs to decide
 * whether to spend — what it does, what it costs, what it accepts — is on the
 * descriptor, so discovering the price never costs a failed round trip.
 *
 * Pure: takes catalog entries, returns descriptors. No database, no engine.
 */
import type { CatalogEntry } from "@/lib/catalog";
import type { McpToolDescriptor } from "./server";
import { RESOURCE_CONTRACT_EXTENSION_URI } from "@/lib/public-service-contract";
import { resourceRunEnvelopeSchema } from "@/lib/resources/run-receipt";

/** MCP tool names SHOULD stay within 128 characters. */
const MAX_TOOL_NAME_LENGTH = 128;
/** The only characters MCP tool names SHOULD use. */
const UNSAFE_TOOL_NAME_CHARS = /[^A-Za-z0-9_.-]/g;

const TOOL_NAME_PREFIX = "run_";

/**
 * The MCP tool name for an agent slug. Prefixed so the tool reads as an action
 * in a model's tool list rather than as a bare noun.
 */
export function toolNameForSlug(slug: string): string {
  const safe = slug.replace(UNSAFE_TOOL_NAME_CHARS, "_");
  return `${TOOL_NAME_PREFIX}${safe}`.slice(0, MAX_TOOL_NAME_LENGTH);
}

/** Human price line. Zero-price agents read as "Free", never as "0 USDC". */
export function describePrice(priceUsdc: number): string {
  return priceUsdc > 0
    ? `Costs ${priceUsdc} USDC per call, billed to your workspace credit.`
    : "Free to call.";
}

/** Build the MCP tool descriptor for one eligibility-checked published agent. */
export function catalogEntryToTool(entry: CatalogEntry): McpToolDescriptor {
  // The creator's own pitch beats the derived node chain; the chain is the
  // fallback so a tool is never described only by its price.
  const what = entry.description ?? entry.summary;
  return {
    name: toolNameForSlug(entry.slug),
    title: entry.name,
    description: `${what} ${describePrice(entry.priceUsdc)}${
      entry.curation ? ` ${entry.curation.buyerIntent} ${entry.curation.reviewPolicy}` : ""
    }`,
    inputSchema: entry.inputSchema,
    outputSchema: entry.extensions?.[RESOURCE_CONTRACT_EXTENSION_URI] !== undefined
      ? (entry.outputSchema?.type === "object" &&
          Array.isArray(entry.outputSchema.required) && entry.outputSchema.required.includes("resourceReceipt")
        ? entry.outputSchema
        : resourceRunEnvelopeSchema(entry.outputSchema ?? { type: "object" }))
      : {
      type: "object",
      additionalProperties: false,
      required: ["runId", "outputs", "chargedUsdc"],
      properties: {
        runId: { type: "string" },
        outputs: { type: "object", additionalProperties: true },
        ...(entry.outputSchema ? { result: entry.outputSchema } : {}),
        chargedUsdc: { type: "number", minimum: 0 },
      },
      },
    annotations: {
      title: entry.name,
      // Running a priced tool moves workspace credit and every run is stored,
      // so this must not be advertised as read-only even when the business
      // decision itself does not mutate an external system.
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    ...(entry.extensions ? { _meta: entry.extensions } : {}),
  };
}

/**
 * Tool descriptors for a whole catalog, in a stable order.
 *
 * Deterministic ordering is a spec SHOULD: it lets clients cache the tool list
 * and improves prompt-cache hit rates when tools go into model context. Slug
 * is the sort key because it is unique and stable, unlike call counts.
 */
export function catalogToTools(
  entries: readonly CatalogEntry[],
): McpToolDescriptor[] {
  return [...entries]
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map(catalogEntryToTool);
}

export type McpEligibility =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: string };

/**
 * Whether an agent may be reached over MCP at all.
 *
 * Three shapes are excluded rather than silently run without their
 * protections, or advertised when they cannot actually serve a call:
 *
 * - **Agents with no active live deployment.** buildCatalog falls back to the
 *   flow's current draft graph for *listing*, but a paid call resolves the
 *   immutable published version — the guarantee that a creator's in-progress
 *   canvas edit never changes what a payer receives. With no published
 *   version there is nothing legitimate to charge for, and advertising the
 *   tool would only produce a charge-then-refund round trip.
 *
 * - **Company employees** are governed by department budgets, founder approval
 *   flags, and company status. Bypassing those would let an MCP caller spend a
 *   founder's budget past its ceiling.
 * - **Relay-backed agents** forward to a creator-hosted process over a shared
 *   secret. That path has its own failure and timeout semantics that this
 *   handler does not implement.
 *
 * Both are lifts for a later pass, not permanent exclusions.
 */
export function mcpEligibility(input: {
  readonly isCompanyEmployee: boolean;
  readonly hasRelay: boolean;
  readonly hasPublishedDeployment: boolean;
}): McpEligibility {
  if (!input.hasPublishedDeployment) {
    return {
      eligible: false,
      reason:
        "This agent has no published live version. A paid call runs the immutable published version, so it cannot be served until the creator publishes one.",
    };
  }
  if (input.isCompanyEmployee) {
    return {
      eligible: false,
      reason:
        "This agent is a company employee. Its budget and approval gates are only enforced on its x402 endpoint, so it is not exposed over MCP.",
    };
  }
  if (input.hasRelay) {
    return {
      eligible: false,
      reason:
        "This agent forwards to a creator-hosted relay, which is not exposed over MCP.",
    };
  }
  return { eligible: true };
}

/** Reverse index from tool name back to the agent that backs it. */
export function toolIndex(
  entries: readonly CatalogEntry[],
): Map<string, CatalogEntry> {
  return new Map(entries.map((entry) => [toolNameForSlug(entry.slug), entry]));
}
