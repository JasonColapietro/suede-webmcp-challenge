import type { RunSummary } from "../run-service";
import type { PublicServiceContract } from "../public-service-contract";
import type { ResourceRepository } from "./repository";
import { parseEvidencePointer, resourceSchemaAccepts } from "./schemas";
import type {
  EvidencePointer,
  ResourceJsonValue,
  ResourcePaymentState,
  ResourceReceipt,
} from "./types";

export const INVALID_RESOURCE_RUN_RECEIPT = "Invalid resource run receipt.";
export const RESOURCE_PAYMENT_STATES = Object.freeze([
  "free", "challenged", "credited", "settled", "refunded", "failed",
] as const);

export interface ResourcePaymentFact {
  readonly priceUsdc: number;
  readonly state: ResourcePaymentState;
  readonly paymentId: string | null;
}

export interface ResourceRunEnvelope {
  readonly result: ResourceJsonValue;
  readonly resourceReceipt: ResourceReceipt;
  readonly payment: {
    readonly priceUsdc: number;
    readonly state: ResourcePaymentState;
    readonly receiptId: string | null;
  };
}

function invalid(): never { throw new TypeError(INVALID_RESOURCE_RUN_RECEIPT); }

function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(descriptors, key)) || Object.keys(descriptors).some((key) => !allowed.has(key) || !descriptors[key]?.enumerable || !("value" in descriptors[key]!))) invalid();
  return value as Record<string, unknown>;
}

function json(value: unknown, depth = 0): ResourceJsonValue {
  if (depth > 20) invalid();
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid();
    return value;
  }
  if (Array.isArray(value)) return Object.freeze(value.map((entry) => json(entry, depth + 1)));
  const source = exact(value, Object.keys(value as object));
  const result: Record<string, ResourceJsonValue> = Object.create(null);
  for (const [key, entry] of Object.entries(source)) result[key] = json(entry, depth + 1);
  return Object.freeze(result);
}

function evidence(value: unknown): EvidencePointer {
  try { return parseEvidencePointer(value); } catch { return invalid(); }
}

function strings(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) invalid();
  return Object.freeze([...value]) as readonly string[];
}

function receipt(value: unknown, service: PublicServiceContract): ResourceReceipt {
  if (!service.resource) invalid();
  const source = exact(value, [
    "resourceProductId", "resourceVersion", "semanticHash", "freshness", "evidence",
    "unknowns", "conflicts", "outputSchemaValid",
  ]);
  if (source.resourceProductId !== service.resource.resourceProductId ||
      source.resourceVersion !== service.resource.resourceVersion ||
      source.semanticHash !== service.resource.semanticHash ||
      source.freshness !== service.resource.freshness || source.outputSchemaValid !== true ||
      !Array.isArray(source.evidence)) invalid();
  return Object.freeze({
    resourceProductId: source.resourceProductId,
    resourceVersion: source.resourceVersion,
    semanticHash: source.semanticHash,
    freshness: source.freshness,
    evidence: Object.freeze(source.evidence.map(evidence)),
    unknowns: strings(source.unknowns),
    conflicts: strings(source.conflicts),
    outputSchemaValid: true,
  }) as ResourceReceipt;
}

export async function buildAndPersistResourceRunEnvelope(input: {
  readonly service: PublicServiceContract;
  readonly summary: RunSummary;
  readonly payment: ResourcePaymentFact;
  readonly repository: Pick<ResourceRepository, "recordRunReceipt">;
}): Promise<ResourceRunEnvelope> {
  if (input.service.kind !== "resource" || !input.service.resource ||
      !Number.isFinite(input.payment.priceUsdc) || input.payment.priceUsdc < 0 ||
      !RESOURCE_PAYMENT_STATES.includes(input.payment.state) ||
      (input.payment.paymentId !== null && typeof input.payment.paymentId !== "string")) invalid();
  const queryNodes = input.service.graph.nodes.filter((node) => node.type === "resource.query");
  if (queryNodes.length !== 1) invalid();
  const output = exact(input.summary.outputs[queryNodes[0]!.id], ["result", "resourceReceipt"]);
  const result = json(output.result);
  const resourceReceipt = receipt(output.resourceReceipt, input.service);
  if (!resourceSchemaAccepts(input.service.resource.jobContract.outputSchema, result)) invalid();
  const persisted = await input.repository.recordRunReceipt({
    ownerId: input.service.release.ownerId,
    resourceProductId: input.service.resource.resourceProductId,
    packVersionId: input.service.resource.resourceVersion,
    agentId: input.service.id,
    runId: input.summary.runId,
    flowVersionId: input.service.release.flowVersionId,
    deploymentId: input.service.release.deploymentId,
    paymentId: input.payment.paymentId,
    paymentState: input.payment.state,
    priceUsdc: input.payment.priceUsdc,
    receipt: resourceReceipt,
  });
  return Object.freeze({
    result,
    resourceReceipt,
    payment: Object.freeze({
      priceUsdc: input.payment.priceUsdc,
      state: input.payment.state,
      receiptId: persisted.id,
    }),
  });
}

