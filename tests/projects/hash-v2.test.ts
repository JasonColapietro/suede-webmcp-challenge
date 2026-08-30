import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FlowGraphV2 } from "@/lib/flow/types";
import type { DependencyPinInput } from "@/lib/projects/types";
import { hashFlowGraph } from "@/lib/projects/hash";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import { SqliteProjectRepo } from "@/lib/projects/sqlite-project-repo";

const graph = (): FlowGraphV2 => ({
  schemaVersion: 2,
  id: "flow-v2",
  name: "Hash v2",
  nodes: [
    {
      id: "source",
      type: "input",
      params: { enabled: false, limit: 0 },
      bindings: { query: { kind: "literal", value: null } },
      implementationVersion: "input@2",
      position: { x: 10, y: 20 },
      meta: { display: { color: "blue" } },
    },
    {
      id: "sink",
      type: "output",
      params: {},
      bindings: { value: { kind: "port", nodeId: "source", portId: "result" } },
      position: { x: 300, y: 20 },
    },
  ],
  edges: [
    {
      id: "edge-1",
      source: "source",
      sourceHandle: "result",
      target: "sink",
      targetHandle: "in",
      condition: { kind: "variable", variableId: "var-1" },
    },
  ],
  variables: [
    {
      id: "var-1",
      name: "Enabled",
      scope: "run",
      schema: { type: "boolean" },
      default: false,
      sensitive: false,
    },
  ],
  groups: [{ id: "group-1", label: "Visual", nodeIds: ["source", "sink"] }],
  annotations: [{ id: "note-1", text: "Visual", position: { x: 5, y: 5 } }],
  meta: { display: { zoom: 0.8 }, runtime: { retries: 2 } },
});

const pins: DependencyPinInput[] = [
  { kind: "skill", resourceId: "z", version: "2", contentHash: "bbb" },
  { kind: "agent", resourceId: "a", version: "1", contentHash: "aaa" },
];

