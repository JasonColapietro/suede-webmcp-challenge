"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  NODE_GROUP_ORDER,
  projectAvailableNodeDefinitions,
  type NodeGroup,
  type NodeDefinitionV2,
} from "@/lib/flow/node-definitions";
import { CONNECTOR_LAB_FLAG } from "@/lib/connectors/flags";
import { matchesNodeDefinition } from "@/lib/flow/node-display";
import type { NodeType } from "@/lib/flow/types";
import { nodeGroupAccent } from "./SuedeNode";
import "./canvas-theme.css";

export interface NodePaletteProps {
  onAdd: (type: NodeType) => void;
  onBrowseApiOperations?: () => void;
  apiOperationTriggerRef?: React.RefObject<HTMLButtonElement | null>;
}

const DRAG_MIME = "application/suede-node-type";
const COLLAPSE_STORAGE_KEY = "suede.nodePalette.collapsedGroups";

/** Groups collapsed on first visit. The core primitives (Triggers, I/O, AI,
 * Logic) stay open so a first-time builder sees the recommended nodes;
 * the specialized groups keep their headers visible but fold until opened.
 * Search still auto-expands every group, and any change persists per
 * browser. */
const DEFAULT_COLLAPSED: NodeGroup[] = [
  "Docs & Data",
  "Comms & CRM",
  "Finance & Ops",
  "Dev & Infra",
  "Music & IP",
  "Rails",
];

function loadCollapsedGroups(): Set<NodeGroup> {
  if (typeof window === "undefined") return new Set(DEFAULT_COLLAPSED);
  try {
    const raw = window.localStorage.getItem(COLLAPSE_STORAGE_KEY);
    if (!raw) return new Set(DEFAULT_COLLAPSED);
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((g): g is NodeGroup => typeof g === "string"));
    }
  } catch {
    // Fall through to defaults.
  }
  return new Set(DEFAULT_COLLAPSED);
}

function groupDefs(): Map<NodeGroup, NodeDefinitionV2[]> {
  const byGroup = new Map<NodeGroup, NodeDefinitionV2[]>();
  for (const group of NODE_GROUP_ORDER) byGroup.set(group, []);
  for (const def of projectAvailableNodeDefinitions(CONNECTOR_LAB_FLAG, "visible")) {
    const list = byGroup.get(def.category);
    if (list) list.push(def);
  }
  return byGroup;
}

function compactTestLabel(definition: NodeDefinitionV2): string {
  if (definition.testMode === "native") return "native";
  if (definition.testMode === "stub") return "stub";
  return "off";
}

function compactCostLabel(definition: NodeDefinitionV2): string {
  if (definition.cost.kind === "free") return "Free";
  if (definition.cost.kind === "variable") return "Variable";
  const amount = definition.cost.amount;
  return typeof amount === "number" && Number.isFinite(amount)
    ? `$${amount.toFixed(3)}`
    : "Variable";
}

function nodeChipAccessibleLabel(definition: NodeDefinitionV2): string {
  const prototypeBoundary = definition.type === "api.operation"
    ? " Prototype: simulation only. Cannot run in published workflows."
    : "";
  const base = `${definition.label}. Type ${definition.type}. ${definition.description} Cost ${compactCostLabel(definition)}. Test mode ${compactTestLabel(definition)}.`;
  return `${base}${prototypeBoundary}`;
}

export function nodePaletteDefinitionDraggable(type: NodeType): boolean {
  return type !== "api.operation";
}

export function selectNodePaletteDefinition(
  type: NodeType,
  onAdd: (type: NodeType) => void,
  onBrowseApiOperations?: () => void,
): boolean {
  if (type === "api.operation") {
    if (!onBrowseApiOperations) return false;
    onBrowseApiOperations();
    return true;
  }
  onAdd(type);
  return true;
}

function NodeChip({
  def,
  onAdd,
  onBrowseApiOperations,
  apiOperationTriggerRef,
}: {
  def: NodeDefinitionV2;
  onAdd: (type: NodeType) => void;
  onBrowseApiOperations?: () => void;
  apiOperationTriggerRef?: React.RefObject<HTMLButtonElement | null>;
}): React.JSX.Element {
  const apiOperation = !nodePaletteDefinitionDraggable(def.type);
  return (
    <button
      ref={apiOperation ? apiOperationTriggerRef : undefined}
      className="node-palette-chip"
      type="button"
      aria-label={nodeChipAccessibleLabel(def)}
      draggable={!apiOperation}
      disabled={apiOperation && onBrowseApiOperations === undefined}
      onDragStart={apiOperation ? undefined : (event) => {
        event.dataTransfer.setData(DRAG_MIME, def.type);
        event.dataTransfer.effectAllowed = "move";
      }}
      onClick={() => { selectNodePaletteDefinition(def.type, onAdd, onBrowseApiOperations); }}
      /* Surface styling (accent bar, hover lift, transitions) lives in
         canvas-theme.css keyed off --chip-accent; only layout stays inline. */
      style={{
        "--chip-accent": nodeGroupAccent(def.category),
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 3,
        width: "100%",
        textAlign: "left",
        cursor: apiOperation ? onBrowseApiOperations ? "pointer" : "not-allowed" : "grab",
        padding: "8px 10px",
        color: "var(--text-primary)",
      } as React.CSSProperties}
    >
      <span className="node-palette-chip__label" aria-hidden="true">
        {def.label}
      </span>
      <span className="node-palette-chip__meta" aria-hidden="true">
        <span className="node-palette-chip__summary" title={def.description}>
          {def.description}
        </span>
        <span
          className="node-palette-chip__datum mono tabular"
          title={`Type ${def.type} · Test ${compactTestLabel(def)}`}
        >
          {compactCostLabel(def)}
        </span>
      </span>
      {apiOperation ? (
        <span className="mono" style={{ display: "grid", gap: 2, color: "var(--text-warning)", fontSize: "var(--text-label)" }} aria-hidden="true">
          <span>Prototype: simulation only</span>
          <span>Cannot run in published workflows</span>
        </span>
      ) : null}
    </button>
  );
}

