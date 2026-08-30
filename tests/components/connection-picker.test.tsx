import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import Inspector, {
  connectionChoiceDisplayLabel,
  connectionBindingFromSelection,
  repairHttpHeadersBinding,
} from "@/components/canvas/Inspector";
import type { ConnectionChoice } from "@/lib/connections/client";
import type { FlowNodeV2, ValueBinding } from "@/lib/flow/types";

const choices: readonly ConnectionChoice[] = [
  {
    id: "conn_primary",
    label: "Primary API",
    kind: "bearer",
    publicHeaderNames: ["authorization"],
    lifecycleRevision: 7,
    slots: { test: "configured", live: "revoked" },
  },
  {
    id: "conn_backup",
    label: "Backup API",
    kind: "api_key",
    publicHeaderNames: ["x-api-key"],
    lifecycleRevision: 2,
    slots: { test: "missing", live: "configured" },
  },
];

function httpNode(binding?: ValueBinding): FlowNodeV2 {
  return {
    id: "http-node",
    type: "http",
    params: { method: "GET", url: "https://example.com", headers: {} },
    bindings: binding ? { headers: binding } : {},
    position: { x: 0, y: 0 },
  };
}

function markupFor(
  binding?: ValueBinding,
  status: "loading" | "ready" | "error" | "unavailable" = "ready",
  availableChoices: readonly ConnectionChoice[] = choices,
): string {
  return renderToStaticMarkup(createElement(Inspector, {
    graphVersion: 2,
    node: httpNode(binding),
    connectionChoices: availableChoices,
    connectionChoicesStatus: status,
    onSetBinding: vi.fn(),
    onRemoveBinding: vi.fn(),
  }));
}

