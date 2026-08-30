"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import { getNodeDefinition, type JsonSchema, type NodeConnectionSpec, type NodeField, type NodeFieldOption } from "@/lib/flow/node-definitions";
import {
  nodeCapabilitySummary,
  nodeCostLabel,
  nodePermissionSummary,
  nodeTestModeLabel,
} from "@/lib/flow/node-display";
import type { FlowNode, FlowNodeV2, FlowVariable, SubflowReference, ValueBinding } from "@/lib/flow/types";
import type { SupportedFlowGraph } from "@/lib/flow/types";
import type { JsonPatchOp, JsonValue } from "@/lib/flow/graph-command-types";
import {
  resolveNodeCapabilityReceipt,
  resolveNodePorts,
  type ValidatedNodePortResolver,
} from "@/lib/flow/node-ports";
import CallableInterfaceEditor from "./CallableInterfaceEditor";
import type { FlowCallableInterface, FlowGraphV2 } from "@/lib/flow/types";
import SubflowReferenceControl, { type ReferenceResolutionStatus } from "./SubflowReferenceControl";
import type { SubflowResolveProjection } from "@/lib/flow/subflow-api";
import { normalizeSubflowReference } from "@/lib/flow/subflow-reference";
import type { FlowTestScope } from "@/lib/flow/test-scope";
import type { ConnectionChoice } from "@/lib/connections/client";
import ApiOperationInspector, { type ApiOperationInspectorProps } from "@/components/connectors/ApiOperationInspector";

export type ConnectionChoicesStatus = "loading" | "ready" | "error" | "unavailable";

export interface UpstreamPortChoice {
  readonly nodeId: string;
  readonly nodeLabel: string;
  readonly portId: string;
  readonly portLabel: string;
  readonly schema: JsonSchema;
}

export interface InspectorProps {
  node: FlowNode | FlowNodeV2 | null;
  graph?: SupportedFlowGraph;
  resolvePorts?: ValidatedNodePortResolver;
  graphVersion?: 1 | 2;
  variables?: readonly FlowVariable[];
  upstreamPorts?: readonly UpstreamPortChoice[];
  validationIssues?: readonly string[];
  onPatch?: (patch: readonly JsonPatchOp[], groupId?: string) => void;
  onSetBinding?: (key: string, binding: ValueBinding) => void;
  onRemoveBinding?: (key: string) => void;
  onCallableInterfaceSet?: (value: FlowCallableInterface) => void;
  onCallableInterfaceRemove?: () => void;
  parentFlowId?: string | null;
  referenceResolutionStatus?: ReferenceResolutionStatus;
  onSubflowReferenceResolved?: (projection: SubflowResolveProjection, nodeId: string) => void;
  onOpenResolvedSubflow?: (
    nodeId: string,
    reference: SubflowReference,
    event: React.MouseEvent<HTMLButtonElement>,
  ) => void;
  onRunTestScope?: (scope: FlowTestScope) => void;
  testRunDisabledReason?: string | null;
  testRunBusy?: boolean;
  /** Strict metadata only. Connection values never enter Inspector props. */
  connectionChoices?: readonly ConnectionChoice[];
  connectionChoicesStatus?: ConnectionChoicesStatus;
  /** Narrow, build-owned action model. No client or mutable closure map enters Inspector. */
  apiOperation?: ApiOperationInspectorProps;
  apiOperationAuthoringEnabled?: boolean;
  /** Render-only compatibility for older callers; edits use onPatch. */
  onChange?: (params: Record<string, unknown>) => void;
}

type BindingMode = "static" | "port" | "variable" | "secret";

/** Names the runtime source that overrides a field's stored param value. */
export function boundSourceSummary(
  binding: ValueBinding | undefined,
  upstreamPorts: readonly UpstreamPortChoice[],
  variables: readonly FlowVariable[],
): string | undefined {
  if (binding?.kind === "port") {
    const match = upstreamPorts.find(
      (port) => port.nodeId === binding.nodeId && port.portId === binding.portId,
    );
    return match ? `${match.nodeLabel} · ${match.portLabel}` : `${binding.nodeId}.${binding.portId}`;
  }
  if (binding?.kind === "variable") {
    const match = variables.find((variable) => variable.id === binding.variableId);
    return match ? `variable ${match.name}` : `variable ${binding.variableId}`;
  }
  // Secret bindings provide request provenance and can still merge with a
  // static param, so they deliberately do not lock the field control.
  return undefined;
}

export function bindingFromSelection(
  mode: "port" | "variable",
  selection: string,
  upstreamPorts: readonly UpstreamPortChoice[],
  variables: readonly FlowVariable[],
): { readonly ok: true; readonly binding: ValueBinding } | { readonly ok: false } {
  if (mode === "port") {
    const choice = upstreamPorts.find((item) => `${item.nodeId}::${item.portId}` === selection);
    return choice
      ? { ok: true, binding: { kind: "port", nodeId: choice.nodeId, portId: choice.portId } }
      : { ok: false };
  }
  const variable = variables.find((item) => item.id === selection);
  return variable
    ? { ok: true, binding: { kind: "variable", variableId: variable.id } }
    : { ok: false };
}

