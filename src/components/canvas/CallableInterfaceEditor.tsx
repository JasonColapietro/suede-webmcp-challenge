"use client";

import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { validateCallableInterfaceForGraph } from "@/lib/flow/callable-interface-validation";
import { createAuthoringNodePortResolver, type ValidatedNodePortResolver } from "@/lib/flow/node-ports";
import type {
  CallableInputPort,
  CallableOutputPort,
  FlowCallableInterface,
  FlowGraphV2,
  JsonSchema,
} from "@/lib/flow/types";

export interface CallableInterfaceEditorProps {
  readonly graph: FlowGraphV2;
  readonly value?: FlowCallableInterface;
  readonly onSet: (value: FlowCallableInterface) => void;
  readonly onRemove: () => void;
  readonly disabled?: boolean;
  readonly resolvePorts?: ValidatedNodePortResolver;
  readonly showApiOperationPortStatus?: boolean;
}

export interface CallableInputEditorRow { readonly key: string; readonly port: CallableInputPort; readonly schemaText: string }
export interface CallableOutputEditorRow { readonly key: string; readonly port: CallableOutputPort; readonly schemaText: string }
export interface CallableEditorRows { readonly inputs: readonly CallableInputEditorRow[]; readonly outputs: readonly CallableOutputEditorRow[] }
export type CallableEditorRowsAction =
  | { readonly kind: "reset"; readonly rows: CallableEditorRows }
  | { readonly kind: "schema.set"; readonly direction: "inputs" | "outputs"; readonly key: string; readonly text: string }
  | { readonly kind: "remove"; readonly direction: "inputs" | "outputs"; readonly key: string }
  | { readonly kind: "move"; readonly direction: "inputs" | "outputs"; readonly key: string; readonly offset: -1 | 1 };

const schemaText = (schema: JsonSchema): string => JSON.stringify(schema);

export function createCallableEditorRows(
  value: FlowCallableInterface | undefined,
  makeKey: (direction: "input" | "output") => string,
): CallableEditorRows {
  return {
    inputs: (value?.inputs ?? []).map((port) => ({ key: makeKey("input"), port: structuredClone(port), schemaText: schemaText(port.schema) })),
    outputs: (value?.outputs ?? []).map((port) => ({ key: makeKey("output"), port: structuredClone(port), schemaText: schemaText(port.schema) })),
  };
}

export function reduceCallableEditorRows(
  state: CallableEditorRows,
  action: CallableEditorRowsAction,
): CallableEditorRows {
  if (action.kind === "reset") return action.rows;
  const values = [...state[action.direction]] as Array<CallableInputEditorRow | CallableOutputEditorRow>;
  const index = values.findIndex((row) => row.key === action.key);
  if (index < 0) return state;
  if (action.kind === "schema.set") values[index] = { ...values[index]!, schemaText: action.text };
  if (action.kind === "remove") values.splice(index, 1);
  if (action.kind === "move") {
    const target = index + action.offset;
    if (target < 0 || target >= values.length) return state;
    [values[index], values[target]] = [values[target]!, values[index]!];
  }
  return { ...state, [action.direction]: values } as CallableEditorRows;
}

function parseSchema(text: string): JsonSchema {
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
  return parsed as JsonSchema;
}

export function callableInterfaceFromEditorRows(rows: CallableEditorRows): FlowCallableInterface {
  return {
    inputs: rows.inputs.map((row) => ({ ...row.port, schema: parseSchema(row.schemaText) })),
    outputs: rows.outputs.map((row) => ({ ...row.port, schema: parseSchema(row.schemaText) })),
  };
}

function fieldId(root: string, direction: "input" | "output", rowKey: string, field: string): string {
  return `${root}-${direction}-${rowKey}-${field}`;
}

function displayIdentity(direction: "Input" | "Output", index: number, id: string): string {
  return `${direction} ${index + 1}${id ? ` (${id})` : ""}`;
}

