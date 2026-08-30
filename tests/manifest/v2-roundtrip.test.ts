import { describe, expect, it } from "vitest";
import type { AgentManifestV2 } from "@/lib/manifest/schema";
import { flowToManifest } from "@/lib/manifest/from-flow";
import { manifestToFlow } from "@/lib/manifest/to-flow";
import { parseSupportedAgentManifest } from "@/lib/manifest/schema";
import { hashCallableInterface } from "@/lib/flow/subflow-reference";
import type { FlowCallableInterface, FlowGraphV2 } from "@/lib/flow/types";
import { codegen } from "@/lib/manifest/codegen";

function manifest(): AgentManifestV2 {
  return {
    meta: { createdBy: "studio", template: "ordered" },
    payoutAddress: "0x2222222222222222222222222222222222222222",
    graph: {
      annotations: [{ position: { y: 8, x: 7 }, text: "note", id: "annotation-z" }],
      groups: [{ nodeIds: ["sink", "source"], label: "Group", id: "group-z" }],
      variables: [
        { sensitive: true, schema: { type: "string" }, scope: "run", name: "Token", id: "var-z" },
        { default: 0, schema: { type: "number" }, scope: "workflow", name: "Limit", id: "var-a" },
      ],
      edges: [
        {
          condition: { kind: "variable", variableId: "var-a" },
          targetHandle: "in",
          target: "sink",
          sourceHandle: "result",
          source: "source",
          id: "edge-z",
        },
      ],
      nodes: [
        {
          meta: { display: { color: "blue" } },
          position: { y: 20, x: 10 },
          implementationVersion: "input@2",
          bindings: { query: { kind: "literal", value: null } },
          params: { enabled: false, limit: 0 },
          type: "input",
          id: "source",
        },
        {
          position: { y: 20, x: 300 },
          bindings: {
            value: { kind: "port", nodeId: "source", portId: "result", path: "/items/0" },
            token: { kind: "secret", connectionId: "conn-1", field: "token" },
          },
          params: {},
          type: "output",
          id: "sink",
        },
      ],
      name: "Noncanonical order",
      id: "flow-v2",
      schemaVersion: 2,
      meta: { display: { zoom: 0.5 }, runtime: { retries: 2 } },
    },
    triggers: [{ kind: "manual" }],
    description: "Round trip",
    name: "Noncanonical order",
    schemaVersion: 2,
    manifestVersion: 2,
  };
}

