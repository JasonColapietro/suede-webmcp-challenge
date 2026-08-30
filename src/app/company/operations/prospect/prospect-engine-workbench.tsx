"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  EphemeralPlaceCandidateSchema,
  ProspectRecordSchema,
  type EphemeralPlaceCandidate,
  type ProspectAction,
  type ProspectRecord,
} from "@/lib/company/prospect-engine/contracts";

interface DeliveryHandoff {
  readonly mailtoUrl: string | null;
  readonly approvalDigest: string;
  readonly handoffDigest: string;
  readonly createdAt: string;
  readonly idempotencyKey: string;
  readonly copyFallback: { readonly recipientEmail: string; readonly subject: string; readonly body: string };
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function field(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function preparedRepairText(record: ProspectRecord): string | undefined {
  if (record.repair) return record.repair.preparedRepair;
  const repair = record.audit?.handoff.findings.find((finding) => finding.preparedRepair)?.preparedRepair;
  if (!repair) return undefined;
  return `Replace ${repair.before} with ${repair.after}. ${repair.instruction}`;
}

function preparedVerificationText(record: ProspectRecord): string | undefined {
  if (record.repair) return record.repair.verificationStep;
  return record.audit?.handoff.findings.find((finding) => finding.preparedRepair)
    ?.preparedRepair?.verification.join(" ");
}

export default function ProspectEngineWorkbench(): React.JSX.Element {
  const [prospects, setProspects] = useState<ProspectRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<EphemeralPlaceCandidate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [handoff, setHandoff] = useState<DeliveryHandoff | null>(null);
  const [handoffRequestKey, setHandoffRequestKey] = useState<string | null>(null);

  const selected = prospects.find((prospect) => prospect.id === selectedId) ?? prospects[0] ?? null;
  const selectedDraft = selected?.draft ?? null;
  const canBuildDraft = selected?.stage === "repair_ready"
    || selected?.stage === "draft_ready"
    || selected?.stage === "approved";

  const load = useCallback(async (): Promise<void> => {
    const response = await fetch("/api/companies/prospects", { cache: "no-store" });
    const json = await responseJson(response);
    if (!response.ok) throw new Error(typeof json.error === "string" ? json.error : "Could not load prospects.");
    const parsed = ProspectRecordSchema.array().safeParse(json.prospects);
    if (!parsed.success) throw new Error("Prospect queue returned an invalid response.");
    setProspects(parsed.data);
    setSelectedId((current) => current ?? parsed.data[0]?.id ?? null);
  }, []);

  useEffect(() => { void load().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Could not load prospects.")); }, [load]);

  async function mutate(path: string, body: unknown): Promise<Record<string, unknown>> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await responseJson(response);
      if (!response.ok) throw new Error(typeof json.error === "string" ? json.error : "Prospect action failed.");
      return json;
    } finally {
      setBusy(false);
    }
  }

  async function importWebsite(websiteUrl: string, source: { kind: "manual" }): Promise<void> {
    try {
      const json = await mutate("/api/companies/prospects", { websiteUrl, source });
      const parsed = ProspectRecordSchema.parse(json.prospect);
      await load();
      setSelectedId(parsed.id);
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Could not import website.");
    }
  }

  function importCandidate(candidate: EphemeralPlaceCandidate): void {
    if (!candidate.websiteUrl) return;
    void importWebsite(candidate.websiteUrl, { kind: "manual" });
  }

  async function action(value: ProspectAction): Promise<void> {
    if (!selected) return;
    try {
      const json = await mutate(`/api/companies/prospects/${selected.id}`, value);
      const parsed = ProspectRecordSchema.parse(json.prospect);
      setProspects((current) => current.map((item) => item.id === parsed.id ? parsed : item));
      setHandoff(null);
      setHandoffRequestKey(null);
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Prospect action failed.");
    }
  }

  async function searchPlaces(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    try {
      const json = await mutate("/api/companies/prospects/discover", { query: field(new FormData(event.currentTarget), "query") });
      const parsed = EphemeralPlaceCandidateSchema.array().safeParse(json.candidates);
      if (!parsed.success) throw new Error("Discovery returned an invalid response.");
      setCandidates(parsed.data);
    } catch (caught: unknown) {
      setCandidates([]);
      setError(caught instanceof Error ? caught.message : "Discovery unavailable. Use manual import.");
    }
  }

  async function prepareEmailHandoff(): Promise<void> {
    if (!selected) return;
    try {
      const idempotencyKey = handoffRequestKey ?? selected.handoff?.idempotencyKey ?? crypto.randomUUID();
      setHandoffRequestKey(idempotencyKey);
      const json = await mutate(`/api/companies/prospects/${selected.id}`, { action: "email-handoff", idempotencyKey });
      if (
        !(json.mailtoUrl === null || typeof json.mailtoUrl === "string")
        || typeof json.approvalDigest !== "string"
        || typeof json.handoffDigest !== "string"
        || typeof json.createdAt !== "string"
        || typeof json.idempotencyKey !== "string"
        || json.copyFallback === null
        || typeof json.copyFallback !== "object"
      ) {
        throw new Error("Email handoff returned an invalid response.");
      }
      const fallback = json.copyFallback as Record<string, unknown>;
      if (typeof fallback.recipientEmail !== "string" || typeof fallback.subject !== "string" || typeof fallback.body !== "string") throw new Error("Email handoff returned an invalid copy fallback.");
      const next = {
        mailtoUrl: json.mailtoUrl,
        approvalDigest: json.approvalDigest,
        handoffDigest: json.handoffDigest,
        createdAt: json.createdAt,
        idempotencyKey: json.idempotencyKey,
        copyFallback: { recipientEmail: fallback.recipientEmail, subject: fallback.subject, body: fallback.body },
      };
      setHandoff(next);
      if (next.mailtoUrl) window.location.href = next.mailtoUrl;
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Could not prepare email handoff.");
    }
  }

  async function copyEmailHandoff(): Promise<void> {
    if (!handoff) return;
    const { recipientEmail, subject, body } = handoff.copyFallback;
    await navigator.clipboard.writeText(`To: ${recipientEmail}\nSubject: ${subject}\n\n${body}`);
  }

  async function redactSelected(): Promise<void> {
    if (!selected || !window.confirm("Redact this prospect record? Any opt-out suppression digest is retained.")) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/companies/prospects/${selected.id}`, { method: "DELETE" });
      const json = await responseJson(response);
      if (!response.ok) throw new Error(typeof json.error === "string" ? json.error : "Could not redact prospect.");
      setHandoff(null); setHandoffRequestKey(null); setSelectedId(null); await load();
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Could not redact prospect.");
    } finally { setBusy(false); }
  }

  return (
    <section className="spl-engine" aria-labelledby="prospect-engine-heading">
      <div className="spl-section-title">
        <div>
          <span className="sos-kicker">Private Prospect Engine</span>
          <h2 id="prospect-engine-heading">Find, prove, prepare, review, and record.</h2>
        </div>
        <small>Manual delivery only</small>
      </div>

      <div className="spl-grid spl-grid--diagnostic">
        <aside className="spl-intake">
          <fieldset>
            <legend>Manual website import</legend>
            <form onSubmit={(event) => {
              event.preventDefault();
              void importWebsite(field(new FormData(event.currentTarget), "websiteUrl"), { kind: "manual" });
            }}>
              <label>Clean public website URL<input name="websiteUrl" type="url" required placeholder="https://business.example/" /></label>
              <button className="lp-btn lp-btn--primary lp-btn--sm" disabled={busy}>Import website</button>
            </form>
          </fieldset>

          <fieldset>
            <legend>Optional Google Places discovery</legend>
            <form onSubmit={(event) => void searchPlaces(event)}>
              <label>Business search<input name="query" required minLength={2} maxLength={160} placeholder="roofers in Tampa" /></label>
              <button className="lp-btn lp-btn--ghost lp-btn--sm" disabled={busy}>Search Google Maps</button>
            </form>
            {candidates.length > 0 && <ul className="spl-candidates">{candidates.map((candidate) => (
              <li key={candidate.placeId}>
                <b>{candidate.displayName}</b>
                <small>Source: Google Maps · transient result, not stored</small>
                {candidate.mapsUri && <a href={candidate.mapsUri} target="_blank" rel="noreferrer">View on Google Maps</a>}
                {candidate.websiteUrl ? (
                  <button type="button" onClick={() => importCandidate(candidate)}>
                    Import selected website
                  </button>
                ) : <em>No website supplied by Google; use manual import after verification.</em>}
              </li>
            ))}</ul>}
          </fieldset>

          <fieldset>
            <legend>Owner-scoped queue</legend>
            {prospects.length === 0 ? <p>No prospects yet.</p> : (
              <ol className="spl-prospect-queue">{prospects.map((prospect) => (
                <li key={prospect.id}>
                  <button type="button" className={prospect.id === selected?.id ? "is-selected" : ""} onClick={() => { setSelectedId(prospect.id); setHandoff(null); setHandoffRequestKey(null); }}>
                    <b>{prospect.domain}</b><span>{prospect.stage.replaceAll("_", " ")}</span>
                  </button>
                </li>
              ))}</ol>
            )}
          </fieldset>
        </aside>

        <div className="spl-output">
          {error && <div className="spl-form-error" role="alert">{error}</div>}
          {!selected ? <div className="spl-empty"><h3>Import one website to begin.</h3></div> : (
            <article className="spl-diagnostic">
              <header className="spl-diagnostic__head"><div><span className="spl-draft-mark">{selected.stage.replaceAll("_", " ")}</span><h3>{selected.domain}</h3><p>{selected.websiteUrl}</p></div></header>
              <aside className="spl-boundary"><b>Source</b><p>{selected.source.attribution}</p></aside>
              {selected.suppression.suppressed && <div className="spl-form-error">Suppressed: no approval or delivery is allowed.</div>}

              {selected.stage === "discovered" && <button className="lp-btn lp-btn--primary" disabled={busy} onClick={() => void action({ action: "audit" })}>Run authenticated Optimize audit</button>}

              {selected.stage === "audited" && <form onSubmit={(event) => {
                event.preventDefault(); const data = new FormData(event.currentTarget);
                void action({ action: "reproduce", sourceUrl: field(data, "sourceUrl"), operatorNote: field(data, "operatorNote") });
              }}><fieldset><legend>Reproduce the primary public observation</legend><label>Exact source URL<input name="sourceUrl" type="url" required defaultValue={selected.websiteUrl} /></label><label>Operator evidence note<textarea name="operatorNote" required maxLength={500} /></label><button className="lp-btn lp-btn--primary" disabled={busy}>Record reproduction receipt</button></fieldset></form>}

              {(selected.stage === "reproduced" || selected.stage === "repair_ready") && <form onSubmit={(event) => {
                event.preventDefault(); const data = new FormData(event.currentTarget);
                void action({ action: "prepare-repair", primaryFindingId: field(data, "primaryFindingId"), preparedRepair: field(data, "preparedRepair"), verificationStep: field(data, "verificationStep") });
              }}><fieldset><legend>Prepare the complete fix</legend><label>Primary audited finding<select name="primaryFindingId" defaultValue={selected.repair?.primaryFindingId ?? selected.audit?.handoff.findings.find((finding) => finding.preparedRepair)?.id}>{selected.audit?.handoff.findings.map((finding) => <option key={finding.id} value={finding.id}>{finding.title}{finding.preparedRepair ? " · prepared repair available" : ""}</option>)}</select></label><label>Paste-ready repair<textarea name="preparedRepair" required minLength={20} maxLength={4000} defaultValue={preparedRepairText(selected)} /></label><label>Verification step<textarea name="verificationStep" required minLength={10} maxLength={1200} defaultValue={preparedVerificationText(selected)} /></label><p>Optimize&apos;s prepared repair is only a prefill. Reproduce the issue and review or edit every field before saving this receipt.</p><button className="lp-btn lp-btn--primary" disabled={busy}>Save repair receipt</button></fieldset></form>}

              {canBuildDraft && <form onSubmit={(event) => {
                event.preventDefault(); const data = new FormData(event.currentTarget);
                void action({ action: "build-draft", recipientEmail: field(data, "recipientEmail"), recipientName: field(data, "recipientName") || null, postalAddress: field(data, "postalAddress"), contactSource: field(data, "contactSource"), jurisdiction: field(data, "jurisdiction") as "united-states" | "other-reviewed", recipientType: field(data, "recipientType") as "corporate-business" | "individual-or-unknown", suppressionChecked: true, optOutMonitored: true, outreachRulesReviewed: true });
              }}><fieldset><legend>Build deterministic Jason-voice draft</legend><label>Recipient email<input name="recipientEmail" type="email" required defaultValue={selected.draft?.recipientEmail} /></label><label>Recipient first name<input name="recipientName" /></label><label>Contact source<input name="contactSource" required minLength={3} defaultValue={selected.draft?.contactSource} /></label><label>Postal address<input name="postalAddress" required minLength={10} defaultValue={selected.draft?.draft.postalAddress} /></label><label>Jurisdiction<select name="jurisdiction" defaultValue="united-states"><option value="united-states">United States</option><option value="other-reviewed">Other, reviewed</option></select></label><label>Recipient type<select name="recipientType"><option value="corporate-business">Corporate business</option><option value="individual-or-unknown">Individual or unknown</option></select></label><p>Submitting attests suppression was checked, the opt-out is monitored, and applicable outreach rules were reviewed.</p><button className="lp-btn lp-btn--primary" disabled={busy}>Build or replace draft</button></fieldset></form>}

              {selected.draft && <section className="spl-email-proof"><p className="sos-kicker">Current reviewed draft</p><h3>{selected.draft.draft.subject}</h3><pre>{selected.draft.draft.body}</pre></section>}
              {selected.stage === "draft_ready" && <button className="lp-btn lp-btn--primary" disabled={busy || selected.suppression.suppressed} onClick={() => void action({ action: "approve", suppressionChecked: true })}>Approve this exact draft digest</button>}
              {selected.stage === "approved" && selectedDraft && <><button className="lp-btn lp-btn--primary" disabled={busy} onClick={() => void prepareEmailHandoff()}>Prepare approved email handoff</button>{handoff && <div className="spl-boundary"><p>A one-time handoff lease was recorded. The app cannot know whether a mail client opened or whether anything was sent.</p>{handoff.mailtoUrl ? <a className="lp-btn lp-btn--ghost" href={handoff.mailtoUrl}>Try mail app</a> : <p>The approved email is too large for a safe mailto link. Use the copy fallback.</p>}<button className="lp-btn lp-btn--ghost" onClick={() => void copyEmailHandoff()}>Copy approved email</button><button className="lp-btn lp-btn--ghost" onClick={() => void action({ action: "confirm-delivery", approvalDigest: handoff.approvalDigest, handoffDigest: handoff.handoffDigest, recipientEmail: selectedDraft.recipientEmail, idempotencyKey: handoff.idempotencyKey })}>Confirm I manually sent this exact draft</button></div>}</>}
              {selected.draft && ["draft_ready", "approved"].includes(selected.stage) && <button className="lp-btn lp-btn--ghost" disabled={busy} onClick={() => void action({ action: "suppress", note: "Suppressed before delivery by operator." })}>Suppress this recipient before sending</button>}
              {(selected.stage === "sent" || selected.stage === "follow_up_due") && <form onSubmit={(event) => event.preventDefault()}><fieldset><legend>Record outcome</legend><label>Outcome note<input name="outcomeNote" maxLength={500} /></label><button type="button" onClick={(event) => { const form = event.currentTarget.form; if (form) void action({ action: "mark-replied", note: field(new FormData(form), "outcomeNote") || "Recipient replied." }); }}>Replied</button><button type="button" onClick={() => void action({ action: "opt-out", note: "Recipient opted out." })}>Opted out</button><button type="button" onClick={(event) => { const form = event.currentTarget.form; if (form) void action({ action: "close", note: field(new FormData(form), "outcomeNote") || "Closed by operator." }); }}>Close</button>{selected.stage === "sent" && <button type="button" onClick={() => void action({ action: "mark-follow-up-due" })}>Mark follow-up due when eligible</button>}<p>Follow-up due: {selected.followUpAt ? new Date(selected.followUpAt).toLocaleString() : "none"}. Nothing is sent automatically.</p></fieldset></form>}
              <button className="lp-btn lp-btn--ghost" disabled={busy} onClick={() => void redactSelected()}>Redact prospect record</button>
            </article>
          )}
        </div>
      </div>
    </section>
  );
}
