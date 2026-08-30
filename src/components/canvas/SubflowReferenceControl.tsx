"use client";

import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  SubflowCandidate,
  SubflowResolveProjection,
  SubflowVersionProjection,
} from "@/lib/flow/subflow-api";
import {
  SubflowReferenceController,
  createSubflowReferenceClient,
  pickerOptionIndex,
  type SubflowReferenceClient,
  type SubflowReferenceClientState,
} from "@/lib/flow/subflow-reference-client";
import type { FlowNode, FlowNodeV2, SubflowReference } from "@/lib/flow/types";

export type ReferenceResolutionStatus = "legacy" | "unresolved" | "resolved" | "drift" | "error";

export interface VerifiedReferenceReceipt {
  readonly parentFlowId: string;
  readonly nodeId: string;
  readonly fingerprint: string;
}

export function verifiedReceiptMatchesContext(
  receipt: VerifiedReferenceReceipt | null,
  parentFlowId: string | null,
  nodeId: string,
  fingerprint: string,
): boolean {
  return receipt?.parentFlowId === parentFlowId
    && receipt.nodeId === nodeId
    && receipt.fingerprint === fingerprint;
}

export interface SubflowReferenceControlProps {
  readonly parentFlowId: string | null;
  readonly node: FlowNode | FlowNodeV2;
  readonly current?: SubflowReference;
  readonly resolutionStatus?: ReferenceResolutionStatus;
  readonly disabled?: boolean;
  readonly client?: SubflowReferenceClient;
  readonly onResolved: (projection: SubflowResolveProjection, nodeId: string) => void;
  readonly onOpenChild?: (
    nodeId: string,
    reference: SubflowReference,
    event: React.MouseEvent<HTMLButtonElement>,
  ) => void;
}

function stateMessage(state: SubflowReferenceClientState): string {
  if (state.status === "loading") return state.lane === "resolve" ? "Verifying reference…" : "Loading flow choices…";
  if (state.status === "error") return state.message;
  if (state.status === "drift") return "This flow changed. Review and choose again.";
  if (state.status === "resolved") return "Reference verified.";
  if (state.status === "ready" && state.flows.length === 0) return "No reusable flows found.";
  if (state.status === "versions" && state.versions.length === 0) return "No typed versions found.";
  return "";
}

