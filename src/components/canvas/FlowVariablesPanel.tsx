"use client";

import React, { useMemo, useState } from "react";
import type { JsonPatchOp, JsonValue } from "@/lib/flow/graph-command-types";
import type { FlowVariable, JsonSchema } from "@/lib/flow/types";

export type VariableSchemaType =
  | "string"
  | "number"
  | "boolean"
  | "object"
  | "array"
  | "unknown"
  | "custom";

export interface VariableDraft {
  readonly name: string;
  readonly scope: "workflow" | "run";
  readonly schemaType: VariableSchemaType;
  readonly schemaText: string;
  readonly defaultText: string;
  readonly sensitive: boolean;
}

export type VariableDraftResult =
  | {
      readonly ok: true;
      readonly name: string;
      readonly scope: "workflow" | "run";
      readonly schema: JsonSchema;
      readonly hasDefault: boolean;
      readonly defaultValue?: JsonValue;
      readonly sensitive: boolean;
    }
  | { readonly ok: false; readonly error: string };

export interface FlowVariablesPanelProps {
  readonly variables: readonly FlowVariable[];
  readonly onAdd: (variable: FlowVariable) => void;
  readonly onPatch: (variableId: string, patch: readonly JsonPatchOp[]) => void;
  readonly onRemove: (variableId: string) => void;
}

const EMPTY_DRAFT: VariableDraft = {
  name: "",
  scope: "workflow",
  schemaType: "string",
  schemaText: '{"type":"string"}',
  defaultText: "",
  sensitive: false,
};

export function schemaForVariableType(type: Exclude<VariableSchemaType, "custom">): JsonSchema {
  return type === "unknown" ? {} : { type };
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value).every(isJsonValue);
}

function parseJsonObject(text: string): JsonSchema | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && isJsonValue(parsed)
      ? parsed as JsonSchema
      : null;
  } catch {
    return null;
  }
}

export function validateVariableDraft(
  draft: VariableDraft,
  variables: readonly FlowVariable[],
  editingId?: string,
): VariableDraftResult {
  const name = draft.name.trim();
  if (name === "") return { ok: false, error: "Variable name is required." };
  if (variables.some((variable) => variable.id !== editingId && variable.name.trim().toLowerCase() === name.toLowerCase())) {
    return { ok: false, error: "Variable names must be unique, ignoring case." };
  }
  const schema = parseJsonObject(draft.schemaText);
  if (!schema) return { ok: false, error: "Schema JSON must be a JSON object." };
  const hasDefault = draft.defaultText.trim() !== "";
  if (draft.sensitive && hasDefault) {
    return { ok: false, error: "Sensitive variables cannot have a default." };
  }
  let defaultValue: JsonValue | undefined;
  if (hasDefault) {
    try {
      const parsed: unknown = JSON.parse(draft.defaultText);
      if (!isJsonValue(parsed)) return { ok: false, error: "Default JSON must be finite JSON data." };
      defaultValue = parsed;
    } catch {
      return { ok: false, error: "Default JSON is invalid." };
    }
  }
  return {
    ok: true,
    name,
    scope: draft.scope,
    schema,
    hasDefault,
    ...(hasDefault ? { defaultValue } : {}),
    sensitive: draft.sensitive,
  };
}

function inferSchemaType(schema: JsonSchema): VariableSchemaType {
  const keys = Object.keys(schema);
  if (keys.length === 0) return "unknown";
  if (keys.length === 1 && typeof schema.type === "string" && ["string", "number", "boolean", "object", "array"].includes(schema.type)) {
    return schema.type as VariableSchemaType;
  }
  return "custom";
}

function draftForVariable(variable: FlowVariable): VariableDraft {
  return {
    name: variable.name,
    scope: variable.scope,
    schemaType: inferSchemaType(variable.schema),
    schemaText: JSON.stringify(variable.schema, null, 2),
    defaultText: Object.hasOwn(variable, "default") ? JSON.stringify(variable.default, null, 2) : "",
    sensitive: variable.sensitive === true,
  };
}

export function variableIdForName(name: string, variables: readonly FlowVariable[]): string {
  const stem = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "variable";
  const ids = new Set(variables.map((variable) => variable.id.toLowerCase()));
  if (!ids.has(stem.toLowerCase())) return stem;
  let suffix = 2;
  while (ids.has(`${stem}-${suffix}`.toLowerCase())) suffix += 1;
  return `${stem}-${suffix}`;
}

function patchForDraft(variable: FlowVariable, result: Extract<VariableDraftResult, { ok: true }>): JsonPatchOp[] {
  const patch: JsonPatchOp[] = [
    { op: "replace", path: "/name", value: result.name },
    { op: "replace", path: "/scope", value: result.scope },
    { op: "replace", path: "/schema", value: result.schema as JsonValue },
  ];
  const hadSensitive = Object.hasOwn(variable, "sensitive");
  if (result.sensitive) patch.push({ op: hadSensitive ? "replace" : "add", path: "/sensitive", value: true });
  else if (hadSensitive) patch.push({ op: "remove", path: "/sensitive" });
  const hadDefault = Object.hasOwn(variable, "default");
  if (result.hasDefault) {
    patch.push({
      op: hadDefault ? "replace" : "add",
      path: "/default",
      value: result.defaultValue as JsonValue,
    });
  } else if (hadDefault) {
    patch.push({ op: "remove", path: "/default" });
  }
  return patch;
}

