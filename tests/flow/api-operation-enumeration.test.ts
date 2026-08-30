import { describe, expect, it } from "vitest";
import { CONNECTOR_SYSTEM_POLICY_V1 } from "@/lib/connectors/schema";
import { FREE_NODE_TYPES } from "@/lib/flow/executor";
import { getNodeDefinition, NODE_TYPE_SET } from "@/lib/flow/node-definitions";
import { NODE_META } from "@/lib/flow/node-meta";
import { NODE_DEFS } from "@/lib/flow/nodes";
import { scopedTestStubFor } from "@/lib/flow/test-scoped-stubs";
import { DURABLE_NODE_ADMISSION } from "@/lib/runtime/admission";
import { SEED_TEMPLATES } from "@/lib/templates";

describe("api.operation exhaustive registration", () => {
  it("has one conservative simulation-only catalog and runtime entry", () => {
    const definition = getNodeDefinition("api.operation");
    expect(definition).toMatchObject({
      type: "api.operation",
      testMode: "stub",
      effects: ["write"],
      retry: "unsafe",
      cost: { kind: "variable" },
      prototype: { enabled: false, badge: "Prototype: simulation only" },
    });
    expect(definition.inputPorts.map(({ id }) => id)).toEqual(["request"]);
    expect(definition.outputPorts.map(({ id }) => id)).toEqual(["result"]);
    expect(NODE_TYPE_SET.has("api.operation")).toBe(true);
    expect(NODE_DEFS.filter(({ type }) => type === "api.operation")).toHaveLength(1);
    expect(NODE_META.filter(({ type }) => type === "api.operation")).toHaveLength(1);
    expect(FREE_NODE_TYPES).not.toContain("api.operation");
    expect(scopedTestStubFor("api.operation")).toBeTypeOf("function");
    expect(DURABLE_NODE_ADMISSION["api.operation"]).toBe("refuse");
    expect(SEED_TEMPLATES.flatMap((template) => template.graph.nodes).some((node) => node.type === "api.operation")).toBe(false);
    expect(CONNECTOR_SYSTEM_POLICY_V1).toEqual({ effects: ["write"], retry: "unsafe", cost: "unknown", idempotency: "none" });
    expect(definition.cost).not.toEqual(CONNECTOR_SYSTEM_POLICY_V1);
  });
});
