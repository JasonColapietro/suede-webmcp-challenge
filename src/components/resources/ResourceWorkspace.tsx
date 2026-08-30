"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import ResourceBriefPanel from "./ResourceBriefPanel";
import ResourceConfirmDialog from "./ResourceConfirmDialog";
import ResourceJobPanel from "./ResourceJobPanel";
import ResourceLifecycleControls from "./ResourceLifecycleControls";
import ResourcePublishPanel, { type ResourcePublishFormValue } from "./ResourcePublishPanel";
import ResourceRecordsPanel from "./ResourceRecordsPanel";
import ResourceSourcesPanel, { type ResourceManualSourceInput, type ResourceRefreshFormInput } from "./ResourceSourcesPanel";
import ResourceTabs, { parseResourceTab, type ResourceTabId } from "./ResourceTabs";
import ResourceTestPanel, {
  ResourceRepresentativeProofReceipt,
} from "./ResourceTestPanel";
import ResourceTrustEarningsPanel from "./ResourceTrustEarningsPanel";
import {
  buildResourceRepresentativeProof,
  buildResourceRepresentativeDraft,
  parseResourceRepresentativeDraft,
  resourceRepresentativeForPublication,
  resourceRepresentativeProofIsCurrent,
  type ResourceRepresentativeDraft,
  type ResourceRepresentativeProof,
  type ResourceRepresentativeValue,
} from "./representative";
import {
  bootstrapResourceWorkspace,
  buildResourceLifecycleRequest,
  buildResourceRecollectRequest,
  buildResourceRejectRequest,
  consumeResourceImportNotice,
  parseResourceApproveResponse,
  parseResourceDetailResponse,
  parseResourceLifecycleResponse,
  parseResourcePackResponse,
  parseResourcePublishResponse,
  parseResourceRefreshRejection,
  parseResourceRefreshResponse,
  parseResourceReleaseHistoryResponse,
  parseResourceSourceResponse,
  parseResourceTestResponse,
  parseResourceTrustResponse,
  requestIsCurrent,
  resourceJsonRequest,
  resourceLifecycleNeedsReconciliation,
  resourceMutationAllowedForHost,
  writeResourcePackPointer,
  type PublishedResource,
  type ResourceDryRun,
  type ResourceImportNotice,
  type ResourceLifecycleAction,
  type ResourceLifecycleRequest,
  type ResourceCurrentReleaseSummary,
  type ResourcePackBundle,
  type ResourcePackContent,
  type ResourcePackPointer,
  type ResourcePortfolioItem,
  type ResourceRefreshResult,
  type ResourceSourceResult,
  type ResourceTrust,
} from "./client";

export function resourceTabUrl(resourceId: string, tab: ResourceTabId): string {
  return `/resources/${encodeURIComponent(resourceId)}?tab=${tab}`;
}

export function resourcePackPointerFromProduct(product: ResourcePortfolioItem): ResourcePackPointer | null {
  if (product.currentCandidate) return { id: product.currentCandidate.packVersionId, revision: product.currentCandidate.revision, status: "candidate", semanticHash: product.currentCandidate.semanticHash };
  if (product.approvedPack && (!product.livePack || product.approvedPack.revision > product.livePack.revision)) {
    return { id: product.approvedPack.packVersionId, revision: product.approvedPack.revision, status: "approved", semanticHash: product.approvedPack.semanticHash };
  }
  if (product.livePack) return { id: product.livePack.packVersionId, revision: product.livePack.revision, status: "live", semanticHash: product.livePack.semanticHash };
  if (product.approvedPack) return { id: product.approvedPack.packVersionId, revision: product.approvedPack.revision, status: "approved", semanticHash: product.approvedPack.semanticHash };
  return null;
}

export function resourceRefreshBaseFromProduct(product: ResourcePortfolioItem): {
  readonly packVersionId: string;
  readonly semanticHash: string;
} | null {
  if (product.approvedPack && (!product.livePack || product.approvedPack.revision >= product.livePack.revision)) {
    return { packVersionId: product.approvedPack.packVersionId, semanticHash: product.approvedPack.semanticHash };
  }
  if (product.livePack) return { packVersionId: product.livePack.packVersionId, semanticHash: product.livePack.semanticHash };
  return null;
}

export function mergeCollectedSource(
  content: ResourcePackContent,
  source: Pick<ResourceSourceResult, "snapshot" | "collection">,
): ResourcePackContent {
  return {
    ...content,
    records: [...content.records, ...source.collection.records],
    evidence: [...content.evidence, ...source.collection.evidence],
    sourceSnapshotIds: [...content.sourceSnapshotIds, source.snapshot.id],
  };
}

