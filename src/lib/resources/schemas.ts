import { z } from "zod";
import type {
  EvidencePointer, ResourceDiscoveryAccess, ResourceExecutionAccess, ResourceJobContract,
  ResourceJsonSchema, ResourceJsonValue, ResourcePackContent, ResourceProduct,
  ResourceProductStatus, ResourceRecord, ResourceSourceSnapshot, ResourceTaxonomyEntry,
  SourceProvenance,
} from "./types";

export const RESOURCE_INPUT_ERROR = "Invalid resource input.";
export const RESOURCE_LIMITS = Object.freeze({
  idBytes: 128,
  nameBytes: 160,
  slugBytes: 160,
  jobTextBytes: 4 * 1024,
  schemaDepth: 12,
  schemaValues: 2_000,
  jsonDepth: 16,
  jsonValues: 10_000,
  records: 2_000,
  fieldsPerRecord: 64,
  tagsPerRecord: 32,
  taxonomy: 256,
  evidence: 4_000,
  evidencePerRecord: 32,
  evidenceLocatorBytes: 1_024,
  sourceSnapshotIds: 512,
  safeExampleBytes: 32 * 1024,
  provenanceNoteBytes: 1_024,
  packTotalBytes: 512 * 1024,
  packTotalValues: 20_000,
} as const);

const CONTROL = /[\u0000-\u001f\u007f]/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const PUBLIC_EVIDENCE_LOCATOR = /^(?:row|page|evidence):[A-Za-z0-9._:-]{1,1000}$/u;
const PRODUCT_STATUSES = new Set<ResourceProductStatus>(["draft", "test", "live", "paused", "retired"]);
const EXECUTION_ACCESS = new Set<ResourceExecutionAccess>(["free", "paid", "private"]);
const DISCOVERY_ACCESS = new Set<ResourceDiscoveryAccess>(["public", "unlisted"]);
const PROVENANCE = new Set<SourceProvenance>(["mine", "licensed_or_permissioned", "public_source", "other_or_unspecified"]);
const JSON_SCHEMA_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

function invalid(): never { throw new TypeError(RESOURCE_INPUT_ERROR); }

function byteLength(value: string): number { return Buffer.byteLength(value, "utf8"); }

/** Stable across runtimes: NFC-normalized strings sort by JavaScript UTF-16 code units. */
export function compareResourceCanonical(left: string, right: string): number {
  const normalizedLeft = left.normalize("NFC");
  const normalizedRight = right.normalize("NFC");
  if (normalizedLeft !== normalizedRight) return normalizedLeft < normalizedRight ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || CONTROL.test(value)) invalid();
  const normalized = value.normalize("NFC");
  if (byteLength(normalized) > maximum) invalid();
  return normalized;
}

function timestamp(value: unknown): string {
  const parsed = text(value, 64);
  if (Number.isNaN(Date.parse(parsed))) invalid();
  return parsed;
}

function safeRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  let symbols: symbol[];
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(value);
    symbols = Object.getOwnPropertySymbols(value);
  } catch { invalid(); }
  if ((prototype !== Object.prototype && prototype !== null) || symbols.length !== 0) invalid();
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !("value" in descriptor) || key === "__proto__" || key === "prototype" || key === "constructor") invalid();
    result[key] = descriptor.value;
  }
  return result;
}

function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  const record = safeRecord(value);
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(record, key)) || Object.keys(record).some((key) => !allowed.has(key))) invalid();
  return record;
}

function safeArray(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum || Object.getOwnPropertySymbols(value).length !== 0) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const expected = new Set(["length", ...value.map((_entry, index) => String(index))]);
  if (Object.keys(descriptors).some((key) => !expected.has(key))) invalid();
  return value.map((entry, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
    return entry;
  });
}

interface InputBudget { values: number; bytes: number; active: WeakSet<object> }

