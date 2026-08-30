import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import CallableInterfaceEditor from "@/components/canvas/CallableInterfaceEditor";
import type { ValidatedNodePortResolver } from "@/lib/flow/node-ports";
import type { FlowGraphV2, FlowNodeV2 } from "@/lib/flow/types";

const operation: FlowNodeV2 = {
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
  nodes: [operation],
  edges: [],
  variables: [],
  groups: [],
  annotations: [],
};

describe("API operation callable interface", () => {
  it("offers result only through the injected closure-backed resolver", () => {
    const resolvePorts: ValidatedNodePortResolver = () => ({
      inputPorts: [],
      outputPorts: [{
        id: "closure-result",
        label: "Closure result",
        schema: { type: "object", properties: { orderId: { type: "string" } } },
        required: true,
        cardinality: "one",
      }],
    });
    const markup = renderToStaticMarkup(createElement(CallableInterfaceEditor, {
      graph,
      resolvePorts,
      value: {
        inputs: [],
        outputs: [{
          id: "answer",
          label: "Answer",
          schema: { type: "object" },
          required: true,
          cardinality: "one",
          source: { nodeId: "operation", portId: "closure-result" },
        }],
      },
      onSet: () => undefined,
      onRemove: () => undefined,
    }));

    expect(markup).toContain("Closure result (closure-result)");
    expect(markup).not.toContain("Result (result)");
  });

  it("announces a fixed repair state when operation authority has no ports", () => {
    const resolvePorts: ValidatedNodePortResolver = () => ({ inputPorts: [], outputPorts: [] });
    const markup = renderToStaticMarkup(createElement(CallableInterfaceEditor, {
      graph,
      resolvePorts,
      showApiOperationPortStatus: true,
      onSet: () => undefined,
      onRemove: () => undefined,
    }));

    expect(markup).toContain("API operation ports are unavailable. Repair this node before mapping outputs.");
    expect(markup).not.toContain("Result (result)");
  });
});
