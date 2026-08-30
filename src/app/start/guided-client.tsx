"use client";

/**
 * Guided builder client component.
 * Manages conversation state, polls /api/guided turn-by-turn,
 * renders review cards on manifest receipt, launches via existing routes.
 *
 * IMPORTANT: This file must NOT import from:
 *   - @/lib/manifest (from-flow, to-flow, codegen pull viem/node:crypto)
 *   - @/lib/flow/registry or node executors
 * Type imports from @/lib/manifest/schema are safe (zod only, stripped at build).
 * Review cards come from @/lib/guided/review — the single source of truth for
 * the approved plain-English strings (pure zod + describeCron, client-safe).
 */

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import WorkspaceKeyCallout from "@/components/WorkspaceKeyCallout";
import { buildReviewCards } from "@/lib/guided/review";
import { buildLaunchGraph, launchPriceUsdc } from "@/lib/launch/manifest-graph";

// ── Inline types (mirror src/lib/manifest/schema.ts — kept in sync manually) ──

type ManifestTriggerUnion =
  | { kind: "manual" }
  | { kind: "schedule"; cron: string }
  | { kind: "paidCall"; priceUsdc: number }
  | { kind: "webhook" };

interface ManifestStep {
  id: string;
  type: string;
  label?: string;
  config: Record<string, unknown>;
  after: Array<string | { node: string; handle?: string }>;
}

interface AgentManifest {
  manifestVersion: 1;
  name: string;
  description: string;
  triggers: ManifestTriggerUnion[];
  steps: ManifestStep[];
  payoutAddress?: string;
  meta: { template?: string; createdBy?: "guided" | "studio" | "code" };
}

// ── Conversation types ─────────────────────────────────────────────────────────

interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

interface GuidedResponse {
  clarifyingQuestion: string | null;
  manifest: AgentManifest | null;
  /** Which brain answered — "fallback" is the deterministic interview. */
  brain?: "model" | "fallback";
}

// ── Review card types (inline — mirrors src/lib/guided/review.ts) ─────────────

interface ReviewCardData {
  label: string;
  value: string;
}

// ── Phase machine ──────────────────────────────────────────────────────────────

type Phase =
  | { kind: "chat" }
  | { kind: "drafting" }
  | { kind: "review"; manifest: AgentManifest; cards: ReviewCardData[] }
  | { kind: "launching" }
  | {
      kind: "launched";
      slug: string;
      flowId: string;
      /** Whether the agent is actually collecting USDC. Launch defaults OFF. */
      settlementLive: boolean;
      /** Server-provided payout caveat (lane contract; optional at runtime). */
      payoutWarning: string | null;
    }
  | { kind: "saving"; manifest: AgentManifest; cards: ReviewCardData[] }
  | { kind: "saved"; flowId: string };

/** True when the manifest declares a priced paid-call trigger. */
function manifestPricesCalls(manifest: AgentManifest): boolean {
  return manifest.triggers.some(
    (t) => t.kind === "paidCall" && t.priceUsdc > 0,
  );
}

interface GuidedInitialFlow {
  flowId: string;
  name: string;
  updatedAt: number;
  manifest: AgentManifest;
}

interface GuidedClientProps {
  initialFlow?: GuidedInitialFlow;
}

const NEW_AGENT_WELCOME = "Describe the job. I'll build the agent.";
const EXISTING_AGENT_WELCOME =
  "Here's your existing agent in Guided. Review it or tell me exactly what to change.";

// ── GuidedClient ───────────────────────────────────────────────────────────────