/** Counts the entire pack before parsing, without invoking accessors or traversing prototypes. */
function inspectPackInput(value: unknown, budget: InputBudget, depth = 0): void {
  if (depth > RESOURCE_LIMITS.jsonDepth + RESOURCE_LIMITS.schemaDepth) invalid();
  budget.values += 1;
  if (budget.values > RESOURCE_LIMITS.packTotalValues) invalid();
  if (typeof value === "string") {
    budget.bytes += byteLength(value);
    if (budget.bytes > RESOURCE_LIMITS.packTotalBytes) invalid();
    return;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) invalid();
    return;
  }
  if (typeof value !== "object") invalid();
  if (budget.active.has(value)) invalid();
  budget.active.add(value);
  if (Array.isArray(value)) {
    const values = safeArray(value, RESOURCE_LIMITS.packTotalValues);
    for (const entry of values) inspectPackInput(entry, budget, depth + 1);
    budget.active.delete(value);
    return;
  }
  const record = safeRecord(value);
  for (const key of Object.keys(record)) {
    budget.bytes += byteLength(key);
    if (budget.bytes > RESOURCE_LIMITS.packTotalBytes) invalid();
    inspectPackInput(record[key], budget, depth + 1);
  }
  budget.active.delete(value);
}

function unique(values: readonly string[]): readonly string[] {
  if (new Set(values).size !== values.length) invalid();
  return values;
}

/** Reject aliases before normalization can overwrite a field during canonicalization. */
function canonicalKeys(record: Readonly<Record<string, unknown>>): readonly { readonly raw: string; readonly normalized: string }[] {
  const keys = Object.keys(record).map((raw) => Object.freeze({ raw, normalized: text(raw, RESOURCE_LIMITS.idBytes) }));
  if (new Set(keys.map((key) => key.normalized)).size !== keys.length) invalid();
  return keys.sort((left, right) => compareResourceCanonical(left.normalized, right.normalized));
}

function freeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  const pending: object[] = [value as object];
  const seen = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(current))) {
      if ("value" in descriptor && descriptor.value !== null && typeof descriptor.value === "object") pending.push(descriptor.value as object);
    }
    Object.freeze(current);
  }
  return value;
}

interface JsonBudget { values: number }
interface SchemaBudget { values: number }
interface PackParseBudget { readonly json: JsonBudget; readonly schema: SchemaBudget }

function createPackParseBudget(): PackParseBudget { return { json: { values: 0 }, schema: { values: 0 } }; }

function json(value: unknown, depth = 0, budget: JsonBudget = { values: 0 }): ResourceJsonValue {
  if (depth > RESOURCE_LIMITS.jsonDepth) invalid();
  budget.values += 1;
  if (budget.values > RESOURCE_LIMITS.jsonValues) invalid();
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid();
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "string") return text(value, RESOURCE_LIMITS.safeExampleBytes);
  if (Array.isArray(value)) return freeze(safeArray(value, RESOURCE_LIMITS.jsonValues).map((entry) => json(entry, depth + 1, budget)));
  const record = safeRecord(value);
  const result = Object.create(null) as Record<string, ResourceJsonValue>;
  for (const key of canonicalKeys(record)) result[key.normalized] = json(record[key.raw], depth + 1, budget);
  return freeze(result);
}