/**
 * Bounded, side-effect-free response for a public Resource preview. The result
 * is the reviewed synthetic example sealed into the immutable Job Contract;
 * it never queries the owner corpus and therefore has no durable receipt ID.
 */
export function buildResourcePublicPreviewEnvelope(
  service: PublicServiceContract,
): ResourceRunEnvelope {
  if (service.kind !== "resource" || !service.resource ||
      service.resource.access.execution !== "free" || service.priceUsdc !== 0) invalid();
  const result = json(service.resource.jobContract.safeExample);
  if (!resourceSchemaAccepts(service.resource.jobContract.outputSchema, result)) invalid();
  return Object.freeze({
    result,
    resourceReceipt: Object.freeze({
      resourceProductId: service.resource.resourceProductId,
      resourceVersion: service.resource.resourceVersion,
      semanticHash: service.resource.semanticHash,
      freshness: service.resource.freshness,
      evidence: Object.freeze([]),
      unknowns: Object.freeze([]),
      conflicts: Object.freeze([]),
      outputSchemaValid: true,
    }),
    payment: Object.freeze({ priceUsdc: 0, state: "free", receiptId: null }),
  });
}

const EVIDENCE_POINTER_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["id", "sourceSnapshotId", "locator", "observedAt"],
  properties: {
    id: { type: "string", minLength: 1 },
    sourceSnapshotId: { type: "string", minLength: 1 },
    locator: { type: "string", minLength: 1 },
    observedAt: { type: "string", format: "date-time" },
    fieldHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    conflict: { type: "string", minLength: 1 },
  },
});

/** The exact structuredContent contract advertised for every resource tool. */
export function resourceRunEnvelopeSchema(
  resultSchema: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["result", "resourceReceipt", "payment"],
    properties: {
      result: resultSchema,
      resourceReceipt: {
        type: "object",
        additionalProperties: false,
        required: [
          "resourceProductId", "resourceVersion", "semanticHash", "freshness",
          "evidence", "unknowns", "conflicts", "outputSchemaValid",
        ],
        properties: {
          resourceProductId: { type: "string", minLength: 1 },
          resourceVersion: { type: "string", minLength: 1 },
          semanticHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
          freshness: { enum: ["fresh", "stale", "mixed"] },
          evidence: { type: "array", items: EVIDENCE_POINTER_SCHEMA },
          unknowns: { type: "array", items: { type: "string" } },
          conflicts: { type: "array", items: { type: "string" } },
          outputSchemaValid: { const: true },
        },
      },
      payment: {
        type: "object",
        additionalProperties: false,
        required: ["priceUsdc", "state", "receiptId"],
        properties: {
          priceUsdc: { type: "number", minimum: 0 },
          state: { enum: [...RESOURCE_PAYMENT_STATES] },
          receiptId: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
        },
      },
      // AP2 authorization is transport metadata around the same canonical
      // Resource envelope. It is optional because ordinary HTTP/x402, MCP,
      // and A2A calls return the three-field envelope without AP2.
      ap2: {
        type: "object",
        additionalProperties: false,
        required: ["profile", "authorizationMode", "checkoutReceipt"],
        properties: {
          profile: { const: "ap2-v0.2-experimental" },
          authorizationMode: { enum: ["direct", "autonomous"] },
          checkoutReceipt: { type: "string", minLength: 1 },
        },
      },
    },
  });
}

