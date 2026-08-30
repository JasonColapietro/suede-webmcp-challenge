"use client";

import React, { useId } from "react";
import type { ConnectionChoice } from "@/lib/connections/client";
import type { ConnectorReadinessReceipt } from "@/lib/connectors/readiness";
import type { ApiOperationSimulationReceiptV1 } from "@/lib/connectors/simulation-contract";
import type { ApiOperationBrowserClosureProjection } from "@/lib/connectors/operation-closure";
import type { OperationAuthenticationV1 } from "@/lib/connectors/types";
import type { ApiOperationReference } from "@/lib/flow/api-operation-reference";

export type ApiOperationActionState<Receipt> =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "busy" }>
  | Readonly<{ status: "success"; receipt: Receipt }>
  | Readonly<{ status: "error"; message: string }>;

export interface ApiOperationInspectorProps {
  readonly closure: ApiOperationBrowserClosureProjection | null;
  readonly readinessBinding: ApiOperationReference["readinessBinding"];
  readonly connectionChoices: readonly ConnectionChoice[];
  readonly connectionChoicesStatus?: "loading" | "ready" | "error" | "unavailable";
  readonly disabledReason: string | null;
  readonly simulationDisabledReason?: string | null;
  readonly readinessDisabledReason?: string | null;
  readonly simulation: ApiOperationActionState<ApiOperationSimulationReceiptV1>;
  readonly readiness: ApiOperationActionState<ConnectorReadinessReceipt>;
  readonly simulationPins?: readonly Readonly<{
    key: string;
    label: string;
    control: "json" | "boolean";
    value: string;
  }>[];
  readonly onSimulationPinChange?: (key: string, value: string) => void;
  readonly onReadinessBindingChange: (binding: ApiOperationReference["readinessBinding"]) => void;
  readonly onSimulate: () => void;
  readonly onCheckReadiness: () => void;
}

function sameNames(actual: readonly string[], expected: readonly string[]): boolean {
  const left = actual.map((name) => name.toLowerCase()).sort();
  const right = expected.map((name) => name.toLowerCase()).sort();
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

export function compatibleApiOperationConnections(
  authentication: OperationAuthenticationV1,
  choices: readonly ConnectionChoice[],
): readonly ConnectionChoice[] {
  if (authentication.kind === "none") return Object.freeze([]);
  const expected = authentication.kind === "api_key_header"
    ? [authentication.headerName.toLowerCase()]
    : ["authorization"];
  return Object.freeze(choices.filter((choice) => {
    if (!sameNames(choice.publicHeaderNames, expected)) return false;
    if (authentication.kind === "http_bearer") return choice.kind === "bearer";
    if (authentication.kind === "http_basic") return choice.kind === "basic";
    return choice.kind === "api_key" || choice.kind === "custom_headers";
  }));
}

export function boundCompatibleApiOperationConnection(
  authentication: OperationAuthenticationV1,
  binding: ApiOperationReference["readinessBinding"],
  choices: readonly ConnectionChoice[],
): ConnectionChoice | null {
  if (binding?.kind !== "connection") return null;
  return compatibleApiOperationConnections(authentication, choices)
    .find((choice) => choice.id === binding.connectionId) ?? null;
}

export function redactedIdentifierTag(value: string): string {
  if (value.length > 6) return value.slice(-6);
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  let tag = (hash >>> 0).toString(16).padStart(8, "0").slice(-6);
  if (value.length > 0 && tag.includes(value)) {
    const alphabet = "23456789abcdefghjkmnpqrstuvwxyz";
    const safe = [...alphabet].find((character) => !value.includes(character)) ?? "z";
    tag = safe.repeat(6);
  }
  return tag;
}

function schemaText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

const receiptStyle: React.CSSProperties = {
  display: "grid",
  gap: 8,
  padding: 12,
  background: "var(--ink-panel)",
  border: "1px solid var(--hairline-visible)",
  borderRadius: "var(--radius)",
  boxShadow: "var(--shadow-card)",
};

const datumStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(110px, .75fr) minmax(0, 1.5fr)",
  gap: 8,
  alignItems: "baseline",
  fontSize: "var(--text-xs)",
};

function Datum({ label, children }: { readonly label: string; readonly children: React.ReactNode }): React.JSX.Element {
  return <div style={datumStyle}><span className="eyebrow" style={{ color: "var(--text-muted)" }}>{label}</span><span className="mono" style={{ color: "var(--text-primary)", overflowWrap: "anywhere" }}>{children}</span></div>;
}

