/**
 * Pure projection of the Suede shelf into the WebMCP storefront tool set.
 *
 * FOUR FIXED TOOLS, not one per agent. Per-agent registration would blow the
 * 30-character WebMCP name budget (HTTP MCP allows 128, which is why
 * toolNameForSlug's `run_<slug>` is fine there and useless here) and would grow
 * the buying agent's context linearly with inventory. A fixed funnel stays
 * constant as the shelf grows: find -> get -> preview -> buy.
 *
 * Everything here is pure: descriptors in, strings out, no DOM and no fetch, so
 * the whole surface is unit-testable in the node environment.
 */
import {
  clampText,
  WEBMCP_BUDGETS,
  type WebMcpToolAnnotations,
} from "./protocol";
import type { JsonObjectSchema } from "@/lib/flow/input-contract";
import { isBuyable, isPreviewable, type ShelfEntry } from "./shelf-contract";

/**
 * Price sentence for a shelf entry.
 *
 * Deliberately re-derived rather than imported from src/lib/mcp/tools.ts:
 * that module has value imports (public-service-contract, resources/run-receipt)
 * which would reach the browser bundle through a client component. The wording
 * must stay byte-identical to describePrice() so a buyer reading the HTTP MCP
 * surface and a buyer reading the browser surface are quoted the same price in
 * the same words; tests/webmcp-storefront.test.ts asserts that parity directly
 * against the MCP implementation. A zero price reads "Free to call.", never
 * "0 USDC".
 */
export function describeShelfPrice(priceUsdc: number): string {
  return priceUsdc > 0
    ? `Costs ${priceUsdc} USDC per call, billed to your workspace credit.`
    : "Free to call.";
}

/** Tool names, hand-authored to sit inside the 30-character budget. */
export const WEBMCP_TOOL_NAMES = {
  find: "find_services",
  get: "get_service",
  preview: "preview_service",
  buy: "buy_service",
} as const;

/**
 * Creator-authored text (agent names, summaries, pitches) reaches the output of
 * every one of these tools, not just search — so all four carry the untrusted
 * hint. It marks the payload as data rather than instructions, which is the
 * documented mitigation for indirect prompt injection through a tool result.
 */
const UNTRUSTED: WebMcpToolAnnotations = { untrustedContentHint: true };

const READ_ONLY: WebMcpToolAnnotations = { ...UNTRUSTED, readOnlyHint: true };

/**
 * Not read-only. A dry-run burns no inference (the executor substitutes a stub
 * for every cost-bearing node) but it DOES write a durable runs row, so
 * advertising it as read-only would be false.
 */
const WRITES: WebMcpToolAnnotations = { ...UNTRUSTED, readOnlyHint: false };

export interface StorefrontToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObjectSchema;
  readonly annotations: WebMcpToolAnnotations;
}

const slugParam = {
  type: "string",
  description: "Exact service slug from find_services. Not a name or a title.",
} as const;

/**
 * The four descriptors, minus their execute functions.
 *
 * get_service's description carries only the funnel instruction, never the
 * contract itself. The 500-character description budget cannot hold pitch plus
 * price plus buyerIntent plus reviewPolicy, and Chrome truncates silently — so
 * putting the contract here is exactly how a review-policy caveat would
 * disappear from what a spending agent reads. The contract goes in the OUTPUT,
 * which has a 1500-character budget of its own.
 */