/** Safe complete example for x402/Bazaar discovery of an immutable Resource. */
export function resourceRunEnvelopeExample(input: {
  readonly resourceProductId: string;
  readonly resourceVersion: string;
  readonly semanticHash: string;
  readonly freshness: "fresh" | "stale" | "mixed";
  readonly priceUsdc: number;
}): Readonly<Record<string, unknown>> {
  return Object.freeze({
    // Every approved Resource Job Contract accepts the empty deterministic
    // result, so this remains valid without inventing a record or evidence.
    result: Object.freeze([]),
    resourceReceipt: Object.freeze({
      resourceProductId: input.resourceProductId,
      resourceVersion: input.resourceVersion,
      semanticHash: input.semanticHash,
      freshness: input.freshness,
      evidence: Object.freeze([]),
      unknowns: Object.freeze([]),
      conflicts: Object.freeze([]),
      outputSchemaValid: true,
    }),
    payment: Object.freeze({
      priceUsdc: input.priceUsdc,
      state: input.priceUsdc > 0 ? "settled" : "free",
      receiptId: "resource-receipt-example",
    }),
  });
}

function schemaValueAccepts(schema: unknown, value: unknown): boolean {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
  const rule = schema as Readonly<Record<string, unknown>>;
  if (Array.isArray(rule.anyOf)) return rule.anyOf.some((candidate) => schemaValueAccepts(candidate, value));
  if (Object.hasOwn(rule, "const") && rule.const !== value) return false;
  if (Array.isArray(rule.enum) && !rule.enum.some((candidate) => jsonValuesEqual(candidate, value))) return false;
  const type = rule.type;
  if (type === undefined) return true;
  if (type === "null") return value === null;
  if (type === "boolean") return typeof value === "boolean";
  if (type === "string") {
    if (typeof value !== "string") return false;
    if (typeof rule.minLength === "number" && value.length < rule.minLength) return false;
    if (typeof rule.maxLength === "number" && value.length > rule.maxLength) return false;
    if (typeof rule.pattern === "string" && !new RegExp(rule.pattern, "u").test(value)) return false;
    if (rule.format === "date-time" && Number.isNaN(Date.parse(value))) return false;
    return true;
  }
  if (type === "number") return typeof value === "number" && Number.isFinite(value) &&
    (typeof rule.minimum !== "number" || value >= rule.minimum) &&
    (typeof rule.maximum !== "number" || value <= rule.maximum);
  if (type === "integer") return typeof value === "number" && Number.isSafeInteger(value) &&
    (typeof rule.minimum !== "number" || value >= rule.minimum) &&
    (typeof rule.maximum !== "number" || value <= rule.maximum);
  if (type === "array") return Array.isArray(value) &&
    (typeof rule.minItems !== "number" || value.length >= rule.minItems) &&
    (typeof rule.maxItems !== "number" || value.length <= rule.maxItems) &&
    value.every((entry) => schemaValueAccepts(rule.items, entry));
  if (type !== "object" || !value || typeof value !== "object" || Array.isArray(value)) return false;
  const properties = rule.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return false;
  const source = value as Readonly<Record<string, unknown>>;
  const allowed = properties as Readonly<Record<string, unknown>>;
  if (rule.additionalProperties === false && Object.keys(source).some((key) => !Object.hasOwn(allowed, key))) return false;
  if (Array.isArray(rule.required) && rule.required.some((key) => typeof key !== "string" || !Object.hasOwn(source, key))) return false;
  return Object.entries(source).every(([key, entry]) => !Object.hasOwn(allowed, key) || schemaValueAccepts(allowed[key], entry));
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object" ||
      Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((entry, index) => jsonValuesEqual(entry, right[index]));
  }
  const leftRecord = left as Readonly<Record<string, unknown>>;
  const rightRecord = right as Readonly<Record<string, unknown>>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && jsonValuesEqual(leftRecord[key], rightRecord[key]));
}

/** Runtime proof that structuredContent conforms to the advertised schema. */
export function resourceRunEnvelopeAccepts(schema: unknown, value: unknown): boolean {
  return schemaValueAccepts(schema, value);
}
