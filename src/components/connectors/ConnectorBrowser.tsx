"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ConnectorClientError,
  createConnectorClient,
  type ConnectorClient,
} from "@/lib/connectors/client";
import type {
  ConnectorEnvelope,
  ConnectorListEnvelope,
  ConnectorOperationVersionSummary,
  OperationClosuresEnvelope,
} from "@/lib/connectors/api-contract";
import type { ConnectorIdentityView } from "@/lib/connectors/repository";
import type { ApiOperationBrowserClosureProjection } from "@/lib/connectors/operation-closure";

export interface ConnectorBrowserProps {
  readonly client?: ConnectorClient;
  readonly mode: "manage" | "pick";
  readonly onPick?: (closure: ApiOperationBrowserClosureProjection) => void;
  readonly onClose?: () => void;
  readonly returnFocusRef?: React.RefObject<HTMLElement | null>;
}

export interface ConnectorDetails {
  readonly connector: ConnectorEnvelope;
  readonly operations: readonly ConnectorOperationVersionSummary[];
  readonly operationsCursor: string | null;
}

export async function loadConnectorBrowserPage(
  client: ConnectorClient,
  input: Readonly<{ cursor?: string; search: string; includeArchived: boolean; limit?: number }>,
  signal: AbortSignal,
): Promise<ConnectorListEnvelope> {
  return client.list({
    limit: input.limit ?? 30,
    search: input.search.length > 0 ? input.search : undefined,
    includeArchived: input.includeArchived,
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
  }, signal);
}

export async function loadConnectorBrowserDetails(
  client: ConnectorClient,
  connectorId: string,
  signal: AbortSignal,
): Promise<ConnectorDetails> {
  const [connector, operations] = await Promise.all([
    client.get(connectorId, { limit: 30 }, signal),
    client.listOperations(connectorId, { limit: 30 }, signal),
  ]);
  return Object.freeze({ connector, operations: operations.operations, operationsCursor: operations.nextCursor });
}

export async function renameConnectorForBrowser(
  client: ConnectorClient,
  connector: ConnectorIdentityView,
  displayLabel: string,
  signal: AbortSignal,
): Promise<Readonly<{ connector: ConnectorIdentityView }>> {
  return client.rename(connector.id, {
    action: "rename",
    displayLabel,
    expectedLifecycleRevision: connector.lifecycleRevision,
  }, signal);
}

export async function archiveConnectorForBrowser(
  client: ConnectorClient,
  connector: ConnectorIdentityView,
  signal: AbortSignal,
): Promise<Readonly<{ connector: ConnectorIdentityView }>> {
  return client.archive(connector.id, connector.lifecycleRevision, signal);
}

export type OwnedPickerResult =
  | Readonly<{ status: "resolved"; closure: ApiOperationBrowserClosureProjection }>
  | Readonly<{ status: "repair" }>
  | Readonly<{ status: "refusal"; error: unknown }>
  | Readonly<{ status: "stale" }>;

export type OwnedBrowserCall<Value> =
  | Readonly<{ status: "success"; value: Value }>
  | Readonly<{ status: "refusal"; error: unknown }>
  | Readonly<{ status: "stale" }>;

export async function settleOwnedBrowserCall<Value>(
  run: () => Promise<Value>,
  isCurrent: () => boolean,
): Promise<OwnedBrowserCall<Value>> {
  try {
    const value = await run();
    return isCurrent() ? Object.freeze({ status: "success", value }) : Object.freeze({ status: "stale" });
  } catch (error) {
    return isCurrent() ? Object.freeze({ status: "refusal", error }) : Object.freeze({ status: "stale" });
  }
}

export function connectorBrowserWorkAvailable(busyAction: string | null, loadingDetails: boolean): boolean {
  return busyAction === null && !loadingDetails;
}

