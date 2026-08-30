/**
 * Regression cover for the JSON-field corruption defect.
 *
 * The Inspector's `json` control is a controlled textarea over
 * JSON.stringify(value). It used to commit unparsed text straight into
 * node.params, so the next render fed that raw string back through
 * JSON.stringify and quoted/escaped it — compounding on every keystroke. Any
 * edit passing through a momentarily-invalid state (deleting a brace, adding a
 * comma, typing `{` into an empty field) silently destroyed the param, and
 * nothing surfaced it until the flow failed at run time.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import Inspector, { configValidationIssues } from "@/components/canvas/Inspector";
import type { FlowNode, FlowNodeV2 } from "@/lib/flow/types";

const INSPECTOR = readFileSync(
  join(process.cwd(), "src/components/canvas/Inspector.tsx"),
  "utf8",
);

function httpNode(params: Record<string, unknown>): FlowNode {
  return { id: "n1", type: "http", params, position: { x: 0, y: 0 } };
}

describe("Inspector json fields", () => {
  it("never writes unparsed text back into params", () => {
    // The exact corrupting fallback that caused the defect.
    expect(INSPECTOR).not.toMatch(/catch\s*\{\s*update\(field\.key,\s*text\)\s*\}/);
    // The draft buffer that replaced it.
    expect(INSPECTOR).toContain("function JsonFieldControl(");
    expect(INSPECTOR).toContain("const [draft, setDraft] = useState<string | null>(null)");
  });

  it("keeps the user's own text on screen instead of re-serializing it", () => {
    // Render the draft when present; only fall back to the stored value.
    expect(INSPECTOR).toContain("const text = draft ?? serialized;");
  });

  it("tells the user, in a live region, that invalid JSON is unsaved", () => {
    expect(INSPECTOR).toContain('role="alert"');
    expect(INSPECTOR).toContain("Not valid JSON");
  });

  it("reports a param corrupted by an older build as needing attention", () => {
    // The corruption signature: a string that does not itself parse as JSON.
    const issues = configValidationIssues(httpNode({ headers: '{"Accept": "application/json"' }));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("json");
  });

  it("does not flag a json param that legitimately holds a string", () => {
    // JSON_VALUE_SCHEMA admits a bare string, so `"hello"` is valid here and
    // flagging every string would fire false positives across the catalog.
    expect(configValidationIssues(httpNode({ headers: '"hello"' }))).toEqual([]);
  });

  it("does not flag a well-formed object value", () => {
    expect(configValidationIssues(httpNode({ headers: { Accept: "application/json" } }))).toEqual([]);
  });

  it("makes a runtime-bound JSON field read-only and names its source", () => {
    const node: FlowNodeV2 = {
      id: "http-node",
      type: "http",
      params: {
        method: "GET",
        url: "https://example.com",
        headers: { Accept: "application/json" },
      },
      bindings: {
        headers: { kind: "port", nodeId: "fetch-node", portId: "result" },
      },
      position: { x: 0, y: 0 },
    };
    const markup = renderToStaticMarkup(createElement(Inspector, {
      graphVersion: 2,
      node,
      upstreamPorts: [{
        nodeId: "fetch-node",
        nodeLabel: "Fetch profile",
        portId: "result",
        portLabel: "Result",
        schema: { type: "object" },
      }],
      onPatch: vi.fn(),
      onSetBinding: vi.fn(),
      onRemoveBinding: vi.fn(),
    }));

    expect(markup).toMatch(/<textarea id="inspector-http-node-headers"[^>]*readOnly=""/);
    expect(markup).toContain("Value comes from Fetch profile · Result.");
    expect(markup).toContain("Change the data source below to edit a static value.");
  });
});
