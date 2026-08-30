import type { ResourceDryRun, ResourcePackBundle } from "./client";
import { sha256Utf8 } from "@/lib/flow/subflow-reference";

export interface ResourceRepresentativeDraft {
  readonly inputJson: string;
  readonly expectedProperties: readonly string[];
  readonly limit: string;
}

export interface ResourceRepresentativeValue {
  readonly input: unknown;
  readonly filters: Readonly<Record<string, unknown>>;
  readonly expectedProperties: readonly string[];
  readonly limit?: number;
}

export interface ResourceRepresentativeProof {
  readonly representative: ResourceRepresentativeValue;
  readonly canonical: string;
  readonly digest: string;
  readonly generation: number;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const source = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(source).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(source[key])}`).join(",")}}`;
}

export function canonicalResourceRepresentative(
  representative: ResourceRepresentativeValue,
): string {
  return canonicalJson({
    input: representative.input,
    filters: representative.filters,
    expectedProperties: [...representative.expectedProperties].sort(),
    ...(representative.limit === undefined ? {} : { limit: representative.limit }),
  });
}

export function buildResourceRepresentativeProof(
  representative: ResourceRepresentativeValue,
  generation: number,
): ResourceRepresentativeProof {
  const canonical = canonicalResourceRepresentative(representative);
  return Object.freeze({
    representative,
    canonical,
    digest: sha256Utf8(canonical),
    generation,
  });
}

export function resourceRepresentativeProofIsCurrent(
  proof: ResourceRepresentativeProof,
  generation: number,
  representative: ResourceRepresentativeValue | null,
): boolean {
  return representative !== null && proof.generation === generation &&
    proof.canonical === canonicalResourceRepresentative(representative);
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function sampleValue(schemaValue: unknown): unknown {
  const schema = record(schemaValue);
  if (!schema) return "example";
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (Object.hasOwn(schema, "const")) return schema.const;
  switch (schema.type) {
    case "boolean": return false;
    case "integer":
    case "number": return 0;
    case "array": return [];
    case "object": {
      const properties = record(schema.properties) ?? {};
      const required = Array.isArray(schema.required)
        ? schema.required.filter((entry): entry is string => typeof entry === "string")
        : [];
      return Object.fromEntries(required.map((property) => [
        property,
        sampleValue(properties[property]),
      ]));
    }
    case "null": return null;
    default: return "example";
  }
}

export function buildResourceRepresentativeDraft(
  pack: ResourcePackBundle,
): ResourceRepresentativeDraft {
  const schema = record(pack.content.jobContract.inputSchema) ?? {};
  const properties = record(schema.properties) ?? {};
  const firstRecord = pack.content.records[0]?.fields ?? {};
  const input = Object.fromEntries(pack.content.filterFields.map((field) => [
    field,
    Object.hasOwn(firstRecord, field)
      ? firstRecord[field]
      : sampleValue(properties[field]),
  ]));
  return Object.freeze({
    inputJson: JSON.stringify(input, null, 2),
    expectedProperties: Object.freeze([...pack.content.returnFields]),
    limit: "10",
  });
}

export function parseResourceRepresentativeDraft(
  pack: ResourcePackBundle,
  draft: ResourceRepresentativeDraft,
): ResourceRepresentativeValue | null {
  try {
    const input = JSON.parse(draft.inputJson) as unknown;
    const inputRecord = record(input);
    const inputFields = inputRecord ? Object.keys(inputRecord).sort() : [];
    const filterFields = [...pack.content.filterFields].sort();
    const expectedProperties = [...new Set(draft.expectedProperties)];
    const limit = Number(draft.limit);
    if (!inputRecord || inputFields.length !== filterFields.length ||
        inputFields.some((field, index) => field !== filterFields[index]) ||
        pack.content.records.length === 0 || expectedProperties.length === 0 ||
        expectedProperties.some((property) => !pack.content.returnFields.includes(property)) ||
        !Number.isInteger(limit) || limit < 1 || limit > 100) return null;
    const canonicalInput = Object.freeze({ ...inputRecord });
    return Object.freeze({
      input: canonicalInput,
      filters: canonicalInput,
      expectedProperties: Object.freeze(expectedProperties),
      limit,
    });
  } catch {
    return null;
  }
}

export function resourceRepresentativeForPublication(
  pack: ResourcePackBundle,
  test: ResourceDryRun | null,
  proof: ResourceRepresentativeProof | null,
  currentRepresentative: ResourceRepresentativeValue | null,
): ResourceRepresentativeValue | null {
  if (!test || !proof || !currentRepresentative ||
      proof.canonical !== canonicalResourceRepresentative(currentRepresentative) ||
      proof.digest !== sha256Utf8(proof.canonical) ||
      test.packVersionId !== pack.packVersionId ||
      test.semanticHash !== pack.semanticHash || test.result.length === 0 ||
      proof.representative.expectedProperties.length === 0 ||
      proof.representative.expectedProperties.some((property) =>
        !pack.content.returnFields.includes(property) ||
        test.result.some((row) => !Object.hasOwn(row, property)))) return null;
  return proof.representative;
}
