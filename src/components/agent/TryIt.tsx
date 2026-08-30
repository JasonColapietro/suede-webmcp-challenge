"use client";

/**
 * Dry-run "Try it" panel for a public agent page. Posts the run endpoint with
 * user-supplied JSON input and renders the result + cost — the fastest path
 * from "found this agent" to "saw it work".
 */
import { useState } from "react";
import ReportContentButton from "@/components/moderation/ReportContentButton";

interface TryItProps {
  agentId: string;
  /** Example body derived from the flow's real input node on the server. */
  defaultInput?: string;
}

interface RunOutcome {
  ok: boolean;
  body: string;
}

export default function TryIt({ agentId, defaultInput }: TryItProps): React.JSX.Element {
  const [input, setInput] = useState<string>(defaultInput ?? '{ "prompt": "your input here" }');
  const [busy, setBusy] = useState<boolean>(false);
  const [outcome, setOutcome] = useState<RunOutcome | null>(null);

  async function run(): Promise<void> {
    setBusy(true);
    setOutcome(null);
    try {
      let parsed: unknown = {};
      try {
        parsed = input.trim() === "" ? {} : JSON.parse(input);
      } catch {
        setOutcome({ ok: false, body: "Input is not valid JSON." });
        setBusy(false);
        return;
      }
      const res = await fetch(`/api/agents/${agentId}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // dryRun keeps the promise in the label above: without it, a priced
        // agent with live settlement answers 402 (or executes for real).
        body: JSON.stringify({ input: parsed, dryRun: true }),
      });
      const text = await res.text();
      let pretty = text;
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        // leave as-is
      }
      setOutcome({ ok: res.ok, body: pretty.slice(0, 4000) });
    } catch (err: unknown) {
      setOutcome({
        ok: false,
        body: err instanceof Error ? err.message : "Request failed.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="lp-try">
      <label
        className="lp-eyebrow"
        htmlFor="tryit-input"
        style={{ display: "block", marginBottom: "0.6rem" }}
      >
        Try it · dry-run, no payment
      </label>
      <textarea
        id="tryit-input"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        spellCheck={false}
        aria-label="JSON input for the agent run"
      />
      <div style={{ marginTop: "0.7rem", display: "flex", gap: "0.6rem", alignItems: "center" }}>
        <button
          type="button"
          className="lp-btn lp-btn--primary lp-btn--sm"
          onClick={() => void run()}
          disabled={busy}
          style={busy ? { opacity: 0.6, cursor: "wait" } : undefined}
        >
          {busy ? "Running…" : "Run agent →"}
        </button>
        <span className="lp-pill">POST /api/agents/{agentId.slice(0, 8)}…/run</span>
      </div>
      {outcome && (
        <div
          className="lp-try-result"
          role={outcome.ok ? "status" : "alert"}
          aria-live="polite"
        >
          <div
            className="lp-code"
            style={outcome.ok ? undefined : { borderColor: "var(--rights-red)" }}
          >
            {outcome.body}
          </div>
          {outcome.ok ? <div style={{ marginTop: "0.65rem" }}>
            <ReportContentButton
              subject={{ subjectType: "agent_output", agentId }}
              label="Report unsafe output"
            />
          </div> : null}
        </div>
      )}
    </div>
  );
}
