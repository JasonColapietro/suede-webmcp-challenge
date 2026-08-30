"use client";

import { useRef, type KeyboardEvent } from "react";

export const RESOURCE_TAB_ORDER = [
  "brief", "sources", "records", "job", "test", "publish", "trust-and-earnings",
] as const;
export type ResourceTabId = (typeof RESOURCE_TAB_ORDER)[number];
export type ResourceStageState = "ready" | "complete";

const LABELS: Record<ResourceTabId, string> = {
  brief: "Brief",
  sources: "Sources",
  records: "Records",
  job: "Job",
  test: "Test",
  publish: "Publish",
  "trust-and-earnings": "Trust & Earnings",
};

export function parseResourceTab(value: string | null): ResourceTabId {
  return RESOURCE_TAB_ORDER.find((tab) => tab === value) ?? "brief";
}

export function nextResourceTab(active: ResourceTabId, key: string): ResourceTabId {
  const index = RESOURCE_TAB_ORDER.indexOf(active);
  if (key === "Home") return RESOURCE_TAB_ORDER[0];
  if (key === "End") return RESOURCE_TAB_ORDER.at(-1)!;
  if (key === "ArrowRight" || key === "ArrowDown") {
    return RESOURCE_TAB_ORDER[(index + 1) % RESOURCE_TAB_ORDER.length];
  }
  if (key === "ArrowLeft" || key === "ArrowUp") {
    return RESOURCE_TAB_ORDER[(index - 1 + RESOURCE_TAB_ORDER.length) % RESOURCE_TAB_ORDER.length];
  }
  return active;
}

export default function ResourceTabs({
  active,
  states = {},
  onSelect,
}: {
  readonly active: ResourceTabId;
  readonly states?: Partial<Record<ResourceTabId, ResourceStageState>>;
  readonly onSelect: (tab: ResourceTabId) => void;
}): React.JSX.Element {
  const refs = useRef<Partial<Record<ResourceTabId, HTMLButtonElement | null>>>({});

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const next = nextResourceTab(active, event.key);
    if (next === active) return;
    event.preventDefault();
    onSelect(next);
    refs.current[next]?.focus();
  };

  return (
    <div className="resource-rail-wrap">
      <div className="resource-rail" role="tablist" aria-label="Resource release stages">
        {RESOURCE_TAB_ORDER.map((tab, index) => (
          <button
            key={tab}
            ref={(element) => { refs.current[tab] = element; }}
            type="button"
            id={`resource-tab-${tab}`}
            className="resource-rail-step"
            data-state={states[tab] ?? "ready"}
            role="tab"
            aria-label={`${LABELS[tab]}, ${states[tab] ?? "ready"}`}
            aria-selected={active === tab}
            tabIndex={active === tab ? 0 : -1}
            aria-controls={`resource-panel-${tab}`}
            onClick={() => onSelect(tab)}
            onKeyDown={onKeyDown}
          >
            <span className="resource-rail-index" aria-hidden="true">{index + 1}</span>
            <span>{LABELS[tab]}</span>
          </button>
        ))}
      </div>
      <p className="resource-rail-note">Review any stage at any time. Actions only stop for technical prerequisites.</p>
    </div>
  );
}