function schema(value: unknown, depth = 0, budget: SchemaBudget = { values: 0 }, jsonBudget: JsonBudget = { values: 0 }): ResourceJsonSchema {
  if (depth > RESOURCE_LIMITS.schemaDepth) invalid();
  budget.values += 1;
  if (budget.values > RESOURCE_LIMITS.schemaValues) invalid();
  const record = safeRecord(value);
  if (typeof record.type !== "string" || !JSON_SCHEMA_TYPES.has(record.type)) invalid();
  const type = record.type;
  const allowed = type === "object" ? ["type", "properties", "required", "additionalProperties", "enum"]
    : type === "array" ? ["type", "items", "minItems", "maxItems", "enum"]
      : type === "string" ? ["type", "minLength", "maxLength", "enum"]
        : type === "number" || type === "integer" ? ["type", "minimum", "maximum", "enum"]
          : type === "boolean" || type === "null" ? ["type", "enum"] : [];
  if (Object.keys(record).some((key) => !allowed.includes(key))) invalid();
  const result = Object.create(null) as Record<string, ResourceJsonValue>;
  result.type = type;
  if (type === "object") {
    if (record.additionalProperties !== false || !Object.hasOwn(record, "properties") || !Object.hasOwn(record, "required")) invalid();
    const properties = safeRecord(record.properties);
    const output = Object.create(null) as Record<string, ResourceJsonValue>;
    for (const key of canonicalKeys(properties)) output[key.normalized] = schema(properties[key.raw], depth + 1, budget, jsonBudget);
    const required = unique(safeArray(record.required, RESOURCE_LIMITS.fieldsPerRecord).map((entry) => text(entry, RESOURCE_LIMITS.idBytes)));
    if (required.some((key) => !Object.hasOwn(output, key))) invalid();
    result.properties = freeze(output);
    result.required = freeze([...required].sort(compareResourceCanonical));
    result.additionalProperties = false;
  } else if (type === "array") {
    if (!Object.hasOwn(record, "items")) invalid();
    result.items = schema(record.items, depth + 1, budget, jsonBudget);
    for (const key of ["minItems", "maxItems"] as const) {
      if (record[key] !== undefined) {
        if (!Number.isSafeInteger(record[key]) || (record[key] as number) < 0) invalid();
        result[key] = record[key] as number;
      }
    }
    if (typeof result.minItems === "number" && typeof result.maxItems === "number" && result.minItems > result.maxItems) invalid();
  } else {
    for (const key of type === "string" ? ["minLength", "maxLength"] : ["minimum", "maximum"]) {
      if (record[key] !== undefined) {
        if (typeof record[key] !== "number" || !Number.isFinite(record[key])) invalid();
        result[key] = Object.is(record[key], -0) ? 0 : record[key] as number;
      }
    }
    if (typeof result.minLength === "number" && typeof result.maxLength === "number" && result.minLength > result.maxLength) invalid();
    if (typeof result.minimum === "number" && typeof result.maximum === "number" && result.minimum > result.maximum) invalid();
  }
  if (record.enum !== undefined) {
    const values = safeArray(record.enum, RESOURCE_LIMITS.fieldsPerRecord).map((entry) => json(entry, 0, jsonBudget));
    if (values.length === 0) invalid();
    result.enum = freeze(values);
  }
  return freeze(result);
}

function parseProduct(value: unknown): ResourceProduct {
  const source = exact(value, ["id", "ownerId", "name", "slug", "status", "executionAccess", "discoveryAccess"]);
  if (!PRODUCT_STATUSES.has(source.status as ResourceProductStatus) || !EXECUTION_ACCESS.has(source.executionAccess as ResourceExecutionAccess) || !DISCOVERY_ACCESS.has(source.discoveryAccess as ResourceDiscoveryAccess)) invalid();
  return freeze({ id: text(source.id, RESOURCE_LIMITS.idBytes), ownerId: text(source.ownerId, RESOURCE_LIMITS.idBytes), name: text(source.name, RESOURCE_LIMITS.nameBytes), slug: text(source.slug, RESOURCE_LIMITS.slugBytes), status: source.status as ResourceProductStatus, executionAccess: source.executionAccess as ResourceExecutionAccess, discoveryAccess: source.discoveryAccess as ResourceDiscoveryAccess });
}

function parseSource(value: unknown): ResourceSourceSnapshot {
  const source = exact(value, ["id", "resourceProductId", "locator", "sourceKind", "capturedAt", "contentHash", "freshnessDeadline"], ["sourcePublishedAt", "provenance", "provenanceNote"]);
  if (typeof source.contentHash !== "string" || !SHA256.test(source.contentHash)) invalid();
  if (source.provenance !== undefined && !PROVENANCE.has(source.provenance as SourceProvenance)) invalid();
  return freeze({ id: text(source.id, RESOURCE_LIMITS.idBytes), resourceProductId: text(source.resourceProductId, RESOURCE_LIMITS.idBytes), locator: text(source.locator, RESOURCE_LIMITS.evidenceLocatorBytes), sourceKind: text(source.sourceKind, RESOURCE_LIMITS.idBytes), capturedAt: timestamp(source.capturedAt), ...(source.sourcePublishedAt === undefined ? {} : { sourcePublishedAt: timestamp(source.sourcePublishedAt) }), contentHash: source.contentHash, freshnessDeadline: timestamp(source.freshnessDeadline), ...(source.provenance === undefined ? {} : { provenance: source.provenance as SourceProvenance }), ...(source.provenanceNote === undefined ? {} : { provenanceNote: text(source.provenanceNote, RESOURCE_LIMITS.provenanceNoteBytes) }) });
}

