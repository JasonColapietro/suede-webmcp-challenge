import { compareResourceCanonical, parseResourcePackContent, resourceSchemaAccepts } from "./schemas";
import { resourcePackSemanticHash } from "./pack-hash";
import type { EvidencePointer, ResourceFreshness, ResourceJsonValue, ResourcePackBundle, ResourceQueryParams, ResourceQueryResult } from "./types";
import { RESOURCE_QUERY_LIMIT, RESOURCE_QUERY_LIMITS } from "./query-limits";

export { RESOURCE_QUERY_LIMIT, RESOURCE_QUERY_LIMITS } from "./query-limits";

export const RESOURCE_QUERY_ERROR = "Resource query refused.";
const SHA256 = /^[a-f0-9]{64}$/u;
const FRESHNESS = new Set<ResourceFreshness>(["fresh", "stale", "mixed"]);

export interface ResourcePackReader {
  getExactPack(reference: Readonly<{ resourceProductId: string; packVersionId: string; semanticHash: string }>): ResourcePackBundle | null | Promise<ResourcePackBundle | null>;
}

function refused(): never { throw new TypeError(RESOURCE_QUERY_ERROR); }
function bytes(value: string): number { return new TextEncoder().encode(value).byteLength; }

function text(value: unknown, maximum: number = RESOURCE_QUERY_LIMITS.idBytes): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) refused();
  const normalized = value.normalize("NFC");
  if (bytes(normalized) > maximum) refused();
  return normalized;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) refused();
  const prototype = Object.getPrototypeOf(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length !== 0) refused();
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !("value" in descriptor) || key === "__proto__" || key === "prototype" || key === "constructor") refused();
    result[key] = descriptor.value;
  }
  return result;
}

function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  const source = record(value);
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(source, key)) || Object.keys(source).some((key) => !allowed.has(key))) refused();
  return source;
}

function array(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum || Object.getOwnPropertySymbols(value).length !== 0) refused();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const expected = new Set(["length", ...value.map((_entry, index) => String(index))]);
  if (Object.keys(descriptors).some((key) => !expected.has(key))) refused();
  return value.map((entry, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) refused();
    return entry;
  });
}

interface JsonBudget { values: number; bytes: number }
function json(value: unknown, budget: JsonBudget, depth = 0): ResourceJsonValue {
  if (depth > RESOURCE_QUERY_LIMITS.depth) refused();
  budget.values += 1;
  if (budget.values > RESOURCE_QUERY_LIMITS.filterValues) refused();
  if (typeof value === "string") {
    const parsed = text(value, RESOURCE_QUERY_LIMITS.filterBytes);
    budget.bytes += bytes(parsed);
    if (budget.bytes > RESOURCE_QUERY_LIMITS.filterBytes) refused();
    return parsed;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) refused();
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return Object.freeze(array(value, RESOURCE_QUERY_LIMITS.filterValues).map((entry) => json(entry, budget, depth + 1)));
  const source = record(value);
  const result = Object.create(null) as Record<string, ResourceJsonValue>;
  const keys = Object.keys(source).map((raw) => Object.freeze({ raw, normalized: text(raw) })).sort((left, right) => compareResourceCanonical(left.normalized, right.normalized));
  if (new Set(keys.map((key) => key.normalized)).size !== keys.length) refused();
  for (const key of keys) {
    const normalized = key.normalized;
    budget.bytes += bytes(normalized);
    if (budget.bytes > RESOURCE_QUERY_LIMITS.filterBytes) refused();
    result[normalized] = json(source[key.raw], budget, depth + 1);
  }
  return Object.freeze(result);
}

function fieldList(value: unknown): readonly string[] {
  const fields = array(value, RESOURCE_QUERY_LIMITS.filterFields).map((entry) => text(entry));
  if (new Set(fields).size !== fields.length) refused();
  return Object.freeze(fields);
}

function parseQueryParams(value: unknown): ResourceQueryParams {
  const source = exact(value, ["resourceProductId", "packVersionId", "semanticHash", "filters", "filterFields", "returnFields"], ["limit"]);
  const resourceProductId = text(source.resourceProductId);
  const packVersionId = text(source.packVersionId);
  if (typeof source.semanticHash !== "string" || !SHA256.test(source.semanticHash)) refused();
  const filterFields = fieldList(source.filterFields);
  const returnFields = fieldList(source.returnFields);
  const rawFilters = record(source.filters);
  const keys = Object.keys(rawFilters).map((raw) => Object.freeze({ raw, normalized: text(raw) })).sort((left, right) => compareResourceCanonical(left.normalized, right.normalized));
  if (new Set(keys.map((entry) => entry.normalized)).size !== keys.length || keys.length !== filterFields.length || keys.some((entry, index) => entry.normalized !== [...filterFields].sort(compareResourceCanonical)[index])) refused();
  const budget: JsonBudget = { values: 0, bytes: 0 };
  const filters = Object.create(null) as Record<string, ResourceJsonValue>;
  for (const key of keys) filters[key.normalized] = json(rawFilters[key.raw], budget);
  let suppliedLimit: number | undefined;
  if (source.limit !== undefined) {
    if (typeof source.limit !== "number" || !Number.isSafeInteger(source.limit) || source.limit < 1 || source.limit > RESOURCE_QUERY_LIMIT) refused();
    suppliedLimit = source.limit;
  }
  return Object.freeze({ resourceProductId, packVersionId, semanticHash: source.semanticHash, filters: Object.freeze(filters), filterFields, returnFields, ...(suppliedLimit === undefined ? {} : { limit: suppliedLimit }) });
}

