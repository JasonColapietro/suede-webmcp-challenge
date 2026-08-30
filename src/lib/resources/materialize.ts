import { createHash } from "node:crypto";
import { parseResourcePackBundle } from "./query";
import type { FlowGraphV2, JsonSchema, JsonValue } from "@/lib/flow/types";
import { parseSupportedFlowGraph } from "@/lib/flow/graph-schema";
import { hashFlowGraph } from "@/lib/projects/hash";
import type { ResourceJobContract, ResourcePackBundle, ResourceProduct, ResourceSourceDisclosure } from "./types";

export interface ResourceMaterializationPlan {
  readonly resourceProductId: string;
  readonly packVersionId: string;
  readonly semanticHash: string;
  readonly freshness: ResourcePackBundle["freshness"];
  readonly filterFields: readonly string[];
  readonly returnFields: readonly string[];
  readonly jobContract: ResourceJobContract;
}

/**
 * Pure, side-effect-free draft authority for Task 6. It deliberately does not
 * register a node, create a flow, publish an agent, or inspect provenance.
 */
export function planResourceMaterialization(value: unknown): ResourceMaterializationPlan {
  const pack = parseResourcePackBundle(value);
  return Object.freeze({
    resourceProductId: pack.resourceProductId,
    packVersionId: pack.packVersionId,
    semanticHash: pack.semanticHash,
    freshness: pack.freshness,
    filterFields: pack.content.filterFields,
    returnFields: pack.content.returnFields,
    jobContract: pack.content.jobContract,
  });
}

const RESOURCE_RECEIPT_SCHEMA: JsonSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: [
    "resourceProductId", "resourceVersion", "semanticHash", "freshness",
    "evidence", "unknowns", "conflicts", "outputSchemaValid",
  ],
  properties: {
    resourceProductId: { type: "string" },
    resourceVersion: { type: "string" },
    semanticHash: { type: "string" },
    freshness: { enum: ["fresh", "stale", "mixed"] },
    evidence: { type: "array", items: { type: "object" } },
    unknowns: { type: "array", items: { type: "string" } },
    conflicts: { type: "array", items: { type: "string" } },
    outputSchemaValid: { type: "boolean" },
  },
});

function jsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(jsonValue);
  if (typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.entries(value).every(([key, entry]) => key !== "__proto__" && jsonValue(entry));
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function viewport(value: unknown): JsonValue | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Readonly<Record<string, unknown>>;
  const x = finiteNumber(source.x);
  const y = finiteNumber(source.y);
  const zoom = finiteNumber(source.zoom);
  if (x === undefined && y === undefined && zoom === undefined) return undefined;
  return Object.freeze({
    ...(x === undefined ? {} : { x }),
    ...(y === undefined ? {} : { y }),
    ...(zoom === undefined ? {} : { zoom }),
  });
}

function display(value: unknown): JsonValue | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const accent = (value as Readonly<Record<string, unknown>>).accent;
  if (typeof accent !== "string" || !/^[a-z0-9_-]{1,32}$/u.test(accent)) return undefined;
  return Object.freeze({ accent });
}

function presentationMeta(value: Readonly<Record<string, unknown>> | undefined): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  if (!value) return result;
  const canvas = viewport(value.canvas);
  const currentViewport = viewport(value.viewport);
  const currentDisplay = display(value.display);
  if (canvas !== undefined) result.canvas = canvas;
  if (currentViewport !== undefined) result.viewport = currentViewport;
  if (currentDisplay !== undefined) result.display = currentDisplay;
  return result;
}

function defaultForSchema(value: unknown): JsonValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const schema = value as Record<string, unknown>;
  if (jsonValue(schema.default)) return schema.default;
  if (schema.type === "string") return "";
  if (schema.type === "number" || schema.type === "integer") return 0;
  if (schema.type === "boolean") return false;
  if (schema.type === "array") return [];
  if (schema.type === "object") return {};
  return null;
}

function inputFields(schema: JsonSchema): Readonly<Record<string, JsonValue>> {
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return {};
  return Object.freeze(Object.fromEntries(
    Object.entries(properties).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, defaultForSchema(value)]),
  ));
}

export interface MaterializeResourceGraphInput {
  readonly product: ResourceProduct;
  readonly pack: ResourcePackBundle;
  readonly sourceDisclosure: ResourceSourceDisclosure;
  readonly existingMeta?: Readonly<Record<string, unknown>>;
}

export interface MaterializedResourceGraph {
  readonly graph: FlowGraphV2;
  readonly semanticHash: string;
  readonly fullHash: string;
}

/** One immutable public slug shared by materialization and publication. */
export function canonicalResourceAgentSlug(product: Pick<ResourceProduct, "id" | "slug">): string {
  const base = product.slug.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "") || "resource";
  const suffix = createHash("sha256").update(product.id).digest("hex").slice(0, 10);
  return `${base.slice(0, 160 - suffix.length - 1)}-${suffix}`;
}

