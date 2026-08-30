import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import Inspector, {
  bindingFromSelection,
  boundSourceSummary,
  connectionBindingFromSelection,
  repairHttpHeadersBinding,
  type UpstreamPortChoice,
} from "@/components/canvas/Inspector";
import type { ConnectionChoice } from "@/lib/connections/client";
import type { FlowNodeV2, FlowVariable } from "@/lib/flow/types";

const variables: FlowVariable[] = [
  { id: "region-id", name: "Region", scope: "workflow", schema: { type: "string" } },
];
const upstream: UpstreamPortChoice[] = [
  { nodeId: "source-a", nodeLabel: "Source", portId: "result", portLabel: "Result", schema: { type: "object" } },
  { nodeId: "source-b", nodeLabel: "Source", portId: "result", portLabel: "Result", schema: {} },
];
const node: FlowNodeV2 = {
  id: "sink",
  type: "llm",
  params: { prompt: "hello" },
  bindings: {},
  position: { x: 0, y: 0 },
};
const connectionChoices: readonly ConnectionChoice[] = [{
  id: "http-auth",
  label: "HTTP auth",
  kind: "custom_headers",
  publicHeaderNames: ["x-api-key"],
  lifecycleRevision: 1,
  slots: { test: "configured", live: "missing" },
}];