export default function FlowVariablesPanel({ variables, onAdd, onPatch, onRemove }: FlowVariablesPanelProps): React.JSX.Element {
  const [draft, setDraft] = useState<VariableDraft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const editingVariable = useMemo(
    () => variables.find((variable) => variable.id === editingId) ?? null,
    [editingId, variables],
  );
  const descriptionId = "flow-variable-form-description";
  const errorId = "flow-variable-form-error";

  const reset = (): void => {
    setDraft(EMPTY_DRAFT);
    setEditingId(null);
    setError(null);
  };

  const submit = (): void => {
    const result = validateVariableDraft(draft, variables, editingId ?? undefined);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (editingVariable) {
      onPatch(editingVariable.id, patchForDraft(editingVariable, result));
    } else {
      onAdd({
        id: variableIdForName(result.name, variables),
        name: result.name,
        scope: result.scope,
        schema: result.schema,
        ...(result.hasDefault ? { default: result.defaultValue } : {}),
        ...(result.sensitive ? { sensitive: true } : {}),
      });
    }
    reset();
  };

  return (
    <section className="flow-variables-panel" aria-label="Flow variables">
      <div className="flow-variables-panel__heading">
        <div>
          <span className="eyebrow">Data ledger</span>
          <h2>Variables</h2>
        </div>
        <span className="mono tabular">{variables.length}</span>
      </div>
      <p id={descriptionId} className="flow-variables-panel__description">
        Named run data. Sensitive entries store references only and never a value.
      </p>
      <div className="flow-variables-panel__list" aria-label="Existing variables">
        {variables.length === 0 ? <p>No variables yet.</p> : variables.map((variable) => (
          <article className="flow-variable-row" key={variable.id}>
            <div className="data-receipt">
              <strong>{variable.name}</strong>
              <span>{variable.scope} · {Object.keys(variable.schema).length === 0 ? "Unknown schema" : "typed"}</span>
            </div>
            <div className="flow-variable-row__actions">
              <button type="button" onClick={() => {
                setEditingId(variable.id);
                setDraft(draftForVariable(variable));
                setError(null);
              }}>Edit {variable.name}</button>
              <button type="button" onClick={() => onRemove(variable.id)}>Remove {variable.name}</button>
            </div>
          </article>
        ))}
      </div>
      <form className="flow-variable-form" onSubmit={(event) => { event.preventDefault(); submit(); }} aria-describedby={`${descriptionId}${error ? ` ${errorId}` : ""}`}>
        <label htmlFor="flow-variable-name">Variable name</label>
        <input id="flow-variable-name" value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />

        <label htmlFor="flow-variable-scope">Variable scope</label>
        <select id="flow-variable-scope" value={draft.scope} onChange={(event) => setDraft((current) => ({ ...current, scope: event.target.value as "workflow" | "run" }))}>
          <option value="workflow">Workflow</option>
          <option value="run">Run</option>
        </select>

        <label htmlFor="flow-variable-schema-type">Schema type</label>
        <select id="flow-variable-schema-type" value={draft.schemaType} onChange={(event) => {
          const schemaType = event.target.value as VariableSchemaType;
          setDraft((current) => ({
            ...current,
            schemaType,
            ...(schemaType === "custom" ? {} : { schemaText: JSON.stringify(schemaForVariableType(schemaType), null, 2) }),
          }));
        }}>
          <option value="string">String</option>
          <option value="number">Number</option>
          <option value="boolean">Boolean</option>
          <option value="object">Object</option>
          <option value="array">Array</option>
          <option value="unknown">Unknown</option>
          <option value="custom">Custom schema</option>
        </select>

        <label htmlFor="flow-variable-schema">Schema JSON</label>
        <textarea id="flow-variable-schema" spellCheck={false} value={draft.schemaText} onChange={(event) => setDraft((current) => ({ ...current, schemaType: "custom", schemaText: event.target.value }))} />

        <label htmlFor="flow-variable-default">Default JSON</label>
        <textarea id="flow-variable-default" spellCheck={false} disabled={draft.sensitive} value={draft.defaultText} onChange={(event) => setDraft((current) => ({ ...current, defaultText: event.target.value }))} aria-describedby={descriptionId} />

        <label className="flow-variable-form__check" htmlFor="flow-variable-sensitive">
          <input id="flow-variable-sensitive" type="checkbox" checked={draft.sensitive} onChange={(event) => setDraft((current) => ({ ...current, sensitive: event.target.checked, ...(event.target.checked ? { defaultText: "" } : {}) }))} />
          <span>Sensitive variable</span>
        </label>
        {error ? <p id={errorId} role="alert" className="flow-variable-form__error">{error}</p> : null}
        <div className="flow-variable-form__actions">
          <button type="submit">{editingVariable ? "Update variable" : "Add variable"}</button>
          {editingVariable ? <button type="button" onClick={reset}>Cancel edit</button> : null}
        </div>
      </form>
    </section>
  );
}