/**
 * Deterministically projects an approved pack's reviewed public contract into
 * a runnable graph. Source bodies, records, evidence, and provenance are never
 * read or copied into graph metadata.
 */
export function materializeResourceGraph(input: MaterializeResourceGraphInput): MaterializedResourceGraph {
  const pack = parseResourcePackBundle(input.pack);
  if (pack.resourceProductId !== input.product.id) throw new TypeError("Resource Pack mismatch.");
  const sourceKinds = [...input.sourceDisclosure.sourceKinds].sort((left, right) => left.localeCompare(right));
  if (!Number.isSafeInteger(input.sourceDisclosure.sourceCount) || input.sourceDisclosure.sourceCount < 0 ||
      input.sourceDisclosure.sourceCount !== pack.content.sourceSnapshotIds.length ||
      sourceKinds.some((kind) => typeof kind !== "string" || kind.length === 0 || kind.trim() !== kind) ||
      new Set(sourceKinds).size !== sourceKinds.length) throw new TypeError("Resource source disclosure mismatch.");
  const resultSchema = pack.content.jobContract.outputSchema as JsonSchema;
  const inputSchema = pack.content.jobContract.inputSchema as JsonSchema;
  const outputSchema: JsonSchema = {
    type: "object",
    additionalProperties: false,
    required: ["result", "resourceReceipt"],
    properties: { result: resultSchema, resourceReceipt: RESOURCE_RECEIPT_SCHEMA },
  };
  const graph: FlowGraphV2 = {
    schemaVersion: 2,
    id: `resource-product:${input.product.id}`,
    name: input.product.name,
    nodes: [
      {
        id: "resource-input", type: "input", position: { x: 0, y: 0 },
        params: { fields: inputFields(inputSchema) }, bindings: {},
      },
      {
        id: "resource-query", type: "resource.query", position: { x: 280, y: 0 },
        params: {
          resourceProductId: input.product.id,
          packVersionId: pack.packVersionId,
          resourcePackContentHash: pack.semanticHash,
          filterFields: pack.content.filterFields,
          returnFields: pack.content.returnFields,
        },
        bindings: {},
      },
      {
        id: "resource-output", type: "output", position: { x: 560, y: 0 },
        params: { label: "Resource result" }, bindings: {},
      },
    ],
    edges: [
      {
        id: "resource-input-query", source: "resource-input", sourceHandle: "result",
        target: "resource-query", targetHandle: "filters",
      },
      {
        id: "resource-query-output", source: "resource-query", sourceHandle: "result",
        target: "resource-output", targetHandle: "in",
      },
    ],
    variables: [], groups: [], annotations: [],
    callableInterface: {
      inputs: [{
        id: "filters", label: "Filters", schema: inputSchema, required: true,
        cardinality: "one", target: { kind: "trigger", path: "" },
      }],
      outputs: [
        {
          id: "result", label: "Result", schema: resultSchema, required: true,
          cardinality: "one", source: { nodeId: "resource-query", portId: "result" },
        },
        {
          id: "resourceReceipt", label: "Resource receipt", schema: RESOURCE_RECEIPT_SCHEMA,
          required: true, cardinality: "one",
          source: { nodeId: "resource-query", portId: "resourceReceipt" },
        },
      ],
    },
    meta: {
      ...presentationMeta(input.existingMeta),
      description: pack.content.jobContract.jobStatement,
      resourceProduct: {
        id: input.product.id,
        name: input.product.name,
        slug: canonicalResourceAgentSlug(input.product),
        executionAccess: input.product.executionAccess,
        discoveryAccess: input.product.discoveryAccess,
        packVersionId: pack.packVersionId,
        semanticHash: pack.semanticHash,
        freshness: pack.freshness,
        filterFields: pack.content.filterFields,
        returnFields: pack.content.returnFields,
        inputSchema,
        outputSchema,
        jobContract: pack.content.jobContract as unknown as JsonValue,
        sourceDisclosure: {
          corpus: "private",
          sourceCount: input.sourceDisclosure.sourceCount,
          sourceKinds,
          freshness: pack.freshness,
        },
      },
    },
  };
  const parsed = parseSupportedFlowGraph(graph) as FlowGraphV2;
  const dependencies = [{
    kind: "resource" as const,
    resourceId: input.product.id,
    version: pack.packVersionId,
    contentHash: pack.semanticHash,
  }];
  return Object.freeze({
    graph: parsed,
    semanticHash: hashFlowGraph(parsed, { semantic: true }, dependencies),
    fullHash: hashFlowGraph(parsed, { semantic: false }, dependencies),
  });
}
