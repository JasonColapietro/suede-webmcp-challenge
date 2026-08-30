"use client";

/**
 * "Paste your website, get an agent" client.
 *
 * Three states worth naming: the URL form, a read-back panel that shows
 * exactly what was pulled off the site before anything is launched, and the
 * launched confirmation. Showing the read-back is the point — the agent will
 * speak for this business to paying strangers, so its owner sees the source
 * pages and the extracted facts before they publish it.
 *
 * IMPORTANT: this file must NOT import from @/lib/manifest (from-flow,
 * to-flow, codegen pull viem/node:crypto), @/lib/flow/registry, node
 * executors, or @/lib/site/crawl. The client-safe pieces are
 * @/lib/site/blueprint-meta (pure data), @/lib/guided/review, and
 * @/lib/launch/manifest-graph.
 */

import { useId, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import WorkspaceKeyCallout from "@/components/WorkspaceKeyCallout";
import { buildReviewCards } from "@/lib/guided/review";
import { buildLaunchGraph, launchPriceUsdc } from "@/lib/launch/manifest-graph";
import { finishResourceSiteImport } from "@/components/resources/client";
import {
  BLUEPRINT_LIST,
  DEFAULT_BLUEPRINT,
  type SiteAgentBlueprint,
} from "@/lib/site/blueprint-meta";

// ── Inline transport types (mirror src/lib/site/* and manifest/schema.ts) ─────

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
  triggers: Array<
    | { kind: "manual" }
    | { kind: "schedule"; cron: string }
    | { kind: "paidCall"; priceUsdc: number }
    | { kind: "webhook" }
  >;
  steps: ManifestStep[];
  payoutAddress?: string;
  meta: { template?: string; createdBy?: "guided" | "studio" | "code" };
}

interface SiteProfileSummary {
  url: string;
  host: string;
  siteName: string;
  tagline: string;
  summary: string;
  offerings: string[];
  audience: string;
  tone: string;
  faqs: Array<{ question: string; answer: string }>;
  sources: Array<{ url: string; title: string }>;
  truncated: boolean;
  refined: boolean;
  knowledgeChars: number;
}

interface SiteAgentPricingSummary {
  estimatedTokens: number;
  estimatedCostUsdc: number;
  floorUsdc: number;
  suggestedUsdc: number;
  priceUsdc: number;
}

interface SiteAgentResponse {
  profile: SiteProfileSummary;
  pricing: SiteAgentPricingSummary;
  manifest: AgentManifest;
}

interface ReviewCardData {
  label: string;
  value: string;
}

/** Where the domain-ownership proof stands after launch. */
type VerifyState =
  | { kind: "loading" }
  | { kind: "ready"; token: string; url: string }
  | { kind: "checking"; token: string; url: string }
  | { kind: "failed"; token: string; url: string; reason: string }
  | { kind: "verified" }
  | { kind: "unavailable"; reason: string };

interface DraftContext {
  profile: SiteProfileSummary;
  pricing: SiteAgentPricingSummary;
  manifest: AgentManifest;
  cards: ReviewCardData[];
}

type Phase =
  | { kind: "form" }
  | { kind: "reading"; host: string }
  | ({ kind: "review" } & DraftContext)
  | ({ kind: "launching" } & DraftContext)
  | {
      kind: "launched";
      profile: SiteProfileSummary;
      slug: string;
      flowId: string;
      verify: VerifyState;
      /** Whether the agent is actually collecting USDC. Launch defaults OFF. */
      settlementLive: boolean;
      /** Server-provided payout caveat (lane contract; optional at runtime). */
      payoutWarning: string | null;
    };