describe("Inspector structured binding contract", () => {
  it("shows structured data modes while refusing legacy secrets outside HTTP headers", () => {
    const boundNode: FlowNodeV2 = {
      ...node,
      bindings: {
        prompt: { kind: "port", nodeId: "source-a", portId: "result" },
        system: { kind: "variable", variableId: "region-id" },
        model: { kind: "secret", connectionId: "model-connection", field: "token" },
      },
    };
    const markup = renderToStaticMarkup(createElement(Inspector, {
      graphVersion: 2,
      node: boundNode,
      variables,
      upstreamPorts: upstream,
      validationIssues: ["Prompt needs review."],
      onPatch: vi.fn(),
      onSetBinding: vi.fn(),
      onRemoveBinding: vi.fn(),
    }));

    expect(markup).toContain("Static value");
    expect(markup).toContain("Upstream output");
    expect(markup).toContain("Workflow/run variable");
    expect(markup).toContain("Unsupported secret reference");
    expect(markup).toContain('value="source-a::result"');
    expect(markup).toContain('value="source-b::result"');
    expect(markup).toContain('value="region-id"');
    expect(markup).not.toContain("Connection ID");
    expect(markup).not.toContain("Secret field");
    expect(markup).not.toMatch(/type="password"|name="secret-value"|>Secret value</i);
    expect(markup).toContain("Prompt needs review.");
    expect(markup).toContain("Unknown schema");
    expect(markup).toContain("typed");
  });

  it("derives the shown data source from stored bindings without remounting focused controls", () => {
    const source = readFileSync(join(process.cwd(), "src/components/canvas/Inspector.tsx"), "utf8");
    expect(source).toContain("key={`${node.id}:${field.key}`}");
    expect(source).not.toContain("key={bindingControlRevision(");
    expect(source).toContain("const mode = pendingMode ?? storedMode;");
  });

  it("names runtime sources while keeping secret-backed params editable", () => {
    const port = { kind: "port", nodeId: "source-a", portId: "result" } as const;
    const variable = { kind: "variable", variableId: "region-id" } as const;

    expect(boundSourceSummary(port, upstream, variables)).toBe("Source · Result");
    expect(boundSourceSummary(variable, upstream, variables)).toBe("variable Region");
    expect(boundSourceSummary(
      { kind: "port", nodeId: "gone", portId: "out" },
      [],
      [],
    )).toBe("gone.out");
    expect(boundSourceSummary(
      { kind: "secret", connectionId: "http-auth", field: "headers" },
      upstream,
      variables,
    )).toBeUndefined();
  });

  it("does not display an unsaved first option for select fields", () => {
    const httpNode: FlowNodeV2 = {
      id: "request",
      type: "http",
      params: { url: "https://example.com" },
      bindings: {},
      position: { x: 0, y: 0 },
    };
    const markup = renderToStaticMarkup(createElement(Inspector, {
      graphVersion: 2,
      node: httpNode,
      variables,
      upstreamPorts: upstream,
      onSetBinding: vi.fn(),
      onRemoveBinding: vi.fn(),
    }));

    expect(markup).toContain("Choose Method");
    expect(markup).toMatch(/<option value="" disabled="" selected="">Choose Method<\/option>/);
  });

  it("does not leave hidden secret controls displayable by CSS", () => {
    const source = readFileSync(join(process.cwd(), "src/components/canvas/Inspector.tsx"), "utf8");
    const styles = readFileSync(join(process.cwd(), "src/app/site.css"), "utf8");
    expect(source).not.toContain('hidden={mode !== "secret"}');
    expect(source).not.toContain('hidden={mode !== "port"}');
    expect(source).not.toContain('hidden={mode !== "variable"}');
    expect(source).not.toContain("setConnectionId");
    expect(source).not.toContain("secretField");
    expect(source).not.toContain("commitSecret");
    expect(styles).not.toMatch(/\.binding-control__secret\s*\{[^}]*display:\s*grid/s);

    const staticMarkup = renderToStaticMarkup(createElement(Inspector, {
      graphVersion: 2,
      node,
      variables,
      upstreamPorts: upstream,
      onSetBinding: vi.fn(),
      onRemoveBinding: vi.fn(),
    }));
    expect(staticMarkup).not.toContain("Connection ID");
    expect(staticMarkup).not.toContain("Secret field");

    const secretMarkup = renderToStaticMarkup(createElement(Inspector, {
      graphVersion: 2,
      node: { ...node, bindings: { prompt: { kind: "secret", connectionId: "opaque", field: "token" } } },
      variables,
      upstreamPorts: upstream,
      onSetBinding: vi.fn(),
      onRemoveBinding: vi.fn(),
    }));
    expect(secretMarkup).toContain("Unsupported secret reference");
    expect(secretMarkup).not.toContain("Connection ID");
    expect(secretMarkup).not.toContain("Secret field");
  });

  it("retains the legacy input hint without inventing structured bindings", () => {
    const markup = renderToStaticMarkup(createElement(Inspector, {
      graphVersion: 1,
      node: { id: node.id, type: node.type, params: node.params, position: node.position },
      variables: [],
      upstreamPorts: upstream,
      validationIssues: [],
      onPatch: vi.fn(),
    }));
    expect(markup).toContain("{{in}}");
    expect(markup).toContain("Legacy flow");
  });

  it("refuses missing or prototype-like upstream and variable IDs", () => {
    expect(bindingFromSelection("port", "missing::result", upstream, variables)).toEqual({ ok: false });
    expect(bindingFromSelection("port", "constructor::result", upstream, variables)).toEqual({ ok: false });
    expect(bindingFromSelection("variable", "missing", upstream, variables)).toEqual({ ok: false });
    expect(bindingFromSelection("variable", "__proto__", upstream, variables)).toEqual({ ok: false });
    expect(bindingFromSelection("port", "source-b::result", upstream, variables)).toEqual({
      ok: true,
      binding: { kind: "port", nodeId: "source-b", portId: "result" },
    });
  });

  it("accepts only listed connection metadata and repairs only the semantic field", () => {
    expect(connectionBindingFromSelection("http-auth", connectionChoices)).toEqual({
      ok: true,
      binding: { kind: "secret", connectionId: "http-auth", field: "headers" },
    });
    expect(connectionBindingFromSelection("constructor", connectionChoices)).toEqual({ ok: false });

    const legacy = { kind: "secret", connectionId: "http-auth", field: "apiKey" } as const;
    expect(repairHttpHeadersBinding(legacy)).toEqual({ ...legacy, field: "headers" });
    expect(JSON.stringify(repairHttpHeadersBinding(legacy))).not.toContain("environment");
  });

  it("renders the logical HTTP picker without credential-shaped controls", () => {
    const http: FlowNodeV2 = {
      id: "http-node",
      type: "http",
      params: { method: "GET", url: "https://example.com", headers: {} },
      bindings: { headers: { kind: "secret", connectionId: "http-auth", field: "headers" } },
      position: { x: 0, y: 0 },
    };
    const markup = renderToStaticMarkup(createElement(Inspector, {
      graphVersion: 2,
      node: http,
      connectionChoices,
      connectionChoicesStatus: "ready",
      onSetBinding: vi.fn(),
      onRemoveBinding: vi.fn(),
    }));

    expect(markup).toContain("Connection reference");
    expect(markup).toContain("HTTP auth");
    expect(markup).toContain("Test: Configured");
    expect(markup).toContain("Live: Missing");
    expect(markup).not.toContain("Connection ID");
    expect(markup).not.toContain("Secret field");
  });

  it("renders a dedicated business-action connection picker with compatible choices only", () => {
    const slack: FlowNodeV2 = {
      id: "slack-node",
      type: "comms.slackMessage",
      params: { text: "{{in}}" },
      bindings: {},
      position: { x: 0, y: 0 },
    };
    const choices: readonly ConnectionChoice[] = [
      ...connectionChoices,
      {
        id: "slack-webhook",
        label: "Support alerts",
        kind: "custom_headers",
        publicHeaderNames: ["x-suede-webhook-url"],
        lifecycleRevision: 1,
        slots: { test: "configured", live: "configured" },
      },
      {
        id: "github-token",
        label: "GitHub",
        kind: "bearer",
        publicHeaderNames: ["authorization"],
        lifecycleRevision: 1,
        slots: { test: "configured", live: "configured" },
      },
    ];
    const markup = renderToStaticMarkup(createElement(Inspector, {
      graphVersion: 2,
      node: slack,
      connectionChoices: choices,
      connectionChoicesStatus: "ready",
      onSetBinding: vi.fn(),
      onRemoveBinding: vi.fn(),
    }));

    expect(markup).toContain("Required connections");
    expect(markup).toContain("Slack webhook");
    expect(markup).toContain("Support alerts");
    expect(markup).not.toContain("GitHub · bearer");
    expect(markup).not.toContain("HTTP auth · custom_headers");
    expect(markup).not.toContain("Connection ID");
    expect(markup).not.toContain("Secret field");
  });
});
