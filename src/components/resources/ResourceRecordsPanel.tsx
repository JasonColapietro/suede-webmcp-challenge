"use client";

import { useMemo, useState, type RefObject } from "react";
import type { ResourcePackBundle, ResourcePackPointer } from "./client";

export default function ResourceRecordsPanel({
  pack,
  pointer,
  busy,
  triggerRef,
  onRequestApprove,
}: {
  readonly pack: ResourcePackBundle | null;
  readonly pointer: ResourcePackPointer | null;
  readonly busy: boolean;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly onRequestApprove: () => void;
}): React.JSX.Element {
  const pageSize = 10;
  const [page, setPage] = useState(0);
  const records = pack?.content.records ?? [];
  const evidence = useMemo(() => pack?.content.evidence ?? [], [pack?.content.evidence]);
  const pageCount = Math.max(1, Math.ceil(records.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const visibleRecords = records.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const evidenceById = useMemo(
    () => new Map(evidence.map((pointer) => [pointer.id, pointer])),
    [evidence],
  );
  const unknowns = records.flatMap((record) => record.unknowns ?? []);
  const conflicts = records.flatMap((record) => record.conflicts ?? []);
  return (
    <section className="resource-stage" aria-labelledby="resource-records-heading">
      <div className="resource-stage-head">
        <p className="resource-kicker">03 / Records</p>
        <h2 id="resource-records-heading">Review the exact pack</h2>
        <p>Schema, evidence, unknowns, and conflicts remain visible. Approval creates an immutable version.</p>
      </div>
      <dl className="resource-fact-strip">
        <div><dt>Pack</dt><dd><code>{pack?.packVersionId ?? "Not available"}</code></dd></div>
        <div><dt>Semantic hash</dt><dd><code className="resource-hash">{pack?.semanticHash ?? "Not available"}</code></dd></div>
        <div><dt>Contents</dt><dd>{records.length} {records.length === 1 ? "record" : "records"}</dd></div>
        <div><dt>Support</dt><dd>{evidence.length} evidence {evidence.length === 1 ? "pointer" : "pointers"}</dd></div>
      </dl>
      {records.length === 0 && evidence.length === 0 && (
        <div className="resource-empty-pack" role="status">
          <b>This pack is honestly empty: 0 records and 0 evidence pointers.</b>
          <span>You can approve an empty pack, but publication requires a representative test that returns at least one record.</span>
        </div>
      )}
      <div className="resource-split resource-split--records">
        <div>
          <h3>Record schema</h3>
          <pre>{pack ? JSON.stringify(pack.content.recordSchema, null, 2) : "Not available"}</pre>
        </div>
        <div className="resource-review-list">
          <h3>Review findings</h3>
          <p><b>Unknowns</b> {unknowns.length === 0 ? "None recorded" : unknowns.join(", ")}</p>
          <p><b>Conflicts</b> {conflicts.length === 0 ? "None recorded" : conflicts.join(", ")}</p>
          <p><b>Source freshness</b> {pack?.freshness ?? "Not recorded"}</p>
        </div>
      </div>
      {records.length > 0 && (
        <div className="resource-record-register" aria-label="Pack records">
          {visibleRecords.map((record) => {
            const support = record.evidenceIds.flatMap((id) => {
              const pointer = evidenceById.get(id);
              return pointer ? [pointer] : [];
            });
            return (
              <article key={record.id} className="resource-record-row">
                <div className="resource-record-id">
                  <span>Record</span>
                  <code>{record.id}</code>
                </div>
                <div>
                  <span className="resource-register-label">Fields</span>
                  <pre>{JSON.stringify(record.fields, null, 2)}</pre>
                </div>
                <div className="resource-record-support">
                  <span className="resource-register-label">Evidence</span>
                  {support.length === 0 ? (
                    <p>No evidence pointer recorded.</p>
                  ) : support.map((pointer) => (
                    <p key={pointer.id}>
                      <code>{pointer.locator}</code>
                      <span>Observed {pointer.observedAt}</span>
                    </p>
                  ))}
                  <p><b>Unknowns</b> {(record.unknowns ?? []).join(", ") || "None recorded"}</p>
                  <p><b>Conflicts</b> {(record.conflicts ?? []).join(", ") || "None recorded"}</p>
                </div>
              </article>
            );
          })}
          <div className="resource-record-pagination" aria-label="Record pages">
            <span>Page {safePage + 1} of {pageCount}</span>
            <button type="button" className="lp-btn lp-btn--ghost lp-btn--sm" disabled={safePage === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>Previous</button>
            <button type="button" className="lp-btn lp-btn--ghost lp-btn--sm" disabled={safePage >= pageCount - 1} onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}>Next</button>
          </div>
        </div>
      )}
      {pointer && (
        <div className="resource-form-action">
          <button
            ref={triggerRef}
            type="button"
            className="lp-btn lp-btn--primary"
            disabled={busy || pack === null || pointer.status !== "candidate"}
            onClick={onRequestApprove}
          >
            {pointer.status === "candidate" ? "Review and approve pack" : "Pack approved"}
          </button>
        </div>
      )}
    </section>
  );
}
