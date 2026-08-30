import { describe, expect, it } from "vitest";
import {
  buildLaunchGraph,
  launchPriceUsdc,
  SCHEDULE_NODE_ID,
  type LaunchManifest,
} from "@/lib/launch/manifest-graph";

const BASE: LaunchManifest = {
  name: "Acme Movers Concierge",
  description: "Answers questions about Acme Movers.",
  triggers: [{ kind: "paidCall", priceUsdc: 0.02 }],
  steps: [
    { id: "n1", type: "input", config: { fields: { request: "" } }, after: [] },
    { id: "n2", type: "llm", config: { prompt: "{{in}}" }, after: ["n1"] },
    { id: "n3", type: "output", config: { label: "Answer" }, after: ["n2"] },
  ],
  meta: { template: "site-agent:concierge", createdBy: "guided" },
};

describe("launchPriceUsdc", () => {
  it("reads the paidCall price, defaulting to free", () => {
    expect(launchPriceUsdc(BASE)).toBe(0.02);
    expect(launchPriceUsdc({ ...BASE, triggers: [{ kind: "manual" }] })).toBe(0);
  });
});

describe("buildLaunchGraph", () => {
  it("lays steps out left to right and wires after entries as edges", () => {
    const graph = buildLaunchGraph(BASE, "site-1");

    expect(graph.id).toBe("site-1");
    expect(graph.name).toBe("Acme Movers Concierge");
    expect(graph.nodes.map((node) => node.position.x)).toEqual([80, 420, 760]);
    expect(graph.edges).toEqual([
      { id: "n1->n2", source: "n1", target: "n2", targetHandle: "in" },
      { id: "n2->n3", source: "n2", target: "n3", targetHandle: "in" },
    ]);
    expect(graph.meta).toEqual({
      template: "site-agent:concierge",
      createdBy: "guided",
      description: "Answers questions about Acme Movers.",
    });
  });

  it("copies step config rather than aliasing it", () => {
    const graph = buildLaunchGraph(BASE, "site-1");

    expect(graph.nodes[0]!.params).toEqual({ fields: { request: "" } });
    expect(graph.nodes[0]!.params).not.toBe(BASE.steps[0]!.config);
  });

  it("prepends a schedule node and shifts every step one column right", () => {
    const graph = buildLaunchGraph(
      { ...BASE, triggers: [{ kind: "schedule", cron: "0 9 * * *" }] },
      "site-2",
    );

    expect(graph.nodes[0]).toEqual({
      id: SCHEDULE_NODE_ID,
      type: "schedule",
      params: { cron: "0 9 * * *" },
      position: { x: 80, y: 120 },
    });
    expect(graph.nodes.map((node) => node.position.x)).toEqual([80, 420, 760, 1100]);
    expect(graph.edges).toContainEqual({
      id: `${SCHEDULE_NODE_ID}->n1`,
      source: SCHEDULE_NODE_ID,
      target: "n1",
      targetHandle: "in",
    });
    // Only the rootless step gets a schedule edge.
    expect(graph.edges.filter((edge) => edge.source === SCHEDULE_NODE_ID)).toHaveLength(1);
  });

  it("preserves named source handles on branch-style edges", () => {
    const graph = buildLaunchGraph(
      {
        ...BASE,
        steps: [
          { id: "n1", type: "branch", config: {}, after: [] },
          { id: "n2", type: "output", config: {}, after: [{ node: "n1", handle: "true" }] },
        ],
      },
      "site-3",
    );

    expect(graph.edges).toEqual([
      { id: "n1:true->n2", source: "n1", target: "n2", targetHandle: "in", sourceHandle: "true" },
    ]);
  });
});