describe("HTTP connection picker", () => {
  it("authors only listed choices with the fixed headers field and no environment", () => {
    expect(connectionBindingFromSelection("conn_primary", choices)).toEqual({
      ok: true,
      binding: { kind: "secret", connectionId: "conn_primary", field: "headers" },
    });
    expect(connectionBindingFromSelection("forged", choices)).toEqual({ ok: false });
    expect(JSON.stringify(connectionBindingFromSelection("conn_primary", choices))).not.toContain("environment");
  });

  it("shows metadata, explicit Test and Live states, and the execution boundary", () => {
    const markup = markupFor({ kind: "secret", connectionId: "conn_primary", field: "headers" });

    expect(markup).toContain("Primary API");
    expect(markup).toContain("bearer");
    expect(markup).toContain("Test: Configured");
    expect(markup).toContain("Live: Revoked");
    expect(markup).toContain("Backup API");
    expect(markup).toContain("Test: Missing");
    expect(markup).toContain("Live: Configured");
    expect(markup).toContain("Current previews and scoped Test runs resolve no credentials; only the active immutable Live deployment does.");
    expect(markup).toContain('href="/connections"');
    expect(markup).not.toContain("Connection ID");
    expect(markup).not.toContain("Secret field");
    expect(markup).not.toContain("environment");
  });

  it("adds only a stable short ID suffix when duplicate display labels collide", () => {
    const duplicates: readonly ConnectionChoice[] = [
      {
        id: "conn_primary_aaa111",
        label: "Shared API",
        kind: "bearer",
        publicHeaderNames: ["authorization"],
        lifecycleRevision: 1,
        slots: { test: "configured", live: "configured" },
      },
      {
        id: "conn_primary_bbb222",
        label: "Shared API",
        kind: "bearer",
        publicHeaderNames: ["authorization"],
        lifecycleRevision: 2,
        slots: { test: "configured", live: "configured" },
      },
    ];

    const first = connectionChoiceDisplayLabel(duplicates[0]!, duplicates);
    const second = connectionChoiceDisplayLabel(duplicates[1]!, duplicates);

    expect(first).toContain("Shared API · …aaa111");
    expect(second).toContain("Shared API · …bbb222");
    expect(first).not.toContain(duplicates[0]!.id);
    expect(second).not.toContain(duplicates[1]!.id);
    expect(connectionChoiceDisplayLabel(choices[0]!, choices)).not.toContain("…");
  });

  it.each([
    ["loading", "Connections are loading."],
    ["error", "Connections could not be loaded."],
    ["unavailable", "Connections are unavailable in this session."],
    ["ready", "No connections are configured."],
  ] as const)("renders an honest %s receipt without free-text fallback", (status, receipt) => {
    const markup = markupFor({ kind: "secret", connectionId: "current", field: "headers" }, status, []);
    expect(markup).toContain(receipt);
    expect(markup).not.toContain("Connection ID");
    expect(markup).not.toContain("Secret field");
  });

  it("preserves a missing reference and links to connection management", () => {
    const binding = { kind: "secret", connectionId: "gone", field: "headers" } as const;
    const before = JSON.stringify(binding);
    const onSetBinding = vi.fn();
    const onRemoveBinding = vi.fn();
    const markup = renderToStaticMarkup(createElement(Inspector, {
      graphVersion: 2,
      node: httpNode(binding),
      connectionChoices: choices,
      connectionChoicesStatus: "ready",
      onSetBinding,
      onRemoveBinding,
    }));

    expect(markup).toContain("Referenced connection is missing.");
    expect(markup).toContain('href="/connections"');
    expect(JSON.stringify(binding)).toBe(before);
    expect(onSetBinding).not.toHaveBeenCalled();
    expect(onRemoveBinding).not.toHaveBeenCalled();
  });

  it("does not rewrite bindings when metadata order or availability changes", () => {
    const binding = { kind: "secret", connectionId: "conn_primary", field: "headers" } as const;
    const before = JSON.stringify(binding);
    const onSetBinding = vi.fn();
    const onRemoveBinding = vi.fn();

    for (const [status, availableChoices] of [
      ["loading", []],
      ["error", []],
      ["unavailable", []],
      ["ready", [...choices].reverse()],
    ] as const) {
      renderToStaticMarkup(createElement(Inspector, {
        graphVersion: 2,
        node: httpNode(binding),
        connectionChoices: availableChoices,
        connectionChoicesStatus: status,
        onSetBinding,
        onRemoveBinding,
      }));
    }

    expect(JSON.stringify(binding)).toBe(before);
    expect(onSetBinding).not.toHaveBeenCalled();
    expect(onRemoveBinding).not.toHaveBeenCalled();
  });

  it("keeps a legacy field byte-stable and offers an explicit one-field repair", () => {
    const credentialCanary = "sk_legacyCredentialCanary123456";
    const legacy = { kind: "secret", connectionId: "conn_primary", field: credentialCanary } as const;
    const before = JSON.stringify(legacy);
    const markup = markupFor(legacy);

    expect(markup).toContain("Unsupported connection field");
    expect(markup).not.toContain(credentialCanary);
    expect(markup).toContain("Repair to headers");
    expect(JSON.stringify(legacy)).toBe(before);
    expect(repairHttpHeadersBinding(legacy)).toEqual({
      kind: "secret",
      connectionId: "conn_primary",
      field: "headers",
    });
    expect(Object.keys(repairHttpHeadersBinding(legacy) ?? {}).sort()).toEqual(["connectionId", "field", "kind"]);
  });

  it("refuses connection authoring on every other node/key and on graph v1", () => {
    const llm: FlowNodeV2 = {
      id: "llm-node",
      type: "llm",
      params: { prompt: "hello" },
      bindings: { prompt: { kind: "secret", connectionId: "opaque", field: "token" } },
      position: { x: 0, y: 0 },
    };
    const unsupported = renderToStaticMarkup(createElement(Inspector, {
      graphVersion: 2,
      node: llm,
      connectionChoices: choices,
      connectionChoicesStatus: "ready",
      onSetBinding: vi.fn(),
      onRemoveBinding: vi.fn(),
    }));
    const legacy = renderToStaticMarkup(createElement(Inspector, {
      graphVersion: 1,
      node: { id: "http-v1", type: "http", params: httpNode().params, position: { x: 0, y: 0 } },
      connectionChoices: choices,
      connectionChoicesStatus: "ready",
      onSetBinding: vi.fn(),
      onRemoveBinding: vi.fn(),
    }));

    expect(unsupported).toContain("Unsupported secret reference");
    expect(unsupported).not.toContain("Choose a connection");
    expect(unsupported).not.toContain("Repair to headers");
    expect(legacy).not.toContain("Connection reference");
    expect(legacy).not.toContain("Choose a connection");
  });
});