export function storefrontToolSpecs(): readonly StorefrontToolSpec[] {
  return [
    {
      name: WEBMCP_TOOL_NAMES.find,
      description:
        "Search Suede's shelf of published AI services by the job you need done. " +
        "Returns matching services with their per-call price and whether each one " +
        "can be previewed free or bought right now. Start here, then call " +
        "get_service for the full contract before spending anything.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["need"],
        properties: {
          need: {
            type: "string",
            description:
              "The job to be done, in plain language. Example: review a vendor contract for renewal risk.",
          },
          limit: {
            type: "number",
            description: "How many services to return. Defaults to 5, capped at 10.",
          },
        },
      },
      annotations: READ_ONLY,
    },
    {
      name: WEBMCP_TOOL_NAMES.get,
      description:
        "Read the full contract for one service before spending: exact per-call " +
        "price, the input fields it requires, what it returns, whether a human " +
        "reviews the result, and how it handles your data. Call this after " +
        "find_services and before preview_service or buy_service.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["slug"],
        properties: { slug: slugParam },
      },
      annotations: READ_ONLY,
    },
    {
      name: WEBMCP_TOOL_NAMES.preview,
      description:
        "Run a service in free dry-run mode to check it fits before paying. " +
        "Returns the shape of a real result without charging and without calling " +
        "any model. Not every service offers a preview; get_service reports which " +
        "do. This records a run on your workspace, so it is not a read-only call.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["slug", "input"],
        properties: {
          slug: slugParam,
          input: {
            type: "object",
            additionalProperties: true,
            description:
              "Fields matching the service's input contract, exactly as get_service reports it.",
          },
        },
      },
      annotations: WRITES,
    },
    {
      name: WEBMCP_TOOL_NAMES.buy,
      description:
        "Buy one real call of a service. SPENDS prepaid credit from the signed-in " +
        "workspace and returns the finished result. Echo the price you agreed to " +
        "in confirmedPriceUsdc; if it no longer matches the listed price the call " +
        "is refused rather than charged. Fails when the balance is short — top up " +
        "at /pricing. Preview first if you have not.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["slug", "input", "confirmedPriceUsdc"],
        properties: {
          slug: slugParam,
          input: {
            type: "object",
            additionalProperties: true,
            description:
              "Fields matching the service's input contract, exactly as get_service reports it.",
          },
          confirmedPriceUsdc: {
            type: "number",
            description:
              "The exact per-call price you agreed to. A mismatch refuses the call instead of charging.",
          },
        },
      },
      annotations: WRITES,
    },
  ];
}

/** Lowercased word tokens, used for shelf matching. */
function tokenize(value: string): readonly string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/i).filter((word) => word.length > 2);
}

/**
 * Rank shelf entries against a stated need.
 *
 * Deliberately a transparent token overlap rather than anything cleverer: the
 * ranking runs in the visitor's browser, and a buying agent can always fall
 * back to reading every entry. Ties break on slug so the order is stable.
 */
export function matchServices(
  entries: readonly ShelfEntry[],
  need: string,
  limit = 5,
): readonly ShelfEntry[] {
  const wanted = new Set(tokenize(need));
  const capped = Math.max(1, Math.min(10, Math.trunc(limit) || 5));
  const scored = entries.map((entry) => {
    const haystack = tokenize(
      [entry.name, entry.summary, entry.description ?? "", ...(entry.tags ?? [])].join(" "),
    );
    const hits = haystack.filter((word) => wanted.has(word)).length;
    return { entry, hits };
  });
  // Zero-hit entries are NOT matches. Returning them sorted alphabetically
  // presents shelf order as relevance, which is worse than an honest miss: the
  // agent cannot tell "nothing fits" from "here are your top results".
  const hits = scored.filter((row) => row.hits > 0);
  return hits
    .sort((a, b) => b.hits - a.hits || a.entry.slug.localeCompare(b.entry.slug))
    .slice(0, capped)
    .map((row) => row.entry);
}

/**
 * What the service actually does, in the creator's own words.
 *
 * `summary` is DERIVED from the node chain, so in production it reads
 * "Input › LLM (Claude) › Output" — identical across most of the shelf and
 * useless to a buyer. `description` is the creator-written pitch. Preferring it
 * is the difference between six distinguishable listings and six identical
 * ones. The fixture-vs-live gap here is real: a test fixture with a written
 * summary hides the problem entirely.
 */
export function describeWhatItDoes(entry: ShelfEntry): string {
  const pitch = entry.description?.trim();
  return pitch !== undefined && pitch.length > 0 ? pitch : entry.summary;
}

/** One-line availability verdict, read back from the server's own projection. */
function availability(entry: ShelfEntry): string {
  if (isBuyable(entry)) return "buyable now";
  if (isPreviewable(entry)) return "preview only, not buyable";
  return "not callable right now";
}

/**
 * Render a result list inside the 1500-character output budget.
 *
 * When entries do not fit, the count that was dropped is stated. A silently
 * shortened list would read to the agent as the complete shelf.
 */