export async function resolveOwnedPickerClosure(input: Readonly<{
  client: ConnectorClient;
  operationVersionId: string;
  signal: AbortSignal;
  isCurrent: () => boolean;
}>): Promise<OwnedPickerResult> {
  try {
    const envelope = await input.client.resolveOperations([input.operationVersionId], input.signal);
    if (!input.isCurrent()) return Object.freeze({ status: "stale" });
    const closure = resolvedPickerClosure(envelope, input.operationVersionId);
    return closure
      ? Object.freeze({ status: "resolved", closure })
      : Object.freeze({ status: "repair" });
  } catch (error) {
    return input.isCurrent()
      ? Object.freeze({ status: "refusal", error })
      : Object.freeze({ status: "stale" });
  }
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

export function connectorBrowserDisplayLabel(
  connector: Readonly<Pick<ConnectorIdentityView, "id" | "displayLabel">>,
): string {
  return `${connector.displayLabel} · …${connector.id.slice(-6)}`;
}

export function resolvedPickerClosure(
  envelope: OperationClosuresEnvelope,
  operationVersionId: string,
): ApiOperationBrowserClosureProjection | null {
  if (envelope.closures.length !== 1) return null;
  const closure = envelope.closures[0];
  return closure?.reference.operationVersionId === operationVersionId && closure.archivedAt === null
    ? closure
    : null;
}

function fixedFailure(error: unknown): string {
  if (!(error instanceof ConnectorClientError)) return "Connector metadata is unavailable. Try again.";
  if (error.error === "request cancelled") return "Connector request cancelled.";
  if (error.error === "conflict") return "Connector metadata changed. Reload it before trying again.";
  if (error.error === "not found") return "Connector metadata is unavailable or archived.";
  if (error.error === "rate limited") return "Connector requests are temporarily limited. Try again shortly.";
  return "Connector metadata is unavailable. Try again.";
}

function appendUniqueConnectors(
  current: readonly ConnectorIdentityView[],
  next: readonly ConnectorIdentityView[],
): readonly ConnectorIdentityView[] {
  const byId = new Map(current.map((connector) => [connector.id, connector]));
  for (const connector of next) byId.set(connector.id, connector);
  return Object.freeze([...byId.values()]);
}

function appendUniqueOperations(
  current: readonly ConnectorOperationVersionSummary[],
  next: readonly ConnectorOperationVersionSummary[],
): readonly ConnectorOperationVersionSummary[] {
  const byId = new Map(current.map((operation) => [operation.operationVersionId, operation]));
  for (const operation of next) byId.set(operation.operationVersionId, operation);
  return Object.freeze([...byId.values()]);
}

export default function ConnectorBrowser({
  client: suppliedClient,
  mode,
  onPick,
  onClose,
  returnFocusRef,
}: ConnectorBrowserProps): React.JSX.Element {
  const client = useMemo(() => suppliedClient ?? createConnectorClient(), [suppliedClient]);
  const [queryInput, setQueryInput] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [connectors, setConnectors] = useState<readonly ConnectorIdentityView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [details, setDetails] = useState<ConnectorDetails | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const firstFocusRef = useRef<HTMLInputElement | null>(null);
  const listControllerRef = useRef<AbortController | null>(null);
  const detailControllerRef = useRef<AbortController | null>(null);
  const selectionControllerRef = useRef<AbortController | null>(null);
  const actionControllerRef = useRef<AbortController | null>(null);
  const listGenerationRef = useRef(0);
  const detailGenerationRef = useRef(0);
  const actionGenerationRef = useRef(0);
  const selectionGenerationRef = useRef(0);

  const invalidateDetailContext = useCallback((): void => {
    detailGenerationRef.current += 1;
    actionGenerationRef.current += 1;
    selectionGenerationRef.current += 1;
    detailControllerRef.current?.abort();
    actionControllerRef.current?.abort();
    selectionControllerRef.current?.abort();
    detailControllerRef.current = null;
    actionControllerRef.current = null;
    selectionControllerRef.current = null;
    setBusyAction(null);
    setLoadingDetails(false);
  }, []);

  const loadList = useCallback(async (input: Readonly<{
    cursor?: string;
    append: boolean;
    search: string;
    archived: boolean;
  }>): Promise<void> => {
    listControllerRef.current?.abort();
    const controller = new AbortController();
    listControllerRef.current = controller;
    const generation = ++listGenerationRef.current;
    setLoadingList(true);
    setAnnouncement(input.append ? "Loading more APIs." : "Loading API metadata.");
    try {
      const page = await loadConnectorBrowserPage(client, {
        cursor: input.cursor,
        search: input.search,
        includeArchived: input.archived,
      }, controller.signal);
      if (generation !== listGenerationRef.current || controller.signal.aborted) return;
      setConnectors((current) => input.append ? appendUniqueConnectors(current, page.connectors) : page.connectors);
      setNextCursor(page.nextCursor);
      setAnnouncement(page.connectors.length === 0 && !input.append ? "No APIs match this search." : "API metadata ready.");
    } catch (error) {
      if (generation !== listGenerationRef.current || controller.signal.aborted) return;
      setAnnouncement(fixedFailure(error));
      if (!input.append) setConnectors([]);
    } finally {
      if (generation === listGenerationRef.current) setLoadingList(false);
      if (listControllerRef.current === controller) listControllerRef.current = null;
    }
  }, [client]);

  useEffect(() => {
    void loadList({ append: false, search: "", archived: false });
    return () => {
      listGenerationRef.current += 1;
      detailGenerationRef.current += 1;
      actionGenerationRef.current += 1;
      selectionGenerationRef.current += 1;
      listControllerRef.current?.abort();
      detailControllerRef.current?.abort();
      actionControllerRef.current?.abort();
      selectionControllerRef.current?.abort();
      // Same reasoning as the generation/controller refs above, and the same as
      // CommandPalette: `returnFocusRef` is a prop aimed at a node the PARENT
      // renders, so focus has to go wherever it points when the browser closes,
      // not wherever it pointed when the browser opened.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      returnFocusRef?.current?.focus();
    };
  }, [client, loadList, returnFocusRef]);

  useEffect(() => {
    if (mode !== "pick") return;
    const element = dialogRef.current;
    if (element && !element.open && typeof element.showModal === "function") element.showModal();
    queueMicrotask(() => firstFocusRef.current?.focus());
  }, [mode]);

  const submitSearch = useCallback((event: React.FormEvent): void => {
    event.preventDefault();
    const normalized = queryInput.trim();
    invalidateDetailContext();
    setSubmittedQuery(normalized);
    setExpandedId(null);
    setDetails(null);
    void loadList({ append: false, search: normalized, archived: includeArchived });
  }, [includeArchived, invalidateDetailContext, loadList, queryInput]);

  const toggleArchived = useCallback((checked: boolean): void => {
    invalidateDetailContext();
    setIncludeArchived(checked);
    setExpandedId(null);
    setDetails(null);
    void loadList({ append: false, search: submittedQuery, archived: checked });
  }, [invalidateDetailContext, loadList, submittedQuery]);

  const expand = useCallback(async (connector: ConnectorIdentityView): Promise<void> => {
    if (expandedId === connector.id) {
      invalidateDetailContext();
      setExpandedId(null);
      setDetails(null);
      return;
    }
    invalidateDetailContext();
    const controller = new AbortController();
    detailControllerRef.current = controller;
    const generation = ++detailGenerationRef.current;
    setExpandedId(connector.id);
    setDetails(null);
    setRenameValue(connector.displayLabel);
    setLoadingDetails(true);
    setAnnouncement("Loading sanitized API history and operation versions.");
    try {
      const loaded = await loadConnectorBrowserDetails(client, connector.id, controller.signal);
      if (generation !== detailGenerationRef.current || controller.signal.aborted) return;
      setDetails(Object.freeze({
        connector: loaded.connector,
        operations: loaded.operations,
        operationsCursor: loaded.operationsCursor,
      }));
      setRenameValue(loaded.connector.connector.displayLabel);
      setAnnouncement("Sanitized API details ready.");
    } catch (error) {
      if (generation !== detailGenerationRef.current || controller.signal.aborted) return;
      setAnnouncement(fixedFailure(error));
    } finally {
      if (generation === detailGenerationRef.current) setLoadingDetails(false);
      if (detailControllerRef.current === controller) detailControllerRef.current = null;
    }
  }, [client, expandedId, invalidateDetailContext]);

  const loadMoreOperations = useCallback(async (): Promise<void> => {
    if (!details?.operationsCursor || !connectorBrowserWorkAvailable(busyAction, loadingDetails)) return;
    const connector = details.connector.connector;
    detailControllerRef.current?.abort();
    const controller = new AbortController();
    detailControllerRef.current = controller;
    const generation = ++detailGenerationRef.current;
    setLoadingDetails(true);
    try {
      const outcome = await settleOwnedBrowserCall(
        () => client.listOperations(connector.id, { limit: 30, cursor: details.operationsCursor! }, controller.signal),
        () => !controller.signal.aborted && generation === detailGenerationRef.current,
      );
      if (outcome.status === "stale") return;
      if (outcome.status === "refusal") throw outcome.error;
      const page = outcome.value;
      setDetails((current) => current && current.connector.connector.id === connector.id
        ? Object.freeze({ ...current, operations: appendUniqueOperations(current.operations, page.operations), operationsCursor: page.nextCursor })
        : current);
      setAnnouncement("More operation versions loaded.");
    } catch (error) {
      if (!controller.signal.aborted && generation === detailGenerationRef.current) setAnnouncement(fixedFailure(error));
    } finally {
      if (generation === detailGenerationRef.current) setLoadingDetails(false);
      if (detailControllerRef.current === controller) detailControllerRef.current = null;
    }
  }, [busyAction, client, details, loadingDetails]);

  const loadMoreDefinitions = useCallback(async (): Promise<void> => {
    if (!details?.connector.nextCursor || !connectorBrowserWorkAvailable(busyAction, loadingDetails)) return;
    const connectorId = details.connector.connector.id;
    detailControllerRef.current?.abort();
    const controller = new AbortController();
    detailControllerRef.current = controller;
    const generation = ++detailGenerationRef.current;
    setLoadingDetails(true);
    try {
      const outcome = await settleOwnedBrowserCall(
        () => client.get(connectorId, { limit: 30, cursor: details.connector.nextCursor! }, controller.signal),
        () => !controller.signal.aborted && generation === detailGenerationRef.current,
      );
      if (outcome.status === "stale") return;
      if (outcome.status === "refusal") throw outcome.error;
      const page = outcome.value;
      setDetails((current) => current && current.connector.connector.id === connectorId
        ? Object.freeze({
            ...current,
            connector: Object.freeze({
              connector: page.connector,
              history: Object.freeze([...current.connector.history, ...page.history]),
              nextCursor: page.nextCursor,
            }),
          })
        : current);
      setAnnouncement("More sanitized definition history loaded.");
    } catch (error) {
      if (!controller.signal.aborted && generation === detailGenerationRef.current) setAnnouncement(fixedFailure(error));
    } finally {
      if (generation === detailGenerationRef.current) setLoadingDetails(false);
      if (detailControllerRef.current === controller) detailControllerRef.current = null;
    }
  }, [busyAction, client, details, loadingDetails]);

  const addOperation = useCallback(async (
    connector: ConnectorIdentityView,
    definitionId: string,
    operationId: string,
  ): Promise<void> => {
    if (connector.archivedAt !== null || !connectorBrowserWorkAvailable(busyAction, loadingDetails)) return;
    actionControllerRef.current?.abort();
    const controller = new AbortController();
    actionControllerRef.current = controller;
    const generation = ++actionGenerationRef.current;
    setBusyAction(`add:${definitionId}:${operationId}`);
    setAnnouncement("Materializing the selected operation version.");
    try {
      const result = await client.addOperation(connector.id, {
        connectorDefinitionVersionId: definitionId,
        operationId,
      }, controller.signal);
      const page = await client.listOperations(connector.id, { limit: 30 }, controller.signal);
      if (controller.signal.aborted || generation !== actionGenerationRef.current || details?.connector.connector.id !== connector.id) return;
      setDetails((current) => current && current.connector.connector.id === connector.id
        ? Object.freeze({ ...current, operations: page.operations, operationsCursor: page.nextCursor })
        : current);
      setAnnouncement(`Operation ${result.disposition}.`);
    } catch (error) {
      if (!controller.signal.aborted && generation === actionGenerationRef.current) setAnnouncement(fixedFailure(error));
    } finally {
      if (generation === actionGenerationRef.current) setBusyAction(null);
      if (actionControllerRef.current === controller) actionControllerRef.current = null;
    }
  }, [busyAction, client, details, loadingDetails]);

  const rename = useCallback(async (): Promise<void> => {
    if (!details || !connectorBrowserWorkAvailable(busyAction, loadingDetails) || renameValue.trim().length === 0) return;
    const current = details.connector.connector;
    actionControllerRef.current?.abort();
    const controller = new AbortController();
    actionControllerRef.current = controller;
    const generation = ++actionGenerationRef.current;
    setBusyAction("rename");
    try {
      const result = await renameConnectorForBrowser(client, current, renameValue.trim(), controller.signal);
      if (controller.signal.aborted || generation !== actionGenerationRef.current || details.connector.connector.id !== current.id) return;
      setConnectors((items) => items.map((item) => item.id === result.connector.id ? result.connector : item));
      setDetails((state) => state?.connector.connector.id === current.id
        ? Object.freeze({ ...state, connector: Object.freeze({ ...state.connector, connector: result.connector }) })
        : state);
      setAnnouncement("API display label updated.");
    } catch (error) {
      if (!controller.signal.aborted && generation === actionGenerationRef.current) setAnnouncement(fixedFailure(error));
    } finally {
      if (generation === actionGenerationRef.current) setBusyAction(null);
      if (actionControllerRef.current === controller) actionControllerRef.current = null;
    }
  }, [busyAction, client, details, loadingDetails, renameValue]);

  const archive = useCallback(async (): Promise<void> => {
    if (!details || !connectorBrowserWorkAvailable(busyAction, loadingDetails)) return;
    const current = details.connector.connector;
    actionControllerRef.current?.abort();
    const controller = new AbortController();
    actionControllerRef.current = controller;
    const generation = ++actionGenerationRef.current;
    setBusyAction("archive");
    try {
      const result = await archiveConnectorForBrowser(client, current, controller.signal);
      if (controller.signal.aborted || generation !== actionGenerationRef.current || details.connector.connector.id !== current.id) return;
      setConnectors((items) => includeArchived
        ? items.map((item) => item.id === result.connector.id ? result.connector : item)
        : items.filter((item) => item.id !== result.connector.id));
      setDetails(null);
      setExpandedId(null);
      setAnnouncement("API archived. Existing workflow references remain intact.");
    } catch (error) {
      if (!controller.signal.aborted && generation === actionGenerationRef.current) setAnnouncement(fixedFailure(error));
    } finally {
      if (generation === actionGenerationRef.current) setBusyAction(null);
      if (actionControllerRef.current === controller) actionControllerRef.current = null;
    }
  }, [busyAction, client, details, includeArchived, loadingDetails]);

  const pick = useCallback(async (operationVersionId: string): Promise<void> => {
    if (mode !== "pick" || !onPick || !connectorBrowserWorkAvailable(busyAction, loadingDetails)) return;
    selectionControllerRef.current?.abort();
    const controller = new AbortController();
    selectionControllerRef.current = controller;
    const generation = ++selectionGenerationRef.current;
    setBusyAction(`pick:${operationVersionId}`);
    setAnnouncement("Resolving the immutable operation closure before selection.");
    const outcome = await resolveOwnedPickerClosure({
      client,
      operationVersionId,
      signal: controller.signal,
      isCurrent: () => !controller.signal.aborted && generation === selectionGenerationRef.current,
    });
    try {
      if (outcome.status === "stale") return;
      if (outcome.status === "repair") {
        setAnnouncement("This operation needs repair before it can be selected.");
        return;
      }
      if (outcome.status === "refusal") {
        setAnnouncement(fixedFailure(outcome.error));
        return;
      }
      onPick(outcome.closure);
      queueMicrotask(() => returnFocusRef?.current?.focus());
      setAnnouncement("Resolved operation selected.");
    } finally {
      if (selectionControllerRef.current === controller) selectionControllerRef.current = null;
      if (generation === selectionGenerationRef.current) setBusyAction(null);
    }
  }, [busyAction, client, loadingDetails, mode, onPick, returnFocusRef]);

  const close = useCallback((): void => {
    invalidateDetailContext();
    if (dialogRef.current?.open) dialogRef.current.close();
    onClose?.();
    queueMicrotask(() => returnFocusRef?.current?.focus());
  }, [invalidateDetailContext, onClose, returnFocusRef]);

  const body = (
    <section className="connector-browser" aria-busy={loadingList || loadingDetails}>
      <style>{`
        .connector-browser { display: grid; gap: 14px; color: var(--text-primary); }
        .connector-browser__toolbar { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 8px; align-items: end; }
        .connector-browser__list { display: grid; gap: 8px; }
        .connector-browser__row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 14px; border: 1px solid var(--hairline); border-radius: var(--radius); background: var(--ink-control); box-shadow: var(--shadow-sm); }
        .connector-browser__details { grid-column: 1 / -1; display: grid; gap: 14px; padding-top: 14px; border-top: 1px solid var(--hairline); }
        .connector-browser__receipt { display: grid; gap: 5px; padding: 12px; background: var(--canvas-bg); border-left: 3px solid var(--primary); font-family: var(--font-mono); font-size: var(--text-xs); overflow-wrap: anywhere; }
        .connector-browser button:focus-visible, .connector-browser input:focus-visible, .connector-browser a:focus-visible { outline: 3px solid var(--primary); outline-offset: 2px; }
        @media (max-width: 680px) { .connector-browser__toolbar { grid-template-columns: 1fr; } .connector-browser__row { grid-template-columns: 1fr; } }
        @media (prefers-reduced-motion: reduce) { .connector-browser * { scroll-behavior: auto !important; transition: none !important; } }
      `}</style>
      <header>
        <p className="eyebrow" style={{ color: "var(--primary)", margin: 0 }}>Prototype: simulation only</p>
        <h2 style={{ margin: "7px 0 4px", fontFamily: "var(--font-display)", fontWeight: 400 }}>
          {mode === "pick" ? "Choose an API operation" : "API library"}
        </h2>
      </header>
      <form className="connector-browser__toolbar" onSubmit={submitSearch}>
        <label>
          Search APIs
          <input
            ref={mode === "pick" ? firstFocusRef : undefined}
            type="search"
            value={queryInput}
            onChange={(event) => setQueryInput(event.target.value)}
            autoComplete="off"
            style={{ ...control, display: "block", width: "100%", marginTop: 6 }}
          />
        </label>
        <label style={{ ...control, display: "flex", alignItems: "center", gap: 8 }}>
          <input type="checkbox" checked={includeArchived} onChange={(event) => toggleArchived(event.target.checked)} />
          Include archived
        </label>
        <button type="submit" style={{ ...control, background: "var(--primary)", color: "var(--on-primary)", borderColor: "var(--primary)" }}>
          Search
        </button>
      </form>

      {connectors.length === 0 && !loadingList ? (
        <div className="connector-browser__receipt">
          <span>No APIs in this view.</span>
          <a href="/connections/import-api">Connector Lab: Import API</a>
        </div>
      ) : null}

      <ul className="connector-browser__list" aria-label="APIs" style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {connectors.map((connector) => {
          const expanded = expandedId === connector.id;
          return (
            <li className="connector-browser__row" key={connector.id}>
              <div>
                <strong>{connectorBrowserDisplayLabel(connector)}</strong>
                <div className="mono" style={{ color: "var(--text-muted)", fontSize: "var(--text-xs)", marginTop: 4 }}>
                  {connector.archivedAt === null ? "Active" : "Archived · existing workflows preserved"}
                </div>
              </div>
              <button type="button" aria-expanded={expanded} onClick={() => void expand(connector)} style={control}>
                {expanded ? "Close details" : mode === "pick" ? "Browse operations" : "Manage API"}
              </button>

              {expanded ? (
                <div className="connector-browser__details">
                  {loadingDetails ? <p>Loading sanitized API details.</p> : null}
                  {details?.connector.connector.id === connector.id ? (
                    <>
                      {mode === "manage" ? (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "end" }}>
                          <label style={{ flex: "1 1 240px" }}>
                            Display label
                            <input value={renameValue} maxLength={120} onChange={(event) => setRenameValue(event.target.value)} style={{ ...control, display: "block", width: "100%", marginTop: 6 }} />
                          </label>
                          <button type="button" disabled={!connectorBrowserWorkAvailable(busyAction, loadingDetails)} onClick={() => void rename()} style={control}>Save label</button>
                          <button type="button" disabled={!connectorBrowserWorkAvailable(busyAction, loadingDetails) || connector.archivedAt !== null} onClick={() => void archive()} style={{ ...control, color: "var(--rights-red)" }}>Archive API</button>
                        </div>
                      ) : null}

                      <p style={{ margin: 0, color: "var(--text-muted)" }}>
                        Missing, stale, or drifted operation? <a href="/connections/import-api">Review or repair this API</a>. Existing workflow references stay intact.
                      </p>

                      <section aria-label="Sanitized definition history">
                        <h3>Sanitized definition history</h3>
                        <p style={{ color: "var(--text-warning)", lineHeight: 1.5 }}>
                          Operation IDs and paths are untrusted public metadata. They must not contain secrets.
                        </p>
                        <div style={{ display: "grid", gap: 10 }}>
                          {details.connector.history.map((definition) => (
                            <div className="connector-browser__receipt" key={definition.id}>
                              <span>Definition v{definition.versionNumber} · {definition.operationCount} supported operations</span>
                              <span>Projection hash {definition.connectorProjectionHash}</span>
                              <span>Simulation only</span>
                              {definition.operations.map((operation) => (
                                <div key={operation.operationId} style={{ display: "flex", gap: 8, justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" }}>
                                  <span><strong>{operation.method}</strong> {operation.path}</span>
                                  {mode === "manage" ? (
                                    <button
                                      type="button"
                                      disabled={connector.archivedAt !== null || !connectorBrowserWorkAvailable(busyAction, loadingDetails)}
                                      onClick={() => void addOperation(connector, definition.id, operation.operationId)}
                                      style={control}
                                    >
                                      Add another operation
                                    </button>
                                  ) : null}
                                </div>
                              ))}
                            </div>
                          ))}
                        </div>
                        {details.connector.nextCursor ? <button type="button" disabled={!connectorBrowserWorkAvailable(busyAction, loadingDetails)} onClick={() => void loadMoreDefinitions()} style={{ ...control, marginTop: 10 }}>More definition history</button> : null}
                      </section>

                      <section aria-label="Materialized operation version history">
                        <h3>Operation versions</h3>
                        {details.operations.length === 0 ? (
                          <p>No materialized operation versions yet. Add one from the sanitized definition history.</p>
                        ) : (
                          <div style={{ display: "grid", gap: 8 }}>
                            {details.operations.map((operation) => (
                              <div className="connector-browser__receipt" key={operation.operationVersionId}>
                                <span>{operation.operationId} · v{operation.definitionVersionNumber} · …{operation.operationVersionId.slice(-6)}</span>
                                <span>Projection hash {operation.operationProjectionHash}</span>
                                <span>Schema hash {operation.schemaHash}</span>
                                {operation.authorAnnotation ? <span>Unverified · {operation.authorAnnotation.effectNote ?? operation.authorAnnotation.retryNote ?? "Author note"}</span> : null}
                                {mode === "pick" ? (
                                  <button
                                    type="button"
                                    disabled={connector.archivedAt !== null || !connectorBrowserWorkAvailable(busyAction, loadingDetails)}
                                    onClick={() => void pick(operation.operationVersionId)}
                                    style={{ ...control, justifySelf: "start" }}
                                  >
                                    {busyAction === `pick:${operation.operationVersionId}` ? "Resolving operation" : "Use resolved operation"}
                                  </button>
                                ) : null}
                              </div>
                            ))}
                          </div>
                        )}
                        {details.operationsCursor ? <button type="button" disabled={!connectorBrowserWorkAvailable(busyAction, loadingDetails)} onClick={() => void loadMoreOperations()} style={{ ...control, marginTop: 10 }}>More operation versions</button> : null}
                      </section>
                    </>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {nextCursor ? (
        <button type="button" disabled={loadingList} onClick={() => void loadList({ cursor: nextCursor, append: true, search: submittedQuery, archived: includeArchived })} style={control}>
          More APIs
        </button>
      ) : null}
      <p aria-live="polite" role="status" style={{ minHeight: 24, margin: 0, color: "var(--primary)" }}>{announcement}</p>
    </section>
  );

  if (mode === "manage") return body;
  return (
    <dialog
      ref={dialogRef}
      aria-label="Choose an API operation dialog"
      onCancel={(event) => { event.preventDefault(); close(); }}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); close(); return; }
        if (event.key !== "Tab") return;
        const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), a[href]') ?? [])];
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}
      style={{ width: "min(920px, calc(100vw - 32px))", maxHeight: "calc(100vh - 32px)", overflow: "auto", border: "1px solid var(--hairline-visible)", borderRadius: "var(--radius)", background: "var(--ink-panel)", color: "var(--text-primary)", padding: 24, boxShadow: "var(--shadow-card)" }}
    >
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
        <button type="button" onClick={close} style={control}>Close picker</button>
      </div>
      {body}
    </dialog>
  );
}
