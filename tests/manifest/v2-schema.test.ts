import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { FlowGraphV2 } from "@/lib/flow/types";
import { hashCallableInterface } from "@/lib/flow/subflow-reference";
import type { FlowCallableInterface } from "@/lib/flow/types";
import {
  AgentManifestSchema,
  AgentManifestV2Schema,
  parseSupportedAgentManifest,
} from "@/lib/manifest/schema";

const graph = (): FlowGraphV2 => ({
  schemaVersion: 2,
  id: "flow-v2",
  name: "Typed flow",
  nodes: [
    {
      id: "input",
      type: "input",
      params: {},
      bindings: {},
      implementationVersion: "input@2",
      position: { x: 10, y: 20 },
    },
  ],
  edges: [],
  variables: [],
  groups: [],
  annotations: [],
});

const manifest = () => ({
  manifestVersion: 2 as const,
  schemaVersion: 2 as const,
  name: "Typed flow",
  description: "A typed workflow",
  triggers: [{ kind: "manual" as const }],
  graph: graph(),
  dependencies: [
    { kind: "skill" as const, resourceId: "skill-z", version: "2" },
    { kind: "agent" as const, resourceId: "agent-a", version: "1" },
  ],
  payoutAddress: "0x1111111111111111111111111111111111111111",
  meta: { template: "typed", createdBy: "studio" as const },
});

function pinnedGraph(kind: "draft" | "pinned" = "pinned"): FlowGraphV2 {
  const callable: FlowCallableInterface = { inputs: [], outputs: [] };
  const reference = kind === "draft"
    ? {
        kind,
        flowId: "child",
        interface: callable,
        interfaceHash: hashCallableInterface(callable),
      }
    : {
        kind,
        flowId: "child",
        versionId: "child-version",
        interface: callable,
        interfaceHash: hashCallableInterface(callable),
        contentHash: "c".repeat(64),
      };
  return {
    ...graph(),
    nodes: [{
      id: "child-node",
      type: "subflow",
      params: { reference } as never,
      bindings: {},
      position: { x: 0, y: 0 },
    }],
  };
}

function resourceGraph(): FlowGraphV2 {
  return {
    ...graph(),
    nodes: [{
      id: "resource-node",
      type: "resource.query",
      params: {
        resourceProductId: "resource-1",
        packVersionId: "pack-1",
        resourcePackContentHash: "d".repeat(64),
        filterFields: ["tier"],
        returnFields: ["name"],
      },
      bindings: {},
      position: { x: 0, y: 0 },
    }],
  };
}

function dependencyBytes(dependencies: readonly Record<string, unknown>[]): number {
  return dependencies.reduce(
    (total, dependency) => total + new TextEncoder().encode(JSON.stringify(dependency)).byteLength,
    0,
  );
}

function dependenciesAtAggregateBytes(target: number): Array<{
  kind: "skill";
  resourceId: string;
  version: string;
  contentHash: string;
}> {
  const dependencies = Array.from({ length: 700 }, (_, index) => {
    const prefix = `resource-${index}-`;
    return {
      kind: "skill" as const,
      resourceId: prefix + "r".repeat(512 - prefix.length),
      version: "v".repeat(512),
      contentHash: "h".repeat(512),
    };
  });
  let excess = dependencyBytes(dependencies) - target;
  if (excess < 0) throw new Error("Target exceeds test dependency capacity");
  for (let index = 0; index < dependencies.length && excess > 0; index += 1) {
    const dependency = dependencies[index]!;
    for (const field of ["contentHash", "version"] as const) {
      const removable = dependency[field].length - 1;
      const removed = Math.min(removable, excess);
      dependency[field] = dependency[field].slice(0, dependency[field].length - removed);
      excess -= removed;
    }
  }
  if (excess !== 0 || dependencyBytes(dependencies) !== target) {
    throw new Error("Could not construct exact aggregate dependency bytes");
  }
  return dependencies;
}

