import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import FlowVariablesPanel, {
  schemaForVariableType,
  variableIdForName,
  validateVariableDraft,
  type VariableDraft,
} from "@/components/canvas/FlowVariablesPanel";
import type { FlowVariable } from "@/lib/flow/types";

const existing: FlowVariable[] = [
  {
    id: "customer-id",
    name: "Customer ID",
    scope: "workflow",
    schema: { type: "string", minLength: 1 },
    default: "guest",
  },
];

const validDraft: VariableDraft = {
  name: "Region",
  scope: "run",
  schemaType: "string",
  schemaText: '{"type":"string"}',
  defaultText: '"us-east"',
  sensitive: false,
};

describe("FlowVariablesPanel contract", () => {
  it("renders an accessible command-backed data ledger without secret-value input", () => {
    const markup = renderToStaticMarkup(createElement(FlowVariablesPanel, {
      variables: existing,
      onAdd: vi.fn(),
      onPatch: vi.fn(),
      onRemove: vi.fn(),
    }));

    expect(markup).toContain('aria-label="Flow variables"');
    for (const label of ["Variable name", "Variable scope", "Schema type", "Schema JSON", "Default JSON", "Sensitive variable"]) {
      expect(markup).toContain(`>${label}<`);
    }
    expect(markup).toContain("Data ledger");
    expect(markup).toContain("Customer ID");
    expect(markup).toContain("Add variable");
    expect(markup).toContain("Edit Customer ID");
    expect(markup).toContain("Remove Customer ID");
    expect(markup).not.toMatch(/secret value|password/i);
  });

  it("maps every schema choice explicitly and keeps unknown honest", () => {
    expect(schemaForVariableType("string")).toEqual({ type: "string" });
    expect(schemaForVariableType("number")).toEqual({ type: "number" });
    expect(schemaForVariableType("boolean")).toEqual({ type: "boolean" });
    expect(schemaForVariableType("object")).toEqual({ type: "object" });
    expect(schemaForVariableType("array")).toEqual({ type: "array" });
    expect(schemaForVariableType("unknown")).toEqual({});
  });

  it("rejects empty, duplicate, malformed, and sensitive-default drafts while preserving falsy JSON", () => {
    expect(validateVariableDraft({ ...validDraft, name: "  " }, existing)).toMatchObject({ ok: false });
    expect(validateVariableDraft({ ...validDraft, name: " customer id " }, existing)).toMatchObject({ ok: false });
    expect(validateVariableDraft({ ...validDraft, schemaText: "[]" }, existing)).toMatchObject({ ok: false });
    expect(validateVariableDraft({ ...validDraft, defaultText: "nope" }, existing)).toMatchObject({ ok: false });
    expect(validateVariableDraft({ ...validDraft, sensitive: true }, existing)).toMatchObject({ ok: false });
    expect(validateVariableDraft({ ...validDraft, defaultText: "false" }, existing)).toMatchObject({ ok: true, defaultValue: false });
    expect(validateVariableDraft({ ...validDraft, defaultText: "0" }, existing)).toMatchObject({ ok: true, defaultValue: 0 });
    expect(validateVariableDraft({ ...validDraft, defaultText: "null" }, existing)).toMatchObject({ ok: true, defaultValue: null });
  });

  it("allows an existing variable to keep its own name and custom schema", () => {
    const result = validateVariableDraft({
      ...validDraft,
      name: "Customer ID",
      schemaType: "custom",
      schemaText: '{"type":"string","minLength":1}',
      defaultText: '"guest"',
    }, existing, "customer-id");
    expect(result).toMatchObject({
      ok: true,
      schema: { type: "string", minLength: 1 },
    });
  });

  it("generates IDs without case-insensitive collisions", () => {
    const mixedCase: FlowVariable[] = [
      { id: "REGION", name: "First", scope: "workflow", schema: {} },
      { id: "region-2", name: "Second", scope: "run", schema: {} },
    ];
    expect(variableIdForName("Region", mixedCase)).toBe("region-3");
    expect(variableIdForName("__Proto__", [
      { id: "PROTO", name: "Prototype", scope: "workflow", schema: {} },
    ])).toBe("proto-2");
  });
});
