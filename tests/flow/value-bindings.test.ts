import { describe, expect, it, vi } from "vitest";
import type { FlowGraphV2, ValueBinding } from "@/lib/flow/types";
import {
  resolveNodeBindings,
  resolveValueBinding,
  type ValueBindingContext,
} from "@/lib/flow/value-bindings";

const graph: FlowGraphV2 = {
  schemaVersion: 2,
  id: "bindings",
  name: "Bindings",
  nodes: [
    {
      id: "source",
      type: "input",
      params: {},
      bindings: {},
      position: { x: 0, y: 0 },
    },
    {
      id: "target",
      type: "output",
      params: { kept: "param" },
      bindings: {
        literal: { kind: "literal", value: false },
        upstream: { kind: "port", nodeId: "source", portId: "result", path: "/nested/0" },
        workflow: { kind: "variable", variableId: "workflow" },
      },
      position: { x: 100, y: 0 },
    },
  ],
  edges: [],
  variables: [
    { id: "workflow", name: "Workflow", scope: "workflow", schema: {}, default: "default" },
    { id: "run", name: "Run", scope: "run", schema: {} },
    { id: "sensitive", name: "Sensitive", scope: "run", schema: {}, sensitive: true },
  ],
  groups: [],
  annotations: [],
};

function context(overrides: Partial<ValueBindingContext> = {}): ValueBindingContext {
  return {
    graph,
    outputs: new Map([["source", { result: { nested: [0, false, null, ""] } }]]),
    runVariables: {},
    resolveSecretReference: async () => "local-secret-value",
    ...overrides,
  };
}

async function value(binding: ValueBinding, overrides: Partial<ValueBindingContext> = {}): Promise<unknown> {
  const resolved = await resolveValueBinding(binding, context(overrides));
  if (!resolved.ok) throw new Error(resolved.error);
  return resolved.value;
}

describe("structured value bindings", () => {
  it("resolves JSON literals including false, zero, null, and empty strings", async () => {
    await expect(value({ kind: "literal", value: false })).resolves.toBe(false);
    await expect(value({ kind: "literal", value: 0 })).resolves.toBe(0);
    await expect(value({ kind: "literal", value: null })).resolves.toBeNull();
    await expect(value({ kind: "literal", value: "" })).resolves.toBe("");
  });

  it("resolves exact upstream ports and never falls back to whole outputs", async () => {
    await expect(value({ kind: "port", nodeId: "source", portId: "result", path: "/nested/1" })).resolves.toBe(false);
    const missing = await resolveValueBinding(
      { kind: "port", nodeId: "source", portId: "missing" },
      context(),
    );
    expect(missing).toMatchObject({ ok: false });
    expect(missing.ok ? "" : missing.error).toMatch(/source.*missing/i);
  });

  it("uses request run overrides before non-sensitive defaults", async () => {
    await expect(value({ kind: "variable", variableId: "workflow" })).resolves.toBe("default");
    await expect(value(
      { kind: "variable", variableId: "workflow" },
      { runVariables: { workflow: "override" } },
    )).resolves.toBe("override");
    await expect(value(
      { kind: "variable", variableId: "run" },
      { runVariables: { run: 0 } },
    )).resolves.toBe(0);
  });

  it("fails closed for missing variables and sensitive variables without an override", async () => {
    for (const variableId of ["missing", "sensitive"]) {
      const resolved = await resolveValueBinding({ kind: "variable", variableId }, context());
      expect(resolved.ok).toBe(false);
    }
  });

  it("implements RFC 6901 pointers and rejects unsafe or malformed traversal", async () => {
    const root = { "a/b": { "m~n": ["zero", "one"] } };
    await expect(value(
      { kind: "variable", variableId: "run", path: "" },
      { runVariables: { run: root } },
    )).resolves.toEqual(root);
    await expect(value({ kind: "port", nodeId: "source", portId: "result", path: "/nested/2" })).resolves.toBeNull();
    await expect(value(
      { kind: "variable", variableId: "run", path: "/a~1b/m~0n/1" },
      { runVariables: { run: root } },
    )).resolves.toBe("one");

    for (const path of ["dot.path", "/nested/01", "/nested/-", "/bad~2token", "/__proto__", "/constructor", "/prototype", "/~0constructor"]) {
      const resolved = await resolveValueBinding(
        { kind: "port", nodeId: "source", portId: "result", path },
        context(),
      );
      expect(resolved.ok, path).toBe(false);
    }
  });

  it("resolves secrets by reference and never includes returned values in errors", async () => {
    const resolver = vi.fn(async () => "do-not-leak-7a16");
    await expect(value(
      { kind: "secret", connectionId: "connection", field: "token" },
      { resolveSecretReference: resolver },
    )).resolves.toBe("do-not-leak-7a16");
    expect(resolver).toHaveBeenCalledWith({ connectionId: "connection", field: "token" });

    const failed = await resolveValueBinding(
      { kind: "secret", connectionId: "connection", field: "token" },
      context({ resolveSecretReference: async () => { throw new Error("do-not-leak-7a16"); } }),
    );
    expect(failed.ok).toBe(false);
    expect(JSON.stringify(failed)).not.toContain("do-not-leak-7a16");
    expect(failed.ok ? "" : failed.error).toMatch(/connection.*token/i);

    const unusual = new Map([["nested", { value: 1 }]]);
    const cloned = await resolveValueBinding(
      { kind: "secret", connectionId: "connection", field: "metadata" },
      context({ resolveSecretReference: async () => unusual }),
    );
    expect(cloned).toMatchObject({ ok: true });
    if (cloned.ok) {
      expect(cloned.value).not.toBe(unusual);
      expect(cloned.value).toEqual(unusual);
    }

    const uncloneable = await resolveValueBinding(
      { kind: "secret", connectionId: "connection", field: "callback" },
      context({ resolveSecretReference: async () => () => "secret-function-body" }),
    );
    expect(uncloneable.ok).toBe(false);
    expect(JSON.stringify(uncloneable)).not.toContain("secret-function-body");
  });

  it("resolves every node binding without mutating params, outputs, or context", async () => {
    const ctx = context({ runVariables: { workflow: "override" } });
    const node = graph.nodes[1]!;
    const before = JSON.stringify({ graph, outputs: [...ctx.outputs] });
    await expect(resolveNodeBindings(node, ctx)).resolves.toEqual({
      values: {
        literal: false,
        upstream: 0,
        workflow: "override",
      },
      secretBindingValues: {},
    });
    expect(JSON.stringify({ graph, outputs: [...ctx.outputs] })).toBe(before);
  });

  it("preserves hostile binding keys as own data without changing prototypes", async () => {
    const bindings = Object.create(null) as Record<string, ValueBinding>;
    bindings.__proto__ = { kind: "literal", value: { polluted: true } };
    const node = { ...graph.nodes[1]!, bindings };
    const resolved = await resolveNodeBindings(node, context());
    expect(Object.hasOwn(resolved.values, "__proto__")).toBe(true);
    expect(resolved.values.__proto__).toEqual({ polluted: true });
    expect(Object.hasOwn(resolved.secretBindingValues, "__proto__")).toBe(false);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});
