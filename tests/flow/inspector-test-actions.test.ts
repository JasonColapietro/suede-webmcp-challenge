import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import Inspector from "@/components/canvas/Inspector";
import type { FlowNodeV2 } from "@/lib/flow/types";

const node: FlowNodeV2 = {
  id: "selected-node",
  type: "transform",
  params: { expression: "input" },
  bindings: {},
  position: { x: 0, y: 0 },
};

function runActions(markup: string): string {
  const start = markup.indexOf("<details");
  const end = markup.indexOf("</details>", start);
  return start >= 0 && end >= 0 ? markup.slice(start, end + "</details>".length) : "";
}

describe("Inspector scoped test actions", () => {
  it("renders one compact native disclosure with the exact three actions", () => {
    const markup = renderToStaticMarkup(createElement(Inspector, {
      node,
      graphVersion: 2,
      onRunTestScope: vi.fn(),
    }));

    expect(markup).toContain("<details");
    expect(markup).toContain("<summary");
    expect(markup).toContain(">Run selected</summary>");
    const labels = ["Run node", "Run to node", "Run from node"];
    for (const label of labels) expect(markup).toContain(`>${label}</button>`);
    expect(labels.map((label) => markup.indexOf(`>${label}</button>`))).toEqual(
      [...labels].map((label) => markup.indexOf(`>${label}</button>`)).sort((a, b) => a - b),
    );
    expect(runActions(markup)).not.toContain(" disabled");
    expect(runActions(markup)).not.toContain("aria-describedby");
  });

  it("disables every action and announces one shared reason", () => {
    const reason = "Resolve this reusable flow before testing.";
    const markup = renderToStaticMarkup(createElement(Inspector, {
      node,
      graphVersion: 2,
      onRunTestScope: vi.fn(),
      testRunDisabledReason: reason,
    }));

    const actions = runActions(markup);
    expect(actions.match(/ disabled=""/g)).toHaveLength(3);
    expect(actions.match(/aria-disabled="true"/g)).toHaveLength(3);
    const describedBy = actions.match(/aria-describedby="([^"]+)"/g) ?? [];
    expect(describedBy).toHaveLength(3);
    expect(new Set(describedBy)).toHaveLength(1);
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-atomic="true"');
    expect(markup.match(new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))).toHaveLength(1);
  });

  it("uses a fixed busy reason and omits actions without a selected callback surface", () => {
    const busy = renderToStaticMarkup(createElement(Inspector, {
      node,
      graphVersion: 2,
      onRunTestScope: vi.fn(),
      testRunBusy: true,
    }));
    expect(busy).toContain("A test run is already in progress.");
    expect(busy.match(/ disabled=""/g)).toHaveLength(3);

    const noCallback = renderToStaticMarkup(createElement(Inspector, { node, graphVersion: 2 }));
    const noSelection = renderToStaticMarkup(createElement(Inspector, {
      node: null,
      graphVersion: 2,
      onRunTestScope: vi.fn(),
    }));
    expect(noCallback).not.toContain("Run selected");
    expect(noSelection).not.toContain("Run selected");
  });

  it("guards dispatch and emits exact typed scopes without server dependencies", () => {
    const source = readFileSync("src/components/canvas/Inspector.tsx", "utf8");
    expect(source).toContain('import type { FlowTestScope } from "@/lib/flow/test-scope"');
    expect(source).toContain("onRunTestScope?: (scope: FlowTestScope) => void");
    expect(source).toContain("testRunDisabledReason?: string | null");
    expect(source).toContain("testRunBusy?: boolean");
    expect(source).toContain("if (!onRunTestScope || testRunBusy || testRunDisabledReason) return");
    expect(source).toContain('onClick={() => runTestScope("node")}');
    expect(source).toContain('onClick={() => runTestScope("to-node")}');
    expect(source).toContain('onClick={() => runTestScope("from-node")}');
    expect(source).toContain("onRunTestScope({ kind, nodeId: node.id })");
    expect(source).not.toMatch(/@\/lib\/(?:db|repository|run-service|settlement|x402)/);
    expect(source).not.toMatch(/@\/lib\/flow\/(?:registry|executor|test-runner)/);
    expect(source).not.toMatch(/from\s+["']node:/);
    expect(source).not.toContain("—");
  });
});
