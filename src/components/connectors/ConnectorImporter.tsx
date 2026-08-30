"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ConnectorClientError,
  createConnectorClient,
  type ConnectorClient,
} from "@/lib/connectors/client";
import type {
  ConnectorOperationEnvelope,
  OpenApiReviewEnvelope,
} from "@/lib/connectors/api-contract";

export const CONNECTOR_SOURCE_MAX_BYTES = 2 * 1024 * 1024;
const ENCODER = new TextEncoder();

export type OpenApiSourceInspection =
  | Readonly<{ ok: true; bytes: number }>
  | Readonly<{ ok: false; reason: "empty" | "too-large" }>;

export function inspectOpenApiSource(source: string): OpenApiSourceInspection {
  if (source.length > CONNECTOR_SOURCE_MAX_BYTES) return Object.freeze({ ok: false, reason: "too-large" });
  if (source.trim().length === 0) return Object.freeze({ ok: false, reason: "empty" });
  const bytes = ENCODER.encode(source).byteLength;
  return bytes > CONNECTOR_SOURCE_MAX_BYTES
    ? Object.freeze({ ok: false, reason: "too-large" })
    : Object.freeze({ ok: true, bytes });
}

export function acceptsLocalJsonFile(
  file: Readonly<Pick<File, "name" | "type" | "size">>,
): boolean {
  return file.size <= CONNECTOR_SOURCE_MAX_BYTES &&
    file.name.toLowerCase().endsWith(".json") &&
    file.type.toLowerCase() === "application/json";
}

export type DecodedLocalJson =
  | Readonly<{ ok: true; source: string; bytes: number }>
  | Readonly<{ ok: false; reason: "file-type" | "empty" | "too-large" | "invalid-utf8" }>;

export async function decodeLocalJsonFile(
  file: Readonly<Pick<File, "name" | "type" | "size" | "arrayBuffer">>,
): Promise<DecodedLocalJson> {
  if (!acceptsLocalJsonFile(file)) return Object.freeze({ ok: false, reason: file.size > CONNECTOR_SOURCE_MAX_BYTES ? "too-large" : "file-type" });
  let bytes: ArrayBuffer;
  try { bytes = await file.arrayBuffer(); } catch { return Object.freeze({ ok: false, reason: "invalid-utf8" }); }
  if (bytes.byteLength > CONNECTOR_SOURCE_MAX_BYTES || bytes.byteLength !== file.size) {
    return Object.freeze({ ok: false, reason: "too-large" });
  }
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch {
    return Object.freeze({ ok: false, reason: "invalid-utf8" });
  }
  const inspection = inspectOpenApiSource(source);
  return inspection.ok
    ? Object.freeze({ ok: true, source, bytes: inspection.bytes })
    : Object.freeze({ ok: false, reason: inspection.reason });
}

export type OwnedCallResult<Value> =
  | Readonly<{ status: "success"; value: Value }>
  | Readonly<{ status: "refusal"; error: unknown }>
  | Readonly<{ status: "stale" }>;

export async function settleOwnedCall<Value>(
  run: () => Promise<Value>,
  isCurrent: () => boolean,
): Promise<OwnedCallResult<Value>> {
  try {
    const value = await run();
    return isCurrent() ? Object.freeze({ status: "success", value }) : Object.freeze({ status: "stale" });
  } catch (error) {
    return isCurrent() ? Object.freeze({ status: "refusal", error }) : Object.freeze({ status: "stale" });
  }
}

export interface ConnectorImporterProps {
  readonly client?: ConnectorClient;
  readonly onOpenInStudio?: (operationVersionId: string) => void;
}

const control: React.CSSProperties = {
  minHeight: 44,
  border: "1px solid var(--hairline)",
  borderRadius: "var(--radius-sm)",
  background: "var(--ink-control)",
  color: "var(--text-primary)",
  fontFamily: "var(--font-ui)",
  padding: "10px 12px",
};

