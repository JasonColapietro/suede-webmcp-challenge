"use client";

import React, { memo, type KeyboardEvent } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import type { NodeType } from "@/lib/flow/types";
import {
  getNodeDefinition,
  type NodeGroup,
  type PortSpec,
} from "@/lib/flow/node-definitions";

export type SuedeNodeStatus = "running" | "done" | "error";

export interface SuedeNodeData extends Record<string, unknown> {
  nodeType: NodeType;
  label: string;
  priceUsdc?: number;
  status?: SuedeNodeStatus;
  graphVersion?: 1 | 2;
  inputPorts?: readonly PortSpec[];
  outputPorts?: readonly PortSpec[];
}

export type SuedeRfNode = Node<SuedeNodeData, "suede">;

const GROUP_COLOR: Record<NodeGroup, string> = {
  Triggers: "var(--violet)",
  "I/O": "var(--text-muted)",
  "Music & IP": "var(--registry-cyan)",
  AI: "var(--primary)",
  Rails: "var(--verified-emerald)",
  Logic: "var(--amber)",
  "Docs & Data": "var(--category-docs)",
  "Comms & CRM": "var(--category-comms)",
  "Finance & Ops": "var(--category-finance)",
  "Dev & Infra": "var(--category-devops)",
};

const GROUP_TEXT_COLOR: Record<NodeGroup, string> = {
  Triggers: "var(--primary-hover)",
  "I/O": "var(--text-secondary)",
  "Music & IP": "var(--text-info)",
  AI: "var(--primary-hover)",
  Rails: "var(--text-success)",
  Logic: "var(--text-warning)",
  "Docs & Data": "var(--category-docs)",
  "Comms & CRM": "var(--category-comms)",
  "Finance & Ops": "var(--text-success)",
  "Dev & Infra": "var(--text-warning)",
};

function categoryColor(nodeType: NodeType): string {
  return GROUP_COLOR[getNodeDefinition(nodeType).category];
}

/** Category accent shared with the node palette's color keys. */
export function nodeGroupAccent(group: NodeGroup): string {
  return GROUP_COLOR[group];
}

function categoryTextColor(nodeType: NodeType): string {
  return GROUP_TEXT_COLOR[getNodeDefinition(nodeType).category];
}

export function suedeNodeStatusLabel(status: SuedeNodeStatus | undefined): string {
  if (status === "running") return "running";
  if (status === "done") return "completed";
  if (status === "error") return "failed";
  return "not run";
}

function statusIcon(status: SuedeNodeStatus | undefined): string {
  if (status === "running") return "↻";
  if (status === "done") return "✓";
  if (status === "error") return "!";
  return "○";
}

function formatPrice(usdc: number): string {
  return `$${usdc.toFixed(3)}`;
}

export function activateHandleFromKeyboard(
  event: KeyboardEvent<HTMLDivElement>,
): void {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  event.currentTarget.click();
}

function accessibleHandleProps(label: string) {
  return {
    role: "button" as const,
    tabIndex: 0,
    "aria-label": label,
    onKeyDown: activateHandleFromKeyboard,
  };
}

export function portPosition(index: number, count: number): string {
  if (count <= 0 || index < 0 || index >= count) return "50%";
  return `${Math.round(((index + 1) / (count + 1)) * 10000) / 100}%`;
}

function schemaState(port: PortSpec): "typed" | "unknown schema" {
  return Object.keys(port.schema).length === 0 ? "unknown schema" : "typed";
}

/** Compact on-card port caption: typed is the norm, so only flag the exception. */
function portCaption(port: PortSpec): string {
  return schemaState(port) === "typed" ? port.label : `${port.label} · untyped`;
}

function handleLabel(
  nodeLabel: string,
  direction: "input" | "output",
  port: PortSpec,
): string {
  return `${nodeLabel} ${direction} ${port.label} (${port.id}), ${schemaState(port)}`;
}

function sourceHandleId(
  nodeType: NodeType,
  graphVersion: 1 | 2,
  port: PortSpec,
  index: number,
  count: number,
): string | undefined {
  if (graphVersion === 2) return port.id;
  if (count === 1 || (nodeType === "loop" && index === 0)) return undefined;
  return port.id;
}

function PortLabel({
  side,
  top,
  children,
}: {
  side: "left" | "right";
  top: string;
  children: string;
}): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="mono"
      style={{
        position: "absolute",
        [side]: 12,
        top,
        transform: "translateY(-50%)",
        color: "var(--text-muted)",
        fontSize: "var(--text-label)",
        letterSpacing: "0.04em",
        lineHeight: 1,
        pointerEvents: "none",
        maxWidth: side === "left" ? 74 : 86,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        textAlign: side,
      }}
    >
      {children}
    </span>
  );
}