export default function CallableInterfaceEditor({
  graph,
  value,
  onSet,
  onRemove,
  disabled = false,
  resolvePorts,
  showApiOperationPortStatus = false,
}: CallableInterfaceEditorProps): React.JSX.Element {
  const id = useId();
  const sequence = useRef(0);
  const makeKey = (direction: "input" | "output"): string => `${direction}-${sequence.current++}`;
  const [rows, setRows] = useState<CallableEditorRows>(() => createCallableEditorRows(value, makeKey));
  const [message, setMessage] = useState("");
  const outputState = useMemo(() => {
    const resolve = resolvePorts ?? createAuthoringNodePortResolver(graph);
    let unavailableOperation = false;
    const choices = graph.nodes.flatMap((node) => {
      try {
        const ports = resolve(node).outputPorts;
        if (node.type === "api.operation" && ports.length === 0) unavailableOperation = true;
        return ports.map((port) => ({
          value: `${node.id}\u0000${port.id}`,
          nodeId: node.id,
          portId: port.id,
          label: `${node.id} · ${port.label} (${port.id})`,
        }));
      } catch {
        if (node.type === "api.operation") unavailableOperation = true;
        return [];
      }
    });
    return { choices, unavailableOperation };
  }, [graph, resolvePorts]);
  const outputChoices = outputState.choices;

  useEffect(() => {
    setRows(createCallableEditorRows(value, makeKey));
    setMessage("");
    // rowsFromValue intentionally snapshots external undo/redo/reset values.
     
  }, [value]);

  const updateInput = (key: string, update: (row: CallableInputEditorRow) => CallableInputEditorRow): void => {
    setRows((current) => ({ ...current, inputs: current.inputs.map((row) => row.key === key ? update(row) : row) }));
  };
  const updateOutput = (key: string, update: (row: CallableOutputEditorRow) => CallableOutputEditorRow): void => {
    setRows((current) => ({ ...current, outputs: current.outputs.map((row) => row.key === key ? update(row) : row) }));
  };
  const move = (direction: "inputs" | "outputs", index: number, offset: -1 | 1): void => {
    setRows((current) => {
      const key = current[direction][index]?.key;
      return key ? reduceCallableEditorRows(current, { kind: "move", direction, key, offset }) : current;
    });
  };
  const apply = (): void => {
    try {
      const candidate = callableInterfaceFromEditorRows(rows);
      onSet(validateCallableInterfaceForGraph(graph, candidate, resolvePorts));
      setMessage("Callable interface ready to save.");
    } catch {
      setMessage("Interface is invalid. Check unique IDs, mappings, schemas, and output sources.");
    }
  };
  const addInput = (): void => {
    const index = rows.inputs.length + 1;
    const port: CallableInputPort = {
      id: `input_${index}`, label: `Input ${index}`, schema: {}, required: true,
      cardinality: "one", target: { kind: "trigger", path: `/input_${index}` },
    };
    setRows((current) => ({ ...current, inputs: [...current.inputs, { key: makeKey("input"), port, schemaText: "{}" }] }));
  };
  const addOutput = (): void => {
    const index = rows.outputs.length + 1;
    const first = outputChoices[0];
    const port: CallableOutputPort = {
      id: `output_${index}`, label: `Output ${index}`, schema: {}, required: true,
      cardinality: "one", source: { nodeId: first?.nodeId ?? "", portId: first?.portId ?? "" },
    };
    setRows((current) => ({ ...current, outputs: [...current.outputs, { key: makeKey("output"), port, schemaText: "{}" }] }));
  };

  return (
    <section aria-label="Callable interface editor" className="callable-interface-editor data-receipt">
      <div className="callable-interface-editor__heading"><div><h2>Callable interface</h2><p>Name the inputs this flow accepts and the outputs it returns.</p></div><span className="reference-badge">Flow ABI</span></div>
      <fieldset disabled={disabled}>
        <legend>Inputs</legend>
        {rows.inputs.length === 0 ? <p>No callable inputs yet.</p> : null}
        {rows.inputs.map((row, index) => {
          const identity = displayIdentity("Input", index, row.port.id);
          return <div className="callable-port-row" key={row.key}>
            <label htmlFor={fieldId(id, "input", row.key, "id")}>{identity} ID</label>
            <input id={fieldId(id, "input", row.key, "id")} value={row.port.id} onChange={(event) => updateInput(row.key, (current) => ({ ...current, port: { ...current.port, id: event.target.value } }))} />
            <label htmlFor={fieldId(id, "input", row.key, "label")}>{identity} label</label>
            <input id={fieldId(id, "input", row.key, "label")} value={row.port.label} onChange={(event) => updateInput(row.key, (current) => ({ ...current, port: { ...current.port, label: event.target.value } }))} />
            <label htmlFor={fieldId(id, "input", row.key, "path")}>{identity} trigger JSON Pointer</label>
            <input id={fieldId(id, "input", row.key, "path")} value={row.port.target.path} onChange={(event) => updateInput(row.key, (current) => ({ ...current, port: { ...current.port, target: { kind: "trigger", path: event.target.value } } }))} />
            <label htmlFor={fieldId(id, "input", row.key, "schema")}>{identity} schema JSON</label>
            <textarea id={fieldId(id, "input", row.key, "schema")} value={row.schemaText} onChange={(event) => setRows((current) => reduceCallableEditorRows(current, { kind: "schema.set", direction: "inputs", key: row.key, text: event.target.value }))} />
            <label htmlFor={fieldId(id, "input", row.key, "cardinality")}>{identity} cardinality</label>
            <select id={fieldId(id, "input", row.key, "cardinality")} value={row.port.cardinality} onChange={(event) => updateInput(row.key, (current) => ({ ...current, port: { ...current.port, cardinality: event.target.value as "one" | "many" } }))}><option value="one">One</option><option value="many">Many</option></select>
            <label className="callable-port-row__check"><input type="checkbox" checked={row.port.required} onChange={(event) => updateInput(row.key, (current) => ({ ...current, port: { ...current.port, required: event.target.checked } }))} /> {identity} required</label>
            <div className="callable-port-row__actions"><button type="button" className="btn btn-secondary task6-target" aria-label={`Move ${identity.toLowerCase()} up`} disabled={index === 0} onClick={() => move("inputs", index, -1)}>↑</button><button type="button" className="btn btn-secondary task6-target" aria-label={`Move ${identity.toLowerCase()} down`} disabled={index === rows.inputs.length - 1} onClick={() => move("inputs", index, 1)}>↓</button><button type="button" className="btn btn-secondary task6-target" onClick={() => setRows((current) => reduceCallableEditorRows(current, { kind: "remove", direction: "inputs", key: row.key }))}>Remove {identity.toLowerCase()}</button></div>
          </div>;
        })}
        <button type="button" className="btn btn-secondary task6-target" onClick={addInput}>Add input</button>
      </fieldset>
      <fieldset disabled={disabled}>
        <legend>Outputs</legend>
        {rows.outputs.length === 0 ? <p>No callable outputs yet.</p> : null}
        {rows.outputs.map((row, index) => {
          const identity = displayIdentity("Output", index, row.port.id);
          return <div className="callable-port-row" key={row.key}>
            <label htmlFor={fieldId(id, "output", row.key, "id")}>{identity} ID</label>
            <input id={fieldId(id, "output", row.key, "id")} value={row.port.id} onChange={(event) => updateOutput(row.key, (current) => ({ ...current, port: { ...current.port, id: event.target.value } }))} />
            <label htmlFor={fieldId(id, "output", row.key, "label")}>{identity} label</label>
            <input id={fieldId(id, "output", row.key, "label")} value={row.port.label} onChange={(event) => updateOutput(row.key, (current) => ({ ...current, port: { ...current.port, label: event.target.value } }))} />
            <label htmlFor={fieldId(id, "output", row.key, "source")}>{identity} source</label>
            <select id={fieldId(id, "output", row.key, "source")} value={`${row.port.source.nodeId}\u0000${row.port.source.portId}`} onChange={(event) => { const choice = outputChoices.find((item) => item.value === event.target.value); if (choice) updateOutput(row.key, (current) => ({ ...current, port: { ...current.port, source: { ...current.port.source, nodeId: choice.nodeId, portId: choice.portId } } })); }}><option value="">Choose a node output</option>{outputChoices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select>
            <label htmlFor={fieldId(id, "output", row.key, "path")}>{identity} JSON Pointer (optional)</label>
            <input id={fieldId(id, "output", row.key, "path")} value={row.port.source.path ?? ""} onChange={(event) => updateOutput(row.key, (current) => ({ ...current, port: { ...current.port, source: { ...current.port.source, ...(event.target.value ? { path: event.target.value } : { path: undefined }) } } }))} />
            <label htmlFor={fieldId(id, "output", row.key, "schema")}>{identity} schema JSON</label>
            <textarea id={fieldId(id, "output", row.key, "schema")} value={row.schemaText} onChange={(event) => setRows((current) => reduceCallableEditorRows(current, { kind: "schema.set", direction: "outputs", key: row.key, text: event.target.value }))} />
            <label htmlFor={fieldId(id, "output", row.key, "cardinality")}>{identity} cardinality</label>
            <select id={fieldId(id, "output", row.key, "cardinality")} value={row.port.cardinality} onChange={(event) => updateOutput(row.key, (current) => ({ ...current, port: { ...current.port, cardinality: event.target.value as "one" | "many" } }))}><option value="one">One</option><option value="many">Many</option></select>
            <label className="callable-port-row__check"><input type="checkbox" checked={row.port.required} onChange={(event) => updateOutput(row.key, (current) => ({ ...current, port: { ...current.port, required: event.target.checked } }))} /> {identity} required</label>
            <div className="callable-port-row__actions"><button type="button" className="btn btn-secondary task6-target" aria-label={`Move ${identity.toLowerCase()} up`} disabled={index === 0} onClick={() => move("outputs", index, -1)}>↑</button><button type="button" className="btn btn-secondary task6-target" aria-label={`Move ${identity.toLowerCase()} down`} disabled={index === rows.outputs.length - 1} onClick={() => move("outputs", index, 1)}>↓</button><button type="button" className="btn btn-secondary task6-target" onClick={() => setRows((current) => reduceCallableEditorRows(current, { kind: "remove", direction: "outputs", key: row.key }))}>Remove {identity.toLowerCase()}</button></div>
          </div>;
        })}
        <button type="button" className="btn btn-secondary task6-target" onClick={addOutput}>Add output</button>
      </fieldset>
      <div className="callable-interface-editor__actions"><button type="button" className="btn btn-primary task6-target" disabled={disabled} onClick={apply}>Apply interface</button><button type="button" className="btn btn-secondary task6-target" disabled={disabled || value === undefined} onClick={onRemove}>Remove interface</button></div>
      {showApiOperationPortStatus && outputState.unavailableOperation ? <p role="status" aria-live="polite" className="callable-interface-editor__status">API operation ports are unavailable. Repair this node before mapping outputs.</p> : null}
      <p className="callable-interface-editor__status" aria-live="polite" aria-atomic="true">{message}</p>
    </section>
  );
}