export default function ApiOperationInspector({
  closure,
  readinessBinding,
  connectionChoices,
  connectionChoicesStatus = "ready",
  disabledReason,
  simulationDisabledReason = null,
  readinessDisabledReason = null,
  simulation,
  readiness,
  simulationPins = [],
  onSimulationPinChange,
  onReadinessBindingChange,
  onSimulate,
  onCheckReadiness,
}: ApiOperationInspectorProps): React.JSX.Element {
  const id = useId();
  if (!closure) {
    return <section aria-label="API operation" style={receiptStyle}>
      <div className="eyebrow" style={{ color: "var(--text-warning)" }}>Prototype: simulation only</div>
      <p role="status" className="mono" style={{ margin: 0, color: "var(--text-muted)" }}>
        {disabledReason ?? "API operation details are unavailable. Repair this node before continuing."}
      </p>
    </section>;
  }

  const compatible = compatibleApiOperationConnections(closure.authentication, connectionChoices);
  const compatibleLabelCounts = new Map<string, number>();
  for (const choice of compatible) {
    compatibleLabelCounts.set(choice.label, (compatibleLabelCounts.get(choice.label) ?? 0) + 1);
  }
  const selectedConnection = boundCompatibleApiOperationConnection(
    closure.authentication,
    readinessBinding,
    compatible,
  );
  const selectedIndex = selectedConnection === null
    ? -1
    : compatible.findIndex((choice) => choice.id === selectedConnection.id);
  const actionDisabled = Boolean(disabledReason) || closure.archivedAt !== null;
  const actionReason = disabledReason ?? (closure.archivedAt !== null
    ? "This API operation is archived. Repair it before continuing."
    : null);
  const policy = `${closure.systemPolicy.effects[0]} / ${closure.systemPolicy.retry} / ${closure.systemPolicy.cost} / ${closure.systemPolicy.idempotency}`;
  const authenticated = closure.authentication.kind !== "none";
  const bindingNeedsRepair = connectionChoicesStatus === "ready" && authenticated && readinessBinding !== undefined && (
    readinessBinding.kind === "unresolved" || selectedIndex < 0
  );
  const readinessUnavailable = authenticated && (connectionChoicesStatus !== "ready" || selectedIndex < 0);

  return <section aria-label="API operation" style={{ display: "grid", gap: 12 }}>
    <div style={{ ...receiptStyle, borderColor: "var(--primary)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <div>
          <div className="eyebrow" style={{ color: "var(--primary)" }}>API operation</div>
          <strong>{closure.connectorDisplayLabel} · …{redactedIdentifierTag(closure.connectorId)}</strong>
        </div>
        <span className="reference-badge">Prototype: simulation only</span>
      </div>
      <p className="mono" style={{ margin: 0, color: "var(--text-warning)", fontSize: "var(--text-xs)" }}>Cannot run in published workflows</p>
      <p className="mono" style={{ margin: 0, color: "var(--text-warning)", fontSize: "var(--text-xs)" }}>Route, operation, and header names are untrusted public metadata. They must not contain secrets.</p>
      <Datum label="Definition">v{closure.definitionVersionNumber} · …{redactedIdentifierTag(closure.reference.connectorDefinitionVersionId)}</Datum>
      <Datum label="Operation version">…{redactedIdentifierTag(closure.reference.operationVersionId)}</Datum>
      <Datum label="Operation ID">{closure.reference.operationId}</Datum>
      <Datum label="Route">{closure.method} {closure.path}</Datum>
      <Datum label="Connector projection hash">{closure.reference.connectorProjectionHash}</Datum>
      <Datum label="Projection hash">{closure.reference.operationProjectionHash}</Datum>
      <Datum label="Schema hash">{closure.reference.schemaHash}</Datum>
      <Datum label="Trusted policy">{policy}</Datum>
    </div>

    <details style={receiptStyle}>
      <summary className="mono" style={{ cursor: "pointer", color: "var(--primary)" }}>Request and result schemas</summary>
      <div><div className="eyebrow">Request schema</div><pre className="mono" style={{ margin: "6px 0 0", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{schemaText(closure.requestSchema)}</pre></div>
      <div><div className="eyebrow">Result schema</div><pre className="mono" style={{ margin: "6px 0 0", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{schemaText(closure.resultSchema)}</pre></div>
    </details>

    {closure.authorAnnotation ? <section aria-label="Unverified author annotation" style={{ ...receiptStyle, borderColor: "var(--warning-amber)" }}>
      <div className="eyebrow" style={{ color: "var(--text-warning)" }}>Unverified</div>
      {closure.authorAnnotation.effectNote ? <p style={{ margin: 0 }}>{closure.authorAnnotation.effectNote}</p> : null}
      {closure.authorAnnotation.retryNote ? <p style={{ margin: 0 }}>{closure.authorAnnotation.retryNote}</p> : null}
    </section> : null}

    {closure.authentication.kind !== "none" ? <section style={receiptStyle} aria-label="Test connection binding">
      <label htmlFor={`${id}-connection`} className="eyebrow">Test connection</label>
      <select
        id={`${id}-connection`}
        value={selectedIndex >= 0 ? `choice-${selectedIndex}` : ""}
        onChange={(event) => {
          const match = /^choice-([0-9]+)$/u.exec(event.target.value);
          const choice = match ? compatible[Number(match[1])] : undefined;
          onReadinessBindingChange(choice
            ? { kind: "connection", connectionId: choice.id, capability: "http.headers" }
            : undefined);
        }}
        style={{ minHeight: 44, background: "var(--ink-control)", border: "1px solid var(--hairline)", borderRadius: "var(--radius-sm)", color: "var(--text-primary)", padding: "0 10px" }}
      >
        <option value="">Choose a compatible Test connection</option>
        {compatible.map((choice, index) => <option key={`choice-${index}`} value={`choice-${index}`}>
          {compatibleLabelCounts.get(choice.label)! > 1 ? `${choice.label} · …${redactedIdentifierTag(choice.id)}` : choice.label}
        </option>)}
      </select>
      {bindingNeedsRepair ? <p role="status" className="mono" style={{ margin: 0, color: "var(--text-warning)" }}>The saved Test connection is unavailable or incompatible. Choose a compatible connection to repair this binding.</p> : null}
      {connectionChoicesStatus === "loading" ? <p role="status" className="mono" style={{ margin: 0, color: "var(--text-muted)" }}>Loading Test connection metadata.</p> : null}
      {connectionChoicesStatus === "error" ? <p role="status" className="mono" style={{ margin: 0, color: "var(--text-muted)" }}>Test connection metadata could not be loaded.</p> : null}
      {connectionChoicesStatus === "unavailable" ? <p role="status" className="mono" style={{ margin: 0, color: "var(--text-muted)" }}>Test connection metadata is unavailable.</p> : null}
      {connectionChoicesStatus === "ready" && compatible.length === 0 ? <p role="status" className="mono" style={{ margin: 0, color: "var(--text-muted)" }}>No compatible Test connection metadata is available.</p> : null}
    </section> : <section style={receiptStyle}><p className="mono" style={{ margin: 0 }}>Authentication not required.</p></section>}

    {simulationPins.length > 0 ? <section style={receiptStyle} aria-label="Simulation boundary inputs">
      <div><div className="eyebrow">Simulation boundary inputs</div><p style={{ margin: "5px 0 0", color: "var(--text-muted)" }}>These values stay in this tab and are sent only to the local zero-egress simulator.</p></div>
      {simulationPins.map((pin, index) => <label key={pin.key} style={{ display: "grid", gap: 5 }}>
        <span className="mono" style={{ fontSize: "var(--text-xs)" }}>{pin.label}</span>
        {pin.control === "boolean" ? <select
          aria-label={`Simulation boundary input ${index + 1}`}
          value={pin.value}
          onChange={(event) => onSimulationPinChange?.(pin.key, event.target.value)}
          style={{ minHeight: 44, background: "var(--ink-control)", border: "1px solid var(--hairline)", borderRadius: "var(--radius-sm)", color: "var(--text-primary)" }}
        ><option value="false">False</option><option value="true">True</option></select> : <textarea
          aria-label={`Simulation boundary input ${index + 1}`}
          value={pin.value}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => onSimulationPinChange?.(pin.key, event.target.value)}
          style={{ minHeight: 64, background: "var(--ink-control)", border: "1px solid var(--hairline)", borderRadius: "var(--radius-sm)", color: "var(--text-primary)", padding: 8, fontFamily: "var(--font-mono)" }}
        />}
      </label>)}
    </section> : null}

    <section style={receiptStyle} aria-label="API operation actions">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
        <button type="button" className="btn btn-primary" style={{ minHeight: 44 }} aria-busy={simulation.status === "busy"} disabled={actionDisabled || Boolean(simulationDisabledReason) || simulation.status === "busy"} onClick={onSimulate}>
          {simulation.status === "busy" ? "Simulating…" : "Simulate workflow"}
        </button>
        <button type="button" className="btn btn-secondary" style={{ minHeight: 44 }} aria-busy={readiness.status === "busy"} disabled={actionDisabled || Boolean(readinessDisabledReason) || readinessUnavailable || readiness.status === "busy"} onClick={onCheckReadiness}>
          {readiness.status === "busy" ? "Checking…" : "Check Test readiness"}
        </button>
      </div>
      {actionReason ? <p role="status" className="mono" style={{ margin: 0, color: "var(--text-warning)" }}>{actionReason}</p> : null}
      {!actionReason && simulationDisabledReason ? <p role="status" className="mono" style={{ margin: 0, color: "var(--text-muted)" }}>{simulationDisabledReason}</p> : null}
      {!actionReason && readinessDisabledReason ? <p role="status" className="mono" style={{ margin: 0, color: "var(--text-muted)" }}>{readinessDisabledReason}</p> : null}
      {!actionReason && readinessUnavailable ? <p role="status" className="mono" style={{ margin: 0, color: "var(--text-muted)" }}>{connectionChoicesStatus === "ready" ? "Choose a compatible Test connection before checking readiness. Simulation remains available." : "Test connection metadata must finish loading before checking readiness. Simulation remains available."}</p> : null}
      <div aria-live="polite" aria-atomic="true" className="mono" style={{ color: "var(--text-muted)", fontSize: "var(--text-xs)" }}>
        {simulation.status === "success" ? simulation.receipt.message : simulation.status === "error" ? simulation.message : ""}
      </div>
      <div aria-live="polite" aria-atomic="true" className="mono" style={{ color: "var(--text-muted)", fontSize: "var(--text-xs)" }}>
        {readiness.status === "success" ? readiness.receipt.message : readiness.status === "error" ? readiness.message : ""}
      </div>
    </section>
  </section>;
}