export function connectionBindingFromSelection(
  connectionId: string,
  choices: readonly ConnectionChoice[],
  field: ValueBinding extends { readonly kind: "secret"; readonly field: infer Field } ? Field : string = "headers",
): { readonly ok: true; readonly binding: ValueBinding } | { readonly ok: false } {
  const choice = choices.find((item) => item.id === connectionId);
  return choice
    ? { ok: true, binding: { kind: "secret", connectionId: choice.id, field } }
    : { ok: false };
}

export function connectionChoiceMatchesRequirement(
  choice: ConnectionChoice,
  requirement: NodeConnectionSpec,
): boolean {
  if (!requirement.allowedKinds.includes(choice.kind)) return false;
  const actual = new Set(choice.publicHeaderNames.map((name) => name.toLowerCase()));
  return requirement.requiredHeaderNames.every((name) => actual.has(name.toLowerCase()));
}

export function repairHttpHeadersBinding(binding: ValueBinding): ValueBinding | null {
  return binding.kind === "secret"
    ? { kind: "secret", connectionId: binding.connectionId, field: "headers" }
    : null;
}

export function schemaPreview(schema: JsonSchema): string {
  return Object.keys(schema).length === 0 ? "Unknown schema" : JSON.stringify(schema);
}

/** Normalizes a select field's options to {value, label} pairs; bare strings use themselves as the label. */
function fieldOptionEntries(field: NodeField): readonly NodeFieldOption[] {
  return (field.options ?? []).map((option) =>
    typeof option === "string" ? { value: option, label: option } : option,
  );
}

export function configValidationIssues(node: FlowNode | FlowNodeV2): string[] {
  const fields = getNodeDefinition(node.type).ui.fields;
  const issues: string[] = [];
  for (const field of fields) {
    const value = node.params[field.key];
    if (value === undefined) continue;
    const valid = field.kind === "number"
      ? typeof value === "number" && Number.isFinite(value)
      : field.kind === "boolean"
        ? typeof value === "boolean"
        : field.kind === "select"
          ? typeof value === "string" && fieldOptionEntries(field).some((entry) => entry.value === value)
          : field.kind === "string" || field.kind === "textarea"
            ? typeof value === "string"
            // A json param may legitimately hold a string (JSON_VALUE_SCHEMA
            // admits one), so flag only the corruption signature left behind by
            // older builds: a string that does not itself parse as JSON.
            : field.kind === "json"
              ? typeof value !== "string" || parsesAsJson(value)
              : true;
    if (!valid) issues.push(`${field.label} has an invalid ${field.kind} value.`);
  }
  return issues;
}

function schemaStatus(schema: JsonSchema): "typed" | "Unknown schema" {
  return Object.keys(schema).length === 0 ? "Unknown schema" : "typed";
}

function focusGroupId(nodeId: string, field: string): string {
  const suffix = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
  return `inspector-focus-${nodeId}-${field}-${suffix}`;
}