function parseContract(value: unknown, budget = createPackParseBudget()): ResourceJobContract {
  const source = exact(value, ["jobStatement", "buyerIntent", "inputSchema", "outputSchema", "unsupportedRequest", "evidenceRequirement", "safeExample", "reviewBoundary", "dataHandlingDisclosure"]);
  const contract = freeze({ jobStatement: text(source.jobStatement, RESOURCE_LIMITS.jobTextBytes), buyerIntent: text(source.buyerIntent, RESOURCE_LIMITS.jobTextBytes), inputSchema: schema(source.inputSchema, 0, budget.schema, budget.json), outputSchema: schema(source.outputSchema, 0, budget.schema, budget.json), unsupportedRequest: text(source.unsupportedRequest, RESOURCE_LIMITS.jobTextBytes), evidenceRequirement: text(source.evidenceRequirement, RESOURCE_LIMITS.jobTextBytes), safeExample: json(source.safeExample, 0, budget.json), reviewBoundary: text(source.reviewBoundary, RESOURCE_LIMITS.jobTextBytes), dataHandlingDisclosure: text(source.dataHandlingDisclosure, RESOURCE_LIMITS.jobTextBytes) });
  if (!resourceSchemaAccepts(contract.outputSchema, contract.safeExample)) invalid();
  return contract;
}

export function parseEvidencePointer(value: unknown): EvidencePointer {
  const source = exact(value, ["id", "sourceSnapshotId", "locator", "observedAt"], ["fieldHash", "confidence", "conflict"]);
  if (source.fieldHash !== undefined && (typeof source.fieldHash !== "string" || !SHA256.test(source.fieldHash))) invalid();
  if (source.confidence !== undefined && (typeof source.confidence !== "number" || !Number.isFinite(source.confidence) || source.confidence < 0 || source.confidence > 1)) invalid();
  const locator = text(source.locator, RESOURCE_LIMITS.evidenceLocatorBytes);
  if (!PUBLIC_EVIDENCE_LOCATOR.test(locator)) invalid();
  return freeze({ id: text(source.id, RESOURCE_LIMITS.idBytes), sourceSnapshotId: text(source.sourceSnapshotId, RESOURCE_LIMITS.idBytes), locator, observedAt: timestamp(source.observedAt), ...(source.fieldHash === undefined ? {} : { fieldHash: source.fieldHash }), ...(source.confidence === undefined ? {} : { confidence: source.confidence }), ...(source.conflict === undefined ? {} : { conflict: text(source.conflict, RESOURCE_LIMITS.idBytes) }) });
}

function parseRecord(value: unknown, budget: PackParseBudget): ResourceRecord {
  const source = exact(value, ["id", "fields", "tags", "evidenceIds"], ["unknowns", "conflicts"]);
  const fields = safeRecord(source.fields);
  if (Object.keys(fields).length > RESOURCE_LIMITS.fieldsPerRecord) invalid();
  const parsedFields = Object.create(null) as Record<string, ResourceJsonValue>;
  for (const key of canonicalKeys(fields)) parsedFields[key.normalized] = json(fields[key.raw], 0, budget.json);
  const strings = (value: unknown, limit: number): readonly string[] => unique(safeArray(value, limit).map((entry) => text(entry, RESOURCE_LIMITS.idBytes)));
  return freeze({ id: text(source.id, RESOURCE_LIMITS.idBytes), fields: freeze(parsedFields), tags: freeze([...strings(source.tags, RESOURCE_LIMITS.tagsPerRecord)].sort(compareResourceCanonical)), evidenceIds: freeze([...strings(source.evidenceIds, RESOURCE_LIMITS.evidencePerRecord)].sort(compareResourceCanonical)), ...(source.unknowns === undefined ? {} : { unknowns: freeze([...strings(source.unknowns, RESOURCE_LIMITS.fieldsPerRecord)].sort(compareResourceCanonical)) }), ...(source.conflicts === undefined ? {} : { conflicts: freeze([...strings(source.conflicts, RESOURCE_LIMITS.fieldsPerRecord)].sort(compareResourceCanonical)) }) });
}

