"use client";

/**
 * /grade client — the input moment, the in-flight state, and the verdict.
 *
 * Presentation only: grading itself lives in /api/grade (LLM read with a
 * deterministic fallback; see src/lib/grade.ts). The verdict routes toward
 * the Grade Rebuilder template, which exists to turn a grade like this one
 * into a ready-to-build Agent Studio spec aimed at the weakest pillar.
 */

import { useId, useState } from "react";
import Link from "next/link";
import type { GradeResultDTO } from "@/lib/grade";
import { trackEvent } from "@/lib/analytics";

type PillarKey = "acceleration" | "traction" | "appCredibility" | "teamCredibility" | "nichePosition";

const PILLAR_KEYS: PillarKey[] = [
  "acceleration",
  "traction",
  "appCredibility",
  "teamCredibility",
  "nichePosition",
];

const PILLAR_LABELS: Record<PillarKey, string> = {
  acceleration: "Acceleration",
  traction: "Traction",
  appCredibility: "App Credibility",
  teamCredibility: "Team Credibility",
  nichePosition: "Niche Position",
};

type ScoreTier = "strong" | "mid" | "low";

function scoreTier(n: number): ScoreTier {
  if (n >= 75) return "strong";
  if (n >= 50) return "mid";
  return "low";
}

const MOMENTUM_META: Record<string, { modifier: string; label: string }> = {
  "↑": { modifier: "grade-momentum--up", label: "Momentum: rising" },
  "→": { modifier: "grade-momentum--flat", label: "Momentum: holding" },
  "↓": { modifier: "grade-momentum--down", label: "Momentum: falling" },
};

export default function GradeClient(): React.JSX.Element {
  const fieldId = useId();
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<GradeResultDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/grade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: trimmed }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        throw new Error(typeof body.error === "string" ? body.error : `HTTP ${res.status}`);
      }
      const data = (await res.json()) as GradeResultDTO;
      setResult(data);
      trackEvent("grade_completed", { momentum: data.momentum });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  const momentum = result === null ? null : (MOMENTUM_META[result.momentum] ?? MOMENTUM_META["→"]);

  return (
    <div className="lp-block" style={{ marginTop: 0 }}>
      {/* Input moment */}
      <form onSubmit={handleSubmit} className="guided-form grade-form">
        <label htmlFor={fieldId} className="guided-field-label">
          Agent handle or URL
        </label>
        <div className="guided-controls">
          <input
            id={fieldId}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="@agent_handle or agentapp.com"
            maxLength={500}
            required
            disabled={loading}
            spellCheck={false}
            autoComplete="off"
            className="lp-input grade-input"
            aria-describedby={`${fieldId}-hint`}
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="lp-btn lp-btn--primary"
          >
            {loading ? "Grading…" : "Grade it"}
            <span aria-hidden="true">→</span>
          </button>
        </div>
        <p id={`${fieldId}-hint`} className="guided-hint">
          Free, no login, no payment. You get a score per pillar, a momentum read, and any
          flags the grader raises.
        </p>
      </form>

      {/* Empty state: name the five pillars before anything is graded. */}
      {result === null && (
        <ul className="grade-pillar-strip" aria-label="The five pillars">
          <li className="grade-pillar-strip-lead">Five pillars</li>
          {PILLAR_KEYS.map((key) => (
            <li key={key}>{PILLAR_LABELS[key]}</li>
          ))}
        </ul>
      )}

      {/* In-flight */}
      {loading && (
        <p className="lp-loading grade-status" role="status">
          Scoring five pillars…
        </p>
      )}

      {/* Error */}
      {error !== null && (
        <div className="state-panel state-panel--error grade-alert" role="alert">
          {error}
        </div>
      )}

      {/* Results */}
      {result !== null && momentum !== null && (
        <section className="grade-result" aria-label="Grade result">
          <div className="grade-result-head">
            <h2>{result.name}</h2>
            <span
              className={`grade-momentum ${momentum.modifier}`}
              role="img"
              aria-label={momentum.label}
            >
              {result.momentum}
            </span>
          </div>

          <div className="grade-pillars">
            {PILLAR_KEYS.map((key) => {
              const score = result.pillars[key];
              const rationale = result.rationale[key] ?? "";
              const tier = scoreTier(score);
              return (
                <div key={key} className="lp-feature">
                  <div className={`lp-feature-no grade-tier--${tier}`}>{PILLAR_LABELS[key]}</div>
                  <div className={`grade-score grade-tier--${tier}`}>
                    {score}
                    <span className="grade-score-max">/100</span>
                  </div>
                  <div className={`grade-meter grade-tier--${tier}`} aria-hidden="true">
                    <span className="grade-meter-fill" style={{ width: `${score}%` }} />
                  </div>
                  {rationale && <p className="grade-rationale">{rationale}</p>}
                </div>
              );
            })}
          </div>

          {/* Anti-gaming flags */}
          {result.antiGamingFlags.length > 0 && (
            <div className="state-panel state-panel--warning grade-flags">
              <span className="grade-flags-label">Flags</span>
              <ul>
                {result.antiGamingFlags.map((flag) => (
                  <li key={flag}>{flag}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Verdict CTA: route the grade toward the Rebuilder template. */}
          <aside className="grade-cta">
            <p className="grade-cta-head">Now build the one that beats it.</p>
            <p className="grade-cta-sub">
              The Grade Rebuilder template turns a grade like this one into a ready-to-build
              agent spec aimed at the weakest pillar. Launch it as a pay-per-call x402 endpoint
              in USDC on Base: no code, no hosting, no engineer. One more seat on your org chart.
            </p>
            <div className="grade-cta-actions">
              <Link
                href="/templates/grade-rebuilder"
                className="lp-btn lp-btn--primary"
                onClick={() => {
                  const weakPillar = (PILLAR_KEYS as readonly PillarKey[]).reduce(
                    (min, k) => (result.pillars[k] < result.pillars[min] ? k : min),
                    PILLAR_KEYS[0]
                  );
                  trackEvent("agentix_studio_cta_clicked", {
                    weak_pillar: PILLAR_LABELS[weakPillar],
                    handle: result.name,
                  });
                }}
              >
                {result.studioCtaLabel ?? "Build the better version in Agent Studio →"}
              </Link>
              <Link href="/start" className="lp-btn lp-btn--ghost lp-btn--sm">
                Describe your own instead →
              </Link>
            </div>
          </aside>
        </section>
      )}
    </div>
  );
}
