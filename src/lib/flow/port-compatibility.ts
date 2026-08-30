import type { NodeDefinitionV2 } from "./node-definition-types";
import { getNodeDefinition } from "./node-definitions";
import { createAuthoringNodePortResolver } from "./node-ports";
import type { ValidatedNodePortResolver } from "./node-ports";
import { hasHandleCollision, wouldCreateCycle } from "./graph-invariants";
import type { JsonSchema, JsonValue, NodeType, SupportedFlowGraph } from "./types";

export interface PortCompatibilityVerdict {
  readonly status: "compatible" | "incompatible" | "untyped";
  readonly message: string;
}

export interface TypedConnectionCandidate {
  readonly source: string | null | undefined;
  readonly sourceHandle: string | null | undefined;
  readonly target: string | null | undefined;
  readonly targetHandle: string | null | undefined;
}

export type NodeDefinitionResolver = (type: NodeType) => NodeDefinitionV2;

const SUPPORTED_KEYS = new Set([
  "type",
  "enum",
  "anyOf",
  "oneOf",
  "items",
  "properties",
  "required",
  "additionalProperties",
]);
const JSON_TYPES = new Set(["array", "boolean", "integer", "null", "number", "object", "string"]);

const compatible = (message: string): PortCompatibilityVerdict => ({ status: "compatible", message });
const incompatible = (message: string): PortCompatibilityVerdict => ({ status: "incompatible", message });
const untyped = (message: string): PortCompatibilityVerdict => ({ status: "untyped", message });

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function unsupportedKeyword(schema: JsonSchema): string | null {
  return Object.keys(schema).find((key) => !SUPPORTED_KEYS.has(key)) ?? null;
}

function schemaBranches(schema: JsonSchema): readonly JsonSchema[] | null {
  if (schema.anyOf !== undefined && schema.oneOf !== undefined) return [];
  const kind = schema.anyOf !== undefined ? "anyOf" : schema.oneOf !== undefined ? "oneOf" : null;
  const raw = kind ? schema[kind] : undefined;
  if (raw === undefined) return null;
  if (Object.keys(schema).some((key) => key !== kind)) return [];
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const branches: JsonSchema[] = [];
  for (const branch of raw) {
    const value = record(branch);
    if (!value) return [];
    branches.push(value as JsonSchema);
  }
  if (kind === "oneOf") {
    for (let left = 0; left < branches.length; left += 1) {
      for (let right = left + 1; right < branches.length; right += 1) {
        const leftTypes = declaredTypes(branches[left] as JsonSchema);
        const rightTypes = declaredTypes(branches[right] as JsonSchema);
        if (!leftTypes || !rightTypes) return [];
        const overlap = leftTypes.some((leftType) => rightTypes.some((rightType) =>
          typeAccepted(leftType, rightType) || typeAccepted(rightType, leftType),
        ));
        if (overlap) return [];
      }
    }
  }
  return branches;
}

function declaredTypes(schema: JsonSchema): readonly string[] | null {
  const raw = schema.type;
  if (typeof raw === "string") return JSON_TYPES.has(raw) ? [raw] : [];
  if (Array.isArray(raw)) {
    if (raw.length === 0 || raw.some((value) => typeof value !== "string" || !JSON_TYPES.has(value))) return [];
    return [...new Set(raw as string[])];
  }
  if (schema.properties !== undefined || schema.required !== undefined) return ["object"];
  if (schema.items !== undefined) return ["array"];
  return null;
}

function typeUnionBranches(schema: JsonSchema): readonly JsonSchema[] | null {
  const types = declaredTypes(schema);
  if (!types || types.length < 2 || !Array.isArray(schema.type)) return null;
  return types.map((type) => ({ ...schema, type }));
}

function literalType(value: JsonValue): string | null {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "object") return "object";
  return ["string", "boolean"].includes(typeof value) ? typeof value : null;
}

function typeAccepted(sourceType: string, targetType: string): boolean {
  return sourceType === targetType || (sourceType === "integer" && targetType === "number");
}

