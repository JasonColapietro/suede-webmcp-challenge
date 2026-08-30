"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type KeyboardEvent,
} from "react";
import type { WorkbookFlowTab } from "@/lib/projects/types";

export interface WorkbookTabFocusHandoff {
  current: string | null;
}

export interface WorkbookTabsProps {
  readonly tabs: readonly WorkbookFlowTab[];
  readonly activeFlowId: string;
  readonly busyFlowId: string | null;
  readonly error: string | null;
  readonly focusHandoff: WorkbookTabFocusHandoff;
  readonly onActivate: (tab: WorkbookFlowTab) => Promise<void>;
}

export function consumeWorkbookTabFocus(
  handoff: WorkbookTabFocusHandoff,
  activeFlowId: string,
  focus: () => void,
): boolean {
  if (handoff.current !== activeFlowId) return false;
  handoff.current = null;
  focus();
  return true;
}

function compareTabs(left: WorkbookFlowTab, right: WorkbookFlowTab): number {
  return left.position - right.position || left.id.localeCompare(right.id);
}

function isModifiedClick(event: MouseEvent<HTMLButtonElement>): boolean {
  return event.metaKey || event.ctrlKey || event.altKey || event.shiftKey;
}

export default function WorkbookTabs({
  tabs,
  activeFlowId,
  busyFlowId,
  error,
  focusHandoff,
  onActivate,
}: WorkbookTabsProps): React.JSX.Element {
  const orderedTabs = useMemo(() => [...tabs].sort(compareTabs), [tabs]);
  const activeIndex = Math.max(0, orderedTabs.findIndex((tab) => tab.flowId === activeFlowId));
  const [focusIndex, setFocusIndex] = useState(activeIndex);
  const [transitionAnnouncement, setTransitionAnnouncement] = useState("");
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    setFocusIndex(activeIndex);
  }, [activeFlowId, activeIndex]);

  useEffect(() => {
    const activeButton = buttonRefs.current[activeIndex];
    if (!activeButton) return;
    consumeWorkbookTabFocus(focusHandoff, activeFlowId, () => activeButton.focus());
  }, [activeFlowId, activeIndex, focusHandoff, orderedTabs.length]);

  const activate = useCallback(async (tab: WorkbookFlowTab): Promise<void> => {
    if (tab.flowId === activeFlowId || busyFlowId !== null) return;
    setTransitionAnnouncement("");
    try {
      await onActivate(tab);
      setTransitionAnnouncement(`Switching to ${tab.title}.`);
    } catch {
      // The controlled error prop carries the stable, non-sensitive refusal copy.
    }
  }, [activeFlowId, busyFlowId, onActivate]);

  const moveFocus = useCallback((nextIndex: number): void => {
    if (orderedTabs.length === 0) return;
    setFocusIndex(nextIndex);
    buttonRefs.current[nextIndex]?.focus();
  }, [orderedTabs.length]);

  const handleKeyDown = useCallback((
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
    tab: WorkbookFlowTab,
  ): void => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + orderedTabs.length) % orderedTabs.length;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % orderedTabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = orderedTabs.length - 1;
    if (nextIndex !== null) {
      event.preventDefault();
      moveFocus(nextIndex);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      void activate(tab);
    }
  }, [activate, moveFocus, orderedTabs.length]);

  const busyTab = busyFlowId === null
    ? null
    : orderedTabs.find((tab) => tab.flowId === busyFlowId) ?? null;
  const activeTab = orderedTabs.find((tab) => tab.flowId === activeFlowId) ?? null;
  const announcement = error
    ?? (busyTab
      ? `Saving ${activeTab?.title ?? "the current draft"} before switching.`
      : transitionAnnouncement);

  return (
    <section className="workbook-tabs" aria-busy={busyFlowId !== null || undefined}>
      <div
        className="workbook-tabs__list"
        role="tablist"
        aria-label="Workbook flows"
        aria-orientation="horizontal"
      >
        {orderedTabs.map((tab, index) => {
          const active = tab.flowId === activeFlowId;
          const busy = tab.flowId === busyFlowId;
          return (
            <button
              key={tab.id}
              ref={(button) => { buttonRefs.current[index] = button; }}
              className="workbook-tabs__tab mono"
              type="button"
              role="tab"
              aria-selected={active}
              aria-current={active ? "page" : undefined}
              aria-busy={busy || undefined}
              tabIndex={active ? 0 : -1}
              data-roving-focus={focusIndex === index || undefined}
              onFocus={() => setFocusIndex(index)}
              onKeyDown={(event) => handleKeyDown(event, index, tab)}
              onClick={(event) => {
                if (isModifiedClick(event)) event.preventDefault();
                void activate(tab);
              }}
            >
              <span className="workbook-tabs__name">{tab.title}</span>
              {busy ? <span className="workbook-tabs__state">Saving</span> : null}
            </button>
          );
        })}
      </div>
      <p
        className="workbook-tabs__announcement"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement}
      </p>
    </section>
  );
}
