import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ENVIRONMENT_KINDS,
  FLOW_LIFECYCLES,
  FLOW_SCHEMA_VERSION,
  parseEnvironmentKind,
  parseFlowLifecycle,
  type DependencyPin,
  type FlowVersionRecord,
  type ReadonlyFlowGraph,
} from "@/lib/projects/types";

function assertGraphContractIsDeeplyReadonly(version: FlowVersionRecord): void {
  expectTypeOf(version.graph).toEqualTypeOf<ReadonlyFlowGraph>();
  // @ts-expect-error Version graph properties are immutable.
  version.graph.name = "mutated";
  // @ts-expect-error Version node collections are immutable.
  version.graph.nodes.push({
    id: "new",
    type: "input",
    params: {},
    position: { x: 0, y: 0 },
  });
  // @ts-expect-error Nested node properties are immutable.
  version.graph.nodes[0].position.x = 100;
  // @ts-expect-error Nested params are immutable.
  version.graph.nodes[0].params.runtime = true;
}

void assertGraphContractIsDeeplyReadonly;

describe("versioned project contracts", () => {
  it("freezes the initial schema and valid lifecycle values", () => {
    expect(FLOW_SCHEMA_VERSION).toBe(1);
    expect(ENVIRONMENT_KINDS).toEqual(["draft", "test", "live"]);
    expect(FLOW_LIFECYCLES).toEqual(["draft", "test", "live", "retired"]);
  });

  it("accepts valid environment and lifecycle values", () => {
    expect(parseEnvironmentKind("test")).toBe("test");
    expect(parseFlowLifecycle("retired")).toBe("retired");
  });

  it.each(["preview", "production", "", null, 1])(
    "rejects invalid environment value %o",
    (value) => {
      expect(() => parseEnvironmentKind(value)).toThrow("Invalid environment kind");
    },
  );

  it.each(["paused", "archived", "", undefined, false])(
    "rejects invalid lifecycle value %o",
    (value) => {
      expect(() => parseFlowLifecycle(value)).toThrow("Invalid flow lifecycle");
    },
  );

  it("represents immutable versions with pinned dependencies", () => {
    const dependency: DependencyPin = {
      id: "pin-1",
      flowVersionId: "version-1",
      kind: "agent",
      resourceId: "agent-1",
      version: "3",
      contentHash: "abc123",
      createdAt: 1,
    };
    const version: FlowVersionRecord = {
      id: "version-1",
      flowId: "flow-1",
      versionNumber: 1,
      schemaVersion: FLOW_SCHEMA_VERSION,
      label: "Initial checkpoint",
      description: "Known-good draft",
      graph: {
        id: "graph-1",
        name: "Graph",
        nodes: [],
        edges: [],
      },
      semanticHash: "semantic",
      fullHash: "full",
      createdBy: "owner-1",
      createdAt: 1,
      dependencies: [dependency],
    };

    expect(version.dependencies).toEqual([dependency]);
    expect(version.schemaVersion).toBe(FLOW_SCHEMA_VERSION);
  });
});
