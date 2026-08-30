import {
  DEPENDENCY_KINDS,
  type DependencyKind,
  type DependencyPinInput,
} from "./types";

export interface VersionCreationInput {
  readonly flowId: string;
  readonly ownerId: string;
  readonly label?: string;
  readonly description?: string;
  readonly dependencies?: readonly DependencyPinInput[];
}

export interface NormalizedVersionCreationInput {
  readonly flowId: string;
  readonly ownerId: string;
  readonly label?: string;
  readonly description?: string;
  readonly dependencies: readonly DependencyPinInput[];
}

interface ComparableDependency {
  readonly kind: DependencyKind;
  readonly resourceId: string;
  readonly version: string;
  readonly contentHash?: string;
}

const dependencyKinds = new Set<string>(DEPENDENCY_KINDS);
const MAX_ID_BYTES = 512;
const MAX_LABEL_BYTES = 200;
const MAX_DESCRIPTION_BYTES = 2_000;
const MAX_DEPENDENCIES = 1_000;
const MAX_DEPENDENCY_BYTES = 1024 * 1024;

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function requireVersionText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} is required`);
  }
  const normalized = value.trim();
  if (utf8Bytes(normalized) > MAX_ID_BYTES) throw new TypeError(`${field} is too long`);
  return normalized;
}

function optionalVersionText(value: unknown, field: string, maximum = MAX_ID_BYTES): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  const normalized = value.trim();
  if (normalized.length === 0) return undefined;
  if (utf8Bytes(normalized) > maximum) throw new TypeError(`${field} is too long`);
  return normalized;
}

export function compareDependencyContent(
  left: ComparableDependency,
  right: ComparableDependency,
): number {
  const leftKey = JSON.stringify([
    left.kind,
    left.resourceId,
    left.version,
    left.contentHash ?? null,
  ]);
  const rightKey = JSON.stringify([
    right.kind,
    right.resourceId,
    right.version,
    right.contentHash ?? null,
  ]);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

export function normalizeDependencyPins(value: unknown): DependencyPinInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError("dependencies must be an array");
  if (value.length > MAX_DEPENDENCIES) throw new TypeError("too many dependency pins");
  let aggregateBytes = 0;
  const normalized = value.map((candidate): DependencyPinInput => {
    if (candidate === null || typeof candidate !== "object") {
      throw new TypeError("dependency pin must be an object");
    }
    const dependency = candidate as Record<string, unknown>;
    const kind = dependency.kind;
    if (typeof kind !== "string" || !dependencyKinds.has(kind)) {
      throw new TypeError(`Invalid dependency kind: ${String(kind)}`);
    }
    const contentHash = optionalVersionText(dependency.contentHash, "dependency contentHash");
    const normalizedDependency = {
      kind: kind as DependencyKind,
      resourceId: requireVersionText(dependency.resourceId, "dependency resourceId"),
      version: requireVersionText(dependency.version, "dependency version"),
      ...(contentHash === undefined ? {} : { contentHash }),
    };
    aggregateBytes += utf8Bytes(JSON.stringify(normalizedDependency));
    if (aggregateBytes > MAX_DEPENDENCY_BYTES) throw new TypeError("dependency pins are too large");
    return normalizedDependency;
  });
  normalized.sort(compareDependencyContent);
  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1];
    const current = normalized[index];
    if (previous.kind === current.kind && previous.resourceId === current.resourceId) {
      throw new TypeError(`Duplicate dependency pin: ${current.kind}/${current.resourceId}`);
    }
  }
  return normalized;
}

export function normalizeVersionCreationInput(
  input: VersionCreationInput,
): NormalizedVersionCreationInput {
  const label = optionalVersionText(input.label, "label", MAX_LABEL_BYTES);
  const description = optionalVersionText(input.description, "description", MAX_DESCRIPTION_BYTES);
  return {
    flowId: requireVersionText(input.flowId, "flowId"),
    ownerId: requireVersionText(input.ownerId, "ownerId"),
    dependencies: normalizeDependencyPins(input.dependencies),
    ...(label === undefined ? {} : { label }),
    ...(description === undefined ? {} : { description }),
  };
}
