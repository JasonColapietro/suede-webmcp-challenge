import { z } from "zod";

const identity = z.string().min(1).max(512)
  .refine((value) => value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value));
const assetId = z.string().uuid();
const hash = z.string().regex(/^[0-9a-f]{64}$/u);

const readinessBinding = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("connection"),
    connectionId: identity,
    capability: z.literal("http.headers"),
  }).strict(),
  z.object({
    kind: z.literal("unresolved"),
    requirementKey: identity,
    capability: z.literal("http.headers"),
  }).strict(),
]);

export const ApiOperationReferenceSchema = z.object({
  connectorDefinitionVersionId: assetId,
  operationVersionId: assetId,
  operationId: identity,
  connectorProjectionHash: hash,
  operationProjectionHash: hash,
  schemaHash: hash,
  readinessBinding: readinessBinding.optional(),
}).strict();

export const ApiOperationNodeParamsSchema = ApiOperationReferenceSchema;
export type ApiOperationReference = Readonly<z.infer<typeof ApiOperationReferenceSchema>>;
export type ApiOperationNodeParams = ApiOperationReference;

function freezeDeep<Value>(value: Value, seen = new WeakSet<object>()): Value {
  if (value === null || typeof value !== "object" || seen.has(value as object)) return value;
  seen.add(value as object);
  for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child, seen);
  return Object.freeze(value);
}

export function parseApiOperationReference(value: unknown): ApiOperationReference {
  const parsed = ApiOperationReferenceSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("Invalid API operation node");
  return freezeDeep(parsed.data);
}

export const parseApiOperationNodeParams = parseApiOperationReference;

export function sameApiOperationNodeParams(left: ApiOperationNodeParams, right: unknown): boolean {
  const parsed = ApiOperationReferenceSchema.safeParse(right);
  if (!parsed.success) return false;
  return JSON.stringify(parsed.data) === JSON.stringify(left);
}
