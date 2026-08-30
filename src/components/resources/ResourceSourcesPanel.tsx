"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { ResourceImportNotice, ResourceRefreshResult, ResourceRefreshSource } from "./client";

type SourceProvenance = "mine" | "licensed_or_permissioned" | "public_source" | "other_or_unspecified";
type ResourceUiJson = string | number | boolean | null | ResourceUiJson[] | { [key: string]: ResourceUiJson };
export type ResourceManualSourceInput =
  | { readonly kind: "manual_text"; readonly locator: string; readonly text: string; readonly freshnessDays: number; readonly provenance?: SourceProvenance; readonly provenanceNote?: string }
  | { readonly kind: "json_rows"; readonly locator: string; readonly rows: Record<string, ResourceUiJson>[]; readonly freshnessDays: number; readonly provenance?: SourceProvenance; readonly provenanceNote?: string };
export interface ResourceRefreshFormInput {
  readonly source: ResourceRefreshSource;
  readonly replaceSourceSnapshotIds: readonly string[];
}

export function parseResourceJsonRows(value: string): Record<string, ResourceUiJson>[] {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("JSON rows must be a valid JSON array of objects."); }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 2_000 || parsed.some((row) =>
    !row || typeof row !== "object" || Array.isArray(row) || Object.getPrototypeOf(row) !== Object.prototype
  )) throw new Error("JSON rows must be a non-empty array of up to 2,000 objects.");
  return parsed as Record<string, ResourceUiJson>[];
}