export function formatServiceList(
  entries: readonly ShelfEntry[],
  total: number,
): string {
  if (entries.length === 0) {
    // Naming the shelf size distinguishes "your query missed" from "the shelf
    // is empty" — an agent should retry differently in each case.
    return total > 0
      ? `No services match that need. The Suede shelf has ${total}; try broader wording.`
      : "The Suede shelf has no services right now.";
  }
  const lines: string[] = [];
  let shown = 0;
  for (const entry of entries) {
    const line =
      `- ${entry.slug}: ${entry.name}. ${describeWhatItDoes(entry)} ` +
      `${describeShelfPrice(entry.priceUsdc)} (${availability(entry)})`;
    const candidate = [...lines, clampText(line, 300)].join("\n");
    if (candidate.length > WEBMCP_BUDGETS.toolOutput - 120) break;
    lines.push(clampText(line, 300));
    shown += 1;
  }
  // Count against what MATCHED, not the whole shelf. Measuring against shelf
  // size made every query end in "1 further match not shown" even when the
  // agent had already seen every match — and pointed at narrowing the need,
  // which re-ranks without revealing more. `limit` is the actual lever.
  const omitted = entries.length - shown;
  const footer =
    omitted > 0
      ? `\n${omitted} more match(es) not shown. Raise limit (max 10) to see them.`
      : "";
  return clampText(
    `${shown} of ${entries.length} match(es) from ${total} on the shelf:\n` +
      `${lines.join("\n")}${footer}`,
    WEBMCP_BUDGETS.toolOutput,
  );
}

/**
 * Render one service's full contract inside the output budget.
 *
 * Two rules, both learned from measuring real shelf data rather than fixtures:
 *
 * 1. ORDER BY WHAT A BUYER CANNOT PROCEED WITHOUT. Price, availability and the
 *    review policy come first, then the input contract, then the worked
 *    example, then the return shape. A dry-run stubs every fetch and model
 *    node, so `exampleOutput` is the only thing that can show a buyer what it
 *    is actually paying for — it must outrank the return schema, not trail it.
 *
 * 2. OMIT A PART WHOLE, NEVER CLIP IT. A JSON blob cut mid-string does not
 *    parse AND consumes the budget that would have carried a smaller part
 *    intact. Anything dropped is named, so the agent knows to ask rather than
 *    assuming it saw everything.
 */
export function formatServiceDetail(entry: ShelfEntry): string {
  const head = [
    `${entry.slug}: ${entry.name}`,
    describeShelfPrice(entry.priceUsdc),
    `Availability: ${availability(entry)}.`,
    entry.curation
      ? `Review policy: ${entry.curation.reviewPolicy} Data handling: ${entry.curation.dataHandling}`
      : "Published by a Suede customer, not reviewed by Suede.",
    `What it does: ${clampText(describeWhatItDoes(entry), 400)}`,
  ].join("\n");

  const optional: readonly { readonly label: string; readonly text: string }[] = [
    { label: "input contract", text: `Input contract: ${JSON.stringify(entry.inputSchema)}` },
    ...(entry.exampleInput
      ? [{ label: "example input", text: `Example input: ${JSON.stringify(entry.exampleInput)}` }]
      : []),
    ...(entry.exampleOutput
      ? [{ label: "example output", text: `Example output: ${JSON.stringify(entry.exampleOutput)}` }]
      : []),
    ...(entry.outputSchema
      ? [{ label: "return shape", text: `Returns: ${JSON.stringify(entry.outputSchema)}` }]
      : []),
  ];

  const parts: string[] = [head];
  const dropped: string[] = [];
  let used = head.length;
  for (const part of optional) {
    // +1 for the newline join, and reserve room for the omission notice.
    if (used + part.text.length + 1 <= WEBMCP_BUDGETS.toolOutput - 90) {
      parts.push(part.text);
      used += part.text.length + 1;
    } else {
      dropped.push(part.label);
    }
  }
  if (dropped.length > 0) {
    parts.push(`Omitted, too large to inline: ${dropped.join(", ")}.`);
  }
  // head is bounded by construction, so this clamp is a backstop, not the
  // mechanism — the loop above is what keeps every included part parseable.
  return clampText(parts.join("\n"), WEBMCP_BUDGETS.toolOutput);
}
