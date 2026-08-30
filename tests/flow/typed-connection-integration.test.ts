import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  commandForConnection,
  decideCanvasConnectionForRenderedGraph,
  verdictForSavedCanvasEdge,
  verdictForCanvasConnection,
} from "@/components/canvas/FlowCanvas";
import type { ValidatedNodePortResolver } from "@/lib/flow/node-ports";
import type { FlowGraphV1, FlowGraphV2 } from "@/lib/flow/types";

const v2: FlowGraphV2 = {
  schemaVersion: 2,
  id: "typed",
  name: "Typed",
  nodes: [
    { id: "llm", type: "llm", params: {}, bindings: {}, position: { x: 0, y: 0 } },
    { id: "output", type: "output", params: {}, bindings: {}, position: { x: 200, y: 0 } },
  ],
  edges: [],
  variables: [],
  groups: [],
  annotations: [],
};

describe("typed canvas connection integration", () => {
  it("routes connection notices through the persistent builder announcement", () => {
    const source = readFileSync(join(process.cwd(), "src/components/canvas/FlowCanvas.tsx"), "utf8");
    const builder = readFileSync(join(process.cwd(), "src/app/build/[flowId]/builder.tsx"), "utf8");
    expect(source).toContain('if (decision.verdict.status === "untyped") showConnectionError(decision.verdict.message)');
    expect(source).toContain("onAnnounce?.(message)");
    expect(source).toContain("onAnnounce?: (message: string) => void");
    expect(source).toContain('aria-hidden="true"');
    expect(source).toContain("{connectionError}");
    expect(builder).toContain("onAnnounce={setCommandAnnouncement}");
  });

  it("keeps the visual connection notice below the command bar and out of the pointer path", () => {
    const theme = readFileSync(join(process.cwd(), "src/components/canvas/canvas-theme.css"), "utf8");
    const toastRule = theme.match(/\.canvas-connection-toast\s*\{([^}]*)\}/u)?.[1];

    expect(toastRule).toContain("bottom: 24px;");
    expect(toastRule).toContain("pointer-events: none;");
    expect(toastRule).not.toMatch(/\btop:/u);
  });

  it("rejects repeated targets honestly even when the port advertises many inputs", () => {
    const graph: FlowGraphV2 = {
      ...v2,
      nodes: [
        { id: "first", type: "llm", params: {}, bindings: {}, position: { x: 0, y: 0 } },
        { id: "second", type: "llm", params: {}, bindings: {}, position: { x: 0, y: 100 } },
        { id: "target", type: "output", params: {}, bindings: {}, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "existing", source: "first", sourceHandle: "result", target: "target", targetHandle: "in" }],
    };
    const resolvePorts: ValidatedNodePortResolver = (node) => node.id === "target"
      ? {
          inputPorts: [{ id: "in", label: "Input", schema: {}, required: true, cardinality: "many" }],
          outputPorts: [],
        }
      : {
          inputPorts: [],
          outputPorts: [{ id: "result", label: "Result", schema: {}, required: true, cardinality: "one" }],
        };

    const decision = decideCanvasConnectionForRenderedGraph(
      graph,
      resolvePorts,
      { source: "second", sourceHandle: "result", target: "target", targetHandle: "in" },
      "connect-2",
      "edge-2",
    );
    expect(decision.command).toBeNull();
    expect(decision.verdict).toMatchObject({ status: "incompatible" });
    expect(decision.verdict.message).toMatch(/already has an incoming edge.*not supported yet/i);
  });

  it("validates a saved edge without treating that edge as its own collision", () => {
    const graph: FlowGraphV2 = {
      ...v2,
      edges: [{ id: "saved", source: "llm", sourceHandle: "result", target: "output", targetHandle: "in" }],
    };
    const edge = graph.edges[0];
    if (!edge) throw new Error("saved edge fixture missing");

    expect(verdictForCanvasConnection(graph, edge).status).toBe("incompatible");
    expect(verdictForSavedCanvasEdge(graph, edge).status).toBe("compatible");
  });

  it("requires and preserves both v2 handles in the authored command", () => {
    expect(verdictForCanvasConnection(v2, {
      source: "llm", target: "output", sourceHandle: null, targetHandle: "in",
    }).status).toBe("incompatible");

    expect(commandForConnection(
      v2,
      { source: "llm", target: "output", sourceHandle: "result", targetHandle: "in" },
      "connect-1",
      "edge-1",
    )).toEqual({
      v: 1,
      id: "connect-1",
      kind: "edge.add",
      edge: { id: "edge-1", source: "llm", sourceHandle: "result", target: "output", targetHandle: "in" },
    });
  });

  it("keeps config-dependent loop input untyped and permits open provider links with named notices", () => {
    const loopGraph = {
      ...v2,
      nodes: [
        { id: "llm", type: "llm" as const, params: {}, bindings: {}, position: { x: 0, y: 0 } },
        { id: "loop", type: "loop" as const, params: {}, bindings: {}, position: { x: 200, y: 0 } },
      ],
    };
    const loopVerdict = verdictForCanvasConnection(loopGraph, {
      source: "llm", target: "loop", sourceHandle: "result", targetHandle: "in",
    });
    expect(loopVerdict.status).toBe("untyped");
    expect(loopVerdict.status).not.toBe("compatible");
    expect(loopVerdict.message).toMatch(/llm\.result.*loop\.in/i);

    const untyped = {
      ...v2,
      nodes: [
        { id: "provider", type: "suede.styleCoach" as const, params: {}, bindings: {}, position: { x: 0, y: 0 } },
        { id: "sink", type: "suede.lyrics" as const, params: {}, bindings: {}, position: { x: 200, y: 0 } },
      ],
    };
    const verdict = verdictForCanvasConnection(untyped, {
      source: "provider", target: "sink", sourceHandle: "result", targetHandle: "in",
    });
    expect(verdict.status).toBe("untyped");
    expect(verdict.message).toMatch(/provider\.result.*sink\.in/i);
  });

  it("keeps v1 grandfathered collision behavior and optional handles", () => {
    const v1: FlowGraphV1 = {
      id: "legacy",
      name: "Legacy",
      nodes: [
        { id: "a", type: "input", params: {}, position: { x: 0, y: 0 } },
        { id: "b", type: "output", params: {}, position: { x: 200, y: 0 } },
      ],
      edges: [
        { id: "old-1", source: "a", target: "b" },
        { id: "old-2", source: "a", target: "b" },
      ],
    };
    expect(verdictForCanvasConnection(v1, {
      source: "a", target: "b", sourceHandle: null, targetHandle: null,
    }).status).toBe("incompatible");
    expect(commandForConnection(
      v1,
      { source: "a", target: "b", sourceHandle: null, targetHandle: null },
      "legacy-connect",
      "legacy-edge",
    ).edge).toEqual({ id: "legacy-edge", source: "a", target: "b" });
  });
});