export default function SubflowReferenceControl({
  parentFlowId,
  node,
  current,
  resolutionStatus,
  disabled = false,
  client,
  onResolved,
  onOpenChild,
}: SubflowReferenceControlProps): React.JSX.Element | null {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const retryRef = useRef<() => Promise<void>>(async () => undefined);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedCandidate, setSelectedCandidate] = useState<SubflowCandidate | null>(null);
  const [state, setState] = useState<SubflowReferenceClientState>({ status: "idle" });
  const [activeIndex, setActiveIndex] = useState(0);
  const [verifiedReceipt, setVerifiedReceipt] = useState<VerifiedReferenceReceipt | null>(null);
  const referenceFingerprint = JSON.stringify(current ?? null);
  const contextKey = JSON.stringify([parentFlowId, node.id, referenceFingerprint]);
  const latestContextRef = useRef(contextKey);
  latestContextRef.current = contextKey;
  const api = useMemo(() => client ?? createSubflowReferenceClient(), [client]);
  const controller = useMemo(() => {
    const expectedContext = contextKey;
    return new SubflowReferenceController(
      api,
      (nextState) => {
        if (latestContextRef.current === expectedContext) setState(nextState);
      },
      (projection) => {
        if (latestContextRef.current !== expectedContext) return;
        if (!parentFlowId) return;
        setVerifiedReceipt({
          parentFlowId,
          nodeId: node.id,
          fingerprint: JSON.stringify(projection.reference),
        });
        onResolved(projection, node.id);
        setOpen(false);
        queueMicrotask(() => triggerRef.current?.focus());
      },
    );
  }, [api, contextKey, node.id, onResolved, parentFlowId]);

  useEffect(() => () => controller.dispose(), [controller]);
  // The reset below reads these three to decide whether a receipt survives, but
  // they must not trigger it: a new controller is what means "different
  // context, start clean", whereas a fingerprint or parent id changing on its
  // own would wipe the query, the highlighted option, and the open panel out
  // from under someone mid-selection. Mirrored into a ref so the reset always
  // compares against current values without becoming reactive to them.
  //
  // Declared before the reset effect on purpose: effects run in declaration
  // order, so the ref is up to date by the time the reset reads it.
  const receiptContextRef = useRef({ parentFlowId, nodeId: node.id, referenceFingerprint });
  useEffect(() => {
    receiptContextRef.current = { parentFlowId, nodeId: node.id, referenceFingerprint };
  }, [parentFlowId, node.id, referenceFingerprint]);
  useEffect(() => {
    setState({ status: "idle" });
    setSelectedCandidate(null);
    setVerifiedReceipt((receipt) => {
      const context = receiptContextRef.current;
      return verifiedReceiptMatchesContext(
        receipt,
        context.parentFlowId,
        context.nodeId,
        context.referenceFingerprint,
      ) ? receipt : null;
    });
    setQuery("");
    setActiveIndex(0);
    optionRefs.current = [];
    setOpen(false);
  }, [controller]);
  useEffect(() => {
    if (open) queueMicrotask(() => searchRef.current?.focus());
  }, [open]);
  useEffect(() => {
    if (state.status === "error" && state.lane === "resolve") {
      setOpen(false);
      queueMicrotask(() => triggerRef.current?.focus());
    }
  }, [state]);
  useEffect(() => {
    optionRefs.current = [];
    setActiveIndex(0);
  }, [state.status]);
  if (node.type !== "subflow" && node.type !== "loop") return null;

  const close = (): void => {
    controller.dispose();
    setOpen(false);
    queueMicrotask(() => triggerRef.current?.focus());
  };
  const search = async (nextQuery = query, cursor?: string): Promise<void> => {
    if (!parentFlowId) return;
    const run = () => controller.searchCandidates({ parentFlowId, query: nextQuery, ...(cursor ? { cursor } : {}) });
    retryRef.current = run;
    await run();
  };
  const chooseVersions = async (candidate: SubflowCandidate, cursor?: string): Promise<void> => {
    if (!parentFlowId) return;
    setSelectedCandidate(candidate);
    const run = () => controller.loadVersions({
      parentFlowId,
      childFlowId: candidate.flowId,
      ...(cursor ? { cursor } : {}),
    });
    retryRef.current = run;
    await run();
  };
  const resolve = async (reference: SubflowReference): Promise<void> => {
    if (!parentFlowId) return;
    const run = () => controller.resolve({ parentFlowId, nodeId: node.id, reference });
    retryRef.current = run;
    await run();
  };
  const chooseDraft = (candidate: SubflowCandidate): void => {
    if (!candidate.draft) return;
    void resolve({
      kind: "draft",
      flowId: candidate.flowId,
      interface: candidate.draft.interface,
      interfaceHash: candidate.draft.interfaceHash,
    });
  };
  const chooseVersion = (version: SubflowVersionProjection): void => {
    if (!selectedCandidate) return;
    void resolve({
      kind: "pinned",
      flowId: selectedCandidate.flowId,
      versionId: version.versionId,
      interface: version.interface,
      interfaceHash: version.interfaceHash,
      contentHash: version.contentHash,
    });
  };

  const busy = state.status === "loading";
  const optionCount = state.status === "ready"
    ? state.flows.reduce((count, candidate) => count + (candidate.draft ? 1 : 0) + (candidate.latestTypedVersion ? 1 : 0), 0)
    : state.status === "versions" ? state.versions.length : 0;
  const optionId = activeIndex >= 0 && activeIndex < optionCount ? `${id}-option-${activeIndex}` : undefined;
  const effectiveResolutionStatus: ReferenceResolutionStatus = state.status === "resolved"
    ? "resolved"
    : state.status === "drift"
      ? "drift"
      : verifiedReceiptMatchesContext(verifiedReceipt, parentFlowId, node.id, referenceFingerprint)
        ? "resolved"
        : resolutionStatus ?? (current ? "unresolved" : "legacy");
  const badge = current?.kind === "draft"
    ? "Draft reference"
    : current?.kind === "pinned"
      ? "Pinned reference"
      : "Legacy reference";
  const receipt = effectiveResolutionStatus === "unresolved"
    ? "Needs verification"
    : effectiveResolutionStatus === "drift"
      ? "Drift detected"
      : effectiveResolutionStatus === "resolved"
        ? "Verified"
        : "";

  return <section className={`subflow-reference-control data-receipt subflow-reference-control--${effectiveResolutionStatus}`} aria-label={`${node.type} reference`}>
    <div className="subflow-reference-control__summary">
      <span className="reference-badge">{badge}</span>
      {receipt ? <span>{receipt}</span> : null}
      <button
        ref={triggerRef}
        type="button"
        className="btn btn-secondary task6-target"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled || !parentFlowId}
        onClick={() => {
          setState({ status: "idle" });
          setOpen(true);
          setSelectedCandidate(null);
          void search("");
        }}
      >Choose reusable flow</button>
      {effectiveResolutionStatus === "resolved" && current && onOpenChild ? <button
        type="button"
        className="btn btn-secondary task6-target"
        data-subflow-open-node={node.id}
        disabled={disabled || !parentFlowId}
        onClick={(event) => onOpenChild(node.id, current, event)}
        onAuxClick={(event) => onOpenChild(node.id, current, event)}
      >Open child</button> : null}
      {state.status === "error" && state.lane === "resolve" ? <button type="button" className="btn btn-secondary task6-target" onClick={() => void retryRef.current()}>Retry verification</button> : null}
    </div>
    <p id={`${id}-status`} aria-live="polite" aria-atomic="true">{stateMessage(state)}</p>
    {open ? <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-status`}
      aria-busy={busy}
      className="subflow-reference-dialog"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          close();
        }
        if (event.key === "Tab") {
          const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])];
          if (focusable.length > 0) {
            const first = focusable[0]!;
            const last = focusable.at(-1)!;
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
          }
        }
      }}
    >
      <div className="subflow-reference-dialog__heading"><h2 id={`${id}-title`}>Choose a reusable flow</h2><button type="button" className="btn btn-secondary task6-target" aria-label="Close reusable flow picker" onClick={close}>Close</button></div>
      {state.status !== "versions" ? <>
        <label htmlFor={`${id}-search`}>Search your flows</label>
        <input
          id={`${id}-search`}
          ref={searchRef}
          role="combobox"
          aria-controls={`${id}-candidates`}
          aria-expanded="true"
          aria-activedescendant={optionId}
          autoComplete="off"
          value={query}
          disabled={busy}
          onChange={(event) => {
            const next = event.target.value;
            setQuery(next);
            void search(next);
          }}
          onKeyDown={(event) => {
            if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
              event.preventDefault();
              setActiveIndex((current) => pickerOptionIndex(event.key as "ArrowDown" | "ArrowUp" | "Home" | "End", current, optionCount));
            }
            if (event.key === "Enter") {
              event.preventDefault();
              optionRefs.current[activeIndex]?.click();
            }
          }}
        />
        <div id={`${id}-candidates`} role="listbox" aria-label="Reusable flow choices">
          {state.status === "ready" ? (() => { let optionIndex = -1; return state.flows.map((candidate) => <div key={candidate.flowId} className="subflow-reference-option">
            <span><strong>{candidate.name}</strong>{candidate.workbookName ? <small>{candidate.workbookName}</small> : null}</span>
            {candidate.draft ? (() => { const index = ++optionIndex; return <button id={`${id}-option-${index}`} ref={(element) => { optionRefs.current[index] = element; }} role="option" aria-selected={activeIndex === index} type="button" className="btn btn-secondary task6-target" disabled={busy} onFocus={() => setActiveIndex(index)} onClick={() => chooseDraft(candidate)}>Use draft · {candidate.name}</button>; })() : null}
            {candidate.latestTypedVersion ? (() => { const index = ++optionIndex; return <button id={`${id}-option-${index}`} ref={(element) => { optionRefs.current[index] = element; }} role="option" aria-selected={activeIndex === index} type="button" className="btn btn-secondary task6-target" disabled={busy} onFocus={() => setActiveIndex(index)} onClick={() => void chooseVersions(candidate)}>Choose version · {candidate.name}</button>; })() : null}
          </div>); })() : null}
        </div>
        {state.status === "ready" && state.nextCursor ? <button type="button" className="btn btn-secondary task6-target" disabled={busy} onClick={() => void search(query, state.nextCursor)}>Load more flows</button> : null}
      </> : <>
        <button type="button" className="btn btn-secondary task6-target" onClick={() => { setSelectedCandidate(null); void search(query); }}>Back to flows</button>
        <div
          role="listbox"
          aria-label="Immutable flow versions"
          aria-activedescendant={optionId}
          tabIndex={0}
          onKeyDown={(event) => {
            if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
              event.preventDefault();
              setActiveIndex((current) => pickerOptionIndex(event.key as "ArrowDown" | "ArrowUp" | "Home" | "End", current, optionCount));
            }
            if (event.key === "Enter") {
              event.preventDefault();
              optionRefs.current[activeIndex]?.click();
            }
          }}
        >
          {state.versions.map((version, index) => <button id={`${id}-option-${index}`} ref={(element) => { optionRefs.current[index] = element; }} role="option" aria-selected={activeIndex === index} type="button" className="subflow-reference-option task6-target" key={version.versionId} disabled={busy} onFocus={() => setActiveIndex(index)} onClick={() => chooseVersion(version)}>Version {version.versionNumber}</button>)}
        </div>
        {state.nextCursor && selectedCandidate ? <button type="button" className="btn btn-secondary task6-target" disabled={busy} onClick={() => void chooseVersions(selectedCandidate, state.nextCursor)}>Load more versions</button> : null}
      </>}
      {state.status === "error" && state.lane !== "resolve" ? <button type="button" className="btn btn-secondary task6-target" onClick={() => void retryRef.current()}>Retry</button> : null}
    </div> : null}
  </section>;
}