type BusyAction = "source" | "refresh" | "reject" | "approve" | "test" | "publish" | "lifecycle" | null;

export default function ResourceWorkspace(): React.JSX.Element {
  const params = useParams<{ resourceId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const resourceId = typeof params.resourceId === "string" ? params.resourceId : "";
  const activeTab = parseResourceTab(searchParams.get("tab"));
  const [product, setProduct] = useState<ResourcePortfolioItem | null>(null);
  const [pointer, setPointer] = useState<ResourcePackPointer | null>(null);
  const [pack, setPack] = useState<ResourcePackBundle | null>(null);
  const [trust, setTrust] = useState<ResourceTrust | null>(null);
  const [releaseHistory, setReleaseHistory] = useState<readonly ResourceCurrentReleaseSummary[]>([]);
  const [testResult, setTestResult] = useState<ResourceDryRun | null>(null);
  const [representativeDraft, setRepresentativeDraft] = useState<ResourceRepresentativeDraft | null>(null);
  const [representativeProof, setRepresentativeProof] = useState<ResourceRepresentativeProof | null>(null);
  const [published, setPublished] = useState<PublishedResource | null>(null);
  const [refreshResult, setRefreshResult] = useState<ResourceRefreshResult | null>(null);
  const [importNotice, setImportNotice] = useState<ResourceImportNotice | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [approveOpen, setApproveOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [lifecycleOpen, setLifecycleOpen] = useState(false);
  const [lifecycleRequest, setLifecycleRequest] = useState<ResourceLifecycleRequest | null>(null);
  const [publishValue, setPublishValue] = useState<ResourcePublishFormValue | null>(null);
  const publishKey = useRef<string | null>(null);
  const approveTriggerRef = useRef<HTMLButtonElement | null>(null);
  const publishTriggerRef = useRef<HTMLButtonElement | null>(null);
  const lifecycleTriggerRef = useRef<HTMLButtonElement | null>(null);
  const lifecycleHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const importNoticeResource = useRef<string | null>(null);
  const representativePack = useRef<string | null>(null);
  const representativeGeneration = useRef(0);
  const representativeValue = useRef<ResourceRepresentativeValue | null>(null);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const playDenied = typeof window !== "undefined" && !resourceMutationAllowedForHost(window.location.host);

  const load = useCallback(async (showLoading = true): Promise<void> => {
    controller.current?.abort();
    const activeController = new AbortController();
    controller.current = activeController;
    const current = generation.current + 1;
    generation.current = current;
    if (showLoading) setLoading(true);
    setLoadError(false);
    try {
      const path = `/api/v2/resources/${encodeURIComponent(resourceId)}`;
      const [nextProduct, nextTrust, nextReleaseHistory] = await Promise.all([
        resourceJsonRequest(path, { signal: activeController.signal }).then(parseResourceDetailResponse),
        resourceJsonRequest(`${path}/trust`, { signal: activeController.signal }).then(parseResourceTrustResponse),
        resourceJsonRequest(`${path}/releases`, { signal: activeController.signal })
          .then((value) => parseResourceReleaseHistoryResponse(value, resourceId)),
      ]);
      const nextPointer = resourcePackPointerFromProduct(nextProduct);
      let nextPack: ResourcePackBundle | null = null;
      if (nextPointer) {
        const query = new URLSearchParams({ packVersionId: nextPointer.id, semanticHash: nextPointer.semanticHash });
        nextPack = parseResourcePackResponse(await resourceJsonRequest(`${path}/packs?${query.toString()}`, {
          signal: activeController.signal,
        }));
      }
      if (requestIsCurrent(current, generation.current, activeController.signal.aborted)) {
        const nextRepresentativePack = nextPack
          ? `${nextPack.packVersionId}:${nextPack.semanticHash}`
          : null;
        setProduct(nextProduct);
        setPublished(null);
        setPointer(nextPointer);
        setPack(nextPack);
        setTrust(nextTrust);
        setReleaseHistory(nextReleaseHistory);
        if (representativePack.current !== nextRepresentativePack) {
          representativePack.current = nextRepresentativePack;
          representativeGeneration.current += 1;
          const nextDraft = nextPack ? buildResourceRepresentativeDraft(nextPack) : null;
          representativeValue.current = nextPack && nextDraft
            ? parseResourceRepresentativeDraft(nextPack, nextDraft)
            : null;
          setRepresentativeDraft(nextDraft);
          setRepresentativeProof(null);
          setTestResult(null);
        } else {
          setTestResult((currentTest) => currentTest && nextPointer &&
            currentTest.packVersionId === nextPointer.id && currentTest.semanticHash === nextPointer.semanticHash
            ? currentTest : null);
        }
        setLoading(false);
      }
    } catch {
      if (requestIsCurrent(current, generation.current, activeController.signal.aborted)) {
        setLoadError(true);
        setLoading(false);
      }
    }
  }, [resourceId]);

  const bootstrap = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadError(false);
    try {
      await bootstrapResourceWorkspace(load);
    } catch {
      setLoadError(true);
      setLoading(false);
    }
  }, [load]);

  useEffect(() => {
    void bootstrap();
    return () => controller.current?.abort();
  }, [bootstrap]);

  useEffect(() => {
    if (importNoticeResource.current === resourceId) return;
    importNoticeResource.current = resourceId;
    setImportNotice(consumeResourceImportNotice(resourceId, window.sessionStorage));
  }, [resourceId]);

  const selectTab = (tab: ResourceTabId): void => {
    router.replace(resourceTabUrl(resourceId, tab), { scroll: false });
  };

  const addSource = async (input: ResourceManualSourceInput): Promise<void> => {
    if (busy || pointer?.status !== "candidate" || !pack || playDenied) return;
    setBusy("source");
    setActionError(null);
    setNotice(null);
    try {
      const base = `/api/v2/resources/${encodeURIComponent(resourceId)}`;
      const source = parseResourceSourceResponse(await resourceJsonRequest(`${base}/sources/collect`, {
        method: "POST",
        body: JSON.stringify({
          source: input,
          candidate: {
            packVersionId: pointer.id,
            revision: pointer.revision,
            semanticHash: pointer.semanticHash,
          },
        }),
      }));
      if (source.collection.status !== "collected") throw new Error("The manual source was not collected.");
      const candidate = source.candidate;
      writeResourcePackPointer(resourceId, candidate);
      setNotice(`${input.kind === "json_rows" ? "JSON rows" : "Manual source"} added to candidate v${candidate.revision}.`);
      await load(false);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The source could not be added.");
    } finally {
      setBusy(null);
    }
  };

  const recollect = async (input: ResourceRefreshFormInput): Promise<void> => {
    const base = product ? resourceRefreshBaseFromProduct(product) : null;
    if (busy || !product || !pointer || !pack || !base || playDenied) return;
    setBusy("refresh");
    setActionError(null);
    setNotice(null);
    try {
      const candidate = pointer.status === "candidate"
        ? { packVersionId: pointer.id, revision: pointer.revision, semanticHash: pointer.semanticHash }
        : null;
      const result = parseResourceRefreshResponse(await resourceJsonRequest(
        `/api/v2/resources/${encodeURIComponent(resourceId)}/refresh`,
        {
          method: "POST",
          body: JSON.stringify(buildResourceRecollectRequest(
            base, candidate, input.replaceSourceSnapshotIds, input.source,
          )),
        },
      ));
      setRefreshResult(result);
      if (result.candidate) {
        writeResourcePackPointer(resourceId, result.candidate);
        setNotice(`Refresh candidate v${result.candidate.revision} created for review. Live remains unchanged.`);
        await load(false);
      } else {
        setNotice(`Collection ${result.collection.status}. The private draft remains available and no release changed.`);
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The source could not be recollected.");
    } finally {
      setBusy(null);
    }
  };

  const rejectRefresh = async (): Promise<void> => {
    const base = product ? resourceRefreshBaseFromProduct(product) : null;
    if (busy || !base || pointer?.status !== "candidate" || playDenied) return;
    setBusy("reject");
    setActionError(null);
    try {
      parseResourceRefreshRejection(await resourceJsonRequest(
        `/api/v2/resources/${encodeURIComponent(resourceId)}/refresh`,
        {
          method: "POST",
          body: JSON.stringify(buildResourceRejectRequest(base, {
            packVersionId: pointer.id, revision: pointer.revision, semanticHash: pointer.semanticHash,
          })),
        },
      ));
      setNotice("Candidate rejected and removed. No approval or republish was recorded.");
      setRefreshResult(null);
      await load(false);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The candidate rejection could not be confirmed.");
    } finally {
      setBusy(null);
    }
  };

  const approve = async (): Promise<void> => {
    if (busy || pointer?.status !== "candidate" || !pack || playDenied) return;
    setBusy("approve");
    setActionError(null);
    try {
      const approved = parseResourceApproveResponse(await resourceJsonRequest(
        `/api/v2/resources/${encodeURIComponent(resourceId)}/packs`,
        {
          method: "POST",
          body: JSON.stringify({
            candidatePackVersionId: pointer.id,
            expectedRevision: pointer.revision,
            expectedSemanticHash: pointer.semanticHash,
          }),
        },
      ));
      writeResourcePackPointer(resourceId, approved);
      setApproveOpen(false);
      setNotice(`Pack v${approved.revision} approved and immutable.`);
      await load(false);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The pack could not be approved.");
    } finally {
      setBusy(null);
    }
  };

  const runTest = async (): Promise<void> => {
    const representative = pack && representativeDraft
      ? parseResourceRepresentativeDraft(pack, representativeDraft)
      : null;
    if (busy || !pointer || !pack || !representative || pointer.status === "candidate" || playDenied) return;
    const proof = buildResourceRepresentativeProof(representative, representativeGeneration.current);
    setBusy("test");
    setActionError(null);
    try {
      const result = parseResourceTestResponse(await resourceJsonRequest(
        `/api/v2/resources/${encodeURIComponent(resourceId)}/test`,
        {
          method: "POST",
          body: JSON.stringify({
            packVersionId: pointer.id, semanticHash: pointer.semanticHash,
            ...representative, filterFields: pack.content.filterFields,
            returnFields: pack.content.returnFields,
          }),
        },
      ));
      if (!resourceRepresentativeProofIsCurrent(
        proof,
        representativeGeneration.current,
        representativeValue.current,
      )) return;
      setTestResult(result);
      setRepresentativeProof(proof);
      setNotice("Representative test completed with an exact pack receipt.");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The representative test could not run.");
    } finally {
      setBusy(null);
    }
  };

  const requestPublish = (value: ResourcePublishFormValue): void => {
    publishKey.current = globalThis.crypto?.randomUUID?.() ?? `publish-${resourceId}-${pointer?.id ?? "pack"}-${Date.now()}`;
    setPublishValue(value);
    setPublishOpen(true);
  };

  const publish = async (): Promise<void> => {
    const representative = pack
      ? resourceRepresentativeForPublication(pack, testResult, representativeProof, representativeValue.current)
      : null;
    if (busy || !product || !pointer || !pack || !testResult || !representative || !publishValue || playDenied ||
        testResult.packVersionId !== pointer.id || testResult.semanticHash !== pointer.semanticHash ||
        product.currentRelease?.packVersionId === pointer.id && product.currentRelease.semanticHash === pointer.semanticHash) return;
    setBusy("publish");
    setActionError(null);
    try {
      const result = parseResourcePublishResponse(await resourceJsonRequest(
        `/api/v2/resources/${encodeURIComponent(resourceId)}/publish`,
        {
          method: "POST",
          body: JSON.stringify({
            idempotencyKey: publishKey.current ?? undefined,
            priceUsdc: publishValue.priceUsdc,
            ...(publishValue.payoutAddress === undefined ? {} : { payoutAddress: publishValue.payoutAddress }),
            representative,
          }),
        },
      ));
      setPublished(result);
      setPublishOpen(false);
      setNotice("Published. Settlement remains off until separately enabled on the existing rail.");
      await load(false);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The resource could not be published.");
    } finally {
      setBusy(null);
    }
  };

  const requestLifecycle = (action: ResourceLifecycleAction, trigger: HTMLButtonElement): void => {
    if (busy || !product || playDenied) return;
    try {
      const request = buildResourceLifecycleRequest(product, action);
      lifecycleTriggerRef.current = trigger;
      setActionError(null);
      setLifecycleRequest(request);
      setLifecycleOpen(true);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The release cannot transition from its current state.");
    }
  };

  const transitionLifecycle = async (): Promise<void> => {
    if (busy || !lifecycleRequest || playDenied) return;
    const action = lifecycleRequest.action;
    setBusy("lifecycle");
    setActionError(null);
    setNotice(null);
    try {
      const nextProduct = parseResourceLifecycleResponse(await resourceJsonRequest(
        `/api/v2/resources/${encodeURIComponent(resourceId)}/lifecycle`,
        { method: "POST", body: JSON.stringify(lifecycleRequest) },
      ));
      const nextPointer = resourcePackPointerFromProduct(nextProduct);
      setProduct(nextProduct);
      const nextRelease = nextProduct.currentRelease;
      if (nextRelease) {
        setReleaseHistory((history) => {
          const nextHistory = history.map((release) => release.id === nextRelease.id
            ? nextRelease
            : release);
          return nextHistory.some((release) => release.id === nextRelease.id)
            ? nextHistory
            : [nextRelease, ...nextHistory].slice(0, 20);
        });
      }
      setPublished(null);
      setPointer(nextPointer);
      if (!nextPointer || !pack || pack.packVersionId !== nextPointer.id || pack.semanticHash !== nextPointer.semanticHash) {
        setPack(null);
        representativePack.current = null;
        representativeGeneration.current += 1;
        representativeValue.current = null;
        setRepresentativeDraft(null);
        setRepresentativeProof(null);
        setTestResult(null);
      }
      setLifecycleOpen(false);
      setLifecycleRequest(null);
      setNotice(action === "pause"
        ? "Paused. Discovery and runs are unavailable; the immutable release receipt remains in history."
        : action === "resume"
          ? "Resumed. The exact release and deployment are live again."
          : "Retired. Discovery and runs are unavailable; immutable history remains and retirement is terminal.");
    } catch (error) {
      setLifecycleOpen(false);
      setLifecycleRequest(null);
      setActionError(error instanceof Error ? error.message : "The release lifecycle could not be changed.");
      if (resourceLifecycleNeedsReconciliation(error)) await load(false);
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <div className="resource-state" role="status">Loading the server-current resource receipt…</div>;
  if (loadError || !product) {
    return (
      <div className="resource-state resource-state--error" role="alert">
        <b>This resource could not be loaded.</b>
        <span>Missing and foreign resources return the same private response.</span>
        <button type="button" className="lp-btn lp-btn--ghost" onClick={() => void bootstrap()}>Retry</button>
      </div>
    );
  }

  const representative = pack && representativeDraft
    ? parseResourceRepresentativeDraft(pack, representativeDraft)
    : null;
  const publicationRepresentative = pack
    ? resourceRepresentativeForPublication(pack, testResult, representativeProof, representative)
    : null;

  const changeRepresentative = (value: ResourceRepresentativeDraft): void => {
    representativeGeneration.current += 1;
    representativeValue.current = pack ? parseResourceRepresentativeDraft(pack, value) : null;
    setRepresentativeDraft(value);
    setRepresentativeProof(null);
    setTestResult(null);
    setNotice(null);
  };

  const panels: Record<ResourceTabId, React.JSX.Element> = {
    brief: <ResourceBriefPanel product={product} pack={pack} />,
    sources: <ResourceSourcesPanel
      disabled={playDenied || pointer?.status !== "candidate" || pack === null}
      busy={busy === "source"}
      onAdd={addSource}
      refreshDisabled={playDenied || pack === null || resourceRefreshBaseFromProduct(product) === null}
      refreshBusy={busy === "refresh"}
      rejectBusy={busy === "reject"}
      canReject={pointer?.status === "candidate" && resourceRefreshBaseFromProduct(product) !== null}
      sourceSnapshotIds={pack?.content.sourceSnapshotIds ?? []}
      refreshResult={refreshResult}
      importNotice={importNotice}
      onRefresh={recollect}
      onReject={rejectRefresh}
    />,
    records: <ResourceRecordsPanel pack={pack} pointer={pointer} busy={busy === "approve"} triggerRef={approveTriggerRef} onRequestApprove={() => setApproveOpen(true)} />,
    job: <ResourceJobPanel pack={pack} />,
    test: <ResourceTestPanel
      pack={pointer?.status === "candidate" ? null : pack}
      result={testResult}
      busy={busy !== null}
      draft={representativeDraft}
      draftInvalid={pack !== null && representativeDraft !== null && representative === null}
      onDraftChange={changeRepresentative}
      onRun={() => void runTest()}
    />,
    publish: <ResourcePublishPanel product={product} pack={pointer?.status === "candidate" ? null : pack} testResult={testResult} representativeReady={publicationRepresentative !== null} published={published} releaseSummary={product.currentRelease} busy={busy === "publish"} triggerRef={publishTriggerRef} onRequestPublish={requestPublish} />,
    "trust-and-earnings": <ResourceTrustEarningsPanel trust={trust} />,
  };

  return (
    <>
      <div className="ws-crumbs"><Link href="/resources">Resources</Link><span aria-hidden="true">/</span><span>{product.name}</span></div>
      <header className="ws-head resource-page-head">
        <h1>{product.name}</h1>
        <span className="resource-status">{product.status}</span>
        <p className="ws-head-sub">One immutable pack, one typed job, one exact release receipt.</p>
      </header>
      <ResourceLifecycleControls
        product={product}
        releaseHistory={releaseHistory}
        disabled={playDenied}
        busy={busy !== null}
        headingRef={lifecycleHeadingRef}
        onRequest={requestLifecycle}
      />
      <ResourceTabs
        active={activeTab}
        states={{
          brief: "complete",
          sources: pack && pack.content.sourceSnapshotIds.length > 0 ? "complete" : "ready",
          records: pointer?.status === "approved" || pointer?.status === "live" ? "complete" : "ready",
          job: pack ? "complete" : "ready",
          test: testResult ? "complete" : "ready",
          publish: published || product.currentRelease ? "complete" : "ready",
          "trust-and-earnings": product.runReceiptCount > 0 ? "complete" : "ready",
        }}
        onSelect={selectTab}
      />
      {actionError && <div className="resource-action-notice resource-action-notice--error" role="alert">{actionError}</div>}
      <p className="resource-action-notice" aria-live="polite" aria-atomic="true">{notice}</p>
      <div
        id={`resource-panel-${activeTab}`}
        className="resource-tabpanel"
        role="tabpanel"
        aria-labelledby={`resource-tab-${activeTab}`}
        tabIndex={0}
      >
        {panels[activeTab]}
      </div>
      <ResourceConfirmDialog
        open={approveOpen}
        title="Approve immutable pack?"
        confirmLabel="Approve pack"
        busy={busy === "approve"}
        triggerRef={approveTriggerRef}
        onCancel={() => setApproveOpen(false)}
        onConfirm={() => void approve()}
      >
        <p><code>{pointer?.id ?? "No candidate"}</code></p>
        <p><code className="resource-hash">{pointer?.semanticHash ?? "No hash"}</code></p>
        <p>Optional source context remains informational and may be empty.</p>
      </ResourceConfirmDialog>
      <ResourceConfirmDialog
        open={publishOpen}
        title="Publish this exact release?"
        confirmLabel="Publish resource"
        busy={busy === "publish"}
        triggerRef={publishTriggerRef}
        onCancel={() => setPublishOpen(false)}
        onConfirm={() => void publish()}
      >
        <p>Pack <code>{pointer?.id ?? "Not available"}</code> at <code className="resource-hash">{pointer?.semanticHash ?? "No hash"}</code>.</p>
        <p>Price <b className="tabular">${(publishValue?.priceUsdc ?? 0).toFixed(6)}</b>. Settlement remains off.</p>
        {representativeProof && publicationRepresentative && (
          <ResourceRepresentativeProofReceipt proof={representativeProof} />
        )}
      </ResourceConfirmDialog>
      <ResourceConfirmDialog
        open={lifecycleOpen}
        title={lifecycleRequest?.action === "pause"
          ? "Pause this exact release?"
          : lifecycleRequest?.action === "resume"
            ? "Resume this exact release?"
            : "Retire this exact release?"}
        confirmLabel={lifecycleRequest?.action === "pause"
          ? "Pause release"
          : lifecycleRequest?.action === "resume"
            ? "Resume release"
            : "Retire release"}
        danger={lifecycleRequest?.action === "retire"}
        busy={busy === "lifecycle"}
        triggerRef={lifecycleTriggerRef}
        fallbackFocusRef={lifecycleHeadingRef}
        onCancel={() => {
          setLifecycleOpen(false);
          setLifecycleRequest(null);
        }}
        onConfirm={() => void transitionLifecycle()}
      >
        <p>Release <code>{lifecycleRequest?.releaseId ?? "Not available"}</code></p>
        <p>Agent <code>{lifecycleRequest?.agentId ?? "Not available"}</code></p>
        <p>Deployment <code>{lifecycleRequest?.deploymentId ?? "Not available"}</code></p>
        {lifecycleRequest?.action === "pause" && <p>Discovery and runs stop. Immutable release history remains available.</p>}
        {lifecycleRequest?.action === "resume" && <p>Only this exact historical release, agent, and deployment can return to Live.</p>}
        {lifecycleRequest?.action === "retire" && <p>Retirement is terminal. Discovery and runs stop; immutable release history remains available.</p>}
      </ResourceConfirmDialog>
    </>
  );
}