export default function ResourceSourcesPanel({
  disabled,
  busy,
  onAdd,
  refreshDisabled,
  refreshBusy,
  rejectBusy,
  canReject,
  sourceSnapshotIds,
  refreshResult,
  importNotice,
  onRefresh,
  onReject,
}: {
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly onAdd: (input: ResourceManualSourceInput) => void | Promise<void>;
  readonly refreshDisabled: boolean;
  readonly refreshBusy: boolean;
  readonly rejectBusy: boolean;
  readonly canReject: boolean;
  readonly sourceSnapshotIds: readonly string[];
  readonly refreshResult: ResourceRefreshResult | null;
  readonly importNotice?: ResourceImportNotice | null;
  readonly onRefresh: (input: ResourceRefreshFormInput) => void | Promise<void>;
  readonly onReject: () => void | Promise<void>;
}): React.JSX.Element {
  const [locator, setLocator] = useState("manual://reviewed-note");
  const [text, setText] = useState("");
  const [sourceKind, setSourceKind] = useState<"manual_text" | "json_rows">("manual_text");
  const [freshnessDays, setFreshnessDays] = useState(30);
  const [provenance, setProvenance] = useState<SourceProvenance | "">("");
  const [provenanceNote, setProvenanceNote] = useState("");
  const [refreshKind, setRefreshKind] = useState<"manual_text" | "json_rows" | "url">("url");
  const [refreshLocator, setRefreshLocator] = useState("manual://reviewed-refresh");
  const [refreshText, setRefreshText] = useState("");
  const [refreshUrl, setRefreshUrl] = useState("");
  const [refreshDays, setRefreshDays] = useState(30);
  const [replaceIds, setReplaceIds] = useState<readonly string[]>([]);

  useEffect(() => setReplaceIds((current) => current.filter((id) => sourceSnapshotIds.includes(id))), [sourceSnapshotIds]);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (disabled || busy) return;
    const context = {
      locator: locator.trim(), freshnessDays,
      ...(provenance === "" ? {} : { provenance }),
      ...(provenanceNote.trim() === "" ? {} : { provenanceNote: provenanceNote.trim() }),
    };
    await onAdd(sourceKind === "json_rows"
      ? { kind: "json_rows", ...context, rows: parseResourceJsonRows(text) }
      : { kind: "manual_text", ...context, text: text.trim() });
  };

  const submitRefresh = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (refreshDisabled || refreshBusy) return;
    const source: ResourceRefreshSource = refreshKind === "url"
      ? { kind: "url", url: refreshUrl.trim(), freshnessDays: refreshDays }
      : refreshKind === "json_rows"
        ? { kind: "json_rows", locator: refreshLocator.trim(), rows: parseResourceJsonRows(refreshText), freshnessDays: refreshDays }
        : { kind: "manual_text", locator: refreshLocator.trim(), text: refreshText.trim(), freshnessDays: refreshDays };
    await onRefresh({ source, replaceSourceSnapshotIds: replaceIds });
  };

  const toggleReplacement = (snapshotId: string): void => {
    setReplaceIds((current) => current.includes(snapshotId)
      ? current.filter((id) => id !== snapshotId)
      : [...current, snapshotId]);
  };

  return (
    <section className="resource-stage" aria-labelledby="resource-sources-heading">
      <div className="resource-stage-head">
        <p className="resource-kicker">02 / Sources</p>
        <h2 id="resource-sources-heading">Add a manual source first</h2>
        <p>Paste one reviewed note or a small bounded extract. The source body stays in the private resource store.</p>
      </div>
      {importNotice && (importNotice.collectionStatus !== "collected" || importNotice.warnings.length > 0) && (
        <div className="resource-refresh-result" role="status" aria-live="polite" aria-atomic="true">
          <p><b>Website import {importNotice.collectionStatus}.</b></p>
          {importNotice.warnings.length > 0 && (
            <ul>{importNotice.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
          )}
          <p>The private draft remains available for review. This warning does not disable approval or publication.</p>
        </div>
      )}
      <form className="resource-source-form" onSubmit={(event) => void submit(event)}>
        <label>
          Intake format
          <select value={sourceKind} onChange={(event) => setSourceKind(event.target.value as "manual_text" | "json_rows")} disabled={disabled || busy}>
            <option value="manual_text">Pasted text</option>
            <option value="json_rows">JSON rows</option>
          </select>
        </label>
        <label>
          Manual source locator
          <input value={locator} onChange={(event) => setLocator(event.target.value)} maxLength={1024} required disabled={disabled || busy} />
        </label>
        <label>
          {sourceKind === "json_rows" ? "JSON row array" : "Manual source"}
          <textarea value={text} onChange={(event) => setText(event.target.value)} maxLength={128000} required disabled={disabled || busy} placeholder={sourceKind === "json_rows" ? '[{"name":"Alpha","score":2}]' : "Paste a reviewed note."} />
        </label>
        <label>
          Recheck after
          <span className="resource-inline-control"><input type="number" min={1} max={3650} value={freshnessDays} onChange={(event) => setFreshnessDays(Number(event.target.value))} required disabled={disabled || busy} /> days</span>
        </label>
        <div className="resource-provenance">
          <p>Optional source context — supplied by you and not verified by Suede.</p>
          <label>
            Context
            <select name="provenance" value={provenance} onChange={(event) => setProvenance(event.target.value as SourceProvenance | "")} disabled={disabled || busy}>
              <option value="">Not supplied</option>
              <option value="mine">Mine</option>
              <option value="licensed_or_permissioned">Licensed or permissioned</option>
              <option value="public_source">Public source</option>
              <option value="other_or_unspecified">Other or unspecified</option>
            </select>
          </label>
          <label>
            Optional note
            <input value={provenanceNote} onChange={(event) => setProvenanceNote(event.target.value)} maxLength={1024} disabled={disabled || busy} />
          </label>
          <small>Leaving both fields empty is valid and does not disable approval or publication.</small>
        </div>
        <div className="resource-form-action">
          <button type="submit" className="lp-btn lp-btn--primary" disabled={disabled || busy || locator.trim() === "" || text.trim() === ""}>
            {busy ? "Adding source…" : "Add manual source"}
          </button>
          {disabled && <p>Load the server-current candidate receipt before adding a source.</p>}
        </div>
      </form>
      <div className="resource-stage-head">
        <p className="resource-kicker">Reviewed refresh</p>
        <h3>Recollect reviewed source</h3>
        <p>
          A fresh manual or URL collection is compared with the approved pack. Review added,
          changed, and removed records plus schema, evidence, unknown, conflict, and freshness
          deltas before approval. The Live pack and its receipts stay pinned until approval and
          a normal republish.
        </p>
      </div>
      <form className="resource-source-form resource-refresh-form" onSubmit={(event) => void submitRefresh(event)}>
        <label>
          Collection type
          <select value={refreshKind} onChange={(event) => setRefreshKind(event.target.value as "manual_text" | "json_rows" | "url")} disabled={refreshDisabled || refreshBusy}>
            <option value="url">Website URL</option>
            <option value="manual_text">Manual replacement</option>
            <option value="json_rows">JSON row replacement</option>
          </select>
        </label>
        {refreshKind === "url" ? (
          <label>
            Source URL
            <input type="url" value={refreshUrl} onChange={(event) => setRefreshUrl(event.target.value)} maxLength={2048} required disabled={refreshDisabled || refreshBusy} placeholder="https://example.com/pricing" />
          </label>
        ) : (
          <>
            <label>
              Manual source locator
              <input value={refreshLocator} onChange={(event) => setRefreshLocator(event.target.value)} maxLength={1024} required disabled={refreshDisabled || refreshBusy} />
            </label>
            <label>
              {refreshKind === "json_rows" ? "Replacement JSON row array" : "Replacement text"}
              <textarea value={refreshText} onChange={(event) => setRefreshText(event.target.value)} maxLength={128000} required disabled={refreshDisabled || refreshBusy} />
            </label>
          </>
        )}
        <label>
          Recheck after
          <span className="resource-inline-control"><input type="number" min={1} max={3650} value={refreshDays} onChange={(event) => setRefreshDays(Number(event.target.value))} required disabled={refreshDisabled || refreshBusy} /> days</span>
        </label>
        <fieldset className="resource-refresh-snapshots">
          <legend>Replace source snapshots</legend>
          {sourceSnapshotIds.length === 0 ? <p>No prior source snapshot is required. An empty candidate diff is valid.</p> : sourceSnapshotIds.map((snapshotId) => (
            <label key={snapshotId}>
              <input type="checkbox" checked={replaceIds.includes(snapshotId)} onChange={() => toggleReplacement(snapshotId)} disabled={refreshDisabled || refreshBusy} />
              <code>{snapshotId}</code>
            </label>
          ))}
        </fieldset>
        <div className="resource-form-action">
          <button type="submit" className="lp-btn lp-btn--primary" disabled={refreshDisabled || refreshBusy || (refreshKind === "url" ? refreshUrl.trim() === "" : refreshLocator.trim() === "" || refreshText.trim() === "")}>
            {refreshBusy ? "Recollecting…" : "Create reviewed refresh candidate"}
          </button>
          <button type="button" className="lp-btn lp-btn--ghost" disabled={!canReject || rejectBusy || refreshBusy} onClick={() => void onReject()}>
            {rejectBusy ? "Rejecting…" : "Reject this candidate"}
          </button>
        </div>
      </form>
      {refreshResult && (
        <div className="resource-refresh-result" role="status" aria-live="polite">
          <p><b>Collection {refreshResult.collection.status}.</b> {refreshResult.collection.warnings.join(" ") || "No collection warnings."}</p>
          {refreshResult.diff ? (
            <dl className="resource-fact-strip" aria-label="Candidate refresh diff">
              <div><dt>Added records</dt><dd>{refreshResult.diff.addedRecordIds.length > 0 ? refreshResult.diff.addedRecordIds.join(", ") : "None"}</dd></div>
              <div><dt>Changed records</dt><dd>{refreshResult.diff.changedRecordIds.length > 0 ? refreshResult.diff.changedRecordIds.join(", ") : "None"}</dd></div>
              <div><dt>Removed records</dt><dd>{refreshResult.diff.removedRecordIds.length > 0 ? refreshResult.diff.removedRecordIds.join(", ") : "None"}</dd></div>
              <div><dt>Added sources</dt><dd>{refreshResult.diff.addedSourceSnapshotIds.length > 0 ? refreshResult.diff.addedSourceSnapshotIds.join(", ") : "None"}</dd></div>
              <div><dt>Removed sources</dt><dd>{refreshResult.diff.removedSourceSnapshotIds.length > 0 ? refreshResult.diff.removedSourceSnapshotIds.join(", ") : "None"}</dd></div>
              <div><dt>Schema</dt><dd>{refreshResult.diff.schemaChanged ? "Changed" : "Unchanged"}</dd></div>
              <div><dt>Taxonomy</dt><dd>{refreshResult.diff.taxonomyChanged ? "Changed" : "Unchanged"}</dd></div>
              <div><dt>Evidence</dt><dd>{refreshResult.diff.evidenceChanged ? "Changed" : "Unchanged"}</dd></div>
              <div><dt>Added evidence</dt><dd>{refreshResult.diff.addedEvidenceIds.length > 0 ? refreshResult.diff.addedEvidenceIds.join(", ") : "None"}</dd></div>
              <div><dt>Changed evidence</dt><dd>{refreshResult.diff.changedEvidenceIds.length > 0 ? refreshResult.diff.changedEvidenceIds.join(", ") : "None"}</dd></div>
              <div><dt>Removed evidence</dt><dd>{refreshResult.diff.removedEvidenceIds.length > 0 ? refreshResult.diff.removedEvidenceIds.join(", ") : "None"}</dd></div>
              <div><dt>Job Contract</dt><dd>{refreshResult.diff.jobContractChanged ? "Changed" : "Unchanged"}</dd></div>
              <div><dt>Freshness</dt><dd>{refreshResult.diff.freshness.before} → {refreshResult.diff.freshness.candidate}</dd></div>
              <div><dt>Unknowns</dt><dd>{refreshResult.diff.unknowns.before} → {refreshResult.diff.unknowns.candidate} ({refreshResult.diff.unknowns.delta >= 0 ? "+" : ""}{refreshResult.diff.unknowns.delta})</dd></div>
              <div><dt>Conflicts</dt><dd>{refreshResult.diff.conflicts.before} → {refreshResult.diff.conflicts.candidate} ({refreshResult.diff.conflicts.delta >= 0 ? "+" : ""}{refreshResult.diff.conflicts.delta})</dd></div>
            </dl>
          ) : <p>No candidate mutation was created. The private draft and existing release pointers remain unchanged.</p>}
          {refreshResult.collection.evidence.length > 0 && (
            <div className="resource-refresh-evidence" aria-label="Collected evidence details">
              <h4>Collected evidence details</h4>
              <ul>{refreshResult.collection.evidence.map((item) => (
                <li key={item.id}>
                  <code>{item.id}</code>
                  <span>Source <code>{item.sourceSnapshotId}</code></span>
                  <span>Locator <code>{item.locator}</code></span>
                  <span>Observed {item.observedAt}</span>
                  {item.fieldHash && <span>Field hash <code>{item.fieldHash}</code></span>}
                  {item.confidence !== undefined && <span>Confidence {item.confidence}</span>}
                  {item.conflict && <span>Conflict {item.conflict}</span>}
                </li>
              ))}</ul>
            </div>
          )}
        </div>
      )}
      <dl className="resource-fact-strip" aria-label="Refresh review boundary">
        <div><dt>Collection failure</dt><dd>No candidate mutation</dd></div>
        <div><dt>Stale source</dt><dd>Shown explicitly</dd></div>
        <div><dt>Rejected candidate</dt><dd>No approval</dd></div>
        <div><dt>Live release</dt><dd>Unchanged until republish</dd></div>
      </dl>
    </section>
  );
}