describe("manifest v2 schema", () => {
  it("parses the strict v2 shape without projecting steps", () => {
    const input = manifest();
    const parsed = parseSupportedAgentManifest(input);

    expect(parsed.manifestVersion).toBe(2);
    expect(parsed).not.toHaveProperty("steps");
    expect((parsed as { graph: FlowGraphV2 }).graph).toBe(input.graph);
    expect(AgentManifestV2Schema.parse(input).graph).toBe(input.graph);
  });

  it.each([
    ["future manifest version", { ...manifest(), manifestVersion: 3 }],
    ["missing manifest version", (({ manifestVersion: _, ...value }) => value)(manifest())],
    ["string manifest version", { ...manifest(), manifestVersion: "2" }],
    ["mismatched graph schema", { ...manifest(), graph: { ...graph(), schemaVersion: 3 } }],
    ["mismatched manifest schema", { ...manifest(), schemaVersion: 1 }],
    ["missing description", (({ description: _, ...value }) => value)(manifest())],
    ["missing metadata", (({ meta: _, ...value }) => value)(manifest())],
    ["v1 steps injected", { ...manifest(), steps: [] }],
    ["unknown outer field", { ...manifest(), future: true }],
    ["unknown graph field", { ...manifest(), graph: { ...graph(), future: true } }],
    [
      "unknown manual trigger field",
      { ...manifest(), triggers: [{ kind: "manual", future: true }] },
    ],
    [
      "unknown schedule trigger field",
      {
        ...manifest(),
        triggers: [{ kind: "schedule", cron: "0 * * * *", future: true }],
      },
    ],
    [
      "unknown paid-call trigger field",
      {
        ...manifest(),
        triggers: [{ kind: "paidCall", priceUsdc: 1, future: true }],
      },
    ],
    [
      "unknown webhook trigger field",
      { ...manifest(), triggers: [{ kind: "webhook", future: true }] },
    ],
    ["unknown metadata field", { ...manifest(), meta: { future: true } }],
    [
      "unknown dependency field",
      {
        ...manifest(),
        dependencies: [
          { kind: "skill", resourceId: "skill-a", version: "1", future: true },
        ],
      },
    ],
    [
      "unknown resource-version field",
      {
        ...manifest(),
        resourceVersion: {
          resourceId: "flow-v2",
          versionId: "version-1",
          versionNumber: 1,
          semanticHash: "a".repeat(64),
          fullHash: "b".repeat(64),
          future: true,
        },
      },
    ],
    [
      "unknown node field",
      {
        ...manifest(),
        graph: {
          ...graph(),
          nodes: [{ ...graph().nodes[0], future: true }],
        },
      },
    ],
  ])("fails closed for %s", (_label, value) => {
    expect(() => parseSupportedAgentManifest(value)).toThrow();
  });

  it("keeps the v1 alias narrow and rejects v2", () => {
    expect(() => AgentManifestSchema.parse(manifest())).toThrow();
  });

  it("refuses typed draft references in portable v2 manifests", () => {
    expect(() => AgentManifestV2Schema.parse({ ...manifest(), graph: pinnedGraph("draft") }))
      .toThrow(/draft.*portable|immutable.*draft/i);
  });

  it("requires the exact embedded pinned-flow dependency set", () => {
    const input = {
      ...manifest(),
      graph: pinnedGraph(),
      dependencies: [
        { kind: "skill" as const, resourceId: "skill-z", version: "2" },
        {
          kind: "flow" as const,
          resourceId: "child",
          version: "child-version",
          contentHash: "c".repeat(64),
        },
      ],
    };
    expect(AgentManifestV2Schema.parse(input)).toBe(input);

    for (const dependencies of [
      input.dependencies.filter((dependency) => dependency.kind !== "flow"),
      input.dependencies.map((dependency) => dependency.kind === "flow"
        ? { ...dependency, version: "wrong" }
        : dependency),
      [...input.dependencies, {
        kind: "flow" as const,
        resourceId: "extra",
        version: "extra-version",
        contentHash: "e".repeat(64),
      }],
    ]) {
      expect(() => AgentManifestV2Schema.parse({ ...input, dependencies }))
        .toThrow(/dependenc|pinned|flow/i);
    }
  });

  it("requires the exact embedded Resource Pack dependency set", () => {
    const dependency = {
      kind: "resource" as const,
      resourceId: "resource-1",
      version: "pack-1",
      contentHash: "d".repeat(64),
    };
    const input = { ...manifest(), graph: resourceGraph(), dependencies: [dependency] };
    expect(AgentManifestV2Schema.parse(input)).toBe(input);

    for (const dependencies of [
      [],
      [{ ...dependency, version: "pack-2" }],
      [{ ...dependency, contentHash: "e".repeat(64) }],
      [dependency, { ...dependency, resourceId: "resource-extra" }],
    ]) {
      expect(() => AgentManifestV2Schema.parse({ ...input, dependencies }))
        .toThrow(/dependenc|resource|pack|pinned/i);
    }
  });

  it("bounds portable dependencies at exactly 1000 entries and 1 MiB", () => {
    const thousand = Array.from({ length: 1_000 }, (_, index) => ({
      kind: "skill" as const,
      resourceId: `skill-${index}`,
      version: "1",
    }));
    expect(() => AgentManifestV2Schema.parse({ ...manifest(), dependencies: thousand }))
      .not.toThrow();
    expect(() => AgentManifestV2Schema.parse({
      ...manifest(),
      dependencies: [...thousand, { kind: "skill", resourceId: "overflow", version: "1" }],
    })).toThrow(/too many|1,?000/i);

    const exact = dependenciesAtAggregateBytes(1024 * 1024);
    expect(() => AgentManifestV2Schema.parse({ ...manifest(), dependencies: exact }))
      .not.toThrow();
    const expanded = exact.map((dependency) => ({ ...dependency }));
    const expandable = expanded.find((dependency) => dependency.contentHash.length < 512);
    if (!expandable) throw new Error("Expected an expandable dependency");
    expandable.contentHash += "x";
    expect(dependencyBytes(expanded)).toBe(1024 * 1024 + 1);
    expect(() => AgentManifestV2Schema.parse({ ...manifest(), dependencies: expanded }))
      .toThrow(/too large|1 MiB|dependency pins/i);
  });

  it("uses UTF-8 byte bounds for every portable dependency field", () => {
    const exact = "é".repeat(256);
    const oversized = `${exact}é`;
    for (const field of ["resourceId", "version", "contentHash"] as const) {
      const accepted = { kind: "skill" as const, resourceId: "resource", version: "1", [field]: exact };
      expect(() => AgentManifestV2Schema.parse({ ...manifest(), dependencies: [accepted] }))
        .not.toThrow();
      expect(() => AgentManifestV2Schema.parse({
        ...manifest(), dependencies: [{ ...accepted, [field]: oversized }],
      })).toThrow(/too long|dependency/i);
    }
  });

  it("keeps the shared dependency normalizer browser-safe", () => {
    const source = readFileSync("src/lib/projects/version-input.ts", "utf8");
    expect(source).not.toMatch(/\bBuffer\b|node:/);
  });
});