export default function NodePalette({
  onAdd,
  onBrowseApiOperations,
  apiOperationTriggerRef,
}: NodePaletteProps): React.JSX.Element {
  const grouped = useMemo(() => groupDefs(), []);
  const [query, setQuery] = useState<string>("");
  const [collapsed, setCollapsed] = useState<Set<NodeGroup>>(
    () => new Set(DEFAULT_COLLAPSED),
  );
  const [hydrated, setHydrated] = useState<boolean>(false);

  // Load saved collapse state after mount so SSR and the first client render
  // stay in sync (avoids a hydration mismatch), then persist changes after.
  useEffect(() => {
    setCollapsed(loadCollapsedGroups());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated || typeof window === "undefined") return;
    window.localStorage.setItem(
      COLLAPSE_STORAGE_KEY,
      JSON.stringify(Array.from(collapsed)),
    );
  }, [collapsed, hydrated]);

  const toggleGroup = (group: NodeGroup): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  const searching = query.trim() !== "";
  const matchCount = useMemo(
    () => NODE_GROUP_ORDER.reduce(
      (total, group) =>
        total + (grouped.get(group) ?? []).filter((def) => matchesNodeDefinition(def, query)).length,
      0,
    ),
    [grouped, query],
  );

  return (
    <aside
      aria-label="Node palette"
      style={{
        height: "100%",
        overflowY: "auto",
        background: "var(--ink-panel)",
        borderRight: "1px solid var(--hairline-visible)",
        padding: "16px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 16,
      }}
    >
      <div className="eyebrow">Nodes</div>
      <input
        className="node-palette-filter"
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Filter nodes…"
        aria-label="Filter nodes"
        spellCheck={false}
        style={{
          width: "100%",
          height: "var(--control-h)",
          background: "var(--ink-control)",
          border: "1px solid var(--hairline)",
          borderRadius: "var(--radius-sm)",
          color: "var(--text-primary)",
          fontFamily: "var(--font-ui)",
          fontSize: "var(--text-sm)",
          padding: "0 10px",
        }}
      />
      {NODE_GROUP_ORDER.map((group) => {
        const allDefs = grouped.get(group) ?? [];
        const defs = allDefs.filter((def) =>
          matchesNodeDefinition(def, query),
        );
        if (defs.length === 0) return null;
        const isOpen = searching || !collapsed.has(group);
        return (
          <section
            key={group}
            className="node-palette-group"
            style={{ display: "flex", flexDirection: "column", gap: 8 }}
          >
            {/* Toggle styling (layout, hover color) lives in canvas-theme.css. */}
            <button
              type="button"
              disabled={searching}
              onClick={() => { if (!searching) toggleGroup(group); }}
              aria-expanded={isOpen}
              className="eyebrow node-palette-group__toggle"
            >
              <span className="node-palette-group__label">
                <span
                  className="node-palette-group__key"
                  aria-hidden="true"
                  style={{ background: nodeGroupAccent(group) }}
                />
                {group} · {defs.length}
              </span>
              <span aria-hidden="true">{isOpen ? "−" : "+"}</span>
            </button>
            {isOpen && (
              <div
                style={{ display: "flex", flexDirection: "column", gap: 6 }}
              >
                {defs.map((def) => (
                  <NodeChip key={def.type} def={def} onAdd={onAdd} onBrowseApiOperations={onBrowseApiOperations} apiOperationTriggerRef={apiOperationTriggerRef} />
                ))}
              </div>
            )}
          </section>
        );
      })}
      {searching && matchCount === 0 ? (
        <p className="inspector-empty">
          No nodes match “{query.trim()}”.{" "}
          <button
            type="button"
            onClick={() => setQuery("")}
            style={{
              background: "none",
              border: "none",
              padding: 0,
              color: "var(--primary)",
              font: "inherit",
              textDecoration: "underline",
              cursor: "pointer",
            }}
          >
            Clear filter
          </button>
        </p>
      ) : null}
      {/* Mounted at all times so the count actually re-announces; a live region
          inserted together with its text usually never fires. */}
      <p className="sr-only" role="status">
        {searching ? `${matchCount} ${matchCount === 1 ? "node matches" : "nodes match"} ${query.trim()}.` : ""}
      </p>
    </aside>
  );
}