function parseContent(value: unknown): ResourcePackContent {
  inspectPackInput(value, { values: 0, bytes: 0, active: new WeakSet<object>() });
  const budget = createPackParseBudget();
  const source = exact(value, ["recordSchema", "filterFields", "returnFields", "taxonomy", "records", "evidence", "sourceSnapshotIds", "jobContract"]);
  const recordSchema = schema(source.recordSchema, 0, budget.schema, budget.json);
  const properties = recordSchema.type === "object" ? recordSchema.properties as Readonly<Record<string, ResourceJsonValue>> : undefined;
  if (!properties) invalid();
  const declaredFields = (value: unknown): readonly string[] => unique(safeArray(value, RESOURCE_LIMITS.fieldsPerRecord).map((entry) => text(entry, RESOURCE_LIMITS.idBytes)));
  const filterFields = declaredFields(source.filterFields);
  const returnFields = declaredFields(source.returnFields);
  if (filterFields.some((field) => !Object.hasOwn(properties, field)) || returnFields.some((field) => !Object.hasOwn(properties, field))) invalid();
  const taxonomy = safeArray(source.taxonomy, RESOURCE_LIMITS.taxonomy).map((entry): ResourceTaxonomyEntry => {
    const item = exact(entry, ["id", "label"]);
    return freeze({ id: text(item.id, RESOURCE_LIMITS.idBytes), label: text(item.label, RESOURCE_LIMITS.nameBytes) });
  });
  const records = safeArray(source.records, RESOURCE_LIMITS.records).map((record) => parseRecord(record, budget));
  const evidence = safeArray(source.evidence, RESOURCE_LIMITS.evidence).map(parseEvidencePointer);
  const snapshotIds = unique(safeArray(source.sourceSnapshotIds, RESOURCE_LIMITS.sourceSnapshotIds).map((entry) => text(entry, RESOURCE_LIMITS.idBytes)));
  for (const identities of [taxonomy.map((entry) => entry.id), records.map((entry) => entry.id), evidence.map((entry) => entry.id)]) if (new Set(identities).size !== identities.length) invalid();
  const evidenceIds = new Set(evidence.map((entry) => entry.id));
  if (records.some((record) => record.evidenceIds.some((id) => !evidenceIds.has(id)))) invalid();
  if (evidence.some((entry) => !snapshotIds.includes(entry.sourceSnapshotId))) invalid();
  if (records.some((record) => !resourceSchemaAccepts(recordSchema, record.fields as ResourceJsonValue))) invalid();
  const jobContract = parseContract(source.jobContract, budget);
  // Deterministic Resource queries can return any bounded subset of records.
  // An enum on the result array is not closed under those subsets unless every
  // possible combination is enumerated, which this bounded validator cannot
  // prove. Refuse that contract shape up front; enums on item fields remain
  // supported and are validated normally.
  if (jobContract.outputSchema.type === "array" && Array.isArray(jobContract.outputSchema.enum)) invalid();
  const projections = records.map((record) => {
    const projected = Object.create(null) as Record<string, ResourceJsonValue>;
    for (const field of returnFields) {
      if (Object.hasOwn(record.fields, field)) projected[field] = record.fields[field]!;
    }
    return freeze(projected);
  });
  // An exact-filter query can always produce no rows and can produce any one
  // matching row. Validate those boundaries plus the largest bounded result;
  // this rejects contracts that could turn a completed paid call into an
  // invalid response after settlement.
  if (!resourceSchemaAccepts(jobContract.outputSchema, freeze([])) ||
      projections.some((projection) => !resourceSchemaAccepts(jobContract.outputSchema, freeze([projection]))) ||
      !resourceSchemaAccepts(jobContract.outputSchema, freeze(projections.slice(0, 100)))) invalid();
  return freeze({ recordSchema, filterFields: freeze([...filterFields].sort(compareResourceCanonical)), returnFields: freeze([...returnFields].sort(compareResourceCanonical)), taxonomy: freeze([...taxonomy].sort((left, right) => compareResourceCanonical(left.id, right.id))), records: freeze([...records].sort((left, right) => compareResourceCanonical(left.id, right.id))), evidence: freeze([...evidence].sort((left, right) => compareResourceCanonical(left.id, right.id))), sourceSnapshotIds: freeze([...snapshotIds].sort(compareResourceCanonical)), jobContract });
}