export function parseResourceQueryParams(value: unknown): ResourceQueryParams {
  try { return parseQueryParams(value); } catch { return refused(); }
}

function parsePackBundle(value: unknown): ResourcePackBundle {
  const source = exact(value, ["resourceProductId", "packVersionId", "semanticHash", "freshness", "content"]);
  const resourceProductId = text(source.resourceProductId);
  const packVersionId = text(source.packVersionId);
  if (typeof source.semanticHash !== "string" || !SHA256.test(source.semanticHash) || !FRESHNESS.has(source.freshness as ResourceFreshness)) refused();
  let content;
  try { content = parseResourcePackContent(source.content); } catch { refused(); }
  return Object.freeze({ resourceProductId, packVersionId, semanticHash: source.semanticHash, freshness: source.freshness as ResourceFreshness, content });
}

export function parseResourcePackBundle(value: unknown): ResourcePackBundle {
  try { return parsePackBundle(value); } catch { return refused(); }
}

function sameJson(left: ResourceJsonValue, right: ResourceJsonValue): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((item, index) => sameJson(item, right[index]!));
  const leftRecord = left as Readonly<Record<string, ResourceJsonValue>>;
  const rightRecord = right as Readonly<Record<string, ResourceJsonValue>>;
  const leftKeys = Object.keys(leftRecord).sort(compareResourceCanonical);
  const rightKeys = Object.keys(rightRecord).sort(compareResourceCanonical);
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && sameJson(leftRecord[key]!, rightRecord[key]!));
}

export async function executeResourceQuery(reader: ResourcePackReader, value: ResourceQueryParams): Promise<ResourceQueryResult> {
  try {
    const params = parseResourceQueryParams(value);
    if (!reader || typeof reader.getExactPack !== "function") refused();
    const rawPack = await reader.getExactPack({ resourceProductId: params.resourceProductId, packVersionId: params.packVersionId, semanticHash: params.semanticHash });
    const pack = parseResourcePackBundle(rawPack);
    if (pack.resourceProductId !== params.resourceProductId || pack.packVersionId !== params.packVersionId || pack.semanticHash !== params.semanticHash || resourcePackSemanticHash(pack.content).semanticHash !== pack.semanticHash) refused();
    const content = pack.content;
    const properties = content.recordSchema.type === "object" ? content.recordSchema.properties as Readonly<Record<string, unknown>> : undefined;
    if (!properties || params.filterFields.some((field) => !content.filterFields.includes(field)) || params.returnFields.some((field) => !content.returnFields.includes(field))) refused();
    const evidenceById = new Map(content.evidence.map((evidence) => [evidence.id, evidence]));
    const unknowns = new Set<string>();
    const conflicts = new Set<string>();
    const evidence = new Map<string, EvidencePointer>();
    const result: Readonly<Record<string, ResourceJsonValue>>[] = [];
    for (const item of content.records) {
      if (!params.filterFields.every((field) => Object.hasOwn(item.fields, field) && sameJson(item.fields[field]!, params.filters[field]!))) continue;
      const projected: Record<string, ResourceJsonValue> = Object.create(null);
      for (const field of params.returnFields) {
        if (Object.hasOwn(item.fields, field)) projected[field] = item.fields[field]!;
        else unknowns.add(field);
      }
      for (const field of item.unknowns ?? []) unknowns.add(field);
      for (const field of item.conflicts ?? []) conflicts.add(field);
      for (const id of item.evidenceIds) {
        const pointer = evidenceById.get(id);
        if (pointer) evidence.set(id, pointer);
      }
      result.push(Object.freeze(projected));
      if (result.length >= (params.limit ?? RESOURCE_QUERY_LIMIT)) break;
    }
    const frozenResult = Object.freeze(result);
    return Object.freeze({ result: frozenResult, resourceReceipt: Object.freeze({ resourceProductId: pack.resourceProductId, resourceVersion: pack.packVersionId, semanticHash: pack.semanticHash, freshness: pack.freshness, evidence: Object.freeze([...evidence.values()].sort((left, right) => compareResourceCanonical(left.id, right.id))), unknowns: Object.freeze([...unknowns].sort(compareResourceCanonical)), conflicts: Object.freeze([...conflicts].sort(compareResourceCanonical)), outputSchemaValid: resourceSchemaAccepts(content.jobContract.outputSchema, frozenResult as unknown as ResourceJsonValue) }) });
  } catch {
    throw new TypeError(RESOURCE_QUERY_ERROR);
  }
}
