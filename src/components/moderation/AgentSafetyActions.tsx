"use client";

import React, { useState } from "react";
import ReportContentButton from "./ReportContentButton";
import {
  HIDDEN_AGENTS_STORAGE_KEY,
  HIDDEN_AGENTS_EVENT,
  parseHiddenAgentIds,
} from "@/lib/moderation/hidden-agents";

export default function AgentSafetyActions({ agentId }: { readonly agentId: string }): React.JSX.Element {
  const [confirmingHide, setConfirmingHide] = useState(false);

  const hide = (): void => {
    const hidden = new Set(parseHiddenAgentIds(globalThis.localStorage?.getItem(HIDDEN_AGENTS_STORAGE_KEY) ?? null));
    hidden.add(agentId);
    globalThis.localStorage?.setItem(HIDDEN_AGENTS_STORAGE_KEY, JSON.stringify([...hidden].slice(0, 1_000)));
    globalThis.dispatchEvent?.(new Event(HIDDEN_AGENTS_EVENT));
    globalThis.location.assign("/agents");
  };

  return <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
    <ReportContentButton subject={{ subjectType: "agent", agentId }} label="Report agent" />
    {!confirmingHide ? <button
      type="button"
      className="lp-btn lp-btn--ghost lp-btn--sm"
      onClick={() => setConfirmingHide(true)}
    >
      Hide this agent
    </button> : <>
      <span role="status" style={{ color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>Hide it from this browser?</span>
      <button type="button" className="lp-btn lp-btn--ghost lp-btn--sm" onClick={hide}>Confirm hide</button>
      <button type="button" className="lp-btn lp-btn--ghost lp-btn--sm" onClick={() => setConfirmingHide(false)}>Cancel</button>
    </>}
  </div>;
}