function boundary<T>(parser: (value: unknown) => T): z.ZodType<T, z.ZodTypeDef, unknown> {
  return z.unknown().transform((value, context) => {
    try { return parser(value); } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, message: RESOURCE_INPUT_ERROR });
      return z.NEVER;
    }
  });
}

export const ResourceProductSchema = boundary(parseProduct);
export const ResourceSourceSnapshotSchema = boundary(parseSource);
export const ResourceJobContractSchema = boundary(parseContract);
export const ResourcePackContentSchema = boundary(parseContent);

export function parseResourceProduct(value: unknown): ResourceProduct { return ResourceProductSchema.parse(value); }
export function parseSourceSnapshot(value: unknown): ResourceSourceSnapshot { return ResourceSourceSnapshotSchema.parse(value); }
export function parseJobContract(value: unknown): ResourceJobContract { return ResourceJobContractSchema.parse(value); }
export function parseResourcePackContent(value: unknown): ResourcePackContent { return ResourcePackContentSchema.parse(value); }

/** Validates a JSON value against the deliberately small supported Job Contract schema subset. */
export function resourceSchemaAccepts(schemaValue: ResourceJsonSchema, value: ResourceJsonValue): boolean {
  const enumValues = schemaValue.enum;
  if (Array.isArray(enumValues) && !enumValues.some((candidate) => resourceJsonEqual(candidate, value))) return false;
  const type = schemaValue.type;
  const minLength = typeof schemaValue.minLength === "number" ? schemaValue.minLength : undefined;
  const maxLength = typeof schemaValue.maxLength === "number" ? schemaValue.maxLength : undefined;
  const minimum = typeof schemaValue.minimum === "number" ? schemaValue.minimum : undefined;
  const maximum = typeof schemaValue.maximum === "number" ? schemaValue.maximum : undefined;
  const minItems = typeof schemaValue.minItems === "number" ? schemaValue.minItems : undefined;
  const maxItems = typeof schemaValue.maxItems === "number" ? schemaValue.maxItems : undefined;
  if (type === "null") return value === null;
  if (type === "boolean") return typeof value === "boolean";
  if (type === "string") return typeof value === "string" && (minLength === undefined || value.length >= minLength) && (maxLength === undefined || value.length <= maxLength);
  if (type === "number") return typeof value === "number" && Number.isFinite(value) && (minimum === undefined || value >= minimum) && (maximum === undefined || value <= maximum);
  if (type === "integer") return typeof value === "number" && Number.isSafeInteger(value) && (minimum === undefined || value >= minimum) && (maximum === undefined || value <= maximum);
  if (type === "array") return Array.isArray(value) && (minItems === undefined || value.length >= minItems) && (maxItems === undefined || value.length <= maxItems) && value.every((entry) => resourceSchemaAccepts(schemaValue.items as ResourceJsonSchema, entry));
  if (type !== "object" || value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const properties = schemaValue.properties as Readonly<Record<string, ResourceJsonSchema>>;
  const required = schemaValue.required as readonly string[];
  const record = value as Readonly<Record<string, ResourceJsonValue>>;
  return Object.keys(record).every((key) => Object.hasOwn(properties, key) && resourceSchemaAccepts(properties[key]!, record[key]!)) && required.every((key) => Object.hasOwn(record, key));
}

function resourceJsonEqual(left: ResourceJsonValue, right: ResourceJsonValue): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((entry, index) => resourceJsonEqual(entry, right[index]!));
  const leftRecord = left as Readonly<Record<string, ResourceJsonValue>>;
  const rightRecord = right as Readonly<Record<string, ResourceJsonValue>>;
  const leftKeys = Object.keys(leftRecord).sort(compareResourceCanonical);
  const rightKeys = Object.keys(rightRecord).sort(compareResourceCanonical);
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && resourceJsonEqual(leftRecord[key]!, rightRecord[key]!));
}