function hostLabel(raw: string): string {
  const trimmed = raw.trim().replace(/^https?:\/\//i, "");
  const host = trimmed.split(/[/?#]/, 1)[0] ?? trimmed;
  return host === "" ? "that address" : host;
}

function priceLabel(value: number): string {
  return `$${value.toFixed(2)} per call`;
}

export default function SiteAgentClient(): React.JSX.Element {
  const router = useRouter();
  const urlFieldId = useId();
  const priceFieldId = useId();
  const walletFieldId = useId();
  const [url, setUrl] = useState("");
  const [blueprint, setBlueprint] = useState<SiteAgentBlueprint>(DEFAULT_BLUEPRINT);
  // Empty means "price it for me": the server derives the price from what a
  // call actually costs to run against this site's baked-in text.
  const [price, setPrice] = useState("");
  // Optional payout wallet so a priced launch routes USDC to the creator
  // instead of the platform fallback. Sent in the launch body when present.
  const [payoutWallet, setPayoutWallet] = useState("");
  const [settlementBusy, setSettlementBusy] = useState(false);
  const [foundryBusy, setFoundryBusy] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const [error, setError] = useState<string | null>(null);

  function chooseBlueprint(next: SiteAgentBlueprint): void {
    setBlueprint(next);
  }

  async function handleRead(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!url.trim()) return;
    setError(null);
    setPhase({ kind: "reading", host: hostLabel(url) });

    const parsedPrice = Number.parseFloat(price);
    const priceUsdc =
      price.trim() !== "" && Number.isFinite(parsedPrice) && parsedPrice >= 0
        ? parsedPrice
        : undefined;

    try {
      const response = await fetch("/api/site-agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: url.trim(),
          blueprint,
          ...(priceUsdc === undefined ? {} : { priceUsdc }),
        }),
      });

      if (response.status === 429) {
        const data = (await response.json()) as { retryAfterSec?: number };
        setError(`That's a lot of reading. Try again in ${data.retryAfterSec ?? 60} seconds.`);
        setPhase({ kind: "form" });
        return;
      }
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: unknown } | null;
        setError(
          typeof data?.error === "string" && response.status < 500
            ? data.error
            : "Couldn't read that site. Try again.",
        );
        setPhase({ kind: "form" });
        return;
      }

      const data = (await response.json()) as SiteAgentResponse;
      setPhase({
        kind: "review",
        profile: data.profile,
        pricing: data.pricing,
        manifest: data.manifest,
        cards: buildReviewCards(data.manifest),
      });
    } catch {
      setError("Couldn't read that site. Try again.");
      setPhase({ kind: "form" });
    }
  }

  /** Post-launch: get the domain-proof token so the owner can list the agent. */
  async function loadVerification(host: string): Promise<VerifyState> {
    try {
      const response = await fetch(`/api/site-agent/verify?host=${encodeURIComponent(host)}`);
      if (!response.ok) {
        return { kind: "unavailable", reason: "Verification isn't available right now." };
      }
      const data = (await response.json()) as { token?: string; url?: string; verified?: boolean };
      if (data.verified) return { kind: "verified" };
      if (typeof data.token !== "string" || typeof data.url !== "string") {
        return { kind: "unavailable", reason: "Verification isn't available right now." };
      }
      return { kind: "ready", token: data.token, url: data.url };
    } catch {
      return { kind: "unavailable", reason: "Verification isn't available right now." };
    }
  }

  async function handleVerify(host: string, current: VerifyState): Promise<void> {
    if (current.kind !== "ready" && current.kind !== "failed") return;
    const context = { token: current.token, url: current.url };
    setPhase((prev) =>
      prev.kind === "launched" ? { ...prev, verify: { kind: "checking", ...context } } : prev,
    );
    let next: VerifyState;
    try {
      const response = await fetch("/api/site-agent/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ host }),
      });
      const data = (await response.json().catch(() => null)) as
        | { verified?: boolean; reason?: string; error?: string }
        | null;
      if (response.ok && data?.verified) {
        next = { kind: "verified" };
      } else if (response.status === 503) {
        next = {
          kind: "unavailable",
          reason: data?.error ?? "Verification isn't available right now.",
        };
      } else {
        next = {
          kind: "failed",
          ...context,
          reason: data?.reason ?? data?.error ?? "That didn't verify. Check the file and try again.",
        };
      }
    } catch {
      next = { kind: "failed", ...context, reason: "That didn't verify. Check the file and try again." };
    }
    setPhase((prev) => (prev.kind === "launched" ? { ...prev, verify: next } : prev));
  }

  async function handleLaunch(context: DraftContext): Promise<void> {
    // Rebuild the draft explicitly: callers pass the whole review phase, and a
    // naive spread would carry its `kind` along and clobber the new one.
    const draft: DraftContext = {
      profile: context.profile,
      pricing: context.pricing,
      manifest: context.manifest,
      cards: context.cards,
    };
    const { profile, manifest } = draft;
    setPhase({ ...draft, kind: "launching" });
    setError(null);
    const backToReview = (): void => setPhase({ ...draft, kind: "review" });

    try {
      // Stamp the source host into graph meta: the catalog gate keys the
      // unlisted-until-verified rule on (site-agent template, siteHost).
      const graph = buildLaunchGraph(manifest, `site-${Date.now()}`);
      graph.meta = { ...graph.meta, siteHost: profile.host };

      const createRes = await fetch("/api/flows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: manifest.name,
          graph,
        }),
      });
      if (!createRes.ok) {
        setError("Couldn't save the agent. Try again.");
        backToReview();
        return;
      }

      const createData = (await createRes.json()) as { flow?: { id?: string } };
      const flowId = createData.flow?.id;
      if (!flowId) {
        setError("Couldn't save the agent. Try again.");
        backToReview();
        return;
      }

      // Launch with the FLOW ROW id, never the graph id (Supabase FK landmine).
      const trimmedWallet = payoutWallet.trim();
      const launchRes = await fetch(`/api/flows/${flowId}/launch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          priceUsdc: launchPriceUsdc(manifest),
          ...(trimmedWallet !== "" ? { payoutAddress: trimmedWallet } : {}),
        }),
      });
      if (!launchRes.ok) {
        const launchBody = (await launchRes.json().catch(() => null)) as { error?: unknown } | null;
        setError(
          typeof launchBody?.error === "string"
            ? `Couldn't launch: ${launchBody.error}`
            : "Agent saved but couldn't launch. Open it in Studio to launch.",
        );
        backToReview();
        return;
      }

      // Defensive read: settlementLive/payoutWarning are a newer launch
      // contract, optional at runtime. Settlement defaults OFF for fresh
      // launches, so an absent flag reads as false.
      const launchRaw: unknown = await launchRes.json();
      const launchData =
        typeof launchRaw === "object" && launchRaw !== null
          ? (launchRaw as Record<string, unknown>)
          : {};
      setPhase({
        kind: "launched",
        profile,
        slug: typeof launchData.slug === "string" ? launchData.slug : "",
        flowId,
        verify: { kind: "loading" },
        settlementLive: launchData.settlementLive === true,
        payoutWarning:
          typeof launchData.payoutWarning === "string" && launchData.payoutWarning !== ""
            ? launchData.payoutWarning
            : null,
      });
      const verify = await loadVerification(profile.host);
      setPhase((prev) => (prev.kind === "launched" ? { ...prev, verify } : prev));
    } catch {
      setError("Something went wrong during launch. Try again.");
      backToReview();
    }
  }

  async function handleContinueFoundry(context: DraftContext): Promise<void> {
    if (foundryBusy) return;
    setFoundryBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/v2/resources/import/site-agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: context.profile.url,
          name: `${context.profile.siteName} resource`,
          sourceUrls: context.profile.sources.map((source) => source.url),
          suggestedJob: context.manifest.description,
          priceUsdc: launchPriceUsdc(context.manifest),
        }),
      });
      const raw: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setError("Couldn't create the Resource Foundry draft. Try again.");
        return;
      }
      const data = finishResourceSiteImport(raw, window.sessionStorage);
      router.push(data.redirectTo);
    } catch {
      setError("Couldn't create the Resource Foundry draft. Try again.");
    } finally {
      setFoundryBusy(false);
    }
  }

  /** One-click post-launch opt-in: flip the agent's settlement switch on. */
  async function handleEnableSettlement(slug: string): Promise<void> {
    if (settlementBusy || slug === "") return;
    setSettlementBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(slug)}/settlement`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ live: true }),
      });
      if (!response.ok) {
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

  const busy = phase.kind === "reading" || phase.kind === "launching";

  return (
    <div className="lp-block" style={{ maxWidth: 720, marginTop: 0 }}>
      {(phase.kind === "form" || phase.kind === "reading") && (
        <form onSubmit={(event) => void handleRead(event)} className="guided-form">
          <label htmlFor={urlFieldId} className="guided-field-label">
            Your website
          </label>
          <div className="guided-controls">
            <input
              id={urlFieldId}
              type="text"
              inputMode="url"
              autoComplete="url"
              spellCheck={false}
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="acme.com"
              className="lp-input"
              aria-describedby={error ? `${urlFieldId}-error ${urlFieldId}-hint` : `${urlFieldId}-hint`}
              disabled={busy}
            />
            <button type="submit" className="lp-btn lp-btn--primary" disabled={busy || !url.trim()}>
              {phase.kind === "reading" ? "Reading…" : "Read my site"}
              <span aria-hidden="true">→</span>
            </button>
          </div>
          <p id={`${urlFieldId}-hint`} className="guided-hint">
            Public pages only. Suede reads your home page and up to five more, obeys your
            robots.txt, and shows you everything it found before anything goes live.
          </p>

          <fieldset className="site-agent-picker">
            <legend className="lp-eyebrow">What should it do?</legend>
            <div className="lp-rows">
              {BLUEPRINT_LIST.map((option) => (
                <label
                  key={option.id}
                  className={`lp-row site-agent-option${blueprint === option.id ? " is-selected" : ""}`}
                >
                  <input
                    type="radio"
                    name="site-agent-blueprint"
                    value={option.id}
                    checked={blueprint === option.id}
                    onChange={() => chooseBlueprint(option.id)}
                    disabled={busy}
                  />
                  <span className="grow">
                    <span className="name">{option.label}</span>
                    <span className="sub">{option.pitch}</span>
                  </span>
                  <span className="lp-pill lp-pill--price tabular">
                    from ${option.suggestedPriceUsdc.toFixed(2)}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="site-agent-price">
            <label htmlFor={priceFieldId} className="guided-field-label">
              Price per call (USDC)
            </label>
            <input
              id={priceFieldId}
              type="number"
              min={0}
              step={0.01}
              value={price}
              placeholder="Auto"
              onChange={(event) => setPrice(event.target.value)}
              className="lp-input tabular"
              disabled={busy}
            />
            <p className="guided-hint">
              Leave blank and Suede prices it from what a call actually costs to run against
              your site&apos;s text. Name your own number and it still never drops below that
              cost, so no call can lose you money.
            </p>
          </div>

          <div className="site-agent-price">
            <label htmlFor={walletFieldId} className="guided-field-label">
              Payout wallet (USDC on Base)
            </label>
            <input
              id={walletFieldId}
              type="text"
              value={payoutWallet}
              placeholder="0x wallet that collects your earnings"
              onChange={(event) => setPayoutWallet(event.target.value)}
              className="lp-input"
              spellCheck={false}
              disabled={busy}
            />
            <p className="guided-hint">
              Optional now, required to get paid: paid calls route USDC to this wallet. Skip
              it and you can add one later in Studio, but earnings can&apos;t reach you until
              you do.
            </p>
          </div>

          {phase.kind === "reading" && (
            <div className="site-agent-reading" role="status">
              <span className="site-agent-reading-dot" aria-hidden="true" />
              <span className="site-agent-reading-title">Reading {phase.host}</span>
              <span className="site-agent-reading-sub">
                Home page first, then up to five more. You see every page it read and approve
                the draft before anything goes live.
              </span>
            </div>
          )}
        </form>
      )}

      {(phase.kind === "review" || phase.kind === "launching") && (
        <>
          <section className="site-agent-readback">
            <h2 className="lp-eyebrow">What Suede read on {phase.profile.host}</h2>
            <p className="site-agent-name">{phase.profile.siteName}</p>
            {phase.profile.tagline && <p className="site-agent-tagline">{phase.profile.tagline}</p>}
            {phase.profile.summary && <p className="site-agent-summary">{phase.profile.summary}</p>}

            {phase.profile.offerings.length > 0 && (
              <div className="site-agent-chips">
                {phase.profile.offerings.map((offering) => (
                  <span key={offering} className="lp-pill">
                    {offering}
                  </span>
                ))}
              </div>
            )}

            <dl className="site-agent-facts">
              {phase.profile.audience && (
                <div>
                  <dt>Who it serves</dt>
                  <dd>{phase.profile.audience}</dd>
                </div>
              )}
              {phase.profile.tone && (
                <div>
                  <dt>How it sounds</dt>
                  <dd>{phase.profile.tone}</dd>
                </div>
              )}
              <div>
                <dt>Pages read</dt>
                <dd>
                  {phase.profile.sources.length}{" "}
                  {phase.profile.sources.length === 1 ? "page" : "pages"},{" "}
                  {phase.profile.knowledgeChars.toLocaleString()} characters
                </dd>
              </div>
            </dl>

            {/* Open by default: showing every page it read is the product's
                honesty guarantee, not a footnote. */}
            <details className="site-agent-sources" open>
              <summary>Every page it read</summary>
              <ul>
                {phase.profile.sources.map((source) => (
                  <li key={source.url}>
                    <a href={source.url} target="_blank" rel="noopener noreferrer nofollow">
                      {source.title || source.url}
                    </a>
                  </li>
                ))}
              </ul>
            </details>

            {phase.profile.truncated && (
              <p className="site-agent-note">
                Your site is bigger than one read. The agent answers from the pages above and says
                it doesn&apos;t know when a question falls outside them.
              </p>
            )}

            {!phase.profile.refined && (
              <p className="site-agent-note">
                This draft is built straight from your pages. Workspaces with credit also get a
                model read of the site: who you serve, how you sound, your real product names, and
                the questions your pages already answer. Top up once and re-read to get it.
              </p>
            )}
          </section>

          <p className="site-agent-note">
            Priced at {priceLabel(phase.pricing.priceUsdc)}. A call moves about{" "}
            {phase.pricing.estimatedTokens.toLocaleString()} tokens of your site through the
            model, costing roughly ${phase.pricing.estimatedCostUsdc.toFixed(3)}. The price
            never drops below that, so every call keeps you above water.
          </p>

          <p className="site-agent-lead">Here&apos;s your agent. Plain English, no surprises.</p>
          <div className="guided-review-grid">
            {phase.cards.map((card) => (
              <div key={card.label} className="guided-review-card">
                <div className="lp-eyebrow" style={{ marginBottom: "0.25rem", fontSize: "0.68rem" }}>
                  {card.label}
                </div>
                <div style={{ fontSize: "var(--text-sm)" }}>{card.value}</div>
              </div>
            ))}
          </div>

          <div className="guided-review-actions">
            <button
              className="lp-btn lp-btn--primary"
              disabled={busy}
              onClick={() => void handleLaunch(phase)}
            >
              {phase.kind === "launching"
                ? "Launching…"
                : `Launch it at ${priceLabel(launchPriceUsdc(phase.manifest))}`}
            </button>
            <button
              type="button"
              className="lp-btn lp-btn--ghost"
              disabled={busy || foundryBusy}
              onClick={() => void handleContinueFoundry(phase)}
            >
              {foundryBusy ? "Creating Foundry draft…" : "Continue in Resource Foundry"}
            </button>
            <button
              className="lp-btn lp-btn--ghost lp-btn--sm"
              disabled={busy}
              onClick={() => {
                setError(null);
                setPhase({ kind: "form" });
              }}
            >
              Read a different page
            </button>
          </div>
          <p className="site-agent-note">
            Resource Foundry re-reads these public URLs through the same bounded safety rules and
            creates a private draft only. It does not publish or treat domain verification as source rights.
          </p>
        </>
      )}

      {phase.kind === "launched" && (
        <div className="site-agent-launched">
          <p className="site-agent-launched-head">
            {phase.profile.siteName} is live as an agent: another seat on your org chart,
            answering while you&apos;re not here.
          </p>
          {phase.payoutWarning && (
            <p className="site-agent-note" role="status" style={{ color: "var(--text-warning)" }}>
              {phase.payoutWarning}
            </p>
          )}
          {phase.settlementLive ? (
            <p className="site-agent-note" style={{ color: "var(--text-success)" }}>
              Settlement is on: every paid call collects USDC.
            </p>
          ) : (
            <div style={{ margin: "0.5rem 0 0.75rem" }}>
              <p className="site-agent-note">
                Calls are free previews until you turn on settlement.
              </p>
              <button
                type="button"
                className="lp-btn lp-btn--primary lp-btn--sm"
                disabled={settlementBusy || phase.slug === ""}
                onClick={() => void handleEnableSettlement(phase.slug)}
              >
                {settlementBusy ? "Turning on…" : "Start collecting payment"}
              </button>
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <Link href="/flows" className="lp-btn lp-btn--primary lp-btn--sm">
              Watch it on your dashboard
            </Link>
            {phase.slug && (
              <a
                href={`/a/${phase.slug}`}
                className="lp-btn lp-btn--ghost lp-btn--sm"
                target="_blank"
                rel="noopener noreferrer"
              >
                View its public page →
              </a>
            )}
            <a href={`/build/${phase.flowId}`} className="lp-btn lp-btn--ghost lp-btn--sm">
              Open it in Studio to change what it says
            </a>
          </div>

          <section className="site-agent-verify" aria-live="polite">
            {phase.verify.kind === "verified" ? (
              <p className="site-agent-verify-done">
                {phase.profile.host} is verified as yours. This agent is listed in the public
                directory.
              </p>
            ) : phase.verify.kind === "unavailable" ? (
              <p className="site-agent-note">
                It&apos;s reachable at its own link but not listed in the public directory yet.{" "}
                {phase.verify.reason}
              </p>
            ) : phase.verify.kind === "loading" ? (
              <p className="site-agent-note">Checking whether {phase.profile.host} is verified…</p>
            ) : (
              <>
                <p className="site-agent-verify-head">
                  One step left to get it listed: prove {phase.profile.host} is yours.
                </p>
                <p className="site-agent-note">
                  Anyone can read a public site, so the agent stays out of the public directory
                  until you claim the domain. Put a plain-text file at{" "}
                  <code className="site-agent-code">{phase.verify.url}</code> containing exactly
                  this line, then verify:
                </p>
                <code className="site-agent-code site-agent-token">{phase.verify.token}</code>
                {phase.verify.kind === "failed" && (
                  <p className="guided-error" role="alert">
                    {phase.verify.reason}
                  </p>
                )}
                <div className="guided-review-actions">
                  <button
                    className="lp-btn lp-btn--primary lp-btn--sm"
                    disabled={phase.verify.kind === "checking"}
                    onClick={() => void handleVerify(phase.profile.host, phase.verify)}
                  >
                    {phase.verify.kind === "checking" ? "Checking your site…" : "I placed the file. Verify it"}
                  </button>
                </div>
              </>
            )}
          </section>

          <WorkspaceKeyCallout variant="guided" />
        </div>
      )}

      {error && (
        <p id={`${urlFieldId}-error`} className="guided-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