function enumValues(schema: JsonSchema): readonly JsonValue[] | null {
  if (schema.enum === undefined) return null;
  return Array.isArray(schema.enum) && schema.enum.length > 0 ? schema.enum : [];
}

function enumContains(values: readonly JsonValue[], candidate: JsonValue): boolean {
  const encoded = JSON.stringify(candidate);
  return values.some((value) => JSON.stringify(value) === encoded);
}

function compareEnums(source: JsonSchema, target: JsonSchema): PortCompatibilityVerdict | null {
  const sourceValues = enumValues(source);
  const targetValues = enumValues(target);
  if (sourceValues?.length === 0 || targetValues?.length === 0) {
    return untyped("An enum is empty or malformed, so compatibility cannot be proven.");
  }
  if (sourceValues && targetValues) {
    return sourceValues.every((value) => enumContains(targetValues, value))
      ? compatible("Every source enum value is accepted by the target enum.")
      : incompatible("The source enum can emit a value the target enum refuses.");
  }
  if (sourceValues) {
    const targetTypes = declaredTypes(target);
    if (!targetTypes || targetTypes.length === 0) return untyped("The target type is insufficient to check the source enum.");
    return sourceValues.every((value) => {
      const type = literalType(value);
      return type !== null && targetTypes.some((targetType) => typeAccepted(type, targetType));
    })
      ? compatible("Every source enum value has a target-accepted type.")
      : incompatible("A source enum value has a type the target refuses.");
  }
  if (targetValues) {
    return incompatible("The source schema admits values outside the target enum.");
  }
  return null;
}

function properties(schema: JsonSchema): Record<string, JsonSchema> | null {
  if (schema.properties === undefined) return {};
  const raw = record(schema.properties);
  if (!raw) return null;
  const parsed: Record<string, JsonSchema> = {};
  for (const [key, value] of Object.entries(raw)) {
    const property = record(value);
    if (!property) return null;
    parsed[key] = property as JsonSchema;
  }
  return parsed;
}

function requiredProperties(schema: JsonSchema): readonly string[] | null {
  if (schema.required === undefined) return [];
  return Array.isArray(schema.required) && schema.required.every((value) => typeof value === "string")
    ? schema.required as string[]
    : null;
}

function compareObjects(source: JsonSchema, target: JsonSchema): PortCompatibilityVerdict {
  const sourceProperties = properties(source);
  const targetProperties = properties(target);
  const sourceRequired = requiredProperties(source);
  const targetRequired = requiredProperties(target);
  if (!sourceProperties || !targetProperties || !sourceRequired || !targetRequired) {
    return untyped("Object properties or required keys are malformed.");
  }
  for (const key of targetRequired) {
    if (!sourceRequired.includes(key)) {
      return incompatible(`The source object does not guarantee required target property "${key}".`);
    }
    if (!sourceProperties[key]) {
      return untyped(`The source does not describe required property "${key}" well enough.`);
    }
  }
  for (const [key, targetProperty] of Object.entries(targetProperties)) {
    if (sourceProperties[key] || source.additionalProperties === false) continue;
    const sourceAdditional = record(source.additionalProperties);
    if (!sourceAdditional) {
      return untyped(`The open source object does not constrain optional target property "${key}".`);
    }
    const verdict = comparePortSchemas(sourceAdditional as JsonSchema, targetProperty);
    if (verdict.status !== "compatible") {
      return { ...verdict, message: `Optional property "${key}": ${verdict.message}` };
    }
  }
  for (const [key, sourceProperty] of Object.entries(sourceProperties)) {
    const targetProperty = targetProperties[key];
    if (targetProperty) {
      const verdict = comparePortSchemas(sourceProperty, targetProperty);
      if (verdict.status !== "compatible") {
        return { ...verdict, message: `Property "${key}": ${verdict.message}` };
      }
      continue;
    }
    if (target.additionalProperties === false) {
      return incompatible(`The source object may emit target-forbidden property "${key}".`);
    }
    const targetAdditional = record(target.additionalProperties);
    if (targetAdditional) {
      const verdict = comparePortSchemas(sourceProperty, targetAdditional as JsonSchema);
      if (verdict.status !== "compatible") return verdict;
    }
  }
  if (target.additionalProperties === false && source.additionalProperties !== false) {
    return incompatible("The source object permits additional properties that the target refuses.");
  }
  if (record(target.additionalProperties) && source.additionalProperties !== false) {
    const sourceAdditional = record(source.additionalProperties);
    if (!sourceAdditional) return untyped("Open source object properties cannot be proven against the target property schema.");
    const verdict = comparePortSchemas(sourceAdditional as JsonSchema, target.additionalProperties as JsonSchema);
    if (verdict.status !== "compatible") return verdict;
  }
  return compatible("The source object guarantees the target object contract.");
}

