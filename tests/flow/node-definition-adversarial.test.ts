import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { CanonicalNodeDef } from "@/lib/flow/executor";
import { requiresDryRunStub } from "@/lib/flow/executor";
import type { NodeDefinitionV2 } from "@/lib/flow/node-definition-types";
import { NODE_DEFINITIONS } from "@/lib/flow/node-definitions";
import type { NodeMeta } from "@/lib/flow/node-meta";
import { NODE_META } from "@/lib/flow/node-meta";
import { NODE_DEFS } from "@/lib/flow/nodes";

interface AuditInput {
  catalog: readonly NodeDefinitionV2[];
  runtime: readonly CanonicalNodeDef[];
  client: readonly NodeMeta[];
}

const SENSITIVE_KEY = /secret|private.?key|service.?role/i;
const SENSITIVE_VALUE =
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|bearer\s+[a-z0-9._~+/=-]{8,}|(?:service.?role|signing.?secret)\s*[:=]\s*[a-z0-9._~+/=-]{8,}/i;
const DIRECT_SIDE_EFFECTS = new Set(["write", "delete", "send", "publish", "settle"]);

function executableSchemaKeyVariants(schema: z.ZodTypeAny): string[][] {
  if (schema instanceof z.ZodUnion) {
    return schema.options.flatMap((option: z.ZodTypeAny) => executableSchemaKeyVariants(option));
  }
  if (schema instanceof z.ZodEffects) return executableSchemaKeyVariants(schema.innerType());
  if (schema instanceof z.ZodObject) return [Object.keys(schema.shape).sort()];
  return [];
}

function expectedSchemaKeyVariants(definition: NodeDefinitionV2): string[][] {
  const described = Object.keys(
    (definition.configSchema.properties ?? {}) as Record<string, unknown>,
  ).sort();
  if (definition.type === "subflow") return [described, ["reference"]];
  if (definition.type === "loop") {
    return [
      described,
      [...described.filter((key) => key !== "flowId" && key !== "itemsPath"), "reference"].sort(),
    ];
  }
  return [described];
}

function sortedVariants(variants: string[][]): string[][] {
  return variants.map((keys) => [...keys].sort()).sort((left, right) =>
    left.join("\0").localeCompare(right.join("\0")));
}

function inspectJson(value: unknown, path: string, issues: string[]): void {
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    issues.push(`${path} is not JSON data`);
    return;
  }
  if (typeof value === "string" && SENSITIVE_VALUE.test(value)) {
    issues.push(`${path} contains credential material`);
    return;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    issues.push(`${path} is not finite`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => inspectJson(child, `${path}[${index}]`, issues));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(key)) issues.push(`${path}.${key} is a sensitive key`);
      inspectJson(child, `${path}.${key}`, issues);
    }
  }
}

function duplicateValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function auditDefinitions(input: AuditInput): string[] {
  const issues: string[] = [];
  const catalogTypes = input.catalog.map(({ type }) => type);
  const runtimeTypes = input.runtime.map(({ type }) => type);
  const clientTypes = input.client.map(({ type }) => type);
  for (const duplicate of duplicateValues(catalogTypes)) issues.push(`duplicate catalog ${duplicate}`);
  for (const duplicate of duplicateValues(runtimeTypes)) issues.push(`duplicate runtime ${duplicate}`);
  for (const duplicate of duplicateValues(clientTypes)) issues.push(`duplicate client ${duplicate}`);

  const catalog = new Map(input.catalog.map((definition) => [definition.type, definition]));
  const runtime = new Map(input.runtime.map((definition) => [definition.type, definition]));
  const client = new Map(input.client.map((definition) => [definition.type, definition]));

  for (const type of catalogTypes) {
    if (!runtime.has(type)) issues.push(`catalog ${type} has no executable`);
    if (!client.has(type)) issues.push(`catalog ${type} has no client projection`);
  }
  for (const type of runtimeTypes) {
    if (!catalog.has(type)) issues.push(`executable ${type} has no catalog entry`);
  }
  for (const type of clientTypes) {
    if (!catalog.has(type)) issues.push(`client ${type} has no catalog entry`);
  }

  for (const definition of input.catalog) {
    inspectJson(definition, definition.type, issues);
    for (const direction of ["inputPorts", "outputPorts"] as const) {
      const duplicates = duplicateValues(definition[direction].map(({ id }) => id));
      for (const duplicate of duplicates) {
        issues.push(`${definition.type} duplicate ${direction} ${duplicate}`);
      }
    }

    const executable = runtime.get(definition.type);
    if (!executable) continue;
    const describedVariants = sortedVariants(expectedSchemaKeyVariants(definition));
    const executableVariants = sortedVariants(executableSchemaKeyVariants(executable.paramsSchema));
    if (JSON.stringify(describedVariants) !== JSON.stringify(executableVariants)) {
      issues.push(`${definition.type} config schema differs from Zod`);
    }
    if (
      definition.cost.kind === "estimated" &&
      executable.priceUsdc !== definition.cost.amount
    ) {
      issues.push(`${definition.type} estimated price drift`);
    }

    const guarded = requiresDryRunStub(executable);
    if (definition.testMode === "stub" && (!guarded || !executable.dryRunStub)) {
      issues.push(`${definition.type} stub mode is not centrally guarded`);
    }
    if (definition.testMode === "refuse" && (!guarded || executable.dryRunStub)) {
      issues.push(`${definition.type} refuse mode does not fail closed`);
    }
    if (definition.testMode === "native" && guarded) {
      issues.push(`${definition.type} native mode is unexpectedly guarded`);
    }
    if (
      definition.testMode === "native" &&
      definition.capabilityMode !== "inherits-graph" &&
      (definition.cost.kind !== "free" ||
        definition.effects.includes("spend") ||
        definition.effects.includes("settle") ||
        definition.effects.some((effect) => DIRECT_SIDE_EFFECTS.has(effect)))
    ) {
      issues.push(`${definition.type} effectful native classification`);
    }
  }
  return issues;
}

