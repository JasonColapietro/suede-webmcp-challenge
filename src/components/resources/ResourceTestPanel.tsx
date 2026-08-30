"use client";

import type { ResourceDryRun, ResourcePackBundle } from "./client";
import {
  buildResourceRepresentativeDraft,
  type ResourceRepresentativeDraft,
  type ResourceRepresentativeProof,
} from "./representative";

export function ResourceRepresentativeProofReceipt({
  proof,
}: {
  readonly proof: ResourceRepresentativeProof;
}): React.JSX.Element {
  return (
    <div className="resource-proof-receipt" aria-label="Representative proof">
      <p><b>Representative proof</b> <code className="resource-hash">{proof.digest}</code></p>
      <pre>{JSON.stringify(proof.representative, null, 2)}</pre>
    </div>
  );
}

export default function ResourceTestPanel({
  pack,
  result,
  busy,
  draft,
  draftInvalid = false,
  onDraftChange,
  onRun,
}: {
  readonly pack: ResourcePackBundle | null;
  readonly result: ResourceDryRun | null;
  readonly busy: boolean;
  readonly draft?: ResourceRepresentativeDraft | null;
  readonly draftInvalid?: boolean;
  readonly onDraftChange?: (value: ResourceRepresentativeDraft) => void;
  readonly onRun: () => void;
}): React.JSX.Element {
  const value = draft ?? (pack ? buildResourceRepresentativeDraft(pack) : null);
  const update = (patch: Partial<ResourceRepresentativeDraft>): void => {
    if (value) onDraftChange?.({ ...value, ...patch });
  };
  return (
    <section className="resource-stage" aria-labelledby="resource-test-heading">
      <div className="resource-stage-head">
        <p className="resource-kicker">05 / Test</p>
        <h2 id="resource-test-heading">Run the exact approved pack</h2>
        <p>Deterministic testing makes no external call and never attempts payment or settlement.</p>
      </div>
      {pack && value ? (
        <div className="resource-representative-grid">
          <label className="resource-field resource-representative-input">
            <span>Representative input</span>
            <textarea
              value={value.inputJson}
              onChange={(event) => update({ inputJson: event.target.value })}
              disabled={busy}
              rows={6}
              spellCheck={false}
              aria-describedby="resource-representative-input-help"
            />
            <small id="resource-representative-input-help">
              One canonical JSON object is checked against the approved input schema and used unchanged by Test, Publish, and live execution.
            </small>
          </label>
          <div className="resource-representative-fields">
            <strong>Declared filters</strong>
            {pack.content.filterFields.length > 0 ? (
              <p>
                The input must contain exactly <code>{pack.content.filterFields.join(", ")}</code>.
              </p>
            ) : <p>The input must be an empty object. This proof must still return at least one record.</p>}
          </div>
          <fieldset className="resource-representative-fields">
            <legend>Expected output properties</legend>
            <div className="resource-check-list">
              {pack.content.returnFields.map((field) => (
                <label key={field}>
                  <input
                    type="checkbox"
                    checked={value.expectedProperties.includes(field)}
                    disabled={busy}
                    onChange={(event) => update({
                      expectedProperties: event.target.checked
                        ? [...value.expectedProperties, field]
                        : value.expectedProperties.filter((property) => property !== field),
                    })}
                  />
                  <code>{field}</code>
                </label>
              ))}
            </div>
          </fieldset>
          <label className="resource-field resource-representative-limit">
            <span>Result limit</span>
            <input
              type="number"
              min="1"
              max="100"
              step="1"
              value={value.limit}
              disabled={busy}
              onChange={(event) => update({ limit: event.target.value })}
            />
          </label>
          {draftInvalid && (
            <p className="resource-field-error" role="alert">
              Use a JSON object with exactly the declared filter keys, select at least one expected property, and choose a limit from 1 to 100.
            </p>
          )}
        </div>
      ) : null}
      <div className="resource-form-action">
        <button
          type="button"
          className="lp-btn lp-btn--primary"
          onClick={onRun}
          disabled={busy || pack === null || value === null || draftInvalid}
        >
          {busy ? "Testing…" : "Run representative test"}
        </button>
      </div>
      {result ? (
        <>
          <dl className="resource-fact-strip">
            <div><dt>Measured cost</dt><dd className="tabular">${result.measuredCostUsdc.toFixed(6)}</dd></div>
            <div><dt>Payment</dt><dd>No settlement attempted</dd></div>
            <div><dt>Freshness</dt><dd>{result.resourceReceipt.freshness.slice(0, 1).toUpperCase() + result.resourceReceipt.freshness.slice(1)}</dd></div>
            <div><dt>Receipt</dt><dd><code>{result.resourceReceipt.resourceVersion}</code></dd></div>
            <div><dt>Semantic hash</dt><dd><code>{result.semanticHash}</code></dd></div>
          </dl>
          <div className="resource-receipt-line" aria-label="Test receipt facts">
            <span>Evidence {result.resourceReceipt.evidence.length}</span>
            <span>Unknowns {result.resourceReceipt.unknowns.length}</span>
            <span>Conflicts {result.resourceReceipt.conflicts.length}</span>
            <span>Schema {result.outputSchemaValid ? "valid" : "invalid"}</span>
          </div>
          <pre>{JSON.stringify(result.result, null, 2)}</pre>
        </>
      ) : <p className="resource-state">No test receipt yet.</p>}
    </section>
  );
}