function SuedeNodeComponent({ data, selected }: NodeProps<SuedeRfNode>): React.JSX.Element {
  const definition = getNodeDefinition(data.nodeType);
  const inputPorts = data.inputPorts ?? definition.inputPorts;
  const outputPorts = data.outputPorts ?? definition.outputPorts;
  const graphVersion = data.graphVersion ?? 1;
  const hasInputs = inputPorts.length > 0;
  const hasOutputs = outputPorts.length > 0;
  const maxPorts = Math.max(inputPorts.length, outputPorts.length);
  const accent = categoryColor(data.nodeType);
  const textAccent = categoryTextColor(data.nodeType);
  const outlineColor = selected ? "var(--primary)" : "var(--hairline)";

  /* Elevation, hover lift, and run-state glows live in canvas-theme.css keyed
     off the class + data attributes; the custom property hands the category
     accent to those rules. Structural styles stay inline (per-side borders are
     load-bearing for the node-definition-ui source contract). */
  const cardStyle = {
    "--node-accent": accent,
    position: "relative",
    /* Fixed width: graph pitch (templates and auto-layout re-lay at 340)
       can never overlap adjacent nodes, every card reads uniformly, and the
       label column keeps its full measure now that labels wrap instead of
       relying on nowrap text to stretch the card. */
    width: 300,
    minHeight: Math.max(64, maxPorts * 30),
    background: "var(--ink-control)",
    borderTop: `1px solid ${outlineColor}`,
    borderRight: `1px solid ${outlineColor}`,
    borderBottom: `1px solid ${outlineColor}`,
    borderLeft: `3px solid ${accent}`,
    borderRadius: "var(--radius)",
    padding: "11px 13px",
    paddingLeft: hasInputs ? 92 : 13,
    paddingRight: hasOutputs ? 102 : 13,
  } as React.CSSProperties;

  return (
    <div
      className="suede-node-card"
      data-selected={selected ? "true" : undefined}
      data-run-status={data.status}
      style={cardStyle}
    >
      {inputPorts.map((port, index) => {
        const top = portPosition(index, inputPorts.length);
        return (
          <React.Fragment key={`input:${port.id}`}>
            <Handle
              id={port.id}
              type="target"
              position={Position.Left}
              {...accessibleHandleProps(handleLabel(definition.label, "input", port))}
              title={handleLabel(definition.label, "input", port)}
              style={{
                top,
                width: 24,
                height: 24,
                background: "radial-gradient(circle, var(--ink-control) 0 3px, " + accent + " 3px 5px, transparent 5px)",
                border: 0,
              }}
            />
            <PortLabel side="left" top={top}>
              {portCaption(port)}
            </PortLabel>
          </React.Fragment>
        );
      })}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          marginBottom: 5,
        }}
      >
        <span
          className="mono"
          title={data.nodeType}
          style={{
            fontSize: "var(--text-label)",
            letterSpacing: "0.03em",
            color: textAccent,
            textTransform: "lowercase",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
          }}
        >
          {data.nodeType}
        </span>
        <span
          className="suede-node-status mono"
          data-status={data.status ?? "idle"}
          style={{ flexShrink: 0 }}
          title={suedeNodeStatusLabel(data.status)}
        >
          <span aria-hidden="true">{statusIcon(data.status)}</span>
          {/* Idle is the resting state of every fresh canvas — the icon alone
              keeps it quiet and leaves header room for the node type. Live
              statuses (running/done/error) spell themselves out. */}
          {data.status !== undefined ? (
            <span>{suedeNodeStatusLabel(data.status)}</span>
          ) : (
            <span className="sr-only">{suedeNodeStatusLabel(data.status)}</span>
          )}
        </span>
      </div>

      {/* Two-line clamp instead of single-line ellipsis: the port gutters
          leave a narrow center column, and one nowrap line truncated most
          multi-word labels at default zoom. Wrapping keeps the whole name
          readable; the clamp still bounds pathological labels. */}
      <div
        title={data.label}
        style={{
          fontFamily: "var(--font-ui)",
          fontWeight: 600,
          fontSize: "var(--text-sm)",
          color: "var(--text-primary)",
          lineHeight: 1.2,
          overflow: "hidden",
          display: "-webkit-box",
          WebkitBoxOrient: "vertical",
          WebkitLineClamp: 2,
        }}
      >
        {data.label}
      </div>

      {typeof data.priceUsdc === "number" && data.priceUsdc > 0 && (
        <div style={{ marginTop: 8 }}>
          <span
            className="mono tabular"
            style={{
              display: "inline-block",
              fontSize: "var(--text-label)",
              color: textAccent,
              border: `1px solid ${accent}`,
              borderRadius: "var(--radius-sm)",
              padding: "1px 6px",
              background: `color-mix(in srgb, ${accent} 10%, var(--ink-control))`,
            }}
          >
            {formatPrice(data.priceUsdc)}
          </span>
        </div>
      )}

      {outputPorts.map((port, index) => {
        const top = portPosition(index, outputPorts.length);
        const id = sourceHandleId(data.nodeType, graphVersion, port, index, outputPorts.length);
        const portAccent = port.id === "errors" || port.id === "false"
          ? "var(--rights-red-bright)"
          : port.id === "true"
            ? "var(--verified-emerald)"
            : accent;
        return (
          <React.Fragment key={`output:${port.id}`}>
            <Handle
              id={id}
              type="source"
              position={Position.Right}
              {...accessibleHandleProps(handleLabel(definition.label, "output", port))}
              title={handleLabel(definition.label, "output", port)}
              data-legacy-default={id === undefined ? "true" : undefined}
              style={{
                top,
                width: 24,
                height: 24,
                background: "radial-gradient(circle, var(--ink-control) 0 3px, " + portAccent + " 3px 5px, transparent 5px)",
                border: 0,
              }}
            />
            <PortLabel side="right" top={top}>
              {portCaption(port)}
            </PortLabel>
          </React.Fragment>
        );
      })}
    </div>
  );
}

const SuedeNode = memo(SuedeNodeComponent);
SuedeNode.displayName = "SuedeNode";

export default SuedeNode;
