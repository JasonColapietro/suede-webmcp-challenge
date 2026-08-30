"use client";

import { useState, type FormEvent } from "react";
import {
  buildOutboundDiagnostic,
  buildSecurityDisclosure,
  formatOutboundDiagnosticText,
  formatSecurityDisclosureText,
  JASON_OUTBOUND_PROFILE,
  OutboundDiagnosticInputSchema,
  scanSnapshotStatus,
  SecurityDisclosureInputSchema,
  type OutboundDiagnosticDraft,
  type ScanDiagnosticFinding,
  type ScanDiagnosticHandoff,
  type SecurityDisclosureDraft,
} from "@/lib/company/operating-system/outbound-diagnostic";

type CopyState = "idle" | "copied" | "error";
type DiagnosticMode = "commercial-diagnostic" | "security-disclosure";
type DisclosureMethod = "passive-observation" | "authorized-test";
type DiagnosticDraft = OutboundDiagnosticDraft | SecurityDisclosureDraft;

function formText(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function nullableText(data: FormData, name: string): string | null {
  const value = formText(data, name);
  return value.length > 0 ? value : null;
}

function dateTimeInputToIso(value: string): string {
  if (!value) return "";
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : value;
}

function priorityClass(finding: ScanDiagnosticFinding): string {
  return `sos-severity sos-severity--${finding.priority}`;
}

function DraftActions({
  copyState,
  onCopy,
}: {
  readonly copyState: CopyState;
  readonly onCopy: () => void;
}): React.JSX.Element {
  return (
    <div className="spl-actions spl-actions--screen">
      <button type="button" className="lp-btn lp-btn--ghost lp-btn--sm" onClick={onCopy}>
        {copyState === "copied" ? "Copied" : "Copy email draft"}
      </button>
      <button
        type="button"
        className="lp-btn lp-btn--primary lp-btn--sm"
        onClick={() => window.print()}
      >
        Print / save PDF
      </button>
      <span role="status" aria-live="polite">
        {copyState === "copied"
          ? "The reviewed email draft was copied."
          : copyState === "error"
            ? "Clipboard access failed. Select the draft text or print it instead."
            : ""}
      </span>
    </div>
  );
}

function CommercialDraftView({
  draft,
  copyState,
  onCopy,
}: {
  readonly draft: OutboundDiagnosticDraft;
  readonly copyState: CopyState;
  readonly onCopy: () => void;
}): React.JSX.Element {
  return (
    <article
      className="spl-diagnostic spl-diagnostic--commercial"
      id="outbound-diagnostic"
      aria-labelledby="diagnostic-heading"
    >
      <header className="spl-diagnostic__head">
        <div>
          <span className="spl-draft-mark">Draft · manual review required</span>
          <p className="sos-kicker">SEO and site-integrity diagnostic</p>
          <h2 id="diagnostic-heading">Lead with one complete prepared repair.</h2>
        </div>
        <DraftActions copyState={copyState} onCopy={onCopy} />
      </header>

      <aside className="spl-boundary" aria-label="Imported evidence boundary">
        <b>Imported evidence boundary</b>
        <p>{draft.evidenceBoundary}</p>
        {draft.snapshotStatus === "stale" && (
          <strong>Stale snapshot. Re-run Audit and reproduce the issue again before use.</strong>
        )}
      </aside>

      <section className="spl-primary-proof" aria-labelledby="primary-proof-heading">
        <div className="spl-finding__meta">
          <span>01</span>
          <span className={priorityClass(draft.primaryFinding)}>
            {draft.primaryFinding.priority}
          </span>
          <span>{draft.primaryFinding.lane}</span>
        </div>
        <p className="sos-kicker">Primary public observation</p>
        <h3 id="primary-proof-heading">{draft.primaryFinding.title}</h3>
        <dl>
          <div>
            <dt>Observed</dt>
            <dd>{draft.primaryFinding.observed}</dd>
          </div>
          <div>
            <dt>Audit repair direction</dt>
            <dd>{draft.primaryFinding.action}</dd>
          </div>
          <div>
            <dt>Complete prepared repair</dt>
            <dd>{draft.preparedRepair}</dd>
          </div>
          <div>
            <dt>Verification step</dt>
            <dd>{draft.verificationStep}</dd>
          </div>
        </dl>
      </section>

      <section className="spl-supporting-proof" aria-labelledby="supporting-proof-heading">
        <div className="spl-section-title">
          <div>
            <span className="sos-kicker">Extended Scan signal</span>
            <h3 id="supporting-proof-heading">Up to two supporting observations</h3>
          </div>
          <small>{draft.supportingFindings.length} included</small>
        </div>
        {draft.supportingFindings.length > 0 ? (
          <ol>
            {draft.supportingFindings.map((finding, index) => (
              <li key={finding.id}>
                <span>{String(index + 2).padStart(2, "0")}</span>
                <div>
                  <b>{finding.title}</b>
                  <p>{finding.observed}</p>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="spl-no-findings">
            No additional observation was imported. The draft offers only the
            complete prepared repair above.
          </p>
        )}
      </section>

      <EmailDraft subject={draft.subject} body={draft.body} />
    </article>
  );
}

function SecurityDraftView({
  draft,
  copyState,
  onCopy,
}: {
  readonly draft: SecurityDisclosureDraft;
  readonly copyState: CopyState;
  readonly onCopy: () => void;
}): React.JSX.Element {
  return (
    <article
      className="spl-diagnostic spl-diagnostic--security"
      id="security-disclosure"
      aria-labelledby="security-disclosure-heading"
    >
      <header className="spl-diagnostic__head">
        <div>
          <span className="spl-draft-mark">Disclosure only · no sales CTA</span>
          <p className="sos-kicker">Fixed security routing notice</p>
          <h2 id="security-disclosure-heading">Route the issue. Sell nothing.</h2>
        </div>
        <DraftActions copyState={copyState} onCopy={onCopy} />
      </header>

      <aside className="spl-boundary" aria-label="Security evidence boundary">
        <b>Security evidence boundary</b>
        <p>{draft.evidenceBoundary}</p>
      </aside>

      <section className="spl-primary-proof" aria-labelledby="security-proof-heading">
        <div className="spl-finding__meta">
          <span>01</span>
          <span>{draft.discoveryMethod.replace("-", " ")}</span>
          <span>{new URL(draft.affectedAsset).hostname}</span>
        </div>
        <p className="sos-kicker">Private evidence routing</p>
        <h3 id="security-proof-heading">Operator evidence stays out of the generated email.</h3>
        <dl className="spl-security-evidence">
          <div>
            <dt>Observation category</dt>
            <dd>{draft.category.replaceAll("-", " ")}</dd>
          </div>
          <div>
            <dt>Observation date</dt>
            <dd>{new Date(draft.observedAt).toLocaleDateString()}</dd>
          </div>
          <div>
            <dt>Local evidence</dt>
            <dd>Reference recorded for operator use only</dd>
          </div>
          <div>
            <dt>Next step</dt>
            <dd>Use the confirmed private process before sharing technical details</dd>
          </div>
        </dl>
      </section>

      <EmailDraft subject={draft.subject} body={draft.body} />
    </article>
  );
}

function EmailDraft({
  subject,
  body,
}: {
  readonly subject: string;
  readonly body: string;
}): React.JSX.Element {
  return (
    <section className="spl-email-proof" aria-labelledby="email-draft-heading">
      <p className="sos-kicker">Manual email draft</p>
      <h3 id="email-draft-heading">{subject}</h3>
      <pre>{body}</pre>
    </section>
  );
}

export default function OutboundDiagnosticWorkspace({
  handoff,
  importError,
}: {
  readonly handoff: ScanDiagnosticHandoff | null;
  readonly importError: string | null;
}): React.JSX.Element {
  const [mode, setMode] = useState<DiagnosticMode>("commercial-diagnostic");
  const [disclosureMethod, setDisclosureMethod] = useState<DisclosureMethod>("passive-observation");
  const [draft, setDraft] = useState<DiagnosticDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<CopyState>("idle");

  function changeMode(nextMode: DiagnosticMode): void {
    setMode(nextMode);
    setDraft(null);
    setError(null);
    setCopyState("idle");
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setError(null);
    setCopyState("idle");
    const data = new FormData(event.currentTarget);

    if (mode === "commercial-diagnostic") {
      if (!handoff) {
        setDraft(null);
        setError("Open this commercial tool from a completed Suede Audit report.");
        return;
      }
      const parsed = OutboundDiagnosticInputSchema.safeParse({
        handoff,
        mode,
        recipientName: nullableText(data, "recipientName"),
        senderProfile: JASON_OUTBOUND_PROFILE.id,
        postalAddress: formText(data, "postalAddress"),
        contactSource: formText(data, "contactSource"),
        recipientJurisdiction: formText(data, "recipientJurisdiction"),
        recipientType: formText(data, "recipientType"),
        primaryFindingId: formText(data, "primaryFindingId"),
        preparedRepair: formText(data, "preparedRepair"),
        verificationStep: formText(data, "verificationStep"),
        reproducedAtSource: data.get("reproducedAtSource") === "on",
        suppressionChecked: data.get("suppressionChecked") === "on",
        optOutMonitored: data.get("optOutMonitored") === "on",
        outreachRulesReviewed: data.get("outreachRulesReviewed") === "on",
      });
      if (!parsed.success) {
        setDraft(null);
        setError(parsed.error.issues[0]?.message ?? "Review the commercial draft gates.");
        return;
      }
      try {
        setDraft(buildOutboundDiagnostic(parsed.data));
      } catch (caught: unknown) {
        setDraft(null);
        setError(caught instanceof Error ? caught.message : "Could not build the diagnostic.");
      }
      return;
    }

    const parsed = SecurityDisclosureInputSchema.safeParse({
      mode,
      operatorName: formText(data, "operatorName"),
      affectedAsset: formText(data, "affectedAsset"),
      observedAt: dateTimeInputToIso(formText(data, "securityObservedAt")),
      discoveryMethod: disclosureMethod,
      authorizationReference: disclosureMethod === "authorized-test"
        ? nullableText(data, "authorizationReference")
        : null,
      category: formText(data, "securityCategory"),
      evidenceReference: formText(data, "evidenceReference"),
      disclosureChannelConfirmed: data.get("disclosureChannelConfirmed") === "on",
      operatorAttested: data.get("securityOperatorAttested") === "on",
    });
    if (!parsed.success) {
      setDraft(null);
      setError(parsed.error.issues[0]?.message ?? "Review the disclosure evidence.");
      return;
    }
    try {
      setDraft(buildSecurityDisclosure(parsed.data));
    } catch (caught: unknown) {
      setDraft(null);
      setError(caught instanceof Error ? caught.message : "Could not build the disclosure.");
    }
  }

  async function copyDraft(): Promise<void> {
    if (!draft) return;
    const text = draft.mode === "commercial-diagnostic"
      ? formatOutboundDiagnosticText(draft)
      : formatSecurityDisclosureText(draft);
    try {
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  }

  const snapshotStatus = handoff ? scanSnapshotStatus(handoff) : null;

  return (
    <div className="spl-grid spl-grid--diagnostic">
      <section className="spl-intake spl-diagnostic-intake" aria-labelledby="diagnostic-intake-heading">
        <div className="spl-section-title">
          <div>
            <span className="sos-kicker">Operator review</span>
            <h2 id="diagnostic-intake-heading">Choose the ethical outreach lane.</h2>
          </div>
          <span>01</span>
        </div>

        {mode === "commercial-diagnostic" && handoff && (
          <aside className={`spl-import-receipt ${snapshotStatus === "stale" ? "is-stale" : ""}`}>
            <span>Unverified client-controlled snapshot</span>
            <b>{handoff.domain}</b>
            <p>
              {handoff.totalFindings} public-site {handoff.totalFindings === 1 ? "observation" : "observations"} ·
              {" "}snapshot claims {new Date(handoff.observedAt).toLocaleString()}
            </p>
            {handoff.omittedCount > 0 && (
              <p>{handoff.omittedCount} lower-priority observations were omitted from the URL handoff.</p>
            )}
            <small>
              {snapshotStatus === "stale"
                ? "Stale snapshot. Re-run Audit, then reproduce the primary observation."
                : "Reproduce the primary observation before external use."}
            </small>
          </aside>
        )}

        <form onSubmit={submit} autoComplete="off">
          <fieldset>
            <legend>Output lane</legend>
            <div className="spl-lane-choice">
              <label className={mode === "commercial-diagnostic" ? "is-selected" : ""}>
                <input
                  type="radio"
                  name="mode"
                  value="commercial-diagnostic"
                  checked={mode === "commercial-diagnostic"}
                  onChange={() => changeMode("commercial-diagnostic")}
                />
                <span>
                  <b>SEO diagnostic</b>
                  <small>Reproduce one site-integrity issue and prepare its complete fix, then cite up to two more.</small>
                </span>
              </label>
              <label className={mode === "security-disclosure" ? "is-selected" : ""}>
                <input
                  type="radio"
                  name="mode"
                  value="security-disclosure"
                  checked={mode === "security-disclosure"}
                  onChange={() => changeMode("security-disclosure")}
                />
                <span>
                  <b>Security routing notice</b>
                  <small>Separate local evidence only. Audit findings cannot become vulnerabilities.</small>
                </span>
              </label>
            </div>
          </fieldset>

          {mode === "commercial-diagnostic" ? (
            <>
              <fieldset>
                <legend>Scan evidence</legend>
                {handoff ? (
                  <>
                    <label>
                      Primary issue to solve
                      <select name="primaryFindingId" defaultValue={handoff.findings[0]?.id}>
                        {handoff.findings.map((finding) => (
                          <option key={finding.id} value={finding.id}>
                            {finding.priority.toUpperCase()} · {finding.title}
                          </option>
                        ))}
                      </select>
                      <small>The imported observation and Audit repair direction remain visibly separate from your prepared fix.</small>
                    </label>
                    <label>
                      Complete prepared repair
                      <textarea
                        name="preparedRepair"
                        required
                        minLength={20}
                        maxLength={4000}
                        placeholder="Provide the exact paste-ready code, configuration, copy, or implementation steps for this one issue."
                      />
                      <small>Do not claim deployment. Include only a complete, ready-to-apply repair you reviewed.</small>
                    </label>
                    <label>
                      Verification step
                      <textarea
                        name="verificationStep"
                        required
                        minLength={10}
                        maxLength={1200}
                        placeholder="Explain the smallest public check that confirms the repair after it is applied."
                      />
                    </label>
                  </>
                ) : (
                  <aside className="spl-security-rule">
                    <b>No Audit evidence imported</b>
                    <p>
                      Open this tool from <a href="https://optimize.suedeai.ai" rel="noreferrer">Suede Audit</a>.
                      An invalid or expired import must be reopened from its report.
                    </p>
                    {importError && <p role="alert">{importError}</p>}
                  </aside>
                )}
              </fieldset>

              <fieldset>
                <legend>Commercial email fields</legend>
                <aside className="spl-import-receipt">
                  <span>Fixed sender profile</span>
                  <b>{JASON_OUTBOUND_PROFILE.name}</b>
                  <p>{JASON_OUTBOUND_PROFILE.title}</p>
                  <p>
                    Creator of Suede Scan · Author of Proof as Infrastructure ·
                    Programming Insider byline on SEO and AI search
                  </p>
                  <small>
                    First-person identity and credibility wording are fixed. Public proof:{" "}
                    <a href={JASON_OUTBOUND_PROFILE.identityUrl} target="_blank" rel="noreferrer">
                      founder record
                    </a>
                    {" · "}
                    <a href={JASON_OUTBOUND_PROFILE.scanUrl} target="_blank" rel="noreferrer">
                      Suede Scan
                    </a>
                    {" · "}
                    <a href={JASON_OUTBOUND_PROFILE.articleUrl} target="_blank" rel="noreferrer">
                      Programming Insider
                    </a>
                    {" · "}
                    <a href={JASON_OUTBOUND_PROFILE.bookUrl} target="_blank" rel="noreferrer">
                      book record
                    </a>
                  </small>
                </aside>
                <label>
                  Recipient first name <small>Optional</small>
                  <input name="recipientName" maxLength={120} placeholder="Morgan" />
                </label>
                <label>
                  Valid postal address
                  <input
                    name="postalAddress"
                    required
                    minLength={10}
                    maxLength={300}
                    placeholder="Required commercial-email footer. Enter it locally."
                  />
                </label>
                <label>
                  Contact source
                  <input
                    name="contactSource"
                    required
                    minLength={3}
                    maxLength={240}
                    placeholder="How this business contact was sourced"
                  />
                  <small>Recorded locally for operator review. It is not copied into the email.</small>
                </label>
                <div className="spl-field-row">
                  <label>
                    Recipient jurisdiction
                    <select name="recipientJurisdiction" defaultValue="united-states">
                      <option value="united-states">United States</option>
                      <option value="other-reviewed">Other, rules reviewed</option>
                    </select>
                  </label>
                  <label>
                    Recipient type
                    <select name="recipientType" defaultValue="corporate-business">
                      <option value="corporate-business">Corporate business contact</option>
                      <option value="individual-or-unknown">Individual or unknown</option>
                    </select>
                  </label>
                </div>
              </fieldset>

              <fieldset>
                <legend>Manual gates before draft</legend>
                <label className="spl-checkbox">
                  <input name="reproducedAtSource" type="checkbox" required />
                  <span>I confirm Jason reproduced the primary observation on the exact public page.</span>
                </label>
                <label className="spl-checkbox">
                  <input name="suppressionChecked" type="checkbox" required />
                  <span>I checked the applicable suppression or do-not-contact record.</span>
                </label>
                <label className="spl-checkbox">
                  <input name="optOutMonitored" type="checkbox" required />
                  <span>The reply opt-out is monitored and will be honored.</span>
                </label>
                <label className="spl-checkbox">
                  <input name="outreachRulesReviewed" type="checkbox" required />
                  <span>I reviewed the applicable outreach rules and every line of this draft.</span>
                </label>
              </fieldset>
            </>
          ) : (
            <>
              <fieldset>
                <legend>Security evidence source</legend>
                <aside className="spl-security-rule">
                  <b>Not imported from Audit</b>
                  <p>
                    Generic SEO, metadata, headers, robots, sitemap, and schema
                    findings are site-integrity issues, not vulnerabilities.
                  </p>
                </aside>
                <div className="spl-field-row">
                  <label>
                    Affected public asset
                    <input
                      name="affectedAsset"
                      type="url"
                      required
                      maxLength={2048}
                      placeholder="https://example.com/public-path"
                    />
                  </label>
                  <label>
                    Observation time
                    <input name="securityObservedAt" type="datetime-local" required />
                  </label>
                </div>
                <label>
                  Discovery method
                  <select
                    name="discoveryMethod"
                    value={disclosureMethod}
                    onChange={(event) => setDisclosureMethod(event.currentTarget.value as DisclosureMethod)}
                  >
                    <option value="passive-observation">Passive public observation</option>
                    <option value="authorized-test">Documented authorized test</option>
                  </select>
                </label>
                {disclosureMethod === "authorized-test" && (
                  <label>
                    Authorization reference
                    <input
                      name="authorizationReference"
                      required
                      maxLength={240}
                      placeholder="Internal approval or written authorization reference"
                    />
                    <small>This gates the draft and is not copied into the disclosure.</small>
                  </label>
                )}
              </fieldset>

              <fieldset>
                <legend>Local evidence reference</legend>
                <label>
                  Observation category
                  <select name="securityCategory" defaultValue="public-data-exposure">
                    <option value="public-data-exposure">Potential public data exposure</option>
                    <option value="access-control">Potential access-control issue</option>
                    <option value="security-configuration">Potential security configuration issue</option>
                    <option value="dependency-or-version">Potential dependency or version exposure</option>
                    <option value="other-security-observation">Other security observation</option>
                  </select>
                </label>
                <label>
                  Evidence reference
                  <input
                    name="evidenceReference"
                    required
                    maxLength={240}
                    placeholder="Local case or screenshot reference, without secrets"
                  />
                  <small>
                    This reference and the technical evidence stay local. The generated
                    notice contains only controlled, non-commercial copy.
                  </small>
                </label>
              </fieldset>

              <fieldset>
                <legend>Disclosure routing</legend>
                <label>
                  Authorized operator
                  <select name="operatorName" defaultValue="Jason">
                    <option value="Jason">Jason</option>
                    <option value="Johnny">Johnny</option>
                  </select>
                </label>
                <label className="spl-checkbox">
                  <input name="disclosureChannelConfirmed" type="checkbox" required />
                  <span>I manually confirmed the recipient&apos;s private security or engineering channel.</span>
                </label>
                <label className="spl-checkbox">
                  <input name="securityOperatorAttested" type="checkbox" required />
                  <span>The local evidence is accurate, in scope, and will be shared only through the confirmed process.</span>
                </label>
              </fieldset>
            </>
          )}

          {error && <div className="spl-form-error" role="alert">{error}</div>}

          <div className="spl-submit">
            <button type="submit" className="lp-btn lp-btn--primary">
              {mode === "security-disclosure" ? "Build routing notice" : "Build diagnostic draft"}
            </button>
            <p>No model call. No CRM write. No email sent.</p>
          </div>
        </form>
      </section>

      <section className="spl-output" aria-label="Outbound diagnostic draft">
        {draft ? (
          draft.mode === "commercial-diagnostic" ? (
            <CommercialDraftView
              draft={draft}
              copyState={copyState}
              onCopy={() => void copyDraft()}
            />
          ) : (
            <SecurityDraftView
              draft={draft}
              copyState={copyState}
              onCopy={() => void copyDraft()}
            />
          )
        ) : (
          <div className="spl-empty spl-empty--diagnostic">
            <span>02</span>
            <p className="sos-kicker">Evidence-led outreach</p>
            <h2>
              {mode === "security-disclosure"
                ? "A security report is not a sales wedge."
                : "Give away the first useful answer."}
            </h2>
            <p>
              {mode === "security-disclosure"
                ? "The fixed notice establishes a private route without copying technical details or any paid offer."
                : "The draft gives one complete prepared repair, summarizes at most two more observations, and offers an extended Scan."}
            </p>
            <ol>
              <li>Public evidence, not manufactured alarm</li>
              <li>Specific repair, not a vague teaser</li>
              <li>Manual operator review before copy</li>
            </ol>
          </div>
        )}
      </section>
    </div>
  );
}
