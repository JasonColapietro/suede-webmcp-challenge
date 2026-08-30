"use client";

/**
 * Founding page — the description-first path to a company. Conversation UI
 * mirrors src/app/start/guided-client.tsx (bubbles, phase machine, drafting
 * indicator, review → confirm) adapted to company scope: a draft review
 * card (company fields, departments, employee manifests/triggers, budgets,
 * approval policy, notIncluded) instead of a single manifest card, and a
 * materialize step instead of a launch step.
 *
 * IMPORTANT: This file must NOT import from @/lib/company/guided or
 * @/lib/company/founding — both run server-side only (generateObject,
 * better-sqlite3 via the manifest → flow chain). Conversation/draft types
 * are duplicated inline, same as guided-client.tsx does for AgentManifest.
 *
 * Requires a signed-in identity (fetch /api/me) before drafting — founding
 * writes real rows under the caller's account, so sign-up precedes
 * drafting. The sign-in CTA below mirrors src/app/flows/dashboard.tsx's
 * signed-out row verbatim rather than building new auth UI.
 *
 * Inbound surfaces: linked internally from /fit (the fit guide's human
 * entry-points paragraph) and reached externally via the scan.suedeai.ai
 * hash handoff below. Not in SiteNav/SiteFooter by design; layout.tsx sets
 * noindex,follow.
 *
 * Seed capture: a scan handoff can deep-link here with
 * "#seed=<base64url JSON {domain, findings[]}>". On mount that hash is
 * decoded into sessionStorage (survives the sign-in round-trip, since the
 * tab returns to this origin) and used to prefill the composer.
 *
 * See docs/superpowers/plans/2026-07-17-autonomous-company-v1-plan.md,
 * Task 15.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import SiteNav from "@/components/site/SiteNav";
import SiteFooter from "@/components/site/SiteFooter";
import type { AgentManifest, ManifestTrigger } from "@/lib/manifest/schema";
import "../chrome.css";
import "../site.css";
import { signInUrl } from "@/lib/sign-in-url";

// ── Conversation types (mirrors src/lib/guided/draft.ts's ConversationTurn) ───

interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

// ── Draft types (structural mirror of src/lib/company/founding.ts) ───────────

interface CompanyDraftEmployee {
  slug: string;
  jobDescription: string;
  monthlyBudgetUsdc: number | null;
  publishGated: boolean;
  manifest: AgentManifest;
}

interface CompanyDraftDepartment {
  name: string;
  monthlyBudgetUsdc: number | null;
  employees: CompanyDraftEmployee[];
}

interface CompanyDraft {
  name: string;
  mission: string;
  departments: CompanyDraftDepartment[];
}

interface FoundingTurnResponse {
  clarifyingQuestion?: string | null;
  notIncluded?: string[];
  company?: CompanyDraft | null;
}

interface FoundingMaterializeResponse {
  companyId?: string;
  notIncluded?: string[];
}

// ── Seed handoff (scan report → founding) ──────────────────────────────────────

const SEED_STORAGE_KEY = "founding-seed";

interface FoundingSeed {
  domain: string;
  findings: string[];
}

function decodeBase64Url(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (padded.length % 4)) % 4;
  return atob(padded + "=".repeat(padLength));
}

function parseFoundingSeed(raw: string): FoundingSeed | null {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.domain !== "string" || !Array.isArray(candidate.findings)) return null;
  const findings = candidate.findings.filter((f): f is string => typeof f === "string");
  return { domain: candidate.domain, findings };
}

function buildSeedMessage(seed: FoundingSeed): string {
  const bullets = seed.findings.map((finding) => `- ${finding}`).join("\n");
  return `Found a company to work on these findings for ${seed.domain}:\n${bullets}`;
}

// ── Phase machine ──────────────────────────────────────────────────────────────

type Phase =
  | { kind: "chat" }
  | { kind: "drafting" }
  | {
      kind: "review";
      company: CompanyDraft;
      notIncluded: string[];
    }
  | { kind: "materializing" };

const WELCOME_MESSAGE =
  "Describe the company you want to found. I'll draft the departments and employees.";

const SIGN_IN_RETURN_URL = "https://agents.suedeai.ai/founding";

export default function FoundingPage(): React.JSX.Element {
  const router = useRouter();
  const [signedIn, setSignedIn] = useState<boolean | null>(null); // null = still checking
  const [history, setHistory] = useState<ConversationTurn[]>([
    { role: "assistant", content: WELCOME_MESSAGE },
  ]);
  const [input, setInput] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "chat" });
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Identity check — founding requires a signed-in owner.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/me");
        if (cancelled) return;
        if (!res.ok) {
          setSignedIn(false);
          return;
        }
        const data = (await res.json()) as { identity?: { signedIn?: boolean } };
        setSignedIn(Boolean(data.identity?.signedIn));
      } catch {
        if (!cancelled) setSignedIn(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Seed capture from a scan handoff hash, then prefill the composer from
  // any stored seed — this mount's write above, or one that survived the
  // sign-in round-trip from an earlier mount.
  useEffect(() => {
    const hash = window.location.hash;
    if (hash.startsWith("#seed=")) {
      try {
        const encoded = hash.slice("#seed=".length);
        const seed = parseFoundingSeed(decodeBase64Url(encoded));
        if (seed) sessionStorage.setItem(SEED_STORAGE_KEY, JSON.stringify(seed));
      } catch {
        // Tolerate decode failures silently — the hash is untrusted input.
      }
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }

    try {
      const stored = sessionStorage.getItem(SEED_STORAGE_KEY);
      if (stored) {
        const seed = parseFoundingSeed(stored);
        if (seed) setInput(buildSeedMessage(seed));
      }
    } catch {
      // Ignore malformed storage.
    }
  }, []);

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

    // The seed's only job is prefilling the composer — once any message
    // goes out, clear it so a later remount doesn't re-prefill it.
    if (history.length === 1) {
      try {
        sessionStorage.removeItem(SEED_STORAGE_KEY);
      } catch {
        // Best-effort.
      }
    }

    // history sent to the API excludes the welcome bubble and the message
    // itself — the route receives `message` separately and appends it
    // internally (mirrors src/app/start/guided-client.tsx).
    const priorHistory = history.filter(
      (turn) => !(turn.role === "assistant" && turn.content === WELCOME_MESSAGE),
    );
    setHistory((prev) => [...prev, { role: "user", content: message }]);
    setInput("");
    setPhase({ kind: "drafting" });

    try {
      const res = await fetch("/api/companies/found", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, history: priorHistory }),
      });

      if (res.status === 401) {
        setSignedIn(false);
        setPhase({ kind: "chat" });
        return;
      }

      if (res.status === 429) {
        const data = (await res.json()) as { retryAfterSec?: number };
        setError(`Too many requests. Try again in ${data.retryAfterSec ?? 60} seconds.`);
        setPhase({ kind: "chat" });
        return;
      }

      if (!res.ok) {
        setError("Something went wrong. Try again.");
        setPhase({ kind: "chat" });
        return;
      }

      const data = (await res.json()) as FoundingTurnResponse;

      if (typeof data.clarifyingQuestion === "string") {
        setHistory((prev) => [...prev, { role: "assistant", content: data.clarifyingQuestion! }]);
        setPhase({ kind: "chat" });
        return;
      }

      if (data.company) {
        setPhase({
          kind: "review",
          company: data.company,
          notIncluded: data.notIncluded ?? [],
        });
        return;
      }

      setError("Something went wrong. Try again.");
      setPhase({ kind: "chat" });
    } catch {
      setError("Something went wrong. Try again.");
      setPhase({ kind: "chat" });
    }
  }

  async function handleFound(review: Extract<Phase, { kind: "review" }>): Promise<void> {
    setError(null);
    setPhase({ kind: "materializing" });

    try {
      const res = await fetch("/api/companies/found", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          materialize: true,
          company: review.company,
          notIncluded: review.notIncluded,
        }),
      });

      if (res.status === 401) {
        setSignedIn(false);
        return;
      }

      if (res.status === 429) {
        const data = (await res.json()) as { retryAfterSec?: number };
        setError(`Too many requests. Try again in ${data.retryAfterSec ?? 60} seconds.`);
        setPhase(review);
        return;
      }

      if (!res.ok) {
        setError("Couldn't create the company. Try again.");
        setPhase(review);
        return;
      }

      const data = (await res.json()) as FoundingMaterializeResponse;
      if (!data.companyId) {
        setError("Couldn't create the company. Try again.");
        setPhase(review);
        return;
      }

      router.push(`/company?id=${encodeURIComponent(data.companyId)}`);
    } catch {
      setError("Couldn't create the company. Try again.");
      setPhase(review);
    }
  }

  function handleEditDescription(): void {
    // Discard the draft client-side; history (the exchange that produced
    // it) is retained so the next message keeps the same context.
    setPhase({ kind: "chat" });
  }

  function updateReviewedCompany(update: (company: CompanyDraft) => CompanyDraft): void {
    setPhase((current) =>
      current.kind === "review" ? { ...current, company: update(current.company) } : current,
    );
  }

  function updateDepartment(
    departmentIndex: number,
    update: Partial<Pick<CompanyDraftDepartment, "name" | "monthlyBudgetUsdc">>,
  ): void {
    updateReviewedCompany((company) => ({
      ...company,
      departments: company.departments.map((department, index) =>
        index === departmentIndex ? { ...department, ...update } : department,
      ),
    }));
  }

  function updateEmployee(
    departmentIndex: number,
    employeeIndex: number,
    update: Partial<
      Pick<CompanyDraftEmployee, "slug" | "jobDescription" | "monthlyBudgetUsdc" | "publishGated">
    >,
  ): void {
    updateReviewedCompany((company) => ({
      ...company,
      departments: company.departments.map((department, index) =>
        index === departmentIndex
          ? {
              ...department,
              employees: department.employees.map((employee, innerIndex) =>
                innerIndex === employeeIndex ? { ...employee, ...update } : employee,
              ),
            }
          : department,
      ),
    }));
  }

  function updateEmployeeManifest(
    departmentIndex: number,
    employeeIndex: number,
    update: Partial<Pick<AgentManifest, "name" | "description">>,
  ): void {
    updateReviewedCompany((company) => ({
      ...company,
      departments: company.departments.map((department, index) =>
        index === departmentIndex
          ? {
              ...department,
              employees: department.employees.map((employee, innerIndex) =>
                innerIndex === employeeIndex
                  ? { ...employee, manifest: { ...employee.manifest, ...update } }
                  : employee,
              ),
            }
          : department,
      ),
    }));
  }

  function updateEmployeeTrigger(
    departmentIndex: number,
    employeeIndex: number,
    triggerIndex: number,
    trigger: ManifestTrigger,
  ): void {
    updateReviewedCompany((company) => ({
      ...company,
      departments: company.departments.map((department, index) =>
        index === departmentIndex
          ? {
              ...department,
              employees: department.employees.map((employee, innerIndex) =>
                innerIndex === employeeIndex
                  ? {
                      ...employee,
                      manifest: {
                        ...employee.manifest,
                        triggers: employee.manifest.triggers.map((current, index) =>
                          index === triggerIndex ? trigger : current,
                        ),
                      },
                    }
                  : employee,
              ),
            }
          : department,
      ),
    }));
  }

  return (
    <div className="lp">
      <SiteNav active="/founding" />
      <main id="main-content" className="lp-shell lp-page">
        <header className="lp-page-head">
          <span className="lp-eyebrow">Founding</span>
          <h1>Found a company by describing it.</h1>
          <p>
            Describe what it should do. Review the departments and employees before anything runs
            or spends.
          </p>
        </header>

        {signedIn === null && <div className="lp-empty">Loading…</div>}

        {signedIn === false && (
          <section className="lp-block">
            <span className="lp-eyebrow">Sign in required</span>
            <div className="lp-rows">
              <div className="lp-row" style={{ cursor: "default", flexWrap: "wrap" }}>
                <div className="grow">
                  <div className="name">Sign in with Suede to found a company.</div>
                  <div className="sub">
                    Founding creates a company and its employees under your account, the same
                    Suede login as Suede Social and Suede Muse. Sign in and you&apos;ll land right back
                    here.
                  </div>
                </div>
                <div className="lp-row-actions">
                  <a
                    className="lp-btn lp-btn--primary"
                    href={signInUrl(SIGN_IN_RETURN_URL)}
                  >
                    Sign in with Suede
                  </a>
                </div>
              </div>
            </div>
          </section>
        )}

        {signedIn === true && (
          <div className="lp-block" style={{ maxWidth: 640, marginTop: "1.5rem" }}>
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
                      borderRadius: "var(--radius)",
                      background:
                        turn.role === "user" ? "var(--primary)" : "var(--surface-raised)",
                      color: turn.role === "user" ? "var(--primary-fg)" : "var(--text)",
                      fontSize: "var(--text-sm)",
                      lineHeight: 1.5,
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {turn.content}
                  </div>
                </div>
              ))}

              {phase.kind === "drafting" && (
                <div style={{ display: "flex", justifyContent: "flex-start" }}>
                  <div
                    className="lp-eyebrow"
                    role="status"
                    style={{
                      padding: "0.4rem 0.75rem",
                      background: "var(--surface-raised)",
                      borderRadius: "var(--radius)",
                    }}
                  >
                    Drafting your company…
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
            </div>

            {/* Review card — shown when a company draft is ready */}
            {phase.kind === "review" && (
              <div style={{ marginBottom: "1.5rem" }}>
                <p
                  style={{
                    fontSize: "var(--text-sm)",
                    marginBottom: "1rem",
                    fontWeight: 600,
                  }}
                >
                  Review your company. Nothing runs or spends until you say so.
                </p>

                <div className="lp-rows">
                  <div className="lp-row" style={{ cursor: "default", display: "block" }}>
                    <label className="guided-field-label" htmlFor="review-company-name">
                      Company name
                    </label>
                    <input
                      id="review-company-name"
                      className="lp-input"
                      value={phase.company.name}
                      onChange={(event) =>
                        updateReviewedCompany((company) => ({
                          ...company,
                          name: event.target.value,
                        }))
                      }
                    />
                    <label
                      className="guided-field-label"
                      htmlFor="review-company-mission"
                      style={{ marginTop: "0.75rem" }}
                    >
                      Mission
                    </label>
                    <textarea
                      id="review-company-mission"
                      className="lp-input"
                      rows={2}
                      value={phase.company.mission}
                      onChange={(event) =>
                        updateReviewedCompany((company) => ({
                          ...company,
                          mission: event.target.value,
                        }))
                      }
                    />
                    <div className="sub" style={{ marginTop: "0.75rem" }}>
                      Per-run cost approval threshold: not set in this founding draft. Configure it
                      in company governance after founding.
                    </div>
                  </div>
                </div>

                {phase.company.departments.map((department, di) => (
                  <div key={di} style={{ marginTop: "1.25rem" }}>
                    <span className="lp-eyebrow">Department {di + 1}</span>
                    <div className="lp-rows">
                      <div className="lp-row" style={{ cursor: "default", display: "block" }}>
                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                            gap: "0.75rem",
                          }}
                        >
                          <label className="guided-field-label">
                            Department name
                            <input
                              className="lp-input"
                              value={department.name}
                              onChange={(event) =>
                                updateDepartment(di, { name: event.target.value })
                              }
                            />
                          </label>
                          <label className="guided-field-label">
                            Department monthly cap (USDC)
                            <input
                              className="lp-input"
                              type="number"
                              min="0"
                              step="0.01"
                              placeholder="No cap"
                              value={department.monthlyBudgetUsdc ?? ""}
                              onChange={(event) => {
                                const value = event.target.value;
                                updateDepartment(di, {
                                  monthlyBudgetUsdc: value === "" ? null : Number(value),
                                });
                              }}
                            />
                          </label>
                        </div>
                      </div>
                      {department.employees.map((employee, ei) => (
                        <div
                          key={ei}
                          className="lp-row"
                          style={{ cursor: "default", display: "block" }}
                        >
                          <div className="lp-eyebrow" style={{ marginBottom: "0.5rem" }}>
                            Employee {ei + 1}
                          </div>
                          <div
                            style={{
                              display: "grid",
                              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                              gap: "0.75rem",
                            }}
                          >
                            <label className="guided-field-label">
                              Employee name
                              <input
                                className="lp-input"
                                value={employee.manifest.name}
                                onChange={(event) =>
                                  updateEmployeeManifest(di, ei, { name: event.target.value })
                                }
                              />
                            </label>
                            <label className="guided-field-label">
                              Service slug
                              <input
                                className="lp-input"
                                value={employee.slug}
                                onChange={(event) =>
                                  updateEmployee(di, ei, { slug: event.target.value })
                                }
                              />
                            </label>
                          </div>
                          <label
                            className="guided-field-label"
                            style={{ display: "block", marginTop: "0.75rem" }}
                          >
                            Job description
                            <textarea
                              className="lp-input"
                              rows={2}
                              value={employee.jobDescription}
                              onChange={(event) =>
                                updateEmployee(di, ei, { jobDescription: event.target.value })
                              }
                            />
                          </label>
                          <label
                            className="guided-field-label"
                            style={{ display: "block", marginTop: "0.75rem" }}
                          >
                            Service description
                            <textarea
                              className="lp-input"
                              rows={2}
                              value={employee.manifest.description}
                              onChange={(event) =>
                                updateEmployeeManifest(di, ei, { description: event.target.value })
                              }
                            />
                          </label>

                          <div className="sub" style={{ marginTop: "0.75rem" }}>
                            Steps: {employee.manifest.steps
                              .map((step) => step.label?.trim() || step.type)
                              .join(" → ")}
                          </div>

                          {employee.manifest.triggers.map((trigger, triggerIndex) => (
                            <div key={`${trigger.kind}-${triggerIndex}`} style={{ marginTop: "0.75rem" }}>
                              {trigger.kind === "schedule" && (
                                <label className="guided-field-label">
                                  Schedule (five-field UTC cron; disabled until explicitly enabled)
                                  <input
                                    className="lp-input"
                                    value={trigger.cron}
                                    onChange={(event) =>
                                      updateEmployeeTrigger(di, ei, triggerIndex, {
                                        ...trigger,
                                        cron: event.target.value,
                                      })
                                    }
                                  />
                                </label>
                              )}
                              {trigger.kind === "paidCall" && (
                                <label className="guided-field-label">
                                  Price per call (USDC; live selling remains off)
                                  <input
                                    className="lp-input"
                                    type="number"
                                    min="0"
                                    step="0.01"
                                    value={trigger.priceUsdc}
                                    onChange={(event) =>
                                      updateEmployeeTrigger(di, ei, triggerIndex, {
                                        ...trigger,
                                        priceUsdc: Math.max(0, Number(event.target.value) || 0),
                                      })
                                    }
                                  />
                                </label>
                              )}
                              {trigger.kind === "manual" && (
                                <div className="sub">Trigger: founder runs this employee manually.</div>
                              )}
                              {trigger.kind === "webhook" && (
                                <div className="sub">Trigger: webhook.</div>
                              )}
                            </div>
                          ))}

                          <label
                            className="guided-field-label"
                            style={{ display: "block", marginTop: "0.75rem" }}
                          >
                            Employee monthly cap (USDC)
                            <input
                              className="lp-input"
                              type="number"
                              min="0"
                              step="0.01"
                              placeholder="No cap"
                              value={employee.monthlyBudgetUsdc ?? ""}
                              onChange={(event) => {
                                const value = event.target.value;
                                updateEmployee(di, ei, {
                                  monthlyBudgetUsdc: value === "" ? null : Number(value),
                                });
                              }}
                            />
                          </label>
                          <label
                            style={{
                              display: "flex",
                              gap: "0.5rem",
                              alignItems: "center",
                              marginTop: "0.75rem",
                              minHeight: 44,
                              fontSize: "var(--text-sm)",
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={employee.publishGated}
                              onChange={(event) =>
                                updateEmployee(di, ei, { publishGated: event.target.checked })
                              }
                            />
                            Require founder approval before publishing
                          </label>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}

                {phase.notIncluded.length > 0 && (
                  <div style={{ marginTop: "1.25rem" }}>
                    <span className="lp-eyebrow">Not included</span>
                    <ul style={{ margin: "0.5rem 0 0", paddingLeft: "1.25rem" }}>
                      {phase.notIncluded.map((item, i) => (
                        <li
                          key={i}
                          style={{ fontSize: "var(--text-sm)", marginBottom: "0.35rem" }}
                        >
                          {item}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div
                  style={{
                    display: "flex",
                    gap: "0.75rem",
                    alignItems: "center",
                    marginTop: "1.5rem",
                  }}
                >
                  <button
                    type="button"
                    className="lp-btn lp-btn--primary"
                    onClick={() => void handleFound(phase)}
                  >
                    Found this company
                  </button>
                  <button
                    type="button"
                    className="lp-btn lp-btn--ghost lp-btn--sm"
                    onClick={handleEditDescription}
                  >
                    Edit description
                  </button>
                </div>
              </div>
            )}

            {/* Materializing indicator */}
            {phase.kind === "materializing" && (
              <div className="lp-eyebrow" style={{ marginBottom: "1rem" }}>
                Founding your company…
              </div>
            )}

            {/* Error */}
            {error && (
              <p id="founding-error" className="guided-error" role="alert">
                {error}
              </p>
            )}

            {/* Input — hidden while a review card is showing */}
            {phase.kind !== "review" && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void sendMessage(input);
                }}
                className="guided-form"
              >
                <label htmlFor="founding-message" className="guided-field-label">
                  {history.length === 1 ? "Describe the company" : "Your answer"}
                </label>
                <div className="guided-controls">
                  <textarea
                    id="founding-message"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void sendMessage(input);
                      }
                    }}
                    placeholder="A company that watches competitor pricing and drafts a weekly brief"
                    className="lp-input"
                    rows={3}
                    aria-describedby={error ? "founding-error founding-hint" : "founding-hint"}
                    disabled={phase.kind === "drafting" || phase.kind === "materializing"}
                  />
                  <button
                    type="submit"
                    className="lp-btn lp-btn--primary"
                    disabled={!input.trim() || phase.kind === "drafting" || phase.kind === "materializing"}
                  >
                    {history.length === 1 ? "Start founding" : "Send answer"}
                    <span aria-hidden="true">→</span>
                  </button>
                </div>
                <p id="founding-hint" className="guided-hint">
                  One sentence is enough. I&apos;ll ask only what the company needs, then show you
                  the draft before anything is created.
                </p>
              </form>
            )}
          </div>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