function current(): AuditInput {
  return {
    catalog: NODE_DEFINITIONS,
    runtime: NODE_DEFS,
    client: NODE_META,
  };
}

describe("adversarial canonical node-definition audit", () => {
  it("accepts the complete current product enumeration", () => {
    expect(auditDefinitions(current())).toEqual([]);
  });

  it.each([
    ["catalog entry without executable", () => ({ ...current(), runtime: NODE_DEFS.slice(1) }), /no executable/],
    [
      "executable without catalog entry",
      () => ({
        ...current(),
        runtime: [...NODE_DEFS, { ...NODE_DEFS[0], type: "future.probe" as never }],
      }),
      /no catalog entry/,
    ],
    ["client projection missing a type", () => ({ ...current(), client: NODE_META.slice(1) }), /no client projection/],
    [
      "duplicate type",
      () => ({ ...current(), catalog: [...NODE_DEFINITIONS, NODE_DEFINITIONS[0]] }),
      /duplicate catalog/,
    ],
    [
      "duplicate port id",
      () => ({
        ...current(),
        catalog: NODE_DEFINITIONS.map((definition, index) =>
          index === 0
            ? { ...definition, outputPorts: [definition.outputPorts[0], definition.outputPorts[0]] }
            : definition,
        ),
      }),
      /duplicate outputPorts/,
    ],
    [
      "Zod and metadata key drift",
      () => ({
        ...current(),
        catalog: NODE_DEFINITIONS.map((definition, index) =>
          index === 0
            ? { ...definition, configSchema: { type: "object", properties: { drift: {} } } }
            : definition,
        ),
      }),
      /config schema differs from Zod/,
    ],
    [
      "estimated runtime price drift",
      () => ({
        ...current(),
        runtime: NODE_DEFS.map((definition) =>
          definition.type === "suede.styleCoach"
            ? { ...definition, priceUsdc: (definition.priceUsdc ?? 0) + 1 }
            : definition,
        ),
      }),
      /estimated price drift/,
    ],
    [
      "stub mode without a central stub",
      () => ({
        ...current(),
        runtime: NODE_DEFS.map((definition) =>
          definition.type === "llm"
            ? { ...definition, costBearing: false, sideEffecting: false, dryRunStub: undefined }
            : definition,
        ),
      }),
      /not centrally guarded/,
    ],
    [
      "effectful native mode",
      () => ({
        ...current(),
        catalog: NODE_DEFINITIONS.map((definition) =>
          definition.type === "input"
            ? { ...definition, effects: ["write" as const] }
            : definition,
        ),
      }),
      /effectful native classification/,
    ],
    [
      "function in client descriptor",
      () => ({
        ...current(),
        catalog: NODE_DEFINITIONS.map((definition, index) =>
          index === 0
            ? ({ ...definition, description: (() => "unsafe") as unknown as string })
            : definition,
        ),
      }),
      /not JSON data/,
    ],
    [
      "secret-like client key",
      () => ({
        ...current(),
        catalog: NODE_DEFINITIONS.map((definition, index) =>
          index === 0 ? ({ ...definition, privateKey: "reference" } as NodeDefinitionV2) : definition,
        ),
      }),
      /sensitive key/,
    ],
  ])("rejects %s", (_label, mutate, expected) => {
    expect(auditDefinitions(mutate())).toEqual(
      expect.arrayContaining([expect.stringMatching(expected)]),
    );
  });
});
