/**
 * Derives a flow's public input contract as JSON Schema.
 *
 * The source of truth is the input node's `fields` config — the JSON object of
 * default values a builder authors (e.g. `{"topic": ""}`). Its KEYS are the
 * agent's input contract, and each default's JSON type names the field's type.
 * Deriving from the graph keeps the published contract from drifting the way a
 * hand-maintained schema would.
 *
 * Pure and client-safe: no executors, no registry, no database.
 */
import type { NodeType } from "./types";

/** The narrow shape this derivation needs — any flow graph version satisfies it. */
export interface InputContractGraph {
  readonly nodes: readonly {
    readonly type: NodeType | string;
    readonly params?: Readonly<Record<string, unknown>> | undefined;
  }[];
}

export interface JsonObjectSchema extends Record<string, unknown> {
  type: "object";
  properties?: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties?: boolean;
}

/** JSON Schema type for one authored default value. `{}` means "anything". */
function schemaForDefault(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return { type: "string" };
  if (typeof value === "number") return { type: "number" };
  if (typeof value === "boolean") return { type: "boolean" };
  if (Array.isArray(value)) return { type: "array" };
  if (value !== null && typeof value === "object") return { type: "object" };
  // null carries no type information, and neither does undefined.
  return {};
}

function fieldsOf(params: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> | null {
  const fields = params?.fields;
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
    return null;
  }
  return fields as Record<string, unknown>;
}

/**
 * The node types that forward the run's trigger payload into the graph.
 *
 * All three executors end in `outputs: { result: <the trigger input> }`, so
 * each one is a place a caller's arguments genuinely enter the flow. Deciding
 * "does this agent accept arguments?" from the presence of an `input` node
 * alone would be wrong for the other two: a schedule- or webhook-triggered
 * agent reached over MCP is handed its arguments the same way, and its
 * downstream prompts interpolate them the same way.
 */
const FORWARDING_TRIGGERS: ReadonlySet<string> = new Set([
  "input",
  "schedule",
  "webhook",
]);

/**
 * Build the JSON Schema an MCP client should send as tool arguments.
 *
 * Four cases, each deliberate. The distinction that carries the most weight is
 * between a trigger that *omits* `fields` and one that authors an *empty*
 * `fields: {}` — "we cannot name this agent's arguments" and "this agent takes
 * no arguments" are different claims, and a caller acts on them differently.
 *
 * - No forwarding trigger node: `additionalProperties: false`. Nothing in the
 *   graph reads trigger input, so advertising free-form properties would
 *   invite a model to send data that is silently dropped.
 * - Every forwarding trigger authored `fields`, and all are empty:
 *   `additionalProperties: false`. An explicit statement that the graph is
 *   driven entirely by node params, so there is nothing to send.
 * - A forwarding trigger omits `fields` entirely: bare `{ type: "object" }`,
 *   which accepts anything. The flow does read trigger input; we just cannot
 *   name its fields. This is the honest fallback, not a desirable state.
 * - A forwarding trigger with defaults: those keys, typed. Nothing is
 *   `required`, since every declared field already has a default.
 */
export function deriveInputSchema(graph: InputContractGraph): JsonObjectSchema {
  const triggerNodes = graph.nodes.filter((node) =>
    FORWARDING_TRIGGERS.has(node.type),
  );
  if (triggerNodes.length === 0) {
    return { type: "object", additionalProperties: false };
  }

  const properties: Record<string, Record<string, unknown>> = {};
  let authored = 0;
  for (const node of triggerNodes) {
    const fields = fieldsOf(node.params);
    if (!fields) continue;
    authored++;
    for (const [key, value] of Object.entries(fields)) {
      properties[key] = schemaForDefault(value);
    }
  }

  if (Object.keys(properties).length > 0) return { type: "object", properties };
  // Only close the schema when EVERY trigger made the empty claim. One
  // unauthored trigger means some path may still read arguments we cannot see.
  if (authored === triggerNodes.length) {
    return { type: "object", additionalProperties: false };
  }
  return { type: "object" };
}