describe("manifest v2 round trip", () => {
  it("returns the exact graph object and preserves manifest bytes", () => {
    const original = manifest();
    const bytes = JSON.stringify(original);
    const input = JSON.parse(bytes) as AgentManifestV2;
    const parsed = parseSupportedAgentManifest(input) as AgentManifestV2;
    const flow = manifestToFlow(parsed);

    expect(flow).toBe(input.graph);
    expect(JSON.stringify(flow)).toBe(JSON.stringify(original.graph));
    expect(flowToManifest(flow)).toBe(input);
    expect(JSON.stringify(flowToManifest(flow))).toBe(bytes);
  });

  it("compiles a native v2 graph without steps or mutation", () => {
    const input = manifest().graph;
    const before = JSON.stringify(input);
    const compiled = flowToManifest(input);

    expect(compiled).toMatchObject({
      manifestVersion: 2,
      schemaVersion: 2,
      graph: input,
      name: input.name,
    });
    expect(compiled).not.toHaveProperty("steps");
    expect(compiled.graph).toBe(input);
    expect(JSON.stringify(input)).toBe(before);

    const transported = parseSupportedAgentManifest(
      JSON.parse(JSON.stringify(compiled)),
    ) as AgentManifestV2;
    expect(JSON.stringify(manifestToFlow(transported))).toBe(before);
  });

  it("validates dynamic typed-subflow handles before returning provenance", () => {
    const callable: FlowCallableInterface = {
      inputs: [],
      outputs: [{
        id: "answer", label: "Answer", schema: { type: "string" }, required: true,
        cardinality: "one", source: { nodeId: "sink", portId: "result" },
      }],
    };
    const graph: FlowGraphV2 = {
      schemaVersion: 2, id: "typed-parent", name: "Typed parent",
      nodes: [
        {
          id: "child", type: "subflow", position: { x: 0, y: 0 }, bindings: {},
          params: { reference: {
            kind: "pinned",
            flowId: "child-row",
            versionId: "child-version",
            interface: callable,
            interfaceHash: hashCallableInterface(callable),
            contentHash: "c".repeat(64),
          } } as unknown as FlowGraphV2["nodes"][number]["params"],
        },
        { id: "sink", type: "output", position: { x: 200, y: 0 }, bindings: {}, params: {} },
      ],
      edges: [{ id: "edge", source: "child", sourceHandle: "answer", target: "sink", targetHandle: "in" }],
      variables: [], groups: [], annotations: [],
    };
    const sourceManifest = parseSupportedAgentManifest({
      manifestVersion: 2, schemaVersion: 2, name: graph.name, description: "",
      triggers: [{ kind: "manual" }], graph, meta: {},
      dependencies: [{
        kind: "flow",
        resourceId: "child-row",
        version: "child-version",
        contentHash: "c".repeat(64),
      }],
    }) as AgentManifestV2;
    const transported = manifestToFlow(sourceManifest);
    expect(flowToManifest(transported)).toBe(sourceManifest);

    (transported.edges as unknown as Array<{ sourceHandle: string }>)[0]!.sourceHandle = "result";
    expect(() => flowToManifest(transported)).toThrow(/undeclared.*child\.result|source port/i);
  });

  it("never treats a malformed declared-v2 typed reference as a v1 manifest", () => {
    const input = manifest().graph as FlowGraphV2;
    const malformed = {
      ...input,
      nodes: input.nodes.map((node, index) => index === 0 ? {
        ...node,
        type: "subflow" as const,
        params: { reference: { kind: "draft", flowId: "child" } },
      } : node),
    } as FlowGraphV2;
    expect(() => flowToManifest(malformed)).toThrow(/invalid|reference|interface|schemaVersion 2/i);
  });

  it("refuses native draft export and never downconverts v2 code generation to steps", () => {
    const callable: FlowCallableInterface = { inputs: [], outputs: [] };
    const draft: FlowGraphV2 = {
      ...manifest().graph,
      nodes: [{
        id: "draft-child",
        type: "subflow",
        params: { reference: {
          kind: "draft",
          flowId: "child",
          interface: callable,
          interfaceHash: hashCallableInterface(callable),
        } } as never,
        bindings: {},
        position: { x: 0, y: 0 },
      }],
      edges: [],
    };

    expect(() => flowToManifest(draft)).toThrow(/draft.*portable|immutable.*draft/i);
    expect(() => codegen(manifest() as never)).toThrow(/v2.*code|portable.*code|unsupported/i);
  });

  it("rechecks stale provenance and explicit version metadata before portable export", () => {
    const callable: FlowCallableInterface = { inputs: [], outputs: [] };
    const graph: FlowGraphV2 = {
      ...manifest().graph,
      nodes: [{
        id: "pinned-child",
        type: "subflow",
        params: { reference: {
          kind: "pinned",
          flowId: "child",
          versionId: "version-1",
          interface: callable,
          interfaceHash: hashCallableInterface(callable),
          contentHash: "a".repeat(64),
        } } as never,
        bindings: {},
        position: { x: 0, y: 0 },
      }],
      edges: [],
    };
    const dependency = {
      kind: "flow" as const,
      resourceId: "child",
      version: "version-1",
      contentHash: "a".repeat(64),
    };
    const source = parseSupportedAgentManifest({
      ...manifest(),
      graph,
      dependencies: [dependency],
    }) as AgentManifestV2;
    const transported = manifestToFlow(source);
    expect(transported).toBe(graph);

    const reference = transported.nodes[0]!.params.reference as { versionId: string };
    reference.versionId = "version-2";
    expect(() => flowToManifest(transported)).toThrow(/dependenc|pinned|flow/i);
    reference.versionId = "version-1";
    expect(() => flowToManifest(transported, {
      versionMetadata: { dependencies: [{ ...dependency, contentHash: "b".repeat(64) }] },
    })).toThrow(/dependenc|pinned|flow/i);
  });

  it("round-trips exact Resource Pack metadata and refuses stale portable generation", () => {
    const graph: FlowGraphV2 = {
      ...manifest().graph,
      nodes: [{
        id: "resource",
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
      edges: [],
    };
    const dependency = {
      kind: "resource" as const,
      resourceId: "resource-1",
      version: "pack-1",
      contentHash: "d".repeat(64),
    };
    const source = parseSupportedAgentManifest({
      ...manifest(), graph, dependencies: [dependency],
    }) as AgentManifestV2;
    const transported = manifestToFlow(source);
    expect(flowToManifest(transported)).toBe(source);
    expect(flowToManifest(graph, { versionMetadata: { dependencies: [dependency] } }))
      .toMatchObject({ dependencies: [dependency] });
    expect(() => flowToManifest(graph, {
      versionMetadata: { dependencies: [{ ...dependency, contentHash: "e".repeat(64) }] },
    })).toThrow(/dependenc|resource|pack|pinned/i);
  });

  it("validates a forged direct v2 import before attaching provenance", () => {
    const forged = manifest() as AgentManifestV2 & { future?: boolean };
    forged.future = true;
    expect(() => manifestToFlow(forged)).toThrow();
  });
});
