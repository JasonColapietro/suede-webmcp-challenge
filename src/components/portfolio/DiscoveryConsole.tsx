"use client";

/**
 * Per-agent discovery console. Renders three blocks — readiness, get-discovered
 * venues, and recorded listings — from the /api/agents/[slug]/discovery route.
 *
 * Client/server boundary: this file must NOT import payloads.ts or readiness.ts
 * (both server-only). Every value comes from the API response. It may import the
 * pure-data venues module for its types.
 */
import { useCallback, useEffect, useState } from "react";
import type { DiscoveryVenue, VenueMechanism } from "@/lib/distribution/venues";

type ReadinessState = "pass" | "fail" | "na" | "info";

interface ReadinessCheck {
  id: string;
  label: string;
  state: ReadinessState;
  detail: string;
  fix?: string;
}

interface ReadinessReport {
  agentId: string;
  slug: string;
  protocolVersion: number;
  checks: ReadinessCheck[];
}

interface AgentListing {
  id: string;
  agentId: string;
  venueId: string;
  status: "submitted" | "listed" | "failed" | "pending";
  externalUrl: string | null;
  submittedAt: string;
  updatedAt: string;
}

interface DiscoveryPayloads {
  serviceDescriptor: Record<string, unknown>;
  x402scoutRegister: Record<string, unknown> | null;
  satring: { url: string; requiresPaymentV2: boolean; costUsdc: number; body: Record<string, unknown> | null };
  awesomeListLine: string;
  discoveryIssue: string;
  agenticMarketOutreach: string;
  payshYaml: string;
}

interface DiscoveryData {
  agentId: string;
  slug: string;
  readiness: ReadinessReport;
  venues: DiscoveryVenue[];
  listings: AgentListing[];
  payloads: DiscoveryPayloads;
}

const SETTLEMENT_DOC = "/docs/payments#free";

const MECHANISM_GROUPS: { mechanism: VenueMechanism; label: string }[] = [
  { mechanism: "push-free", label: "One click" },
  { mechanism: "push-github", label: "Opens a GitHub PR / issue" },
  { mechanism: "auto", label: "Automatic, nothing to submit" },
  { mechanism: "paid", label: "Paid, needs your approval" },
  { mechanism: "manual", label: "Manual, copy and send" },
];

function stateColor(state: ReadinessState): string {
  if (state === "pass") return "var(--text-success)";
  if (state === "fail") return "var(--rights-red)";
  return "var(--text-muted)";
}