export default function GuidedClient({ initialFlow }: GuidedClientProps): React.JSX.Element {
  const [history, setHistory] = useState<ConversationTurn[]>([
    {
      role: "assistant",
      content: initialFlow ? EXISTING_AGENT_WELCOME : NEW_AGENT_WELCOME,
    },
  ]);
  const [input, setInput] = useState("");
  const [phase, setPhase] = useState<Phase>(
    initialFlow
      ? {
          kind: "review",
          manifest: initialFlow.manifest,
          cards: buildReviewCards(initialFlow.manifest),
        }
      : { kind: "chat" },
  );
  const [manifestContext, setManifestContext] = useState<AgentManifest | null>(
    initialFlow?.manifest ?? null,
  );
  const [flowUpdatedAt, setFlowUpdatedAt] = useState(initialFlow?.updatedAt ?? null);
  // Payout wallet asked at review time when the agent prices its calls, so a
  // priced launch can route USDC to the creator instead of the platform
  // fallback. Optional: launching without one still works (calls run free
  // until settlement is turned on anyway).
  const [payoutWallet, setPayoutWallet] = useState<string>(
    initialFlow?.manifest.payoutAddress ?? "",
  );
  const [settlementBusy, setSettlementBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set once the server answers from the deterministic interview, so the page
  // can say why the questions are fixed rather than just looking worse.
  const [deterministicBrain, setDeterministicBrain] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (history.length === 1 && phase.kind === "chat") return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    bottomRef.current?.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "nearest",
    });
  }, [history, phase]);

  async function sendMessage(message: string): Promise<void> {
    if (!message.trim()) return;
    setError(null);

    const newHistory: ConversationTurn[] = [
      ...history,
      { role: "user", content: message },
    ];
    setHistory(newHistory);
    setInput("");
    setPhase({ kind: "drafting" });

    try {
      // Pass history without the welcome bubble and without the latest user message
      // (the route receives `message` separately and appends it internally).
      const historyPayload = history.filter(
        (t) =>
          !(
            t.role === "assistant" &&
            (t.content === NEW_AGENT_WELCOME || t.content === EXISTING_AGENT_WELCOME)
          ),
      );

      const res = await fetch("/api/guided", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message,
          history: historyPayload,
          ...(initialFlow
            ? {
                flowId: initialFlow.flowId,
                expectedUpdatedAt: flowUpdatedAt ?? initialFlow.updatedAt,
                currentManifest: manifestContext ?? initialFlow.manifest,
              }
            : {}),
        }),
      });

      if (res.status === 429) {
        const data = (await res.json()) as { retryAfterSec?: number };
        setError(
          `Too many requests. Try again in ${data.retryAfterSec ?? 60} seconds.`,
        );
        setPhase({ kind: "chat" });
        return;
      }

      if (!res.ok) {
        setError("Something went wrong. Try again.");
        setPhase({ kind: "chat" });
        return;
      }

      const data = (await res.json()) as GuidedResponse;
      if (data.brain) setDeterministicBrain(data.brain === "fallback");

      if (data.clarifyingQuestion !== null) {
        setHistory((prev) => [
          ...prev,
          { role: "assistant", content: data.clarifyingQuestion! },
        ]);
        setPhase({ kind: "chat" });
        return;
      }

      if (data.manifest !== null) {
        const cards = buildReviewCards(data.manifest);
        setManifestContext(data.manifest);
        const draftedWallet = data.manifest.payoutAddress;
        if (draftedWallet) {
          setPayoutWallet((prev) => (prev.trim() === "" ? draftedWallet : prev));
        }
        setPhase({ kind: "review", manifest: data.manifest, cards });
        return;
      }

      setError("I need one more detail.");
      setPhase({ kind: "chat" });
    } catch {
      setError("Something went wrong. Try again.");
      setPhase({ kind: "chat" });
    }
  }

  async function handleLaunch(manifest: AgentManifest): Promise<void> {
    setPhase({ kind: "launching" });
    setError(null);

    try {
      const priceUsdc = launchPriceUsdc(manifest);

      const createRes = await fetch("/api/flows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: manifest.name,
          graph: buildLaunchGraph(manifest, `guided-${Date.now()}`),
        }),
      });

      if (!createRes.ok) {
        setError("Couldn't save the agent. Try again.");
        const currentPhase = phase;
        if (currentPhase.kind === "review") {
          setPhase(currentPhase);
        }
        return;
      }

      const createData = (await createRes.json()) as { flow?: { id?: string } };
      const flowId = createData.flow?.id;
      if (!flowId) {
        setError("Couldn't save the agent. Try again.");
        setPhase({ kind: "review", manifest, cards: buildReviewCards(manifest) });
        return;
      }

      // Launch using the FLOW ROW id (not the graph id — Supabase FK landmine).
      const trimmedWallet = payoutWallet.trim();
      const launchRes = await fetch(`/api/flows/${flowId}/launch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          priceUsdc,
          ...(trimmedWallet !== "" ? { payoutAddress: trimmedWallet } : {}),
        }),
      });

      if (!launchRes.ok) {
        const launchErrBody: unknown = await launchRes.json().catch(() => null);
        const serverError =
          typeof launchErrBody === "object" && launchErrBody !== null
            ? (launchErrBody as { error?: unknown }).error
            : undefined;
        setError(
          typeof serverError === "string"
            ? `Couldn't launch: ${serverError}`
            : "Agent saved but couldn't launch. Open it in Studio to launch.",
        );
        setPhase({ kind: "review", manifest, cards: buildReviewCards(manifest) });
        return;
      }

      // Consume the launch response defensively: settlementLive/payoutWarning
      // are a newer contract, so every field is optional at runtime. Settlement
      // defaults OFF for fresh launches, so an absent flag reads as false.
      const launchBody: unknown = await launchRes.json();
      const launchData =
        typeof launchBody === "object" && launchBody !== null
          ? (launchBody as Record<string, unknown>)
          : {};
      const slug = typeof launchData.slug === "string" ? launchData.slug : "";

      setPhase({
        kind: "launched",
        slug,
        flowId,
        settlementLive: launchData.settlementLive === true,
        payoutWarning:
          typeof launchData.payoutWarning === "string" && launchData.payoutWarning !== ""
            ? launchData.payoutWarning
            : null,
      });
    } catch {
      setError("Something went wrong during launch. Try again.");
      setPhase({ kind: "review", manifest, cards: buildReviewCards(manifest) });
    }
  }

  /** One-click post-launch opt-in: flip the agent's settlement switch on. */
  async function handleEnableSettlement(slug: string): Promise<void> {
    if (settlementBusy || slug === "") return;
    setSettlementBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(slug)}/settlement`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ live: true }),
      });
      if (!res.ok) {
        setError("Couldn't turn on settlement. You can also flip it from your Workspace.");
        return;
      }
      setPhase((prev) =>
        prev.kind === "launched" ? { ...prev, settlementLive: true } : prev,
      );
    } catch {
      setError("Couldn't turn on settlement. You can also flip it from your Workspace.");
    } finally {
      setSettlementBusy(false);
    }
  }

  async function handleSave(manifest: AgentManifest, cards: ReviewCardData[]): Promise<void> {
    if (!initialFlow) return;
    setPhase({ kind: "saving", manifest, cards });
    setError(null);

    try {
      const response = await fetch("/api/guided", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "save",
          flowId: initialFlow.flowId,
          expectedUpdatedAt: flowUpdatedAt ?? initialFlow.updatedAt,
          manifest,
        }),
      });
      if (!response.ok) {
        setError(
          response.status === 404
            ? "This agent isn't available in your workspace."
            : response.status === 409
              ? "This agent changed in Studio or Code. Reload before saving Guided changes."
            : "Couldn't save the Guided changes. Try again.",
        );
        setPhase({ kind: "review", manifest, cards });
        return;
      }
      const data = (await response.json()) as { flow?: { updatedAt?: number } };
      if (typeof data.flow?.updatedAt === "number") setFlowUpdatedAt(data.flow.updatedAt);
      setManifestContext(manifest);
      setPhase({ kind: "saved", flowId: initialFlow.flowId });
    } catch {
      setError("Couldn't save the Guided changes. Try again.");
      setPhase({ kind: "review", manifest, cards });
    }
  }

  const currentPhase = phase;

  return (
    <div className="lp-block" style={{ maxWidth: 640, marginTop: 0 }}>
      {/* Chat history */}
      <div
        className="guided-conversation"
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
      >
        {history.map((turn, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              justifyContent: turn.role === "user" ? "flex-end" : "flex-start",
            }}
          >
            <div
              style={{
                maxWidth: "80%",
                padding: "0.6rem 1rem",
                borderRadius: 12,
                background:
                  turn.role === "user"
                    ? "var(--primary)"
                    : "var(--surface-raised)",
                color:
                  turn.role === "user" ? "var(--primary-fg)" : "var(--text)",
                fontSize: "var(--text-sm)",
                lineHeight: 1.5,
              }}
            >
              {turn.content}
            </div>
          </div>
        ))}

        {currentPhase.kind === "drafting" && (
          <div style={{ display: "flex", justifyContent: "flex-start" }}>
            <div
              className="lp-eyebrow"
              role="status"
              style={{
                padding: "0.4rem 0.75rem",
                background: "var(--surface-raised)",
                borderRadius: 12,
              }}
            >
              Drafting your agent…
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Review cards — shown when manifest is ready */}
      {currentPhase.kind === "review" && (
        <div style={{ marginBottom: "1.5rem" }}>
          <p
            style={{
              fontSize: "var(--text-sm)",
              marginBottom: "1rem",
              fontWeight: 600,
            }}
          >
            Here&apos;s your agent. Plain English, no surprises.
          </p>
          <div className="guided-review-grid">
            {currentPhase.cards.map((card) => (
              <div
                key={card.label}
                className="guided-review-card"
              >
                <div
                  className="lp-eyebrow"
                  style={{ marginBottom: "0.25rem", fontSize: "0.68rem" }}
                >
                  {card.label}
                </div>
                <div style={{ fontSize: "var(--text-sm)" }}>
                  {card.value}
                </div>
              </div>
            ))}
          </div>
          {/* Wallet question — only when the agent actually prices its calls,
              and only on the launch path (saving an existing flow does not
              relaunch, so a wallet edit here would silently go nowhere). */}
          {!initialFlow && manifestPricesCalls(currentPhase.manifest) && (
            <div style={{ margin: "0 0 1rem" }}>
              <label htmlFor="guided-wallet" className="guided-field-label">
                Payout wallet (USDC on Base)
              </label>
              <input
                id="guided-wallet"
                type="text"
                value={payoutWallet}
                onChange={(e) => setPayoutWallet(e.target.value)}
                placeholder="0x wallet that collects your earnings"
                className="lp-input"
                spellCheck={false}
                aria-describedby="guided-wallet-hint"
              />
              <p id="guided-wallet-hint" className="guided-hint">
                This agent charges per call. Paste the wallet that should
                collect the USDC. Skip it and you can add one later in Studio,
                but earnings can&apos;t reach you until you do.
              </p>
            </div>
          )}
          <div className="guided-review-actions">
            <button
              className="lp-btn lp-btn--primary"
              onClick={() =>
                initialFlow
                  ? void handleSave(currentPhase.manifest, currentPhase.cards)
                  : void handleLaunch(currentPhase.manifest)
              }
            >
              {initialFlow ? "Save changes" : "Launch it"}
            </button>
            <button
              className="lp-btn lp-btn--ghost lp-btn--sm"
              onClick={() => {
                setPhase({ kind: "chat" });
                setHistory((prev) => [
                  ...prev,
                  {
                    role: "assistant",
                    content:
                      "Change anything. Tell me what to adjust and I'll redraft.",
                  },
                ]);
              }}
            >
              Change anything
            </button>
          </div>
        </div>
      )}

      {/* Launching indicator */}
      {currentPhase.kind === "launching" && (
        <div className="lp-eyebrow" style={{ marginBottom: "1rem" }}>
          Launching…
        </div>
      )}

      {currentPhase.kind === "saving" && (
        <div className="lp-eyebrow" style={{ marginBottom: "1rem" }}>
          Saving Guided changes…
        </div>
      )}

      {/* Post-launch */}
      {currentPhase.kind === "launched" && (
        <div
          style={{
            background: "var(--surface-raised)",
            borderRadius: 12,
            padding: "1.25rem",
            border: "1px solid var(--border)",
          }}
        >
          <p
            style={{
              fontWeight: 600,
              marginBottom: "0.75rem",
              fontSize: "var(--text-sm)",
            }}
          >
            It&apos;s live. It works even when you&apos;re not here.
          </p>
          {currentPhase.payoutWarning && (
            <p
              role="status"
              style={{
                fontSize: "var(--text-sm)",
                color: "var(--text-warning)",
                marginBottom: "0.75rem",
              }}
            >
              {currentPhase.payoutWarning}
            </p>
          )}
          {currentPhase.settlementLive ? (
            <p
              style={{
                fontSize: "var(--text-sm)",
                color: "var(--text-success)",
                marginBottom: "0.75rem",
              }}
            >
              Settlement is on: every paid call collects USDC.
            </p>
          ) : (
            <div style={{ marginBottom: "0.75rem" }}>
              <p style={{ fontSize: "var(--text-sm)", marginBottom: "0.5rem" }}>
                Calls are free previews until you turn on settlement.
              </p>
              <button
                type="button"
                className="lp-btn lp-btn--primary lp-btn--sm"
                disabled={settlementBusy || currentPhase.slug === ""}
                onClick={() => void handleEnableSettlement(currentPhase.slug)}
              >
                {settlementBusy ? "Turning on…" : "Start collecting payment"}
              </button>
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <Link href="/flows" className="lp-btn lp-btn--primary lp-btn--sm">
              Watch it on your dashboard
            </Link>
            {currentPhase.slug && (
              <a
                href={`/a/${currentPhase.slug}`}
                className="lp-btn lp-btn--ghost lp-btn--sm"
                target="_blank"
                rel="noopener noreferrer"
              >
                View agent page →
              </a>
            )}
            {currentPhase.flowId && (
              <a
                href={`/build/${currentPhase.flowId}?from=guided`}
                className="lp-btn lp-btn--ghost lp-btn--sm"
              >
                Curious what&apos;s under the hood? Open it in Studio. Same agent,
                more knobs.
              </a>
            )}
          </div>
          <WorkspaceKeyCallout variant="guided" />
        </div>
      )}

      {currentPhase.kind === "saved" && (
        <div
          style={{
            background: "var(--surface-raised)",
            borderRadius: 12,
            padding: "1.25rem",
            border: "1px solid var(--border)",
          }}
        >
          <p style={{ fontWeight: 600, marginBottom: "0.75rem" }}>
            Saved in Guided. This is the same agent in Studio and Code.
          </p>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <a href={`/build/${encodeURIComponent(currentPhase.flowId)}`} className="lp-btn lp-btn--primary lp-btn--sm">
              Open in Studio
            </a>
            <a href={`/code/${encodeURIComponent(currentPhase.flowId)}`} className="lp-btn lp-btn--ghost lp-btn--sm">
              Open in Code
            </a>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <p id="guided-error" className="guided-error" role="alert">
          {error}
        </p>
      )}

      {/* Input — hidden after launch */}
      {currentPhase.kind !== "launched" && currentPhase.kind !== "saved" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void sendMessage(input);
          }}
          className="guided-form"
        >
          <label htmlFor="guided-job" className="guided-field-label">
            {history.length === 1 ? "Describe the job" : "Your answer"}
          </label>
          <div className="guided-controls">
            <input
              id="guided-job"
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Email me when this page's price drops"
              className="lp-input"
              aria-describedby={error ? "guided-error guided-hint" : "guided-hint"}
              disabled={
                currentPhase.kind === "drafting" ||
                currentPhase.kind === "launching" ||
                currentPhase.kind === "saving"
              }
            />
            <button
              type="submit"
              className="lp-btn lp-btn--primary"
              disabled={
                !input.trim() ||
                currentPhase.kind === "drafting" ||
                currentPhase.kind === "launching" ||
                currentPhase.kind === "saving"
              }
            >
              {history.length === 1 ? "Start guided build" : "Send answer"}
              <span aria-hidden="true">→</span>
            </button>
          </div>
          <p id="guided-hint" className="guided-hint">
            {deterministicBrain
              ? "These are the standard build questions. Workspaces with credit get an interview that reads your answers and asks only what your particular workflow needs."
              : "One sentence is enough. I'll ask only what the workflow needs."}
          </p>
        </form>
      )}
    </div>
  );
}