function fixedFailure(error: unknown): string {
  if (!(error instanceof ConnectorClientError)) {
    return "API review could not finish. Check the file and try again.";
  }
  if (error.error === "payload too large") return "The local JSON file exceeds the 2 MiB review limit.";
  if (error.error === "unsupported media type") return "Choose a local .json file with JSON media type.";
  if (error.error === "import refused") return "API review refused this document. Check the supported OpenAPI subset.";
  if (error.error === "conflict") return "The API changed while this review was open. Review the local file again.";
  if (error.error === "rate limited") return "API review is temporarily limited. Try again after the current review settles.";
  if (error.error === "request cancelled") return "API review was cancelled.";
  return "API review is unavailable. No raw JSON was retained.";
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 8)}…${hash.slice(-8)}`;
}

export default function ConnectorImporter({
  client: suppliedClient,
  onOpenInStudio,
}: ConnectorImporterProps): React.JSX.Element {
  const client = useMemo(() => suppliedClient ?? createConnectorClient(), [suppliedClient]);
  const [displayLabel, setDisplayLabel] = useState("");
  const [rawSource, setRawSource] = useState("");
  const rawSourceRef = useRef("");
  const [review, setReview] = useState<OpenApiReviewEnvelope["review"] | null>(null);
  const [selectedOperationId, setSelectedOperationId] = useState("");
  const [materialized, setMaterialized] = useState<ConnectorOperationEnvelope | null>(null);
  const [busy, setBusy] = useState<"review" | "materialize" | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [correlationId, setCorrelationId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const reviewHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);

  const clearRawSource = useCallback((): void => {
    rawSourceRef.current = "";
    setRawSource("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  useEffect(() => {
    // The file input is rendered unconditionally by this component, so the node
    // captured here is the one that exists for its whole life. Clearing the
    // selection on unmount is defensive either way — the node is being thrown
    // away — but capturing it keeps the rule satisfied without a suppression.
    const fileInput = fileInputRef.current;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      requestRef.current?.abort();
      rawSourceRef.current = "";
      if (fileInput) fileInput.value = "";
    };
  }, []);

  const updateSource = (value: string): void => {
    generationRef.current += 1;
    requestRef.current?.abort();
    requestRef.current = null;
    setBusy(null);
    rawSourceRef.current = value;
    setRawSource(value);
    setReview(null);
    setSelectedOperationId("");
    setMaterialized(null);
    setCorrelationId(null);
    setAnnouncement("");
  };

  const updateDisplayLabel = (value: string): void => {
    generationRef.current += 1;
    requestRef.current?.abort();
    requestRef.current = null;
    setBusy(null);
    setDisplayLabel(value);
    setReview(null);
    setSelectedOperationId("");
    setMaterialized(null);
    setCorrelationId(null);
    setAnnouncement("");
  };

  const sourceInspection = inspectOpenApiSource(rawSource);
  const labelReady = displayLabel.trim().length > 0;
  const disabledReason = !labelReady
    ? "Add a display label."
    : !sourceInspection.ok
      ? sourceInspection.reason === "too-large" ? "Source must be 2 MiB or smaller." : "Paste or choose local JSON."
      : null;

  const chooseFile = useCallback(async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.currentTarget.files?.[0];
    generationRef.current += 1;
    requestRef.current?.abort();
    requestRef.current = null;
    setBusy(null);
    const generation = generationRef.current;
    setReview(null);
    setMaterialized(null);
    setCorrelationId(null);
    if (!file || !acceptsLocalJsonFile(file)) {
      clearRawSource();
      setAnnouncement("Choose a local .json file with JSON media type, no larger than 2 MiB.");
      return;
    }
    try {
      const decoded = await decodeLocalJsonFile(file);
      if (generation !== generationRef.current || !mountedRef.current) return;
      if (!decoded.ok) {
        clearRawSource();
        setAnnouncement(decoded.reason === "too-large"
          ? "The local JSON file exceeds the 2 MiB review limit."
          : decoded.reason === "empty"
            ? "The local JSON file is empty."
            : decoded.reason === "file-type"
              ? "Choose a local .json file with JSON media type, no larger than 2 MiB."
              : "The local JSON file is not valid UTF-8 JSON text. No source was retained.");
        return;
      }
      updateSource(decoded.source);
      setAnnouncement(`Local JSON ready for review. ${decoded.bytes.toLocaleString()} UTF-8 bytes.`);
    } catch {
      if (generation !== generationRef.current || !mountedRef.current) return;
      clearRawSource();
      setAnnouncement("The local JSON file is not valid UTF-8 JSON text. No source was retained.");
    }
  }, [clearRawSource]);

  const submitReview = useCallback(async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    const inspected = inspectOpenApiSource(rawSourceRef.current);
    if (!labelReady || !inspected.ok || busy !== null) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const generation = ++generationRef.current;
    setBusy("review");
    setAnnouncement("Reviewing the local JSON into a sanitized API index.");
    setReview(null);
    setMaterialized(null);
    setCorrelationId(null);
    const outcome = await settleOwnedCall(() => client.reviewOpenApi({
        displayLabel: displayLabel.trim(),
        source: rawSourceRef.current,
      }, controller.signal), () => generation === generationRef.current && mountedRef.current);
    try {
      if (outcome.status === "stale") return;
      if (outcome.status === "refusal") {
        setAnnouncement(fixedFailure(outcome.error));
        if (outcome.error instanceof ConnectorClientError) setCorrelationId(outcome.error.correlationId ?? null);
        return;
      }
      setReview(outcome.value.review);
      setSelectedOperationId(outcome.value.review.operations[0]?.operationId ?? "");
      setCorrelationId(outcome.value.review.correlationId);
      setAnnouncement("Sanitized API review ready. Raw JSON was cleared.");
      queueMicrotask(() => reviewHeadingRef.current?.focus());
    } finally {
      if (generation === generationRef.current && mountedRef.current) {
        clearRawSource();
        if (requestRef.current === controller) requestRef.current = null;
        setBusy(null);
      }
    }
  }, [busy, clearRawSource, client, displayLabel, labelReady]);

  const materialize = useCallback(async (): Promise<void> => {
    if (!review || selectedOperationId.length === 0 || busy !== null) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const generation = ++generationRef.current;
    setBusy("materialize");
    setAnnouncement("Materializing the selected immutable operation version.");
    setMaterialized(null);
    const outcome = await settleOwnedCall(() => client.addOperation(review.identity.id, {
        connectorDefinitionVersionId: review.definition.id,
        operationId: selectedOperationId,
      }, controller.signal), () => generation === generationRef.current && mountedRef.current);
    try {
      if (outcome.status === "stale") return;
      if (outcome.status === "refusal") {
        setAnnouncement(fixedFailure(outcome.error));
        if (outcome.error instanceof ConnectorClientError) setCorrelationId(outcome.error.correlationId ?? null);
        return;
      }
      setMaterialized(outcome.value);
      setCorrelationId(outcome.value.correlationId);
      setAnnouncement("Operation version ready for Studio selection.");
    } finally {
      if (generation === generationRef.current && mountedRef.current) {
        clearRawSource();
        if (requestRef.current === controller) requestRef.current = null;
        setBusy(null);
      }
    }
  }, [busy, clearRawSource, client, review, selectedOperationId]);

  return (
    <section className="connector-importer" aria-labelledby="connector-import-title">
      <style>{`
        .connector-importer { display: grid; gap: 18px; }
        .connector-importer__stage { background: var(--ink-panel); border: 1px solid var(--hairline); border-radius: var(--radius); box-shadow: var(--shadow-sm); padding: clamp(18px, 3vw, 28px); }
        .connector-importer__grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(220px, .55fr); gap: 14px; }
        .connector-importer__receipt { display: grid; gap: 8px; padding: 14px; border-left: 3px solid var(--primary); background: var(--canvas-bg); font-family: var(--font-mono); font-size: var(--text-xs); overflow-wrap: anywhere; }
        .connector-importer button:focus-visible, .connector-importer input:focus-visible, .connector-importer textarea:focus-visible, .connector-importer a:focus-visible { outline: 3px solid var(--primary); outline-offset: 2px; }
        @media (max-width: 720px) { .connector-importer__grid { grid-template-columns: 1fr; } }
        @media (prefers-reduced-motion: reduce) { .connector-importer * { scroll-behavior: auto !important; transition: none !important; } }
      `}</style>
      <header>
        <p className="eyebrow" style={{ color: "var(--primary)", margin: 0 }}>Prototype: simulation only</p>
        <h2 id="connector-import-title" style={{ margin: "8px 0", fontFamily: "var(--font-display)", fontWeight: 400 }}>
          Review a local OpenAPI file
        </h2>
        <p style={{ color: "var(--text-muted)", maxWidth: 760, lineHeight: 1.6 }}>
          The sanitized API index is created or reused. Raw JSON is kept only in this tab while review is pending and is never retained after the request settles.
        </p>
      </header>

      <form className="connector-importer__stage" onSubmit={(event) => void submitReview(event)} aria-busy={busy === "review"}>
        <p className="eyebrow">Stage A · sanitize and review</p>
        <div className="connector-importer__grid">
          <label>
            API display label
            <input
              aria-label="API display label"
              autoComplete="off"
              value={displayLabel}
              disabled={busy !== null}
              onChange={(event) => updateDisplayLabel(event.target.value)}
              style={{ ...control, display: "block", width: "100%", marginTop: 6 }}
              maxLength={120}
              required
            />
          </label>
          <label>
            Local JSON file
            <input
              ref={fileInputRef}
              aria-label="Local OpenAPI JSON file"
              type="file"
              disabled={busy !== null}
              accept=".json,application/json"
              onChange={(event) => void chooseFile(event)}
              style={{ ...control, display: "block", width: "100%", marginTop: 6 }}
            />
          </label>
        </div>
        <label style={{ display: "block", marginTop: 14 }}>
          Or paste local JSON
          <textarea
            aria-label="OpenAPI JSON source"
            autoComplete="off"
            spellCheck={false}
            value={rawSource}
            disabled={busy !== null}
            maxLength={CONNECTOR_SOURCE_MAX_BYTES}
            onChange={(event) => updateSource(event.target.value)}
            style={{ ...control, display: "block", width: "100%", minHeight: 180, marginTop: 6, fontFamily: "var(--font-mono)", resize: "vertical" }}
          />
        </label>
        <p id="connector-review-disabled" style={{ minHeight: 22, color: disabledReason ? "var(--text-warning)" : "var(--text-muted)" }}>
          {disabledReason ?? `${sourceInspection.ok ? sourceInspection.bytes.toLocaleString() : 0} of ${CONNECTOR_SOURCE_MAX_BYTES.toLocaleString()} UTF-8 bytes.`}
        </p>
        <button
          type="submit"
          disabled={disabledReason !== null || busy !== null}
          aria-describedby="connector-review-disabled"
          style={{ ...control, background: "var(--primary)", color: "var(--on-primary)", borderColor: "var(--primary)", cursor: disabledReason === null ? "pointer" : "not-allowed" }}
        >
          {busy === "review" ? "Reviewing local JSON" : "Create sanitized review"}
        </button>
      </form>

      {review ? (
        <section className="connector-importer__stage" aria-labelledby="connector-review-heading">
          <p className="eyebrow">Stage B · choose one operation</p>
          <h3 id="connector-review-heading" ref={reviewHeadingRef} tabIndex={-1} style={{ marginTop: 6 }}>
            Sanitized API review
          </h3>
          <p style={{ color: "var(--text-warning)", lineHeight: 1.5 }}>
            Operation IDs and paths are untrusted public metadata. They must not contain secrets.
          </p>
          <div className="connector-importer__receipt" aria-label="Sanitized review receipt">
            <span>API {review.identityDisposition}</span>
            <span>Definition v{review.definition.versionNumber} · {review.definitionDisposition}</span>
            <span>Connector projection hash {shortHash(review.definition.connectorProjectionHash)}</span>
            <span>{review.drift ? `Drift reviewed: v${review.drift.before.versionNumber} → v${review.drift.after.versionNumber}` : "No projection drift"}</span>
            <span>{review.refusedOperationCount} unsupported operations omitted</span>
          </div>
          {review.operations.length === 0 ? (
            <p role="alert">No supported operations were available to materialize.</p>
          ) : (
            <fieldset style={{ border: 0, padding: 0, margin: "18px 0" }}>
              <legend>Select exactly one operation</legend>
              <div role="radiogroup" style={{ display: "grid", gap: 8, marginTop: 10 }}>
                {review.operations.map((operation) => (
                  <label key={operation.operationId} style={{ ...control, display: "grid", gridTemplateColumns: "auto 1fr", alignItems: "center", gap: 10 }}>
                    <input
                      type="radio"
                      name="connector-operation"
                      value={operation.operationId}
                      checked={selectedOperationId === operation.operationId}
                      onChange={() => setSelectedOperationId(operation.operationId)}
                    />
                    <span><strong>{operation.method}</strong> <span className="mono">{operation.path}</span></span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <button
            type="button"
            onClick={() => void materialize()}
            disabled={selectedOperationId.length === 0 || busy !== null}
            style={{ ...control, background: "var(--primary)", color: "var(--on-primary)", borderColor: "var(--primary)" }}
          >
            {busy === "materialize" ? "Materializing operation" : "Add operation version"}
          </button>
        </section>
      ) : null}

      {materialized ? (
        <section className="connector-importer__stage" aria-label="Materialization receipt">
          <p className="eyebrow">Operation ready</p>
          <div className="connector-importer__receipt">
            <span>Operation {materialized.disposition}</span>
            <span>{materialized.operation.operationId}</span>
            <span>Operation projection hash {shortHash(materialized.operation.operationProjectionHash)}</span>
            <span>Schema hash {shortHash(materialized.operation.schemaHash)}</span>
            <span>Cannot run in published workflows</span>
          </div>
          {onOpenInStudio ? (
            <button type="button" onClick={() => onOpenInStudio(materialized.operation.id)} style={{ ...control, marginTop: 14 }}>
              Open in Studio
            </button>
          ) : (
            <a
              href={`/dashboard?operationVersionId=${encodeURIComponent(materialized.operation.id)}`}
              style={{ ...control, display: "inline-flex", alignItems: "center", marginTop: 14, textDecoration: "none" }}
            >
              Choose a workflow in Studio
            </a>
          )}
        </section>
      ) : null}

      <p aria-live="polite" role="status" style={{ minHeight: 24, color: "var(--primary)", margin: 0 }}>
        {announcement}
      </p>
      {correlationId ? <p className="mono" style={{ color: "var(--text-muted)", fontSize: "var(--text-xs)" }}>Correlation {correlationId}</p> : null}
    </section>
  );
}