function pointerSegment(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number | "" {
  return typeof value === "number" && Number.isFinite(value) ? value : "";
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asJsonText(value: unknown): string {
  if (value === undefined) return "";
  try { return JSON.stringify(value, null, 2); } catch { return ""; }
}

function parsesAsJson(text: string): boolean {
  try { JSON.parse(text); return true; } catch { return false; }
}

/**
 * JSON fields keep their own draft text.
 *
 * The control is a controlled textarea over `JSON.stringify(value)`, so
 * committing half-typed text into params meant the very next render fed that
 * raw string back through JSON.stringify, quoting and escaping it. Every
 * subsequent keystroke re-escaped, so any edit that passed through a
 * momentarily-invalid state (deleting a brace, adding a comma, or simply
 * typing `{` into an empty field) destroyed the param and only surfaced as a
 * schema error at run time. The draft holds the user's literal text; params
 * only ever receive a successfully parsed value.
 */
function JsonFieldControl({
  controlId,
  fieldKey,
  value,
  update,
  focusProps,
  locked,
  describedBy,
}: {
  readonly controlId: string;
  readonly fieldKey: string;
  readonly value: unknown;
  readonly update: (key: string, value: unknown) => void;
  readonly focusProps: (key: string) => { onFocus: () => void; onBlur: () => void };
  readonly locked: boolean;
  readonly describedBy?: string;
}): React.JSX.Element {
  const serialized = asJsonText(value);
  const [draft, setDraft] = useState<string | null>(null);
  const focusedRef = useRef(false);
  const lastSerializedRef = useRef(serialized);

  // Undo/redo, a binding rewrite, or any other external write should win,
  // but only while the user is not mid-edit, so their text is never yanked.
  useEffect(() => {
    if (lastSerializedRef.current === serialized) return;
    lastSerializedRef.current = serialized;
    if (!focusedRef.current) setDraft(null);
  }, [serialized]);

  useEffect(() => {
    if (!locked) return;
    focusedRef.current = false;
    setDraft(null);
  }, [locked]);

  const base = focusProps(fieldKey);
  const text = draft ?? serialized;
  const invalid = text.trim() !== "" && !parsesAsJson(text);
  const messageId = `${controlId}-json-error`;
  const descriptionIds = [describedBy, invalid ? messageId : undefined].filter(Boolean).join(" ") || undefined;

  return (
    <>
      <textarea
        id={controlId}
        value={text}
        spellCheck={false}
        readOnly={locked}
        aria-invalid={invalid || undefined}
        aria-describedby={descriptionIds}
        onChange={(event) => {
          if (locked) return;
          const next = event.target.value;
          setDraft(next);
          if (next.trim() === "") {
            update(fieldKey, undefined);
            return;
          }
          try {
            update(fieldKey, JSON.parse(next) as unknown);
          } catch {
            // Hold the draft only. Writing unparsed text here is the bug.
          }
        }}
        onFocus={() => { focusedRef.current = true; base.onFocus(); }}
        onBlur={() => { focusedRef.current = false; base.onBlur(); }}
        style={{ ...textareaStyle, ...(locked ? { opacity: 0.65, cursor: "not-allowed" } : {}) }}
      />
      {invalid ? (
        <p
          id={messageId}
          role="alert"
          className="mono"
          style={{ margin: "4px 0 0", fontSize: "var(--text-label)", color: "var(--text-error)" }}
        >
          Not valid JSON. This change is not saved yet.
        </p>
      ) : null}
    </>
  );
}

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "var(--text-label)",
  color: "var(--text-muted)",
  marginBottom: 5,
  letterSpacing: "0.02em",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  height: 36,
  background: "var(--ink-control)",
  border: "1px solid var(--hairline)",
  borderRadius: "var(--radius-sm)",
  color: "var(--text-primary)",
  padding: "0 10px",
  fontFamily: "var(--font-ui)",
  fontSize: "var(--text-sm)",
};

const textareaStyle: React.CSSProperties = {
  width: "100%",
  minHeight: 96,
  background: "var(--ink-control)",
  border: "1px solid var(--hairline)",
  borderRadius: "var(--radius-sm)",
  color: "var(--text-primary)",
  padding: "8px 10px",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  resize: "vertical",
};

const hintStyle: React.CSSProperties = {
  display: "block",
  marginTop: 5,
  fontSize: "var(--text-label)",
  color: "var(--text-muted)",
  lineHeight: 1.4,
};

function FieldHint({ hint, id }: { hint?: string; id?: string }): React.JSX.Element | null {
  return hint ? <span id={id} style={hintStyle}>{hint}</span> : null;
}

function retryLabel(retry: "safe" | "idempotency-required" | "unsafe"): string {
  if (retry === "safe") return "Safe to retry";
  if (retry === "idempotency-required") return "Retry only with idempotency protection";
  return "Unsafe to retry automatically";
}

function DetailList({ items }: { items: readonly string[] }): React.JSX.Element {
  return <ul className="capability-receipt__list">{items.map((item) => <li key={item}>{item}</li>)}</ul>;
}

function bindingMode(binding: ValueBinding | undefined): BindingMode {
  if (!binding || binding.kind === "literal") return "static";
  return binding.kind;
}

function bindingReferenceIssue(
  binding: ValueBinding | undefined,
  upstreamPorts: readonly UpstreamPortChoice[],
  variables: readonly FlowVariable[],
): string | null {
  if (binding?.kind === "port" && !upstreamPorts.some((port) => port.nodeId === binding.nodeId && port.portId === binding.portId)) {
    return `Missing upstream port ${binding.nodeId}.${binding.portId}.`;
  }
  if (binding?.kind === "variable" && !variables.some((variable) => variable.id === binding.variableId)) {
    return `Missing variable ${binding.variableId}.`;
  }
  return null;
}

function connectionStatusLabel(status: ConnectionChoice["slots"]["test"]): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function connectionChoiceDisplayLabel(
  choice: ConnectionChoice,
  choices: readonly ConnectionChoice[],
): string {
  const duplicate = choices.some((candidate) =>
    candidate.id !== choice.id && candidate.label === choice.label);
  const label = duplicate ? `${choice.label} · …${choice.id.slice(-6)}` : choice.label;
  return `${label} · ${choice.kind} · Test: ${connectionStatusLabel(choice.slots.test)} · Live: ${connectionStatusLabel(choice.slots.live)}`;
}

function connectionStatusReceipt(status: ConnectionChoicesStatus, hasChoices: boolean): string | null {
  if (status === "loading") return "Connections are loading.";
  if (status === "error") return "Connections could not be loaded.";
  if (status === "unavailable") return "Connections are unavailable in this session.";
  return hasChoices ? null : "No connections are configured.";
}

function BindingControl({
  field,
  nodeId,
  connectionBindingAllowed,
  binding,
  variables,
  upstreamPorts,
  connectionChoices,
  connectionChoicesStatus,
  onSetBinding,
  onRemoveBinding,
}: {
  readonly field: NodeField;
  readonly nodeId: string;
  readonly connectionBindingAllowed: boolean;
  readonly binding?: ValueBinding;
  readonly variables: readonly FlowVariable[];
  readonly upstreamPorts: readonly UpstreamPortChoice[];
  readonly connectionChoices: readonly ConnectionChoice[];
  readonly connectionChoicesStatus: ConnectionChoicesStatus;
  readonly onSetBinding?: (key: string, binding: ValueBinding) => void;
  readonly onRemoveBinding?: (key: string) => void;
}): React.JSX.Element {
  // Stored bindings remain authoritative across undo/redo and node changes.
  // pendingMode represents only a choice that cannot produce a binding yet.
  // This avoids remounting the subtree (and losing keyboard focus) whenever a
  // binding edit returns through command history.
  const [pendingMode, setPendingMode] = useState<BindingMode | null>(null);
  const storedMode = bindingMode(binding);
  const mode = pendingMode ?? storedMode;
  useEffect(() => {
    if (pendingMode !== null && pendingMode === storedMode) setPendingMode(null);
  }, [pendingMode, storedMode]);
  const modeId = `binding-mode-${encodeURIComponent(nodeId)}-${encodeURIComponent(field.key)}`;
  const helpId = `${modeId}-help`;
  const issue = bindingReferenceIssue(binding, upstreamPorts, variables);
  const upstreamValue = binding?.kind === "port" ? `${binding.nodeId}::${binding.portId}` : "";
  const variableValue = binding?.kind === "variable" ? binding.variableId : "";
  const secretBinding = binding?.kind === "secret" ? binding : undefined;
  const legacyConnectionField = Boolean(secretBinding && secretBinding.field !== "headers");
  const selectedChoice = secretBinding && connectionChoicesStatus === "ready"
    ? connectionChoices.find((choice) => choice.id === secretBinding.connectionId)
    : undefined;
  const statusReceipt = connectionStatusReceipt(connectionChoicesStatus, connectionChoices.length > 0);

  return (
    <div className="binding-control data-receipt">
      <label htmlFor={modeId}>Data source for {field.label}</label>
      <select id={modeId} value={mode} aria-describedby={helpId} onChange={(event) => {
        const candidate = event.target.value;
        if (candidate !== "static" && candidate !== "port" && candidate !== "variable" && candidate !== "secret") return;
        if (candidate === "secret" && !connectionBindingAllowed) return;
        const nextMode = candidate as BindingMode;
        setPendingMode(nextMode);
        if (nextMode === "static") {
          if (binding) onRemoveBinding?.(field.key);
          return;
        }
        if (nextMode === "port") {
          const first = upstreamPorts[0];
          if (first) onSetBinding?.(field.key, { kind: "port", nodeId: first.nodeId, portId: first.portId });
          return;
        }
        if (nextMode === "variable") {
          const first = variables[0];
          if (first) onSetBinding?.(field.key, { kind: "variable", variableId: first.id });
        }
      }}>
        <option value="static">Static value</option>
        <option value="port">Upstream output</option>
        <option value="variable">Workflow/run variable</option>
        {connectionBindingAllowed ? <option value="secret">Connection reference</option> : null}
        {!connectionBindingAllowed && secretBinding ? <option value="secret" disabled>Unsupported secret reference</option> : null}
      </select>
      <span id={helpId}>Structured source receipt. No template text is written.</span>
      {mode !== storedMode && binding ? (
        <p role="alert" className="binding-control__error">
          {`Still reading from the previous source until you choose ${mode === "secret" ? "a connection" : mode === "port" ? "an upstream output" : mode === "variable" ? "a variable" : "a value"} below.`}
        </p>
      ) : null}
      {mode === "port" ? <div>
        <select aria-label={`Upstream output for ${field.label}`} value={upstreamValue} onChange={(event) => {
          const result = bindingFromSelection("port", event.target.value, upstreamPorts, variables);
          if (result.ok) onSetBinding?.(field.key, result.binding);
        }}>
          <option value="">Choose upstream output</option>
          {upstreamPorts.map((port) => (
            <option key={`${port.nodeId}::${port.portId}`} value={`${port.nodeId}::${port.portId}`}>
              {port.nodeLabel} · {port.portLabel} ({port.nodeId}.{port.portId}) · {schemaStatus(port.schema)}
            </option>
          ))}
        </select>
        {upstreamPorts.length === 0 ? <p role="alert" className="binding-control__error">No upstream output is available for this node.</p> : null}
      </div> : null}
      {mode === "variable" ? <div>
        <select aria-label={`Variable for ${field.label}`} value={variableValue} onChange={(event) => {
          const result = bindingFromSelection("variable", event.target.value, upstreamPorts, variables);
          if (result.ok) onSetBinding?.(field.key, result.binding);
        }}>
          <option value="">Choose variable</option>
          {variables.map((variable) => <option key={variable.id} value={variable.id}>{variable.name} ({variable.id}) · {schemaStatus(variable.schema)}</option>)}
        </select>
        {variables.length === 0 ? <p role="alert" className="binding-control__error">No workflow or run variable is available.</p> : null}
      </div> : null}
      {mode === "secret" && !connectionBindingAllowed ? <div className="binding-control__secret" role="alert">
        <p>Unsupported secret reference. Connections can only supply HTTP headers.</p>
      </div> : null}
      {mode === "secret" && connectionBindingAllowed ? <div className="binding-control__secret">
        <p>Current previews and scoped Test runs resolve no credentials; only the active immutable Live deployment does.</p>
        {legacyConnectionField && secretBinding ? <div role="alert">
          <p>Unsupported connection field. This reference is preserved and will not resolve.</p>
          <button type="button" onClick={() => {
            const repaired = repairHttpHeadersBinding(secretBinding);
            if (repaired) onSetBinding?.(field.key, repaired);
          }}>Repair to headers</button>
        </div> : <>
          <label htmlFor={`${modeId}-connection`}>Connection</label>
          <select
            id={`${modeId}-connection`}
            aria-label={`Connection for ${field.label}`}
            disabled={connectionChoicesStatus !== "ready" || connectionChoices.length === 0}
            value={selectedChoice?.id ?? ""}
            onChange={(event) => {
              const result = connectionBindingFromSelection(event.target.value, connectionChoices);
              if (result.ok) onSetBinding?.(field.key, result.binding);
            }}
          >
            <option value="">Choose a connection</option>
            {connectionChoicesStatus === "ready" ? connectionChoices.map((choice) => (
              <option key={choice.id} value={choice.id}>{connectionChoiceDisplayLabel(choice, connectionChoices)}</option>
            )) : null}
          </select>
          {connectionChoicesStatus === "ready" && secretBinding && !selectedChoice
            ? <p role="alert" className="binding-control__error">Referenced connection is missing.</p>
            : null}
          {selectedChoice ? <p className="mono">{connectionChoiceDisplayLabel(selectedChoice, connectionChoices)}</p> : null}
          {statusReceipt ? <p role="status">{statusReceipt}</p> : null}
        </>}
        <a href="/connections">Manage connections</a>
      </div> : null}
      {issue ? <p role="alert" className="binding-control__error">{issue}</p> : null}
    </div>
  );
}

function ConnectionRequirementControl({
  requirement,
  binding,
  connectionChoices,
  connectionChoicesStatus,
  onSetBinding,
  onRemoveBinding,
}: {
  readonly requirement: NodeConnectionSpec;
  readonly binding?: ValueBinding;
  readonly connectionChoices: readonly ConnectionChoice[];
  readonly connectionChoicesStatus: ConnectionChoicesStatus;
  readonly onSetBinding?: (key: string, binding: ValueBinding) => void;
  readonly onRemoveBinding?: (key: string) => void;
}): React.JSX.Element {
  const compatible = connectionChoices.filter((choice) =>
    connectionChoiceMatchesRequirement(choice, requirement));
  const secretBinding = binding?.kind === "secret" ? binding : undefined;
  const selected = secretBinding
    ? compatible.find((choice) => choice.id === secretBinding.connectionId)
    : undefined;
  const fieldMismatch = Boolean(secretBinding && secretBinding.field !== requirement.field);
  const statusReceipt = connectionStatusReceipt(connectionChoicesStatus, compatible.length > 0);
  return <div className="binding-control binding-control__secret data-receipt">
    <label htmlFor={`connection-requirement-${requirement.key}`}>{requirement.label}</label>
    <p>{requirement.hint}</p>
    <select
      id={`connection-requirement-${requirement.key}`}
      aria-label={`Connection for ${requirement.label}`}
      disabled={connectionChoicesStatus !== "ready" || compatible.length === 0}
      value={selected?.id ?? ""}
      onChange={(event) => {
        if (event.target.value === "") {
          onRemoveBinding?.(requirement.key);
          return;
        }
        const result = connectionBindingFromSelection(
          event.target.value,
          compatible,
          requirement.field,
        );
        if (result.ok) onSetBinding?.(requirement.key, result.binding);
      }}
    >
      <option value="">Choose a compatible connection</option>
      {connectionChoicesStatus === "ready" ? compatible.map((choice) => (
        <option key={choice.id} value={choice.id}>
          {connectionChoiceDisplayLabel(choice, compatible)}
        </option>
      )) : null}
    </select>
    {fieldMismatch ? <p role="alert">This connection reference uses an unsupported semantic field.</p> : null}
    {secretBinding && !fieldMismatch && !selected
      ? <p role="alert">The referenced connection is missing or incompatible.</p>
      : null}
    {selected ? <p className="mono">{connectionChoiceDisplayLabel(selected, compatible)}</p> : null}
    {statusReceipt ? <p role="status">{statusReceipt}</p> : null}
    <a href="/connections">Manage connections</a>
  </div>;
}

function FieldControl({
  field,
  node,
  update,
  focusProps,
  valueOverride,
  boundTo,
}: {
  readonly field: NodeField;
  readonly node: FlowNode | FlowNodeV2;
  readonly update: (key: string, value: unknown) => void;
  readonly focusProps: (key: string) => { onFocus: () => void; onBlur: () => void };
  readonly valueOverride?: JsonValue;
  readonly boundTo?: string;
}): React.JSX.Element {
  const value = valueOverride === undefined ? node.params[field.key] : valueOverride;
  const controlId = `inspector-${encodeURIComponent(node.id)}-${encodeURIComponent(field.key)}`;
  const hintId = field.hint ? `${controlId}-hint` : undefined;
  const boundHintId = boundTo ? `${controlId}-bound` : undefined;
  const describedBy = [boundHintId, hintId].filter(Boolean).join(" ") || undefined;
  const locked = boundTo !== undefined;
  const lockedStyle: React.CSSProperties = locked ? { opacity: 0.65, cursor: "not-allowed" } : {};
  const boundNotice = boundTo ? (
    <span id={boundHintId} style={hintStyle}>
      {`Value comes from ${boundTo}. Change the data source below to edit a static value.`}
    </span>
  ) : null;
  if (field.kind === "boolean") {
    return (
      <div>
        <label htmlFor={controlId} style={{ display: "flex", alignItems: "center", gap: 8, cursor: locked ? "not-allowed" : "pointer" }}>
          <input id={controlId} type="checkbox" checked={asBoolean(value)} disabled={locked} aria-describedby={describedBy} onChange={(event) => update(field.key, event.target.checked)} {...focusProps(field.key)} style={{ accentColor: "var(--registry-cyan)", ...lockedStyle }} />
          <span className="mono" style={{ ...labelStyle, marginBottom: 0 }}>{field.label}</span>
        </label>
        {boundNotice}
        <FieldHint hint={field.hint} id={hintId} />
      </div>
    );
  }
  return (
    <div>
      <label htmlFor={controlId} className="mono" style={labelStyle}>{field.label}</label>
      {field.kind === "string" ? <input id={controlId} type="text" value={asString(value)} readOnly={locked} aria-describedby={describedBy} onChange={(event) => update(field.key, event.target.value)} {...focusProps(field.key)} style={{ ...inputStyle, ...lockedStyle }} /> : null}
      {field.kind === "number" ? <input id={controlId} type="number" value={asNumber(value)} readOnly={locked} aria-describedby={describedBy} onChange={(event) => update(field.key, event.target.value === "" ? undefined : Number(event.target.value))} {...focusProps(field.key)} style={{ ...inputStyle, ...lockedStyle }} /> : null}
      {field.kind === "json" ? (
        <JsonFieldControl
          key={`${node.id}:${field.key}`}
          controlId={controlId}
          fieldKey={field.key}
          value={value}
          update={update}
          focusProps={focusProps}
          locked={locked}
          describedBy={describedBy}
        />
      ) : null}
      {field.kind === "textarea" ? <textarea id={controlId} value={asString(value)} spellCheck={false} readOnly={locked} aria-describedby={describedBy} onChange={(event) => update(field.key, event.target.value)} {...focusProps(field.key)} style={{ ...textareaStyle, ...lockedStyle }} /> : null}
      {field.kind === "select" ? (() => {
        const entries = fieldOptionEntries(field);
        const stored = asString(value);
        const unset = stored === ""
          ? !entries.some((entry) => entry.value === "")
          : !entries.some((entry) => entry.value === stored);
        return (
          <select id={controlId} value={unset ? "" : stored} disabled={locked} aria-describedby={describedBy} onChange={(event) => update(field.key, event.target.value)} {...focusProps(field.key)} style={{ ...inputStyle, ...lockedStyle }}>
            {unset ? <option value="" disabled>{`Choose ${field.label}`}</option> : null}
            {entries.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
          </select>
        );
      })() : null}
      {boundNotice}
      <FieldHint hint={field.hint} id={hintId} />
    </div>
  );
}

export default function Inspector({
  node,
  graph,
  resolvePorts,
  apiOperationAuthoringEnabled = false,
  graphVersion,
  variables = [],
  upstreamPorts = [],
  validationIssues = [],
  onPatch,
  onSetBinding,
  onRemoveBinding,
  onCallableInterfaceSet,
  onCallableInterfaceRemove,
  parentFlowId = null,
  referenceResolutionStatus,
  onSubflowReferenceResolved,
  onOpenResolvedSubflow,
  onRunTestScope,
  testRunDisabledReason = null,
  testRunBusy = false,
  connectionChoices = [],
  connectionChoicesStatus = "unavailable",
  apiOperation,
  onChange,
}: InspectorProps): React.JSX.Element {
  const staticDefinition = node ? getNodeDefinition(node.type) : null;
  const definition = node && graph && staticDefinition
    ? (() => {
        const ports = resolvePorts ? resolvePorts(node) : resolveNodePorts(graph, node);
        const receipt = resolveNodeCapabilityReceipt(graph, node, undefined, undefined, resolvePorts);
        return {
          ...staticDefinition,
          inputPorts: ports.inputPorts,
          outputPorts: ports.outputPorts,
          effects: receipt.effects,
          permissions: receipt.permissions,
          cost: receipt.cost,
        };
      })()
    : staticDefinition;
  const typedReusableFlow = Boolean(
    node && (node.type === "subflow" || node.type === "loop") &&
    Object.hasOwn(node.params, "reference"),
  );
  const fields = (definition?.ui.fields ?? []).filter((field) => {
    if (!typedReusableFlow) return true;
    if (field.key === "flowId") return false;
    return node?.type !== "loop" || field.key !== "itemsPath";
  });
  const standaloneConnections = (definition?.connections ?? []).filter((requirement) =>
    !fields.some((field) => field.key === requirement.key));
  const focusGroups = useRef(new Map<string, string>());
  const testRunReasonId = useId();
  const version = graphVersion ?? (node && "bindings" in node ? 2 : 1);
  const testRunUnavailableReason = testRunDisabledReason ||
    (testRunBusy ? "A test run is already in progress." : null);
  const testRunDisabled = testRunBusy || Boolean(testRunDisabledReason);

  const runTestScope = (kind: FlowTestScope["kind"]): void => {
    if (!onRunTestScope || testRunBusy || testRunDisabledReason) return;
    if (!node) return;
    onRunTestScope({ kind, nodeId: node.id });
  };

  const update = (key: string, value: unknown): void => {
    if (!node) return;
    if (!onPatch) {
      if (onChange) onChange({ ...node.params, [key]: value });
      return;
    }
    const path = `/${pointerSegment(key)}`;
    const exists = Object.hasOwn(node.params, key);
    const patch: JsonPatchOp = value === undefined
      ? { op: "remove", path }
      : { op: exists ? "replace" : "add", path, value: value as JsonValue };
    if (value === undefined && !exists) return;
    onPatch([patch], focusGroups.current.get(key));
  };
  const focusProps = (key: string) => ({
    onFocus: () => focusGroups.current.set(key, focusGroupId(node?.id ?? "node", key)),
    onBlur: () => focusGroups.current.delete(key),
  });

  const interfaceEditor = graph && "schemaVersion" in graph && onCallableInterfaceSet && onCallableInterfaceRemove
    ? <CallableInterfaceEditor
        graph={graph as FlowGraphV2}
        value={(graph as FlowGraphV2).callableInterface}
        onSet={onCallableInterfaceSet}
        onRemove={onCallableInterfaceRemove}
        resolvePorts={resolvePorts}
        showApiOperationPortStatus={apiOperationAuthoringEnabled}
      />
    : null;

  if (!node) {
    return <aside aria-label="Inspector" className="inspector-panel">
      {interfaceEditor}
      <div className="eyebrow">Select a node</div>
    </aside>;
  }

  if (node.type === "api.operation" && apiOperation) {
    return <aside aria-label="Inspector" className="inspector-panel">
      {interfaceEditor}
      <div><div className="eyebrow">Inspector</div><div className="mono inspector-node-type">api.operation</div></div>
      <ApiOperationInspector {...apiOperation} />
    </aside>;
  }

  if (node.type === "api.operation") {
    return <aside aria-label="Inspector" className="inspector-panel">{interfaceEditor}</aside>;
  }

  const bindings = "bindings" in node && node.bindings ? node.bindings : {};
  const issues = [...configValidationIssues(node), ...validationIssues];
  let currentReference;
  if (node.type === "subflow" || node.type === "loop") {
    try {
      const normalized = normalizeSubflowReference(node.params);
      currentReference = normalized.kind === "typed" ? normalized.reference : undefined;
    } catch {
      currentReference = undefined;
    }
  }
  return (
    <aside aria-label="Inspector" className="inspector-panel">
      {interfaceEditor}
      {(node.type === "subflow" || node.type === "loop") && onSubflowReferenceResolved ? <SubflowReferenceControl
        parentFlowId={parentFlowId}
        node={node}
        current={currentReference}
        resolutionStatus={referenceResolutionStatus ?? (currentReference ? "unresolved" : "legacy")}
        onResolved={onSubflowReferenceResolved}
        onOpenChild={onOpenResolvedSubflow}
      /> : null}
      <div>
        <div className="eyebrow">Inspector</div>
        <div className="mono inspector-node-type">{node.type}</div>
        {definition ? <p className="inspector-node-description">{definition.description}</p> : null}
        {version === 1 ? <p className="inspector-legacy-note">Legacy flow: <code>{"{{in}}"}</code> remains available. Choosing a structured source upgrades once through command history.</p> : null}
        {onRunTestScope ? <details style={{
          marginTop: 10,
          padding: "7px 8px",
          background: "var(--canvas-bg)",
          border: "1px solid var(--hairline)",
          borderRadius: "var(--radius-sm)",
        }}>
          <summary className="mono" style={{
            minHeight: 30,
            color: "var(--primary)",
            fontSize: "var(--text-label)",
            fontWeight: 700,
            lineHeight: "30px",
            cursor: "pointer",
          }}>Run selected</summary>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 6, marginTop: 7 }}>
            <button
              type="button"
              className="inspector-run-btn"
              disabled={testRunDisabled}
              aria-disabled={testRunDisabled}
              aria-describedby={testRunUnavailableReason ? testRunReasonId : undefined}
              onClick={() => runTestScope("node")}
            >Run node</button>
            <button
              type="button"
              className="inspector-run-btn"
              disabled={testRunDisabled}
              aria-disabled={testRunDisabled}
              aria-describedby={testRunUnavailableReason ? testRunReasonId : undefined}
              onClick={() => runTestScope("to-node")}
            >Run to node</button>
            <button
              type="button"
              className="inspector-run-btn"
              disabled={testRunDisabled}
              aria-disabled={testRunDisabled}
              aria-describedby={testRunUnavailableReason ? testRunReasonId : undefined}
              onClick={() => runTestScope("from-node")}
            >Run from node</button>
          </div>
          {testRunUnavailableReason ? <p
            id={testRunReasonId}
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="mono"
            style={{ margin: "7px 0 0", color: "var(--text-muted)", fontSize: "var(--text-label)", lineHeight: 1.4 }}
          >{testRunUnavailableReason}</p> : null}
        </details> : null}
      </div>

      {issues.length > 0 ? <section className="inspector-validation" aria-label="Configuration validation"><h2>Needs attention</h2><DetailList items={issues} /></section> : null}

      {standaloneConnections.length > 0 ? <section className="inspector-connections" aria-label="Required connections">
        <h2>Required connections</h2>
        {standaloneConnections.map((requirement) => <ConnectionRequirementControl
          key={requirement.key}
          requirement={requirement}
          binding={bindings[requirement.key]}
          connectionChoices={connectionChoices}
          connectionChoicesStatus={connectionChoicesStatus}
          onSetBinding={onSetBinding}
          onRemoveBinding={onRemoveBinding}
        />)}
      </section> : null}

      {fields.length === 0 ? <p className="inspector-empty">No parameters for this node.</p> : (
        <div className="inspector-fields">
          {fields.map((field) => (
            <section className="inspector-field" key={field.key}>
              <FieldControl
                field={field}
                node={node}
                valueOverride={(() => {
                  const fieldBinding = bindings[field.key];
                  return fieldBinding?.kind === "literal" ? fieldBinding.value : undefined;
                })()}
                boundTo={boundSourceSummary(bindings[field.key], upstreamPorts, variables)}
                update={(key, value) => {
                  const kind = bindings[key]?.kind;
                  if (kind === "port" || kind === "variable") return;
                  if (kind !== "literal") return update(key, value);
                  if (value === undefined) onRemoveBinding?.(key);
                  else onSetBinding?.(key, { kind: "literal", value: value as JsonValue });
                }}
                focusProps={focusProps}
              />
              <BindingControl
                key={`${node.id}:${field.key}`}
                field={field}
                nodeId={node.id}
                connectionBindingAllowed={version === 2 && node.type === "http" && field.key === "headers"}
                binding={bindings[field.key]}
                variables={variables}
                upstreamPorts={upstreamPorts}
                connectionChoices={connectionChoices}
                connectionChoicesStatus={connectionChoicesStatus}
                onSetBinding={onSetBinding}
                onRemoveBinding={onRemoveBinding}
              />
            </section>
          ))}
        </div>
      )}

      {definition ? (
        <section className="capability-receipt" aria-labelledby="capability-receipt-heading">
          <h2 id="capability-receipt-heading">Capability receipt</h2>
          <dl>
            <div className="capability-receipt__fact"><dt>Inputs</dt><dd><ul className="schema-receipt-list">{definition.inputPorts.length ? definition.inputPorts.map((port) => <li className="data-receipt" key={port.id}><strong>{port.label} · {port.id}</strong><span>{schemaStatus(port.schema)}</span><code>{schemaPreview(port.schema)}</code></li>) : <li>None</li>}</ul></dd></div>
            <div className="capability-receipt__fact"><dt>Outputs</dt><dd><ul className="schema-receipt-list">{definition.outputPorts.length ? definition.outputPorts.map((port) => <li className="data-receipt" key={port.id}><strong>{port.label} · {port.id}</strong><span>{schemaStatus(port.schema)}</span><code>{schemaPreview(port.schema)}</code></li>) : <li>None</li>}</ul></dd></div>
            <div className="capability-receipt__fact"><dt>Test behavior</dt><dd>{nodeTestModeLabel(definition)}</dd></div>
            <div className="capability-receipt__fact"><dt>Possible effects</dt><dd><DetailList items={nodeCapabilitySummary(definition)} /></dd></div>
            <div className="capability-receipt__fact"><dt>Permissions</dt><dd><DetailList items={nodePermissionSummary(definition)} /></dd></div>
            <div className="capability-receipt__fact"><dt>Retry</dt><dd>{retryLabel(definition.retry)}</dd></div>
            <div className="capability-receipt__fact"><dt>Cost</dt><dd className="tabular">{nodeCostLabel(definition)}</dd></div>
          </dl>
        </section>
      ) : null}
    </aside>
  );
}