describe("v2 graph hashing", () => {
  it("is invariant to object keys, canonical collection order, and dependency order", () => {
    const left = graph();
    const right: FlowGraphV2 = {
      ...structuredClone(left),
      nodes: [...left.nodes].reverse(),
      edges: [...left.edges].reverse(),
      variables: [...left.variables].reverse(),
      groups: [...left.groups].reverse(),
      annotations: [...left.annotations].reverse(),
    };

    expect(hashFlowGraph(left, { semantic: true }, pins)).toBe(
      hashFlowGraph(right, { semantic: true }, [...pins].reverse()),
    );
    expect(hashFlowGraph(left, { semantic: false }, pins)).toBe(
      hashFlowGraph(right, { semantic: false }, [...pins].reverse()),
    );
  });

  it.each([
    ["params", (value: FlowGraphV2) => ((value.nodes[0].params as Record<string, unknown>).limit = 1)],
    ["bindings", (value: FlowGraphV2) => ((value.nodes[0].bindings as Record<string, unknown>).query = { kind: "literal", value: 0 })],
    ["implementation version", (value: FlowGraphV2) => ((value.nodes[0] as { implementationVersion?: string }).implementationVersion = "input@3")],
    ["source handle", (value: FlowGraphV2) => ((value.edges[0] as { sourceHandle: string }).sourceHandle = "other")],
    ["target handle", (value: FlowGraphV2) => ((value.edges[0] as { targetHandle: string }).targetHandle = "other")],
    ["edge condition", (value: FlowGraphV2) => ((value.edges[0] as { condition?: unknown }).condition = { kind: "literal", value: true })],
    ["variable schema", (value: FlowGraphV2) => ((value.variables[0].schema as Record<string, unknown>).type = "number")],
    ["variable default", (value: FlowGraphV2) => ((value.variables[0] as { default?: unknown }).default = true)],
    ["variable scope", (value: FlowGraphV2) => ((value.variables[0] as { scope: "workflow" | "run" }).scope = "workflow")],
    ["variable sensitive", (value: FlowGraphV2) => ((value.variables[0] as { sensitive?: boolean }).sensitive = true)],
  ])("changes semantic and full hashes for %s", (_label, mutate) => {
    const changed = structuredClone(graph());
    mutate(changed);
    expect(hashFlowGraph(changed, { semantic: true }, pins)).not.toBe(
      hashFlowGraph(graph(), { semantic: true }, pins),
    );
    expect(hashFlowGraph(changed, { semantic: false }, pins)).not.toBe(
      hashFlowGraph(graph(), { semantic: false }, pins),
    );
  });

  it.each([
    ["node position", (value: FlowGraphV2) => ((value.nodes[0] as { position: { x: number; y: number } }).position.x = 999)],
    ["node display metadata", (value: FlowGraphV2) => ((value.nodes[0] as { meta?: Record<string, unknown> }).meta = { display: { color: "red" } })],
    ["graph display metadata", (value: FlowGraphV2) => ((value as { meta?: Record<string, unknown> }).meta = { ...value.meta, display: { zoom: 2 } })],
    ["groups", (value: FlowGraphV2) => ((value.groups[0] as { label: string }).label = "Changed")],
    ["annotations", (value: FlowGraphV2) => ((value.annotations[0] as { text: string }).text = "Changed")],
  ])("changes full but not semantic hashes for %s", (_label, mutate) => {
    const changed = structuredClone(graph());
    mutate(changed);
    expect(hashFlowGraph(changed, { semantic: true }, pins)).toBe(
      hashFlowGraph(graph(), { semantic: true }, pins),
    );
    expect(hashFlowGraph(changed, { semantic: false }, pins)).not.toBe(
      hashFlowGraph(graph(), { semantic: false }, pins),
    );
  });

  it.each(["kind", "resourceId", "version", "contentHash"] as const)(
    "changes both hashes when dependency %s changes",
    (field) => {
      const changed = structuredClone(pins);
      Object.assign(changed[0], {
        [field]: field === "kind" ? "template" : `${changed[0][field]}-changed`,
      });
      expect(hashFlowGraph(graph(), { semantic: true }, changed)).not.toBe(
        hashFlowGraph(graph(), { semantic: true }, pins),
      );
      expect(hashFlowGraph(graph(), { semantic: false }, changed)).not.toBe(
        hashFlowGraph(graph(), { semantic: false }, pins),
      );
    },
  );

  it("never mutates the graph or pins", () => {
    const input = graph();
    const dependencies = structuredClone(pins);
    const beforeGraph = JSON.stringify(input);
    const beforePins = JSON.stringify(dependencies);
    hashFlowGraph(input, { semantic: true }, dependencies);
    expect(JSON.stringify(input)).toBe(beforeGraph);
    expect(JSON.stringify(dependencies)).toBe(beforePins);
  });

  it("treats prototype-like JSON keys and IDs as inert hash input", () => {
    const left = graph();
    const right = graph();
    (left.nodes[0].params as Record<string, unknown>).payload = JSON.parse(
      '{"__proto__":{"polluted":"left"},"constructor":"left"}',
    );
    (right.nodes[0].params as Record<string, unknown>).payload = JSON.parse(
      '{"__proto__":{"polluted":"right"},"constructor":"left"}',
    );
    (left.nodes[0] as { id: string }).id = "__proto__";
    (right.nodes[0] as { id: string }).id = "__proto__";

    expect(hashFlowGraph(left, { semantic: true })).not.toBe(
      hashFlowGraph(right, { semantic: true }),
    );
    expect(({} as { polluted?: string }).polluted).toBeUndefined();
  });

  it("persists v2 schema and pin-composed hashes without changing graph JSON", async () => {
    const directory = mkdtempSync(join(tmpdir(), "suede-hash-v2-"));
    const path = join(directory, "studio.db");
    try {
      const flowRepo = new SqliteRepo(path);
      const projectRepo = new SqliteProjectRepo(path);
      const input = graph();
      const graphJson = JSON.stringify(input);
      const saved = await flowRepo.saveFlow({
        ownerId: "owner-v2",
        name: input.name,
        graph: input,
      });

      const first = await projectRepo.createFlowVersion({
        flowId: saved.id,
        ownerId: "owner-v2",
        dependencies: pins,
      });
      const reordered = await projectRepo.createFlowVersion({
        flowId: saved.id,
        ownerId: "owner-v2",
        dependencies: [...pins].reverse(),
      });
      const changed = await projectRepo.createFlowVersion({
        flowId: saved.id,
        ownerId: "owner-v2",
        dependencies: [{ ...pins[0], version: "changed" }, pins[1]],
      });

      expect(first).not.toBeNull();
      expect(reordered?.id).toBe(first?.id);
      expect(changed?.id).not.toBe(first?.id);
      expect(changed?.semanticHash).not.toBe(first?.semanticHash);
      expect(changed?.fullHash).not.toBe(first?.fullHash);
      expect(first?.schemaVersion).toBe(2);
      expect(JSON.stringify(first?.graph)).toBe(graphJson);

      const inspection = new Database(path, { readonly: true });
      const persisted = inspection
        .prepare("SELECT graph, schema_version FROM flow_versions WHERE id = ?")
        .get(first?.id) as { graph: string; schema_version: number };
      inspection.close();
      expect(persisted).toEqual({ graph: graphJson, schema_version: 2 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
