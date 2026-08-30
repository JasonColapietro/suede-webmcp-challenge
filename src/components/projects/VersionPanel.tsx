"use client";

import { useId } from "react";
import type { FlowVersionSummary } from "@/lib/projects/types";
import type { VersionHistoryState } from "@/lib/projects/ui-model";
import { versionPanelView } from "@/lib/projects/ui-model";

function shortHash(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 12)}…` : hash;
}

export default function VersionPanel({
  state,
  readOnly,
  canSave,
  saving,
  announcement = null,
  defaultOpen = false,
  onSave,
  onRetry,
  onReview,
}: {
  readonly state: VersionHistoryState;
  readonly readOnly: boolean;
  readonly canSave: boolean;
  readonly saving: boolean;
  readonly announcement?: string | null;
  readonly defaultOpen?: boolean;
  readonly onSave?: () => void;
  readonly onRetry?: () => void;
  readonly onReview?: (version: FlowVersionSummary, trigger: HTMLButtonElement) => void;
}): React.JSX.Element {
  const regionId = useId();
  const model = versionPanelView(state, { readOnly, saving, canSave });

  return (
    <section className="version-panel" aria-label="Version history">
      <details className="version-panel__details" open={defaultOpen || undefined}>
        <summary className="version-panel__summary" aria-controls={regionId}>
          <span>
            <span className="version-panel__title">Versions</span>
            <span className="version-panel__count">{model.countLabel}</span>
          </span>
          <span aria-hidden="true" className="version-panel__chevron">⌄</span>
        </summary>
        <div id={regionId} className="version-panel__body" aria-busy={model.busy || undefined}>
          {model.items.length > 0 ? (
            <ol className="version-ledger" aria-label="Saved versions, newest first">
              {model.items.map((item) => (
                <li key={item.id} className="version-ledger__item">
                  {!readOnly && onReview ? <button type="button" className="version-ledger__review" onClick={(event) => onReview(item, event.currentTarget)}>
                    <span className="version-ledger__marker" aria-hidden="true" />
                    <span className="version-ledger__number">v{item.versionNumber}</span>
                    <span className="version-ledger__copy">
                      <span className="version-ledger__hash" title={item.semanticHash}>{shortHash(item.semanticHash)}</span>
                      {item.label ? <strong>{item.label}</strong> : null}
                      {item.description ? <small>{item.description}</small> : null}
                    </span>
                    <span className="version-ledger__pins">{item.dependencyCount} {item.dependencyCount === 1 ? "pin" : "pins"}</span>
                  </button> : <div className="version-ledger__review version-ledger__review--readonly">
                    <span className="version-ledger__marker" aria-hidden="true" />
                    <span className="version-ledger__number">v{item.versionNumber}</span>
                    <span className="version-ledger__copy">
                      <span className="version-ledger__hash" title={item.semanticHash}>{shortHash(item.semanticHash)}</span>
                      {item.label ? <strong>{item.label}</strong> : null}
                      {item.description ? <small>{item.description}</small> : null}
                    </span>
                    <span className="version-ledger__pins">{item.dependencyCount} {item.dependencyCount === 1 ? "pin" : "pins"}</span>
                  </div>}
                </li>
              ))}
            </ol>
          ) : null}
          {readOnly ? (
            <p className="version-panel__readonly">Read-only on this screen size.</p>
          ) : null}
        </div>
      </details>
      {model.message || (model.canRetry && onRetry) || (model.showSave && onSave) ? (
        <div className="version-panel__footer" aria-busy={model.busy || undefined}>
          {model.message ? <p className="version-panel__message">{model.message}</p> : null}
          {model.canRetry && onRetry ? (
            <button type="button" className="version-panel__action" onClick={onRetry}>
              Retry
            </button>
          ) : null}
          {model.showSave && onSave ? (
            <button
              type="button"
              className="version-panel__save"
              disabled={model.saveDisabled}
              onClick={onSave}
            >
              {saving ? "Saving version…" : "Save version"}
            </button>
          ) : null}
        </div>
      ) : null}
      <p className="version-panel__live" role="status" aria-live="polite" aria-atomic="true">
        {announcement ?? model.announcement ?? model.message}
      </p>
    </section>
  );
}
