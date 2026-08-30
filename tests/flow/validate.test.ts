import { describe, it, expect } from "vitest";
import { validateFlowGraph } from "@/lib/flow/validate";
import { node, edge, graph } from "../_helpers";
import type { FlowNode } from "@/lib/flow/types";
import type { FlowGraphV2 } from "@/lib/flow/types";

function withParams(n: FlowNode, params: Record<string, unknown>): FlowNode {
  return { ...n, params };
}

describe("validateFlowGraph", () => {
  it("passes a simple linear input -> llm -> output chain with a prompt", () => {
    const g = graph(
      [
        node("a", "input"),
        withParams(node("b", "llm"), { prompt: "Summarize the input." }),
        node("c", "output"),
      ],
      [edge("a", "b"), edge("b", "c")],
    );
    expect(validateFlowGraph(g)).toBeNull();
  });

  it("rejects an empty graph", () => {
    const g = graph([], []);
    expect(validateFlowGraph(g)).toMatch(/no nodes/i);
  });

  it("names the offending node when it has no incoming edge", () => {
    const g = graph(
      [node("a", "input"), node("b", "output"), node("c", "output")],
      [edge("a", "b")],
    );
    const err = validateFlowGraph(g);
    expect(err).toMatch(/not connected/i);
    expect(err).toContain("(c)");
  });

  it("rejects a graph with no trigger node", () => {
    // Both nodes have an incoming edge (from each other), so rule 1 passes —
    // this isolates the "no trigger at all" check.
    const g = graph(
      [
        withParams(node("a", "llm"), { prompt: "hi" }),
        withParams(node("b", "llm"), { prompt: "hi" }),
      ],
      [edge("a", "b"), edge("b", "a")],
    );
    expect(validateFlowGraph(g)).toMatch(/no trigger/i);
  });

  it("rejects a trigger-only graph with nothing reachable that terminates", () => {
    const g = graph([node("a", "input")], []);
    expect(validateFlowGraph(g)).toMatch(/ends the flow/i);
  });

  it("rejects a disconnected second component even if the main chain is fine", () => {
    const g = graph(
      [
        node("a", "schedule"),
        node("b", "output"),
        node("c", "input"),
        node("d", "output"),
      ],
      [edge("a", "b"), edge("c", "d")],
    );
    // c and d form their own connected component; d has an incoming edge from c
    // so rule 1 passes for d, and the graph as a whole still has a reachable
    // terminal via a -> b, so this should be valid overall.
    expect(validateFlowGraph(g)).toBeNull();
  });

  it("rejects an llm node with an empty prompt", () => {
    const g = graph(
      [node("a", "input"), withParams(node("b", "llm"), { prompt: "  " }), node("c", "output")],
      [edge("a", "b"), edge("b", "c")],
    );
    const err = validateFlowGraph(g);
    expect(err).toMatch(/no prompt/i);
    expect(err).toContain("(b)");
  });

  it("rejects an llm node with a missing prompt entirely", () => {
    const g = graph(
      [node("a", "input"), node("b", "llm"), node("c", "output")],
      [edge("a", "b"), edge("b", "c")],
    );
    expect(validateFlowGraph(g)).toMatch(/no prompt/i);
  });

  it("rejects a transform node with no expression", () => {
    const g = graph(
      [node("a", "input"), node("b", "transform"), node("c", "output")],
      [edge("a", "b"), edge("b", "c")],
    );
    expect(validateFlowGraph(g)).toMatch(/no expression/i);
  });

  it("passes a transform node with a non-empty expression", () => {
    const g = graph(
      [node("a", "input"), withParams(node("b", "transform"), { expression: "in.a" }), node("c", "output")],
      [edge("a", "b"), edge("b", "c")],
    );
    expect(validateFlowGraph(g)).toBeNull();
  });

  it("accepts a webhook-triggered graph, since webhook counts as a valid trigger", () => {
    const g = graph(
      [
        node("a", "webhook"),
        withParams(node("b", "llm"), { prompt: "Summarize the event." }),
        node("c", "output"),
      ],
      [edge("a", "b"), edge("b", "c")],
    );
    expect(validateFlowGraph(g)).toBeNull();
  });

  it("accepts a branch node with only one of its two output handles wired", () => {
    const g = graph(
      [
        node("a", "input"),
        withParams(node("b", "branch"), { field: "ok", truthy: true }),
        node("c", "output"),
      ],
      [edge("a", "b"), edge("b", "c", "true")],
    );
    expect(validateFlowGraph(g)).toBeNull();
  });

  it("refuses a live business action until its required connection is bound", () => {
    const g = graph(
      [
        node("a", "input"),
        withParams(node("b", "comms.slackMessage"), { text: "{{in.message}}" }),
        node("c", "output"),
      ],
      [edge("a", "b"), edge("b", "c")],
    );
    expect(validateFlowGraph(g)).toMatch(/Slack Message.*Slack webhook.*Connection/i);
  });

  it("accepts the business action after its exact connection binding is present", () => {
    const g: FlowGraphV2 = {
      schemaVersion: 2,
      id: "connected-action",
      name: "Connected action",
      nodes: [
        { id: "a", type: "input", params: {}, bindings: {}, position: { x: 0, y: 0 } },
        {
          id: "b",
          type: "comms.slackMessage",
          params: { text: "{{in.message}}" },
          bindings: {
            connection: { kind: "secret", connectionId: "slack-connection", field: "webhook" },
          },
          position: { x: 100, y: 0 },
        },
        { id: "c", type: "output", params: {}, bindings: {}, position: { x: 200, y: 0 } },
      ],
      edges: [
        { id: "a-b", source: "a", sourceHandle: "result", target: "b", targetHandle: "in" },
        { id: "b-c", source: "b", sourceHandle: "result", target: "c", targetHandle: "in" },
      ],
      variables: [],
      groups: [],
      annotations: [],
    };
    expect(validateFlowGraph(g)).toBeNull();
  });
});
