"use client";

import React, { type MouseEvent } from "react";

export interface SubflowBreadcrumbDisplayItem {
  readonly flowId: string;
  readonly label: string;
  readonly current?: boolean;
}

export type SubflowBreadcrumbDisplayState =
  | { readonly kind: "loading" }
  | { readonly kind: "empty" }
  | { readonly kind: "error" }
  | { readonly kind: "ready"; readonly items: readonly SubflowBreadcrumbDisplayItem[] };

function readyItems(
  state: SubflowBreadcrumbDisplayState,
): readonly SubflowBreadcrumbDisplayItem[] | null {
  if (state.kind !== "ready" || state.items.length < 2) return null;
  const keys = new Set<string>();
  for (let index = 0; index < state.items.length; index += 1) {
    const item = state.items[index]!;
    const current = index === state.items.length - 1;
    if (!item.flowId || new TextEncoder().encode(item.flowId).byteLength > 512 ||
        /[\u0000-\u001f\u007f]/.test(item.flowId) || !item.label.trim() ||
        keys.has(item.flowId) || Boolean(item.current) !== current) return null;
    keys.add(item.flowId);
  }
  return state.items;
}

export default function SubflowBreadcrumbs({
  state,
  onNavigate,
}: {
  readonly state: SubflowBreadcrumbDisplayState;
  readonly onNavigate?: (
    item: SubflowBreadcrumbDisplayItem,
    event: MouseEvent<HTMLAnchorElement>,
  ) => void;
}): React.JSX.Element {
  const items = readyItems(state);
  const statusCopy = state.kind === "loading"
    ? "Loading flow trail…"
    : state.kind === "empty"
      ? "Opened directly. No parent flow trail."
      : "Flow trail unavailable.";

  return (
    <nav
      aria-label="Flow trail breadcrumb"
      aria-busy={state.kind === "loading" || undefined}
      className="mono"
      style={{
        width: "100%",
        minWidth: 0,
        overflowX: "auto",
        overscrollBehaviorInline: "contain",
      }}
    >
      {items ? (
        <ol
          style={{
            display: "flex",
            alignItems: "center",
            width: "max-content",
            minWidth: "100%",
            gap: 4,
            padding: 0,
            margin: 0,
            listStyle: "none",
          }}
        >
          {items.map((item, index) => {
            const current = index === items.length - 1;
            return (
              <li key={item.flowId} style={{ display: "flex", alignItems: "center", minWidth: 0 }}>
                {index > 0 ? <span aria-hidden="true" style={{ color: "var(--text-muted)" }}>›</span> : null}
                {current ? (
                  <span
                    aria-current="page"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      minHeight: 44,
                      padding: "0 10px",
                      color: "var(--text-primary)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {item.label}
                  </span>
                ) : (
                  <a
                    href={`/build/${encodeURIComponent(item.flowId)}`}
                    onClick={(event) => onNavigate?.(item, event)}
                    onAuxClick={(event) => onNavigate?.(item, event)}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      minHeight: 44,
                      padding: "0 10px",
                      color: "var(--text-info)",
                      whiteSpace: "nowrap",
                      textDecoration: "none",
                    }}
                  >
                    {item.label}
                  </a>
                )}
              </li>
            );
          })}
        </ol>
      ) : state.kind === "error" ? (
        <p role="status" aria-live="polite" style={{ margin: 0, minHeight: 44, display: "flex", alignItems: "center" }}>
          {statusCopy}
        </p>
      ) : (
        /* No trail to show: keep the status for assistive tech, paint nothing. */
        <p
          role="status"
          aria-live="polite"
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            margin: -1,
            padding: 0,
            overflowX: "hidden",
            overflowY: "hidden",
            clip: "rect(0, 0, 0, 0)",
            whiteSpace: "nowrap",
            border: 0,
          }}
        >
          {statusCopy}
        </p>
      )}
    </nav>
  );
}
