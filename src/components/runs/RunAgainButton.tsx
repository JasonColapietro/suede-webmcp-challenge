"use client";

import React, { useState } from "react";

const SSE_DELIMITER = "\n\n";

function parseRunId(frame: string): string | null {
  const dataLine = frame
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("data:"));
  if (!dataLine) return null;
  const payload = dataLine.slice("data:".length).trim();
  if (payload === "") return null;
  try {
    const event = JSON.parse(payload) as { kind?: unknown; runId?: unknown };
    return event.kind === "run:start" && typeof event.runId === "string" ? event.runId : null;
  } catch {
    return null;
  }
}

function normalizedTriggerInput(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Resubmits a legacy run's stored trigger input against its flow, then hands off to the new run's own page. */
export default function RunAgainButton({
  flowId,
  triggerInput,
}: {
  readonly flowId: string;
  readonly triggerInput: unknown;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/v2/flows/${encodeURIComponent(flowId)}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ triggerInput: normalizedTriggerInput(triggerInput) }),
      });
      if (!response.ok || !response.body) throw new Error("Run request failed.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let runId: string | null = null;

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx = buffer.indexOf(SSE_DELIMITER);
        while (idx !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + SSE_DELIMITER.length);
          runId ??= parseRunId(frame);
          idx = buffer.indexOf(SSE_DELIMITER);
        }
      }
      const tail = buffer.trim();
      if (tail !== "") runId ??= parseRunId(tail);

      if (!runId) throw new Error("The new run did not start.");
      window.location.assign(`/runs/${encodeURIComponent(runId)}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "The new run did not start.");
      setBusy(false);
    }
  };

  return (
    <div className="mt-8" style={{ display: "grid", gap: 8, justifyItems: "start" }}>
      <button
        type="button"
        className="mono text-xs"
        disabled={busy}
        onClick={() => void run()}
        style={{
          border: "1px solid var(--hairline-visible)",
          borderRadius: "var(--radius-sm)",
          background: "transparent",
          color: "var(--text-info)",
          cursor: busy ? "default" : "pointer",
          padding: "6px 12px",
        }}
      >
        {busy ? "Starting…" : "Run again"}
      </button>
      {error ? <p role="alert" className="mono text-xs" style={{ color: "var(--rights-red)" }}>{error}</p> : null}
    </div>
  );
}
