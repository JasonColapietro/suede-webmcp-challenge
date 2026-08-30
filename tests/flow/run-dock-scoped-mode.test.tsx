import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import RunDock from "@/components/canvas/RunDock";
import type { FlowGraphV2 } from "@/lib/flow/types";

const graph: FlowGraphV2 = {
  schemaVersion: 2,
  id: "graph-1",
  name: "Scoped graph",
  nodes: [
    { id: "source", type: "input", params: {}, bindings: {}, position: { x: 0, y: 0 } },
    { id: "condition", type: "input", params: {}, bindings: {}, position: { x: 0, y: 0 } },
    { id: "target", type: "transform", params: { expression: "input" }, bindings: {}, position: { x: 0, y: 0 } },
  ],
  edges: [{
    id: "source-target",
    source: "source",
    sourceHandle: "result",
    target: "target",
    targetHandle: "in",
    condition: { kind: "port", nodeId: "condition", portId: "result" },
  }],
  variables: [],
  groups: [],
  annotations: [],
};

describe("RunDock scoped test mode", () => {
  it("renders a test receipt, environment, canonical human pin controls, and zero-cost ledger", () => {
    const markup = renderToStaticMarkup(createElement(RunDock, {
      flowId: "flow/one",
      graph,
      testEnvironment: { id: "environment-test", name: "Test" },
      testScope: { kind: "node", nodeId: "target" },
      onTestScopeClear: vi.fn(),
    }));

    expect(markup).toContain("Scoped test");
    expect(markup).toContain("Test receipt");
    expect(markup).toContain("Node only: target");
    expect(markup).toContain("Node only: target<br/>Test");
    expect(markup).toContain("source.result");
    expect(markup).toContain("condition on source-target");
    expect(markup).toContain("<select");
    expect(markup).toContain("<textarea");
    expect(markup).toContain("Run test");
    expect(markup).toContain("Clear test scope");
    expect(markup).toContain("$0.000 USDC · 0 ms");
    expect(markup).not.toContain("Trigger input JSON");
  });

  it("preserves the full-flow controls and copy when no test scope is supplied", () => {
    const markup = renderToStaticMarkup(createElement(RunDock, {
      flowId: "flow-1",
      graph,
      testEnvironment: { id: "environment-test", name: "Test" },
      defaultTriggerInput: { prompt: "demo" },
    }));
    expect(markup).toContain("Trigger input");
    expect(markup).toContain("Trigger input JSON");
    expect(markup).toContain("Run log");
    expect(markup).toContain(">Run</button>");
    expect(markup).not.toContain("Scoped test");
    expect(markup).not.toContain("Clear test scope");
  });

  it("keeps the 44px touch target on the interactive clear action, not the Test badge", () => {
    const markup = renderToStaticMarkup(createElement(RunDock, {
      flowId: "flow/one",
      graph,
      testEnvironment: { id: "environment-test", name: "Test" },
      testScope: { kind: "node", nodeId: "target" },
      onTestScopeClear: vi.fn(),
    }));
    const siteCss = readFileSync("src/app/site.css", "utf8");
    const touchRule = siteCss.match(/\.lp-touch\s*\{([^}]*)\}/u)?.[1];

    expect(markup).toMatch(/<button[^>]*class="mono lp-touch"[^>]*>Clear test scope<\/button>/u);
    expect(markup).toMatch(/<span class="mono"[^>]*>Test<\/span>/u);
    expect(touchRule).toContain("min-height: 44px;");
  });

  it("keeps scoped execution client-only, abortable, stale-safe, generic, and contract parsed", () => {
    const source = readFileSync("src/components/canvas/RunDock.tsx", "utf8");
    expect(source).toContain("graph?: FlowGraphV2 | null");
    expect(source).toContain("testEnvironment?: { readonly id: string; readonly name: string } | null");
    expect(source).toContain("testScope?: FlowTestScope | null");
    expect(source).toContain("onTestScopeClear?: () => void");
    expect(source).toContain("createTestRunUiPlan(graph, testScope)");
    expect(source).toContain("assembleTestRunRequest({");
    expect(source).toContain("readBoundedTestRunResponse(response, { signal: controller.signal })");
    expect(source).toContain("globalThis.fetch(`/api/v2/flows/${encodeURIComponent(executionFlowId)}/test`");
    expect(source).toContain("const controller = new AbortController()");
    expect(source).toContain("runGenerationRef.current += 1");
    expect(source).toContain("generation === runGenerationRef.current");
    expect(source).toContain("activeRunAbortRef.current?.abort()");
    for (const identity of ["flowId", "graph", "scopedMode", "testEnvironment?.id", "testScope?.kind", "testScope?.nodeId"]) {
      expect(source).toContain(identity);
    }
    expect(source).toContain("cancelActiveRun()");
    expect(source).toContain("Scoped test could not run.");
    expect(source).toContain("emitStatuses(nextStatuses)");
    expect(source).toContain("formatCapturedOutput(event.outputs)");
    expect(source).toContain("$0.000 USDC");
    expect(source).toContain("onRunningChange?: (running: boolean) => void");
    expect(source).toContain("const finalBlocker = runBlocker?.() ?? null");
    expect(source).toContain("signal: controller.signal");
    expect(source).toContain('role="status"');
    expect(source).toContain("MAX_VISIBLE_TEST_LOGS");
    expect(source).toContain("MAX_VISIBLE_TEST_LEDGER_ROWS");
    expect(source).toContain("Test outputs");
    expect(source).toContain('gridTemplateColumns: "minmax(200px, 0.9fr) minmax(180px, 1.6fr) minmax(220px, 1fr)"');
    expect(source).toContain('title={row.nodeId}');
    expect(source).toContain('title={row.nodeType}');
    expect(source).toContain('overflowWrap: "anywhere"');
    expect(source).toContain("const inertRun = running || Boolean(blockedMessage)");
    expect(source).toContain("if (running || blockedMessage) return");
    expect(source).not.toMatch(/response\.(?:text|statusText)/u);
    expect(source).not.toMatch(/from\s+["'][^"']*(?:\/db|\/projects|run-service|run-context|server-only)[^"']*["']/u);
  });
});
