import { describe, expect, it } from "vitest";
import {
  canvasNodePortSignature,
  resolveCanvasNodePorts,
} from "@/components/canvas/FlowCanvas";
import type { ResolvedNodePorts, ValidatedNodePortResolver } from "@/lib/flow/node-ports";
import type { FlowGraphV2, FlowNodeV2 } from "@/lib/flow/types";

const node: FlowNodeV2 = {
  id: "operation",
  type: "api.operation",
  params: {
    connectorDefinitionVersionId: "11111111-1111-4111-8111-111111111111",
    operationVersionId: "22222222-2222-4222-8222-222222222222",
    operationId: "listOrders",
    connectorProjectionHash: "a".repeat(64),
    operationProjectionHash: "b".repeat(64),
    schemaHash: "c".repeat(64),
  },
  bindings: {},
  position: { x: 0, y: 0 },
};

const graph: FlowGraphV2 = {
  schemaVersion: 2,
  id: "flow",
  name: "Flow",
  nodes: [node],
  edges: [],
  variables: [],
  groups: [],
  annotations: [],
};

function ports(schemaType: "string" | "number"): ResolvedNodePorts {
  return Object.freeze({
    inputPorts: Object.freeze([Object.freeze({
      id: "request", label: "Request", schema: { type: schemaType }, required: true, cardinality: "one" as const,
    })]),
    outputPorts: Object.freeze([Object.freeze({
      id: "result", label: "Result", schema: { type: schemaType }, required: true, cardinality: "one" as const,
    })]),
  });
}

describe("API operation canvas ports", () => {
  it("uses the injected exact-snapshot resolver instead of static API operation ports", () => {
    const expected = ports("string");
    const resolve: ValidatedNodePortResolver = () => expected;

    expect(resolveCanvasNodePorts(graph, node, resolve)).toBe(expected);
  });

  it("includes stable schema bytes in the handle revision signature", () => {
    const first: ValidatedNodePortResolver = () => ports("string");
    const second: ValidatedNodePortResolver = () => ports("number");

    expect(canvasNodePortSignature(graph, node, first)).not.toBe(
      canvasNodePortSignature(graph, node, second),
    );
  });
});