function stateGlyph(state: ReadinessState): string {
  if (state === "pass") return "✓";
  if (state === "fail") return "✕";
  if (state === "na") return "—";
  return "•";
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** The generated draft a manual/paid/github venue reveals, or null. */
function draftFor(venue: DiscoveryVenue, payloads: DiscoveryPayloads): string | null {
  switch (venue.id) {
    case "satring":
      return payloads.satring.body ? JSON.stringify(payloads.satring.body, null, 2) : null;
    case "paysh":
      return payloads.payshYaml;
    case "agentic-market":
      return payloads.agenticMarketOutreach;
    case "x402-index-discovery":
      return payloads.discoveryIssue;
    case "awesome-x402-xpaysh":
    case "awesome-x402-index":
      return payloads.awesomeListLine;
    default:
      return null;
  }
}

export function DiscoveryConsole({ slug }: { agentId: string; slug: string }) {
  const [data, setData] = useState<DiscoveryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyVenue, setBusyVenue] = useState<string | null>(null);
  const [venueError, setVenueError] = useState<Record<string, string>>({});
  const [openDraft, setOpenDraft] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(slug)}/discovery`, {
        cache: "no-store",
      });
      if (!res.ok) {
        setError("Couldn't load discovery status.");
        return;
      }
      setData((await res.json()) as DiscoveryData);
    } catch {
      setError("Couldn't load discovery status.");
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = useCallback(
    async (venueId: string) => {
      setBusyVenue(venueId);
      setVenueError((prev) => {
        const next = { ...prev };
        delete next[venueId];
        return next;
      });
      try {
        const res = await fetch(`/api/agents/${encodeURIComponent(slug)}/discovery/submit`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ venue: venueId }),
        });
        const body = (await res.json().catch(() => ({}))) as {
          status?: string;
          externalUrl?: string | null;
          error?: string;
          reason?: string;
        };
        if (res.ok && body.status) {
          const now = new Date().toISOString();
          setData((prev) =>
            prev
              ? {
                  ...prev,
                  listings: [
                    {
                      id: `${prev.agentId}:${venueId}`,
                      agentId: prev.agentId,
                      venueId,
                      status: body.status as AgentListing["status"],
                      externalUrl: body.externalUrl ?? null,
                      submittedAt: now,
                      updatedAt: now,
                    },
                    ...prev.listings.filter((l) => l.venueId !== venueId),
                  ],
                }
              : prev,
          );
        } else {
          setVenueError((prev) => ({
            ...prev,
            [venueId]: messageForError(res.status, body.error, body.reason),
          }));
        }
      } catch {
        setVenueError((prev) => ({ ...prev, [venueId]: "Network error. Try again." }));
      } finally {
        setBusyVenue(null);
      }
    },
    [slug],
  );

  const copyDraft = useCallback(async (venueId: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(venueId);
      window.setTimeout(() => setCopied((c) => (c === venueId ? null : c)), 1800);
    } catch {
      // Clipboard denied — the textarea below still lets them select manually.
    }
  }, []);

  if (loading) {
    return (
      <section className="card p-5">
        <p className="eyebrow mb-1">Get discovered</p>
        <p className="lp-loading">Loading…</p>
      </section>
    );
  }
  if (error || !data) {
    return (
      <section className="card p-5">
        <p className="eyebrow mb-2">Get discovered</p>
        <p style={{ color: "var(--rights-red)", fontSize: "var(--text-sm)" }}>
          {error ?? "No discovery data."}
        </p>
        <button type="button" onClick={() => void load()} className="lp-btn lp-btn--ghost lp-btn--sm mt-3">
          Retry
        </button>
      </section>
    );
  }

  const listingByVenue = new Map(data.listings.map((l) => [l.venueId, l]));

  return (
    <section className="flex flex-col gap-6" id="discovery" aria-label="Discovery">
      {/* Block 1 — Readiness */}
      <div className="card p-5">
        <div className="mb-4 flex flex-col gap-1">
          <p className="eyebrow">Discovery readiness</p>
          <p style={{ color: "var(--text-muted)", fontSize: "var(--text-xs)" }}>
            What the studio can verify about this agent&apos;s discovery surface. Facts only: an
            external index accepting your listing is not shown here.
          </p>
        </div>
        <ul className="flex flex-col" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {data.readiness.checks.map((check) => (
            <li
              key={check.id}
              className="flex items-start gap-3 py-2.5"
              style={{ borderTop: "1px solid var(--hairline-visible)" }}
            >
              <span
                aria-hidden="true"
                className="mono"
                style={{ color: stateColor(check.state), fontSize: "var(--text-sm)", lineHeight: 1.5, width: 14 }}
              >
                {stateGlyph(check.state)}
              </span>
              <div className="flex flex-col gap-0.5">
                <span style={{ fontSize: "var(--text-sm)", color: "var(--text-primary)", fontWeight: 500 }}>
                  {check.label}
                </span>
                <span style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)", lineHeight: 1.5 }}>
                  {check.detail}
                </span>
                {check.state === "fail" && check.fix ? (
                  <span style={{ fontSize: "var(--text-xs)", color: "var(--text-warning)", lineHeight: 1.5 }}>
                    {check.fix}
                    {check.id === "settlement_ready" ? (
                      <>
                        {" "}
                        <a href={SETTLEMENT_DOC} className="mono no-underline" style={{ color: "var(--primary)" }}>
                          How settlement works ↗
                        </a>
                      </>
                    ) : null}
                  </span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </div>

      {/* Block 2 — Get discovered */}
      <div className="card p-5">
        <div className="mb-4 flex flex-col gap-1">
          <p className="eyebrow">Get discovered</p>
          <p style={{ color: "var(--text-muted)", fontSize: "var(--text-xs)" }}>
            Where other agents find this one. Each venue states its real mechanism, and no venue is
            promised a one-click publish it doesn&apos;t support.
          </p>
        </div>
        <div className="flex flex-col gap-5">
          {MECHANISM_GROUPS.map((group) => {
            const venues = data.venues.filter((v) => v.mechanism === group.mechanism);
            if (venues.length === 0) return null;
            return (
              <div key={group.mechanism} className="flex flex-col gap-2">
                <p className="eyebrow" style={{ color: "var(--text-muted)" }}>
                  {group.label}
                </p>
                {venues.map((venue) => {
                  const listing = listingByVenue.get(venue.id);
                  const draft = draftFor(venue, data.payloads);
                  const isOpen = openDraft === venue.id;
                  return (
                    <div
                      key={venue.id}
                      className="flex flex-col gap-2 rounded-lg p-3.5"
                      style={{ border: "1px solid var(--hairline)" }}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="flex flex-col gap-0.5" style={{ minWidth: 0 }}>
                          <a
                            href={venue.url}
                            target="_blank"
                            rel="noreferrer"
                            className="no-underline"
                            style={{ fontSize: "var(--text-sm)", color: "var(--text-primary)", fontWeight: 500 }}
                          >
                            {venue.name} <span aria-hidden="true" style={{ color: "var(--text-muted)" }}>↗</span>
                          </a>
                          <span style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)", lineHeight: 1.5 }}>
                            {venue.status}
                          </span>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {listing ? <ListingBadge status={listing.status} /> : null}
                          {(venue.mechanism === "push-free" || venue.mechanism === "push-github") ? (
                            <button
                              type="button"
                              onClick={() => void submit(venue.id)}
                              disabled={busyVenue === venue.id}
                              className="lp-btn lp-btn--primary lp-btn--sm"
                            >
                              {busyVenue === venue.id ? "Submitting…" : listing ? "Resubmit" : "Submit"}
                            </button>
                          ) : null}
                          {venue.id === "bazaar" ? (
                            <a href={SETTLEMENT_DOC} className="lp-btn lp-btn--ghost lp-btn--sm">
                              Enable settlement ↗
                            </a>
                          ) : null}
                          {draft ? (
                            <button
                              type="button"
                              onClick={() => setOpenDraft((c) => (c === venue.id ? null : venue.id))}
                              className="lp-btn lp-btn--ghost lp-btn--sm"
                            >
                              {isOpen ? "Hide draft" : "Copy draft"}
                            </button>
                          ) : null}
                        </div>
                      </div>

                      {venue.mechanism === "paid" ? (
                        <p style={{ fontSize: "var(--text-xs)", color: "var(--text-warning)", lineHeight: 1.5 }}>
                          Blocked: paid listing ({venue.costUsdc?.toFixed(2)} USDC) needs your explicit
                          payment approval. Spending is never automated. Send the draft yourself.
                        </p>
                      ) : null}

                      {venueError[venue.id] ? (
                        <p style={{ fontSize: "var(--text-xs)", color: "var(--rights-red)", lineHeight: 1.5 }}>
                          {venueError[venue.id]}
                        </p>
                      ) : null}

                      {isOpen && draft ? (
                        <div className="flex flex-col gap-2">
                          <textarea
                            readOnly
                            value={draft}
                            rows={Math.min(14, draft.split("\n").length + 1)}
                            onFocus={(e) => e.currentTarget.select()}
                            className="mono"
                            style={{
                              width: "100%",
                              resize: "vertical",
                              fontSize: "var(--text-xs)",
                              lineHeight: 1.5,
                              padding: 10,
                              borderRadius: "var(--radius-sm)",
                              border: "1px solid var(--hairline)",
                              background: "var(--canvas-bg)",
                              color: "var(--text-primary)",
                            }}
                          />
                          <div className="flex items-center gap-3">
                            <button
                              type="button"
                              onClick={() => void copyDraft(venue.id, draft)}
                              className="lp-btn lp-btn--ghost lp-btn--sm"
                            >
                              {copied === venue.id ? "Copied" : "Copy to clipboard"}
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {/* Block 3 — Listings */}
      <div className="card p-5">
        <p className="eyebrow mb-3">Recorded submissions</p>
        {data.listings.length === 0 ? (
          <p style={{ color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>
            No submissions recorded yet. Use the one-click venues above to record your first.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full" style={{ borderCollapse: "collapse", minWidth: 420 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--hairline)" }}>
                  <th className="px-1 py-2 text-left"><span className="eyebrow">Venue</span></th>
                  <th className="px-1 py-2 text-left"><span className="eyebrow">Status</span></th>
                  <th className="px-1 py-2 text-right"><span className="eyebrow">Submitted</span></th>
                  <th className="px-1 py-2 text-right"><span className="eyebrow">Link</span></th>
                </tr>
              </thead>
              <tbody>
                {data.listings.map((l) => {
                  const venue = data.venues.find((v) => v.id === l.venueId);
                  return (
                    <tr key={l.venueId} style={{ borderBottom: "1px solid var(--hairline-visible)" }}>
                      <td className="px-1 py-2.5" style={{ fontSize: "var(--text-sm)" }}>
                        {venue?.name ?? l.venueId}
                      </td>
                      <td className="px-1 py-2.5"><ListingBadge status={l.status} /></td>
                      <td className="px-1 py-2.5 text-right tabular" data-numeric style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
                        {formatDate(l.submittedAt)}
                      </td>
                      <td className="px-1 py-2.5 text-right">
                        {l.externalUrl ? (
                          <a href={l.externalUrl} target="_blank" rel="noreferrer" className="mono no-underline" style={{ color: "var(--primary)", fontSize: "var(--text-xs)" }}>
                            open ↗
                          </a>
                        ) : (
                          <span style={{ color: "var(--text-muted)", fontSize: "var(--text-xs)" }}>—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function ListingBadge({ status }: { status: AgentListing["status"] }) {
  const color =
    status === "listed" || status === "submitted"
      ? "var(--text-success)"
      : status === "failed"
        ? "var(--rights-red)"
        : "var(--text-muted)";
  return (
    <span className="mono" style={{ fontSize: "var(--text-label)", color, whiteSpace: "nowrap" }}>
      {status}
    </span>
  );
}

function messageForError(httpStatus: number, error?: string, reason?: string): string {
  if (error === "NO_PAYOUT_WALLET") return "Add a payout wallet before submitting.";
  if (error === "github_automation_not_configured") {
    return "GitHub automation isn't configured yet. Use Copy draft and open the PR/issue manually.";
  }
  if (httpStatus === 409 && reason) return `Not push-able here: ${reason.replace(/_/g, " ")}.`;
  if (error) return error.replace(/_/g, " ");
  return `Submission failed (HTTP ${httpStatus}).`;
}