function compareArrays(source: JsonSchema, target: JsonSchema): PortCompatibilityVerdict {
  const sourceItems = record(source.items);
  const targetItems = record(target.items);
  if (!sourceItems || !targetItems) return untyped("Array item compatibility is not fully described.");
  const verdict = comparePortSchemas(sourceItems as JsonSchema, targetItems as JsonSchema);
  return verdict.status === "compatible"
    ? compatible("The source array items are accepted by the target array.")
    : { ...verdict, message: `Array items: ${verdict.message}` };
}

/**
 * Proves assignability for a deliberately small JSON Schema subset. Unknown
 * keywords and incomplete shapes remain connectable, but are never called compatible.
 */
export function comparePortSchemas(source: JsonSchema, target: JsonSchema): PortCompatibilityVerdict {
  if (Object.keys(source).length === 0 || Object.keys(target).length === 0) {
    return untyped("At least one port has no declared schema.");
  }
  const sourceUnsupported = unsupportedKeyword(source);
  const targetUnsupported = unsupportedKeyword(target);
  if (sourceUnsupported || targetUnsupported) {
    return untyped(`Unsupported schema keyword "${sourceUnsupported ?? targetUnsupported}" prevents a compatibility proof.`);
  }

  const sourceBranches = schemaBranches(source);
  if (sourceBranches) {
    if (sourceBranches.length === 0) return untyped("The source union is malformed.");
    const verdicts = sourceBranches.map((branch) => comparePortSchemas(branch, target));
    if (verdicts.every((verdict) => verdict.status === "compatible")) {
      return compatible("Every source union branch is accepted by the target.");
    }
    if (verdicts.some((verdict) => verdict.status === "incompatible")) {
      return incompatible("A source union branch is refused by the target.");
    }
    return untyped("A source union branch cannot be proven compatible.");
  }
  const sourceTypeBranches = typeUnionBranches(source);
  if (sourceTypeBranches) {
    const verdicts = sourceTypeBranches.map((branch) => comparePortSchemas(branch, target));
    if (verdicts.every((verdict) => verdict.status === "compatible")) {
      return compatible("Every source type branch is accepted by the target.");
    }
    if (verdicts.some((verdict) => verdict.status === "incompatible")) {
      return incompatible("A source type branch is refused by the target.");
    }
    return untyped("A source type branch cannot be proven compatible.");
  }
  const targetBranches = schemaBranches(target);
  if (targetBranches) {
    if (targetBranches.length === 0) return untyped("The target union is malformed.");
    const sourceValues = enumValues(source);
    if (sourceValues && sourceValues.length > 1) {
      const verdicts = sourceValues.map((value) => comparePortSchemas({ enum: [value] }, target));
      if (verdicts.every((verdict) => verdict.status === "compatible")) {
        return compatible("Every source enum value is accepted by the target union.");
      }
      if (verdicts.some((verdict) => verdict.status === "incompatible")) {
        return incompatible("A source enum value is refused by the target union.");
      }
      return untyped("A source enum value cannot be proven compatible with the target union.");
    }
    const verdicts = targetBranches.map((branch) => comparePortSchemas(source, branch));
    if (verdicts.some((verdict) => verdict.status === "compatible")) {
      return compatible("The source is accepted by a target union branch.");
    }
    if (verdicts.every((verdict) => verdict.status === "incompatible")) {
      return incompatible("The source is refused by every target union branch.");
    }
    return untyped("No target union branch can be proven to accept the source.");
  }

  const enumVerdict = compareEnums(source, target);
  if (enumVerdict) return enumVerdict;

  const sourceTypes = declaredTypes(source);
  const targetTypes = declaredTypes(target);
  if (!sourceTypes || !targetTypes || sourceTypes.length === 0 || targetTypes.length === 0) {
    return untyped("Both ports need supported type information for a compatibility proof.");
  }
  if (!sourceTypes.every((sourceType) => targetTypes.some((targetType) => typeAccepted(sourceType, targetType)))) {
    return incompatible("The source can emit a JSON type the target refuses.");
  }

  if (sourceTypes.length === 1 && targetTypes.length === 1) {
    if (sourceTypes[0] === "object" && targetTypes[0] === "object") return compareObjects(source, target);
    if (sourceTypes[0] === "array" && targetTypes[0] === "array") return compareArrays(source, target);
  }
  const targetIsSpecialized =
    target.items !== undefined || target.properties !== undefined ||
    target.required !== undefined || target.additionalProperties !== undefined;
  return targetIsSpecialized
    ? untyped("Union type constraints are not specific enough for a compatibility proof.")
    : compatible("Every source JSON type is accepted by the target.");
}

function isV2Graph(graph: SupportedFlowGraph): graph is Extract<SupportedFlowGraph, { schemaVersion: 2 }> {
  return "schemaVersion" in graph && graph.schemaVersion === 2;
}

/** Validate a proposed edge without mutating the graph. */
export function validateTypedConnection(
  graph: SupportedFlowGraph,
  connection: TypedConnectionCandidate,
  resolveDefinition: NodeDefinitionResolver = getNodeDefinition,
  resolveGraphPorts?: ValidatedNodePortResolver,
): PortCompatibilityVerdict {
  const sourceId = connection.source;
  const targetId = connection.target;
  if (!sourceId || !targetId) return incompatible("Both connection endpoints are required.");
  const sourceNode = graph.nodes.find((node) => node.id === sourceId);
  const targetNode = graph.nodes.find((node) => node.id === targetId);
  if (!sourceNode || !targetNode) return incompatible("The connection references a missing endpoint node.");

  if (wouldCreateCycle(graph.edges, sourceId, targetId)) {
    return incompatible("That connection would create a cycle.");
  }

  if (!isV2Graph(graph)) {
    if (hasHandleCollision(graph.edges, targetId, connection.targetHandle)) {
      return incompatible("That legacy input already has a connection.");
    }
    return compatible("The legacy connection satisfies existing collision and cycle rules.");
  }

  const sourceHandle = connection.sourceHandle;
  const targetHandle = connection.targetHandle;
  if (!sourceHandle || !targetHandle) {
    return incompatible("Typed connections require both source and target handles.");
  }
  const resolvePorts = resolveGraphPorts ?? createAuthoringNodePortResolver(graph, resolveDefinition);
  const sourcePort = resolvePorts(sourceNode).outputPorts.find((port) => port.id === sourceHandle);
  const targetPort = resolvePorts(targetNode).inputPorts.find((port) => port.id === targetHandle);
  if (!sourcePort) return incompatible(`Source port "${sourceId}.${sourceHandle}" does not exist.`);
  if (!targetPort) return incompatible(`Target port "${targetId}.${targetHandle}" does not exist.`);
  if (
    targetPort.cardinality === "one" &&
    hasHandleCollision(graph.edges, targetId, targetHandle)
  ) {
    return incompatible(`Target port "${targetId}.${targetHandle}" accepts only one connection.`);
  }

  const verdict = comparePortSchemas(sourcePort.schema as JsonSchema, targetPort.schema as JsonSchema);
  const ports = `${sourceId}.${sourceHandle} and ${targetId}.${targetHandle}`;
  if (verdict.status === "compatible") return compatible(`${ports} are schema-compatible.`);
  if (verdict.status === "incompatible") return incompatible(`${ports} are incompatible: ${verdict.message}`);
  return untyped(`${ports} are untyped or insufficiently described; the connection is allowed with runtime validation.`);
}
