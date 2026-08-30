"use client";

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { RunEvent, NodeStatus, NodeType, FlowGraphV2 } from "@/lib/flow/types";
import type { FlowTestScope } from "@/lib/flow/test-scope";
import type { TestRunResult } from "@/lib/flow/test-runner-contract";
import type { ApiOperationSimulationReceiptV1 } from "@/lib/connectors/simulation-contract";
import {
  assembleTestRunRequest,
  createTestRunUiPlan,
  pruneTestRunPinValues,
} from "@/lib/flow/test-run-ui";
import { readBoundedTestRunResponse } from "@/lib/flow/test-run-client";
import {
  durableActionAvailability,
  durableRunUrls,
  enqueueDurableRun,
  parseDurableActionEnvelope,
  parseDurableRunEnvelope,
  readBoundedDurableJson,
  readDurableEventStream,
  type DurableClientAction,
  type DurableClientRun,
} from "@/lib/runtime/client";
import type { SuedeNodeStatus } from "./SuedeNode";
import ReportContentButton from "@/components/moderation/ReportContentButton";
import ArtifactDownloadButton from "@/components/runs/ArtifactDownloadButton";
import { artifactDescriptor } from "@/lib/artifacts/download";
import "./canvas-theme.css";

export interface RunDockProps {
  flowId: string;
  graph?: FlowGraphV2 | null;
  testEnvironment?: { readonly id: string; readonly name: string } | null;
  testScope?: FlowTestScope | null;
  onTestScopeClear?: () => void;
  onRunningChange?: (running: boolean) => void;
  onStatuses?: (statuses: Record<string, SuedeNodeStatus>) => void;
  runBlocker?: () => string | null;
  /** Persists an unsaved template and returns its authoritative flow row ID. */
  prepareRun?: () => Promise<string>;
  /**
   * Attaches to the dock's Run button so the Studio header's state-aware
   * primary action ("Run test") can trigger the same guarded run path.
   */
  runControlRef?: React.Ref<HTMLButtonElement>;
  immutableVersion?: { readonly id: string; readonly versionNumber: number } | null;
  immutableVersionStatus?: "loading" | "ready" | "error";
  /**
   * Sample trigger input built from the flow's Input node's declared default
   * fields, if any. Prefills the trigger textarea so a test run doesn't
   * start from a bare `{}`. Null/undefined falls back to `{}`.
   */
  defaultTriggerInput?: Record<string, unknown> | null;
  /** Dedicated value-opaque path. When present, generic logs, outputs, ledger, and recovery do not mount. */
  apiOperationSimulation?: ApiOperationSimulationView;
}

export type ApiOperationSimulationView =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "busy" }>
  | Readonly<{ status: "error"; message: string }>
  | Readonly<{ status: "success"; receipt: ApiOperationSimulationReceiptV1 }>;

function Names({ label, values }: { readonly label: string; readonly values: readonly string[] }): React.JSX.Element {
  return <div className="mono" style={{ display: "grid", gridTemplateColumns: "minmax(120px, .65fr) minmax(0, 1.35fr)", gap: 8, fontSize: "var(--text-xs)" }}>
    <span style={{ color: "var(--text-muted)" }}>{label}</span>
    <span style={{ overflowWrap: "anywhere" }}>{values.length > 0 ? values.join(", ") : "None"}</span>
  </div>;
}

export function ApiOperationSimulationReceiptView({
  receipt,
}: {
  readonly receipt: ApiOperationSimulationReceiptV1;
}): React.JSX.Element {
  const policy = `${receipt.systemPolicy.effects[0]} / ${receipt.systemPolicy.retry} / ${receipt.systemPolicy.cost} / ${receipt.systemPolicy.idempotency}`;
  return <section aria-label="API operation simulation receipt" style={{ height: "100%", overflow: "auto", padding: 14, background: "var(--ink-panel)", borderTop: "1px solid var(--hairline-visible)" }}>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
      <div><div className="eyebrow" style={{ color: "var(--primary)" }}>Local simulation receipt</div><strong>{receipt.message}</strong></div>
      <div className="mono" style={{ color: "var(--text-success)", fontSize: "var(--text-xs)" }}>{receipt.egressCount} egress · {receipt.costUsdc} USDC</div>
    </div>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: 12, marginTop: 12 }}>
      <div className="data-receipt" style={{ display: "grid", gap: 7, padding: 10 }}>
        <Names label="Route" values={[receipt.operation.method, receipt.operation.origin, receipt.operation.pathTemplate]} />
        <Names label="Path parameters" values={receipt.operation.pathParameterNames} />
        <Names label="Query parameters" values={receipt.operation.queryParameterNames} />
        <Names label="Request headers" values={receipt.operation.requestHeaderNames} />
        <Names label="Credential" values={receipt.operation.credentialPlaceholder
          ? [`${receipt.operation.credentialPlaceholder.headerName}: ${receipt.operation.credentialPlaceholder.value}`]
          : ["Not required"]} />
        <Names label="Selected status" values={[String(receipt.operation.selectedStatus)]} />
      </div>
      <div className="data-receipt" style={{ display: "grid", gap: 7, padding: 10 }}>
        <Names label="Connector projection hash" values={[receipt.operation.connectorProjectionHash]} />
        <Names label="Operation projection hash" values={[receipt.operation.operationProjectionHash]} />
        <Names label="Schema hash" values={[receipt.operation.schemaHash]} />
        <Names label="Trusted policy" values={[policy]} />
        <Names label="Execution" values={[`${receipt.execution.completedNodeCount}/${receipt.execution.plannedNodeCount} nodes`, `${receipt.durationMs} ms`]} />
        <Names label="Correlation" values={[receipt.correlationId]} />
      </div>
    </div>
    {receipt.authorAnnotation ? <section aria-label="Unverified simulation annotation" className="data-receipt" style={{ marginTop: 12, padding: 10, borderColor: "var(--warning-amber)" }}>
      <div className="eyebrow" style={{ color: "var(--text-warning)" }}>Unverified</div>
      {receipt.authorAnnotation.effectNote ? <p style={{ margin: "6px 0 0" }}>{receipt.authorAnnotation.effectNote}</p> : null}
      {receipt.authorAnnotation.retryNote ? <p style={{ margin: "6px 0 0" }}>{receipt.authorAnnotation.retryNote}</p> : null}
    </section> : null}
  </section>;
}

function formatTriggerInput(value: Record<string, unknown> | null | undefined): string {
  if (!value || Object.keys(value).length === 0) return "{}";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "{}";
  }
}

interface LogLine {
  id: string;
  level: "info" | "error";
  text: string;
}

interface LedgerEntry {
  nodeId: string;
  nodeType: NodeType | string;
  status: NodeStatus;
  costUsdc: number;
}

const SSE_DELIMITER = "\n\n";
const MAX_VISIBLE_TEST_LOGS = 200;
const MAX_VISIBLE_TEST_LEDGER_ROWS = 200;
const MAX_VISIBLE_TEST_OUTPUTS = 100;

function parseEvent(frame: string): RunEvent | null {
  const dataLine = frame
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("data:"));
  if (!dataLine) return null;
  const payload = dataLine.slice("data:".length).trim();
  if (payload === "") return null;
  try {
    return JSON.parse(payload) as RunEvent;
  } catch {
    return null;
  }
}

function statusFor(event: RunEvent): SuedeNodeStatus | null {
  if (event.kind === "node:start") return "running";
  if (event.kind === "node:done") return "done";
  if (event.kind === "node:error") return "error";
  return null;
}

function ledgerStatusColor(status: NodeStatus): string {
  if (status === "done") return "var(--text-success)";
  if (status === "error") return "var(--rights-red)";
  if (status === "running") return "var(--text-warning)";
  return "var(--text-muted)";
}

function genId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}

function formatVisibleOutput(value: unknown): string {
  try {
    const encoded = typeof value === "string" ? value : JSON.stringify(value);
    if (!encoded) return "None";
    return encoded.length > 4_096 ? `${encoded.slice(0, 4_096)}…` : encoded;
  } catch {
    return "Output could not be displayed.";
  }
}

/** Convert scoped capture envelopes into operator-facing output text. */
function formatCapturedOutput(captured: unknown): string {
  if (captured && typeof captured === "object" && "kind" in captured) {
    const envelope = captured as { kind: string; value?: unknown; reason?: string };
    if (envelope.kind === "value") return formatVisibleOutput(envelope.value);
    if (envelope.kind === "omitted") {
      const reason = envelope.reason === "limit"
        ? "it was too large to capture"
        : envelope.reason === "sensitive"
          ? "it may contain sensitive material"
          : "its type cannot be captured";
      return `Output withheld: ${reason}.`;
    }
  }
  return formatVisibleOutput(captured);
}

function scopeReceipt(scope: FlowTestScope): string {
  if (scope.kind === "node") return `Node only: ${scope.nodeId}`;
  if (scope.kind === "to-node") return `Through node: ${scope.nodeId}`;
  return `From node: ${scope.nodeId}`;
}

export default function RunDock({
  flowId,
  graph,
  testEnvironment,
  testScope,
  onTestScopeClear,
  onRunningChange,
  onStatuses,
  defaultTriggerInput,
  runBlocker,
  prepareRun,
  runControlRef,
  immutableVersion,
  immutableVersionStatus = "ready",
  apiOperationSimulation,
}: RunDockProps): React.JSX.Element {
  const [triggerInputText, setTriggerInputText] = useState<string>(() =>
    formatTriggerInput(defaultTriggerInput),
  );
  const [running, setRunning] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [total, setTotal] = useState<number>(0);
  const totalRef = useRef<number>(0);
  const runOutcomeRef = useRef<{ readonly status: "done" | "error"; readonly totalCostUsdc: number } | null>(null);
  const [testLatencyMs, setTestLatencyMs] = useState<number | null>(null);
  const [testResult, setTestResult] = useState<TestRunResult | null>(null);
  const [legacyOutputs, setLegacyOutputs] = useState<Readonly<Record<string, {
    readonly runId: string;
    readonly output: unknown;
  }>>>({});
  const [successAnnouncement, setSuccessAnnouncement] = useState<string | null>(null);
  const [pinValues, setPinValues] = useState<Readonly<Record<string, string>>>({});
  const [durableFallbackKey, setDurableFallbackKey] = useState<string | null>(null);
  const [legacyAdmissionReceipt, setLegacyAdmissionReceipt] = useState(false);
  const blockerStatusId = useId();
  const scopedMode = testScope !== null && testScope !== undefined;
  const apiOperationMode = apiOperationSimulation !== undefined;
  const scopedPlan = useMemo(
    () => graph && testScope ? createTestRunUiPlan(graph, testScope) : null,
    [graph, testScope],
  );
  const blockedMessage = scopedMode
    ? scopedPlan?.status === "disabled" || !graph || !testEnvironment
      ? "This scoped test cannot run safely."
      : runBlocker?.() ?? null
    : runBlocker?.() ?? null;
  const visibleError = blockedMessage ?? error;
  const inertRun = running || Boolean(blockedMessage);

  const statusesRef = useRef<Record<string, SuedeNodeStatus>>({});
  const logRef = useRef<HTMLDivElement | null>(null);
  const userEditedInputRef = useRef<boolean>(false);
  const activeRunAbortRef = useRef<AbortController | null>(null);
  /** Identity of the last dock reset, so a graph edit alone never triggers one. */
  const resetIdentityRef = useRef<string | null>(null);
  const legacyAdmissionNoticeRef = useRef<HTMLParagraphElement | null>(null);
  const runGenerationRef = useRef(0);
  const onRunningChangeRef = useRef(onRunningChange);

  useEffect(() => {
    onRunningChangeRef.current = onRunningChange;
  }, [onRunningChange]);

  useEffect(() => {
    if (!legacyAdmissionReceipt) return;
    requestAnimationFrame(() => legacyAdmissionNoticeRef.current?.focus());
  }, [legacyAdmissionReceipt]);

  const reportRunning = useCallback((next: boolean) => {
    setRunning(next);
    onRunningChangeRef.current?.(next);
  }, []);

  const cancelActiveRun = useCallback(() => {
    runGenerationRef.current += 1;
    activeRunAbortRef.current?.abort();
    activeRunAbortRef.current = null;
  }, []);

  // Cancel only when the dock actually goes away. This used to be the cleanup
  // of the reset effect below, which re-runs on every dep change — so editing
  // the canvas mid-run aborted the stream.
  useEffect(() => () => {
    cancelActiveRun();
    onRunningChangeRef.current?.(false);
  }, [cancelActiveRun]);

  useEffect(() => {
    // Switching flow, scope, environment or API-operation mode genuinely
    // invalidates a run, so those still tear it down. Editing the canvas does
    // not: `graph` is a dep purely so the pin resync below stays current, and
    // resetting on it aborted the stream and wiped the log, ledger, outputs and
    // node statuses out from under a run the tester was still watching.
    const identity = JSON.stringify([
      apiOperationMode,
      flowId,
      scopedMode,
      testEnvironment?.id ?? null,
      testScope?.kind ?? null,
      testScope?.nodeId ?? null,
    ]);
    const identityChanged = resetIdentityRef.current !== identity;
    resetIdentityRef.current = identity;
    if (identityChanged) {
      cancelActiveRun();
      reportRunning(false);
      statusesRef.current = {};
      onStatuses?.({});
      setError(null);
      setLogs([]);
      setLedger([]);
      setTotal(0);
      setTestLatencyMs(null);
      setTestResult(null);
      setLegacyOutputs({});
      setSuccessAnnouncement(null);
      setLegacyAdmissionReceipt(false);
    }
    if (scopedPlan?.status === "ready") {
      const retained = pruneTestRunPinValues(scopedPlan.pins, pinValues);
      setPinValues(Object.fromEntries(scopedPlan.pins.map((pin) => [
        pin.key,
        retained[pin.key] ?? (pin.control === "boolean" ? "false" : "null"),
      ])));
    } else {
      setPinValues({});
    }
    // pinValues are intentionally retained only when the scope identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiOperationMode, cancelActiveRun, flowId, graph, onStatuses, reportRunning, scopedMode, testEnvironment?.id, testScope?.kind, testScope?.nodeId]);

  // Keep the prefill in sync with the Input node's declared fields as long as
  // the tester hasn't typed their own trigger input yet.
  useEffect(() => {
    if (userEditedInputRef.current) return;
    setTriggerInputText(formatTriggerInput(defaultTriggerInput));
  }, [defaultTriggerInput]);

  const pushLog = useCallback((line: LogLine) => {
    setLogs((prev) => [...prev, line]);
    requestAnimationFrame(() => {
      if (logRef.current) {
        logRef.current.scrollTop = logRef.current.scrollHeight;
      }
    });
  }, []);

  const emitStatuses = useCallback(
    (next: Record<string, SuedeNodeStatus>) => {
      statusesRef.current = next;
      onStatuses?.(next);
    },
    [onStatuses],
  );

  const beginActiveRun = useCallback(() => {
    cancelActiveRun();
    const controller = new AbortController();
    activeRunAbortRef.current = controller;
    const generation = runGenerationRef.current;
    reportRunning(true);
    return { controller, generation };
  }, [cancelActiveRun, reportRunning]);

  const activeRunIsCurrent = useCallback((generation: number, controller: AbortController): boolean =>
    generation === runGenerationRef.current && activeRunAbortRef.current === controller && !controller.signal.aborted,
  []);

  const applyEvent = useCallback(
    (event: RunEvent) => {
      const nextStatus = statusFor(event);
      if (nextStatus && "nodeId" in event) {
        emitStatuses({ ...statusesRef.current, [event.nodeId]: nextStatus });
      }

      switch (event.kind) {
        case "run:start":
          pushLog({
            id: genId(),
            level: "info",
            text: `run:start ${event.runId}`,
          });
          break;
        case "node:start":
          setLedger((prev) => {
            const without = prev.filter((r) => r.nodeId !== event.nodeId);
            return [
              ...without,
              {
                nodeId: event.nodeId,
                nodeType: event.nodeType,
                status: "running",
                costUsdc: 0,
              },
            ];
          });
          pushLog({
            id: genId(),
            level: "info",
            text: `node:start ${event.nodeId} (${event.nodeType})`,
          });
          break;
        case "node:log":
          pushLog({
            id: genId(),
            level: event.level,
            text: `${event.nodeId}: ${event.msg}`,
          });
          break;
        case "node:done":
          setLegacyOutputs((previous) => ({
            ...previous,
            [event.nodeId]: { runId: event.runId, output: event.outputs },
          }));
          setLedger((prev) =>
            prev.map((r) =>
              r.nodeId === event.nodeId
                ? {
                    ...r,
                    status: "done",
                    costUsdc: event.costUsdc,
                    nodeType: event.nodeType,
                  }
                : r,
            ),
          );
          pushLog({
            id: genId(),
            level: "info",
            text: `node:done ${event.nodeId} ($${event.costUsdc.toFixed(3)})`,
          });
          break;
        case "node:error":
          setLedger((prev) =>
            prev.map((r) =>
              r.nodeId === event.nodeId
                ? { ...r, status: "error", nodeType: event.nodeType }
                : r,
            ),
          );
          pushLog({
            id: genId(),
            level: "error",
            text: `node:error ${event.nodeId}: ${event.error}`,
          });
          break;
        case "run:done":
          setTotal(event.totalCostUsdc);
          totalRef.current = event.totalCostUsdc;
          runOutcomeRef.current = { status: event.status, totalCostUsdc: event.totalCostUsdc };
          pushLog({
            id: genId(),
            level: event.status === "error" ? "error" : "info",
            text: `run:done ${event.status} total $${event.totalCostUsdc.toFixed(3)}`,
          });
          break;
        default:
          break;
      }
    },
    [emitStatuses, pushLog],
  );

  const applyTestResult = useCallback((result: TestRunResult) => {
    const nextStatuses: Record<string, SuedeNodeStatus> = {};
    const rows = new Map<string, LedgerEntry>();
    const nextLogs: LogLine[] = [];
    for (const event of result.events) {
      if (event.kind === "node:start") {
        nextStatuses[event.nodeId] = "running";
        rows.set(event.nodeId, {
          nodeId: event.nodeId, nodeType: event.nodeType, status: "running", costUsdc: 0,
        });
        nextLogs.push({ id: `event-${event.sequence}`, level: "info", text: `node:start ${event.nodeId}` });
      } else if (event.kind === "node:done") {
        nextStatuses[event.nodeId] = "done";
        rows.set(event.nodeId, {
          nodeId: event.nodeId, nodeType: event.nodeType, status: "done", costUsdc: 0,
        });
        nextLogs.push({
          id: `event-${event.sequence}`,
          level: "info",
          text: `node:done ${event.nodeId} output ${formatCapturedOutput(event.outputs)}`,
        });
      } else if (event.kind === "node:error") {
        nextStatuses[event.nodeId] = "error";
        rows.set(event.nodeId, {
          nodeId: event.nodeId, nodeType: event.nodeType, status: "error", costUsdc: 0,
        });
        nextLogs.push({ id: `event-${event.sequence}`, level: "error", text: event.message });
      } else {
        nextLogs.push({
          id: `event-${event.sequence}`,
          level: event.kind === "test:done" && event.status === "error" ? "error" : "info",
          text: event.kind === "test:start" ? `test:start ${event.runId}` : `test:done ${event.status}`,
        });
      }
    }
    for (const [index, line] of result.logs.entries()) {
      nextLogs.push({ id: `log-${index}`, level: line.level, text: line.message });
    }
    emitStatuses(nextStatuses);
    setLedger([...rows.values()].slice(0, MAX_VISIBLE_TEST_LEDGER_ROWS));
    setLogs(nextLogs.slice(0, MAX_VISIBLE_TEST_LOGS));
    setTotal(0);
    setTestLatencyMs(result.latencyMs ?? 0);
    setTestResult(result);
    setSuccessAnnouncement(`Scoped test ${result.status}. ${result.events.length} events, ${result.logs.length} logs.`);
  }, [emitStatuses]);

  const runScopedTest = useCallback(async (executionFlowId = flowId): Promise<void> => {
    if (running || activeRunAbortRef.current || !graph || !testScope || !testEnvironment || scopedPlan?.status !== "ready") {
      setError("This scoped test cannot run safely.");
      return;
    }
    const initialBlocker = runBlocker?.() ?? null;
    if (initialBlocker) {
      setError(initialBlocker);
      return;
    }
    const assembled = assembleTestRunRequest({
      graph, scope: testScope, environmentId: testEnvironment.id, pinValues,
    });
    if (!assembled.ok) {
      setError(assembled.message);
      return;
    }
    const finalBlocker = runBlocker?.() ?? null;
    if (finalBlocker) {
      setError(finalBlocker);
      return;
    }
    const { controller, generation } = beginActiveRun();
    setError(null);
    setLogs([]);
    setLedger([]);
    setTotal(0);
    setTestLatencyMs(null);
    setTestResult(null);
    setSuccessAnnouncement(null);
    emitStatuses(Object.fromEntries(scopedPlan.executionOrder.map((nodeId) => [nodeId, "running" as const])));
    try {
      const response = await globalThis.fetch(`/api/v2/flows/${encodeURIComponent(executionFlowId)}/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(assembled.request),
        signal: controller.signal,
      });
      if (!activeRunIsCurrent(generation, controller)) return;
      if (!response.ok) throw new Error("scoped-test-failed");
      const result = await readBoundedTestRunResponse(response, { signal: controller.signal });
      if (!activeRunIsCurrent(generation, controller)) return;
      if (!result) throw new Error("scoped-test-failed");
      applyTestResult(result);
    } catch {
      if (!activeRunIsCurrent(generation, controller)) return;
      setError("Scoped test could not run.");
      setLogs([{ id: "test-error", level: "error", text: "Scoped test could not run." }]);
      emitStatuses({});
    } finally {
      if (generation === runGenerationRef.current && activeRunAbortRef.current === controller) {
        activeRunAbortRef.current = null;
        reportRunning(false);
      }
    }
  }, [
    running, graph, testScope, testEnvironment, scopedPlan, pinValues, flowId,
    runBlocker, beginActiveRun, activeRunIsCurrent, emitStatuses, applyTestResult, reportRunning,
  ]);

  const runLegacyV2 = useCallback(async (): Promise<void> => {
    if (running || activeRunAbortRef.current) return;
    const blocked = runBlocker?.() ?? null;
    if (blocked) {
      setError(blocked);
      return;
    }

    let executionFlowId = flowId;
    if (prepareRun) {
      setError(null);
      reportRunning(true);
      try {
        const preparedFlowId = await prepareRun();
        if (preparedFlowId.trim().length === 0) throw new Error("The saved draft has no flow id.");
        executionFlowId = preparedFlowId;
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "The draft could not be saved.");
        return;
      } finally {
        reportRunning(false);
      }
    }

    if (scopedMode) {
      await runScopedTest(executionFlowId);
      return;
    }

    let triggerInput: Record<string, unknown> = {};
    if (triggerInputText.trim() !== "") {
      try {
        const parsed: unknown = JSON.parse(triggerInputText);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          triggerInput = parsed as Record<string, unknown>;
        } else {
          setError("Trigger input must be a JSON object.");
          return;
        }
      } catch {
        setError("Trigger input is not valid JSON.");
        return;
      }
    }

    const { controller, generation } = beginActiveRun();
    setError(null);
    setLogs([]);
    setLedger([]);
    setTotal(0);
    totalRef.current = 0;
    runOutcomeRef.current = null;
    setSuccessAnnouncement(null);
    setLegacyOutputs({});
    emitStatuses({});

    try {
      const res = await fetch(`/api/v2/flows/${encodeURIComponent(executionFlowId)}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          triggerInput,
          ...(immutableVersion ? { flowVersionId: immutableVersion.id } : {}),
        }),
        signal: controller.signal,
      });

      if (!activeRunIsCurrent(generation, controller)) return;
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        throw new Error(
          text || `Run request failed (${res.status})`,
        );
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { value, done } = await reader.read();
        if (!activeRunIsCurrent(generation, controller)) return;
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx = buffer.indexOf(SSE_DELIMITER);
        while (idx !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + SSE_DELIMITER.length);
          const event = parseEvent(frame);
          if (!activeRunIsCurrent(generation, controller)) return;
          if (event) applyEvent(event);
          idx = buffer.indexOf(SSE_DELIMITER);
        }
      }

      const tail = buffer.trim();
      if (!activeRunIsCurrent(generation, controller)) return;
      if (tail !== "") {
        const event = parseEvent(tail);
        if (activeRunIsCurrent(generation, controller) && event) applyEvent(event);
      }
    } catch (err: unknown) {
      if (!activeRunIsCurrent(generation, controller)) return;
      const msg = err instanceof Error ? err.message : "Run failed.";
      setError(msg);
      setSuccessAnnouncement(`Run failed. ${msg}`);
      pushLog({ id: genId(), level: "error", text: msg });
    } finally {
      if (generation === runGenerationRef.current && activeRunAbortRef.current === controller) {
        activeRunAbortRef.current = null;
        reportRunning(false);
        setSuccessAnnouncement((current) => {
          if (current?.startsWith("Run failed.")) return current;
          const outcome = runOutcomeRef.current;
          if (!outcome) return "Run stream ended without a final receipt.";
          return `${outcome.status === "error" ? "Run failed" : "Run finished"}. ${totalRef.current.toFixed(3)} USDC.`;
        });
      }
    }
  }, [
    running,
    triggerInputText,
    flowId,
    emitStatuses,
    applyEvent,
    pushLog,
    runBlocker,
    prepareRun,
    immutableVersion,
    scopedMode,
    runScopedTest,
    beginActiveRun,
    activeRunIsCurrent,
    reportRunning,
  ]);

  const durableVersionKey = immutableVersion ? `${flowId}:${immutableVersion.id}` : null;
  if (apiOperationSimulation !== undefined) {
    return <div style={{ height: "100%", background: "var(--ink-panel)" }}>
      {apiOperationSimulation.status === "success"
        ? <ApiOperationSimulationReceiptView receipt={apiOperationSimulation.receipt} />
        : <section aria-label="API operation simulation" style={{ height: "100%", display: "grid", placeItems: "center", padding: 16 }}>
            <p role="status" aria-live="polite" aria-atomic="true" className="mono" style={{ margin: 0, color: apiOperationSimulation.status === "error" ? "var(--rights-red)" : "var(--text-muted)" }}>
              {apiOperationSimulation.status === "busy"
                ? "Simulating locally. No request will be sent."
                : apiOperationSimulation.status === "error"
                  ? apiOperationSimulation.message
                  : "Choose Simulate workflow in the API operation Inspector."}
            </p>
          </section>}
    </div>;
  }
  if (!scopedMode && immutableVersionStatus !== "ready") {
    return <div className="durable-version-pending" role="status" aria-live="polite">
      {immutableVersionStatus === "loading"
        ? "Checking immutable versions before Run is available."
        : "Immutable version history is unavailable. Run is disabled until it can be checked."}
    </div>;
  }
  if (!scopedMode && immutableVersion && durableFallbackKey !== durableVersionKey) {
    return <DurableRunMonitor
      key={durableVersionKey}
      flowId={flowId}
      immutableVersion={immutableVersion}
      triggerInputText={triggerInputText}
      runBlocker={runBlocker}
      onRunningChange={onRunningChange}
      fallbackToLegacy={() => {
        setDurableFallbackKey(durableVersionKey);
        setLegacyAdmissionReceipt(true);
        void runLegacyV2();
      }}
      onTriggerInputChange={(value) => { userEditedInputRef.current = true; setTriggerInputText(value); }}
    />;
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(200px, 0.9fr) minmax(180px, 1.6fr) minmax(220px, 1fr)",
        gap: 1,
        height: "100%",
        background: "var(--hairline-visible)",
        borderTop: "1px solid var(--hairline-visible)",
      }}
    >
      {/* Controls */}
      <div
        style={{
          background: "var(--ink-panel)",
          padding: "12px 14px",
          display: "flex",
          flexDirection: "column",
          gap: 10,
          overflowY: "auto",
        }}
      >
        {scopedMode ? (
          <>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <span className="eyebrow">Scoped test</span>
              <span
                className="mono"
                style={{
                  color: "var(--text-info)", border: "1px solid var(--registry-cyan)",
                  borderRadius: 999, padding: "2px 7px", fontSize: "var(--text-label)",
                }}
              >
                Test
              </span>
            </div>
            <div className="mono" style={{ color: "var(--text-muted)", fontSize: "var(--text-xs)" }}>
              {testScope ? scopeReceipt(testScope) : "No test scope"}
              <br />
              {testEnvironment?.name ?? "No test environment"}
            </div>
            {scopedPlan?.status === "ready" && scopedPlan.pins.map((pin, index) => {
              const fieldId = `${blockerStatusId}-pin-${index}`;
              return (
                <label
                  key={pin.key}
                  htmlFor={fieldId}
                  className="mono"
                  style={{ display: "grid", gap: 5, color: "var(--text-muted)", fontSize: "var(--text-xs)" }}
                >
                  {pin.label}
                  {pin.control === "boolean" ? (
                    <select
                      id={fieldId}
                      value={pinValues[pin.key] ?? "false"}
                      onChange={(event) => setPinValues((current) => ({
                        ...current, [pin.key]: event.target.value,
                      }))}
                      style={{
                        height: "var(--control-h)", background: "var(--ink-control)", color: "var(--text-primary)",
                        border: "1px solid var(--hairline)", borderRadius: "var(--radius-sm)", padding: "0 8px",
                      }}
                    >
                      <option value="false">False</option>
                      <option value="true">True</option>
                    </select>
                  ) : (
                    <textarea
                      id={fieldId}
                      value={pinValues[pin.key] ?? "null"}
                      spellCheck={false}
                      onChange={(event) => setPinValues((current) => ({
                        ...current, [pin.key]: event.target.value,
                      }))}
                      style={{
                        minHeight: 54, resize: "vertical", background: "var(--ink-control)", color: "var(--text-primary)",
                        border: "1px solid var(--hairline)", borderRadius: "var(--radius-sm)", padding: "8px",
                        fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)",
                      }}
                    />
                  )}
                </label>
              );
            })}
            {onTestScopeClear && (
              <button
                type="button"
                onClick={() => {
                  cancelActiveRun();
                  reportRunning(false);
                  emitStatuses({});
                  onTestScopeClear();
                }}
                className="mono lp-touch"
                style={{
                  border: 0, background: "transparent", color: "var(--text-muted)",
                  textDecoration: "underline", cursor: "pointer", textAlign: "left", padding: 0,
                }}
              >
                Clear test scope
              </button>
            )}
          </>
        ) : (
          <>
            {!immutableVersion && !blockedMessage ? <p className="legacy-admission-receipt legacy-admission-receipt--draft" role="status" aria-live="polite">
              Draft run: streams live while you build. Save a version for durable, replayable runs.
            </p> : null}
            {legacyAdmissionReceipt ? <p ref={legacyAdmissionNoticeRef} tabIndex={-1} className="legacy-admission-receipt" role="status" aria-live="polite">
              Durable admission was refused. This is a Legacy run using the existing v2 transport.
            </p> : null}
            <div className="eyebrow">Trigger input</div>
            <textarea
              value={triggerInputText}
              spellCheck={false}
              aria-label="Trigger input JSON"
              onChange={(e) => {
                userEditedInputRef.current = true;
                setTriggerInputText(e.target.value);
              }}
              style={{
                flex: 1,
                minHeight: 56,
                background: "var(--ink-control)",
                border: "1px solid var(--hairline)",
                borderRadius: "var(--radius-sm)",
                color: "var(--text-primary)",
                padding: "8px 10px",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-xs)",
                resize: "none",
              }}
            />
          </>
        )}
        <button
          type="button"
          ref={runControlRef}
          onClick={() => { if (running || blockedMessage) return; void runLegacyV2(); }}
          disabled={running || (scopedMode && Boolean(blockedMessage))}
          aria-disabled={running || Boolean(blockedMessage)}
          aria-describedby={visibleError ? blockerStatusId : undefined}
          style={{
            height: "var(--control-h)",
            flexShrink: 0,
            background: inertRun ? "var(--ink-control)" : "var(--primary)",
            color: inertRun ? "var(--text-muted)" : "var(--on-primary)",
            border: `1px solid ${inertRun ? "var(--hairline)" : "var(--primary)"}`,
            borderRadius: "var(--radius)",
            fontFamily: "var(--font-mono)",
            fontWeight: 700,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            fontSize: "var(--text-eyebrow)",
            cursor: inertRun ? "not-allowed" : "pointer",
            opacity: inertRun ? 0.7 : 1,
            boxShadow: inertRun ? "none" : "var(--shadow-sm)",
            transition: "background 120ms ease",
          }}
          onMouseEnter={(e) => {
            if (!inertRun)
              e.currentTarget.style.background = "var(--primary-hover)";
          }}
          onMouseLeave={(e) => {
            if (!inertRun) e.currentTarget.style.background = "var(--primary)";
          }}
        >
          {running
            ? (prepareRun ? "Saving…" : scopedMode ? "Testing..." : "Running…")
            : (prepareRun ? "Save to run" : scopedMode ? "Run test" : "Run")}
        </button>
        {visibleError && (
          <p
            id={blockerStatusId}
            className="mono"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            style={{
              /* Guidance blockers read as next steps, not failures; true run
                 errors keep the red. */
              color: blockedMessage ? "var(--text-muted)" : "var(--rights-red)",
              fontSize: "var(--text-xs)",
              margin: 0,
            }}
          >
            {visibleError}
          </p>
        )}
      </div>

      {/* Run log */}
      <div
        style={{
          background: "var(--ink-deep)",
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
        }}
      >
        <h3
          className="eyebrow"
          style={{ padding: "10px 14px 6px", color: "var(--text-muted)", margin: 0, lineHeight: "inherit", fontWeight: "inherit" }}
        >
          {scopedMode ? "Test receipt" : "Run log"}
        </h3>
        {successAnnouncement ? (
          <p
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="mono"
            style={{ margin: "0 14px 6px", color: "var(--text-success)", fontSize: "var(--text-xs)" }}
          >
            {successAnnouncement}
          </p>
        ) : null}
        <div
          ref={logRef}
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "0 14px 12px",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            lineHeight: 1.6,
          }}
        >
          {logs.length === 0 ? (
            <span style={{ color: "var(--text-muted)" }}>
              {scopedMode ? "No test yet. Add required pins, then run the scoped test." : "No run yet. Press Run to stream execution."}
            </span>
          ) : (
            logs.map((line) => (
              <div
                key={line.id}
                style={{
                  color:
                    line.level === "error"
                      ? "var(--rights-red)"
                      : "var(--text-primary)",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {line.text}
              </div>
            ))
          )}
          {scopedMode && testResult && testResult.events.length + testResult.logs.length > logs.length ? (
            <div className="mono" style={{ color: "var(--text-muted)", marginTop: 6 }}>
              {testResult.events.length + testResult.logs.length - logs.length} more event or log rows retained in the result.
            </div>
          ) : null}
          {scopedMode && testResult ? (
            <section aria-label="Test outputs" style={{ marginTop: 12 }}>
              <div className="eyebrow" style={{ color: "var(--text-muted)", marginBottom: 6 }}>Test outputs</div>
              {Object.entries(testResult.outputs).slice(0, MAX_VISIBLE_TEST_OUTPUTS).map(([nodeId, output]) => (
                <div key={nodeId} style={{ display: "grid", gap: 6, marginBottom: 10, color: "var(--text-primary)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                  <span>{nodeId}: {formatCapturedOutput(output)}</span>
                  <ArtifactDownloadButton artifact={artifactDescriptor(output)} />
                  <ReportContentButton
                    subject={{ subjectType: "run_output", flowId, runId: testResult.runId, nodeId }}
                  />
                </div>
              ))}
              {Object.keys(testResult.outputs).length > MAX_VISIBLE_TEST_OUTPUTS ? (
                <div style={{ color: "var(--text-muted)" }}>
                  {Object.keys(testResult.outputs).length - MAX_VISIBLE_TEST_OUTPUTS} more outputs retained in the result.
                </div>
              ) : null}
            </section>
          ) : null}
          {!scopedMode && Object.keys(legacyOutputs).length > 0 ? (
            <section aria-label="Run outputs" style={{ marginTop: 12 }}>
              <div className="eyebrow" style={{ color: "var(--text-muted)", marginBottom: 6 }}>Run outputs</div>
              {Object.entries(legacyOutputs).slice(0, MAX_VISIBLE_TEST_OUTPUTS).map(([nodeId, result]) => (
                <div key={nodeId} style={{ display: "grid", gap: 6, marginBottom: 10, color: "var(--text-primary)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                  <span>{nodeId}: {formatVisibleOutput(result.output)}</span>
                  <ArtifactDownloadButton artifact={artifactDescriptor(result.output)} />
                  <ReportContentButton
                    subject={{ subjectType: "run_output", flowId, runId: result.runId, nodeId }}
                  />
                </div>
              ))}
            </section>
          ) : null}
        </div>
      </div>

      {/* Cost ledger */}
      <div
        style={{
          background: "var(--ink-panel)",
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
        }}
      >
        <h3
          className="eyebrow"
          style={{ padding: "10px 14px 6px", color: "var(--text-muted)", margin: 0, lineHeight: "inherit", fontWeight: "inherit" }}
        >
          Cost ledger
        </h3>
        <div style={{ flex: 1, overflowY: "auto", padding: "0 14px" }}>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: "var(--text-xs)",
            }}
          >
            <thead>
              <tr>
                {["NODE", "TYPE", "STATUS", "USDC"].map((h, i) => (
                  <th
                    key={h}
                    className="mono"
                    style={{
                      textAlign: i === 3 ? "right" : "left",
                      color: "var(--text-muted)",
                      fontWeight: 600,
                      fontSize: "var(--text-label)",
                      letterSpacing: "0.08em",
                      padding: "6px 6px",
                      borderBottom: "1px solid var(--hairline)",
                      position: "sticky",
                      top: 0,
                      background: "var(--ink-panel)",
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ledger.length === 0 ? (
                <tr>
                  <td
                    colSpan={4}
                    className="mono"
                    style={{
                      color: "var(--text-muted)",
                      padding: "10px 6px",
                    }}
                  >
                    No costs yet
                  </td>
                </tr>
              ) : (
                ledger.map((row) => (
                  <tr key={row.nodeId} className="rundock-ledger-row" data-status={row.status}>
                    <td
                      className="mono"
                      title={row.nodeId}
                      style={{
                        padding: "5px 6px",
                        color: "var(--text-primary)",
                        maxWidth: 84,
                        overflowWrap: "anywhere",
                      }}
                    >
                      {row.nodeId}
                    </td>
                    <td
                      className="mono"
                      title={row.nodeType}
                      style={{
                        padding: "5px 6px",
                        color: "var(--text-info)",
                        maxWidth: 96,
                        overflowWrap: "anywhere",
                      }}
                    >
                      {row.nodeType}
                    </td>
                    <td
                      className="mono"
                      style={{
                        padding: "5px 6px",
                        color: ledgerStatusColor(row.status),
                      }}
                    >
                      <span className="rundock-status" data-status={row.status}>
                        <span className="rundock-status__dot" aria-hidden="true" />
                        {row.status}
                      </span>
                    </td>
                    <td
                      className="mono ledger-figure"
                      style={{
                        padding: "5px 6px",
                        textAlign: "right",
                        color: "var(--text-primary)",
                      }}
                    >
                      {row.costUsdc.toFixed(3)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          {scopedMode && testResult && Object.keys(testResult.outputs).length > ledger.length ? (
            <p className="mono" style={{ margin: "6px", color: "var(--text-muted)", fontSize: "var(--text-label)" }}>
              {Object.keys(testResult.outputs).length - ledger.length} more ledger rows retained in the result.
            </p>
          ) : null}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "10px 14px",
            borderTop: "1px solid var(--hairline)",
          }}
        >
          <span
            className="eyebrow"
            style={{ color: "var(--text-muted)" }}
          >
            Total
          </span>
          <span
            className="mono ledger-figure"
            style={{
              color: "var(--text-success)",
              fontWeight: 700,
              fontSize: "var(--text-sm)",
            }}
          >
            {scopedMode
              ? `$0.000 USDC · ${testLatencyMs ?? testResult?.latencyMs ?? 0} ms`
              : `$${total.toFixed(3)} USDC`}
          </span>
        </div>
      </div>
    </div>
  );
}

const DURABLE_SESSION_PREFIX = "suede:durable-run:";
const TERMINAL_DURABLE_STATES = new Set(["succeeded", "failed", "cancelled", "dead"]);

export interface DurableRunMonitorProps {
  readonly flowId: string;
  readonly immutableVersion: { readonly id: string; readonly versionNumber?: number };
  readonly triggerInputText?: string;
  readonly initialRunId?: string;
  readonly initialRun?: DurableClientRun;
  readonly initialEventSummary?: readonly { readonly sequence: number; readonly label: string }[];
  readonly runBlocker?: () => string | null;
  readonly onRunningChange?: (running: boolean) => void;
  readonly onTriggerInputChange?: (value: string) => void;
  readonly fallbackToLegacy?: () => void;
  readonly compact?: boolean;
}

function durableSessionKey(flowId: string): string { return `${DURABLE_SESSION_PREFIX}${flowId}`; }
function durablePendingSessionKey(flowId: string, versionId: string): string { return `${DURABLE_SESSION_PREFIX}pending:${flowId}:${versionId}`; }
function durableRetrySessionKey(flowId: string, runId: string): string { return `${DURABLE_SESSION_PREFIX}retry:${flowId}:${runId}`; }
type StoredDurableRun = Readonly<{ kind: "accepted"; runId: string; lastSequence: number }>;
type StoredDurablePending = Readonly<{
  kind: "pending";
  idempotencyKey: string;
  triggerInput: Readonly<Record<string, unknown>>;
}>;
type StoredDurableState = StoredDurableRun | StoredDurablePending;
function safeSession(): Storage | null {
  try { return typeof window === "undefined" ? null : window.sessionStorage; } catch { return null; }
}
function storedRun(flowId: string, versionId: string): StoredDurableState | null {
  let readingPending = false;
  const invalid = () => {
    try { safeSession()?.removeItem(readingPending ? durablePendingSessionKey(flowId, versionId) : durableSessionKey(flowId)); } catch {}
    return null;
  };
  try {
    const pendingRaw = safeSession()?.getItem(durablePendingSessionKey(flowId, versionId));
    readingPending = Boolean(pendingRaw);
    const raw = pendingRaw ?? safeSession()?.getItem(durableSessionKey(flowId));
    if (!raw) return null;
    if (raw.length > 524_288) return invalid();
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
    const kind = Object.getOwnPropertyDescriptor(value, "kind")?.value;
    const runId = Object.getOwnPropertyDescriptor(value, "runId")?.value;
    const storedVersion = Object.getOwnPropertyDescriptor(value, "flowVersionId")?.value;
    const lastSequence = Object.getOwnPropertyDescriptor(value, "lastSequence")?.value;
    if (storedVersion !== versionId) return invalid();
    if ((kind === "accepted" && Reflect.ownKeys(value).length === 4) || (kind === undefined && Reflect.ownKeys(value).length === 3)) {
      if (typeof runId !== "string" || !Number.isSafeInteger(lastSequence) || Number(lastSequence) < 0) return invalid();
      durableRunUrls(runId);
      return { kind: "accepted", runId, lastSequence: Number(lastSequence) };
    }
    if (kind === "pending" && Reflect.ownKeys(value).length === 4) {
      const idempotencyKey = Object.getOwnPropertyDescriptor(value, "idempotencyKey")?.value;
      const triggerInput = Object.getOwnPropertyDescriptor(value, "triggerInput")?.value;
      if (typeof idempotencyKey !== "string" || !triggerInput || typeof triggerInput !== "object" || Array.isArray(triggerInput)) return invalid();
      durableRunUrls(idempotencyKey);
      return { kind, idempotencyKey, triggerInput: triggerInput as Readonly<Record<string, unknown>> };
    }
    return invalid();
  } catch { return invalid(); }
}
function rememberRun(flowId: string, flowVersionId: string, runId: string, lastSequence: number): boolean {
  try {
    const storage = safeSession(); if (!storage) return false;
    const key = durableSessionKey(flowId);
    const value = JSON.stringify({ runId, flowVersionId, lastSequence });
    storage.setItem(key, value);
    return storage.getItem(key) === value;
  } catch { return false; }
}
function rememberPendingRun(flowId: string, flowVersionId: string, idempotencyKey: string, triggerInput: Readonly<Record<string, unknown>>): boolean {
  try {
    const storage = safeSession(); if (!storage) return false;
    const key = durablePendingSessionKey(flowId, flowVersionId);
    const value = JSON.stringify({ kind: "pending", flowVersionId, idempotencyKey, triggerInput });
    storage.setItem(key, value);
    return storage.getItem(key) === value;
  } catch { return false; }
}
function forgetPendingRun(flowId: string, flowVersionId: string): void {
  try { safeSession()?.removeItem(durablePendingSessionKey(flowId, flowVersionId)); } catch {}
}
function retryIdempotencyKey(flowId: string, runId: string): string | null {
  try {
    const value = safeSession()?.getItem(durableRetrySessionKey(flowId, runId));
    if (!value) return null;
    durableRunUrls(value);
    return value;
  } catch {
    try { safeSession()?.removeItem(durableRetrySessionKey(flowId, runId)); } catch {}
    return null;
  }
}
function rememberRetryKey(flowId: string, runId: string, key: string): boolean {
  try {
    const storage = safeSession(); if (!storage) return false;
    const storageKey = durableRetrySessionKey(flowId, runId);
    storage.setItem(storageKey, key);
    return storage.getItem(storageKey) === key;
  } catch { return false; }
}
function forgetRetryKey(flowId: string, runId: string): void {
  try { safeSession()?.removeItem(durableRetrySessionKey(flowId, runId)); } catch {}
}
function forgetRun(flowId: string): void {
  try { safeSession()?.removeItem(durableSessionKey(flowId)); } catch {}
}
function formatMicroUsdc(value: number): string {
  const whole = Math.floor(value / 1_000_000); const fraction = String(value % 1_000_000).padStart(6, "0");
  return `${whole}.${fraction} USDC`;
}

export function DurableRunMonitor({
  flowId, immutableVersion, triggerInputText = "{}", initialRunId, initialRun, initialEventSummary = [], runBlocker,
  onRunningChange, onTriggerInputChange, fallbackToLegacy, compact = false,
}: DurableRunMonitorProps): React.JSX.Element {
  const recoveredRef = useRef<StoredDurableState | null>(initialRunId
    ? { kind: "accepted", runId: initialRunId, lastSequence: 0 }
    : storedRun(flowId, immutableVersion.id));
  const recoveredRun = recoveredRef.current?.kind === "accepted" ? recoveredRef.current : null;
  const [run, setRun] = useState<DurableClientRun | null>(initialRun ?? null);
  const [runId, setRunId] = useState<string | null>(() => recoveredRun?.runId ?? null);
  const [busy, setBusy] = useState(recoveredRef.current?.kind === "pending");
  const [pendingCancel, setPendingCancel] = useState(false);
  const [message, setMessage] = useState<string | null>(() => initialRunId && retryIdempotencyKey(flowId, initialRunId)
    ? "A retry response was interrupted. Retry will safely reuse the same request key."
    : null);
  const [events, setEvents] = useState<readonly { readonly sequence: number; readonly label: string }[]>(initialEventSummary);
  const cursorRef = useRef(Math.max(recoveredRun?.lastSequence ?? 0, initialEventSummary.at(-1)?.sequence ?? 0));
  const monitorGenerationRef = useRef(0);
  const lifecycleGenerationRef = useRef(0);
  const startInFlightRef = useRef(false);
  const actionInFlightRef = useRef(false);
  const actionButtonRef = useRef<HTMLButtonElement | null>(null);
  const statusHeadingRef = useRef<HTMLElement | null>(null);
  const receiptHeadingRef = useRef<HTMLHeadingElement | null>(null);
  // The monitor below seeds its high-water mark from the run it can see when it
  // starts, but it must not restart when that run advances — every streamed
  // event moves `projection.sequence`, so depending on it directly would tear
  // down and re-open the event stream on each event. Mirroring `run` into a ref
  // keeps the seed current without making it reactive.
  //
  // Declared before the monitor effect on purpose: effects run in declaration
  // order, so this ref is already up to date by the time the monitor reads it.
  const runRef = useRef(run);
  useEffect(() => { runRef.current = run; }, [run]);

  const actions = run ? durableActionAvailability(run.projection.state, run.projection.desiredState) : [];

  useEffect(() => {
    setPendingCancel(false);
  }, [runId, run?.projection.state, run?.projection.desiredState]);

  useEffect(() => {
    lifecycleGenerationRef.current += 1;
    return () => { lifecycleGenerationRef.current += 1; };
  }, [flowId, immutableVersion.id]);

  useEffect(() => {
    if (!runId) return;
    const controller = new AbortController();
    const generation = ++monitorGenerationRef.current;
    let delay = 250;
    let highWater = Math.max(cursorRef.current, runRef.current?.projection.sequence ?? 0);
    const current = () => !controller.signal.aborted && generation === monitorGenerationRef.current;
    const sleep = (ms: number) => new Promise<void>((resolve) => {
      const stop = () => { window.clearTimeout(timer); resolve(); };
      const timer = window.setTimeout(() => { controller.signal.removeEventListener("abort", stop); resolve(); }, ms);
      controller.signal.addEventListener("abort", stop, { once: true });
    });
    const load = async (): Promise<DurableClientRun | null> => {
      const response = await fetch(durableRunUrls(runId).status, { cache: "no-store", signal: controller.signal });
      if (response.status === 404) return null;
      if (!response.ok) throw new TypeError("durable status unavailable");
      const envelope = parseDurableRunEnvelope(await readBoundedDurableJson(response, controller.signal));
      if (!envelope) throw new TypeError("invalid durable status");
      return envelope.run;
    };
    const monitor = async () => {
      while (current()) {
        try {
          const latest = await load();
          if (!current()) return;
          if (!latest || latest.executionId !== runId || latest.flowId !== flowId || latest.flowVersionId !== immutableVersion.id) {
            forgetRun(flowId); cursorRef.current = 0; setRun(null); setRunId(null); onRunningChange?.(false);
            setMessage("That saved durable receipt is unavailable. You can start a new run."); return;
          }
          setMessage(null);
          let progressed = latest.projection.sequence > highWater;
          highWater = Math.max(highWater, latest.projection.sequence);
          setRun((currentRun) => !currentRun || currentRun.executionId !== latest.executionId ||
            latest.projection.sequence >= currentRun.projection.sequence ? latest : currentRun);
          if (cursorRef.current > latest.projection.sequence) {
            cursorRef.current = 0;
            rememberRun(flowId, immutableVersion.id, runId, 0);
            setEvents([]);
          }
          const isTerminal = TERMINAL_DURABLE_STATES.has(latest.projection.state);
          onRunningChange?.(!isTerminal);
          if (isTerminal && cursorRef.current >= latest.projection.sequence) return;
          const response = await fetch(`${durableRunUrls(runId).events}?after=${cursorRef.current}`, {
            cache: "no-store", headers: { "Last-Event-ID": String(cursorRef.current) }, signal: controller.signal,
          });
          if (!current()) return;
          const beforeStream = cursorRef.current;
          cursorRef.current = await readDurableEventStream({ response, runId, after: cursorRef.current, signal: controller.signal, onEvent(event) {
            cursorRef.current = event.sequence;
            rememberRun(flowId, immutableVersion.id, runId, event.sequence);
            setEvents((currentEvents) => [...currentEvents.filter((item) => item.sequence !== event.sequence), { sequence: event.sequence, label: `${event.sequence} ${event.type}` }].sort((a, b) => a.sequence - b.sequence).slice(-50));
          } });
          if (cursorRef.current > beforeStream) progressed = true;
          highWater = Math.max(highWater, cursorRef.current);
          if (progressed) delay = 250;
          else { await sleep(delay); delay = Math.min(delay * 2, 5_000); }
          // A clean SSE close means only that this reader ended. Confirm state with GET.
        } catch {
          if (!current()) return;
          setMessage("Connection paused. The durable execution is still being checked.");
          await sleep(delay); delay = Math.min(delay * 2, 5_000);
        }
      }
    };
    void monitor();
    return () => { controller.abort(); };
  }, [flowId, immutableVersion.id, onRunningChange, runId]);

  const begin = async (
    pending?: StoredDurablePending,
    options?: { readonly restart?: boolean },
  ): Promise<void> => {
    if (startInFlightRef.current || (runId && options?.restart !== true)) return;
    const stablePending = pending ?? (recoveredRef.current?.kind === "pending" ? recoveredRef.current : undefined);
    const blocked = runBlocker?.() ?? null; if (blocked) { setMessage(blocked); return; }
    let triggerInput: Record<string, unknown>;
    try {
      const parsed: unknown = stablePending?.triggerInput ?? JSON.parse(triggerInputText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError();
      triggerInput = parsed as Record<string, unknown>;
    } catch { setMessage("Trigger input must be a JSON object."); return; }
    if (!globalThis.crypto?.randomUUID) { setMessage("Durable execution is unavailable in this browser."); return; }
    const idempotencyKey = stablePending?.idempotencyKey ?? globalThis.crypto.randomUUID();
    const generation = lifecycleGenerationRef.current;
    const pendingState: StoredDurablePending = { kind: "pending", idempotencyKey, triggerInput };
    if (!rememberPendingRun(flowId, immutableVersion.id, idempotencyKey, triggerInput)) {
      setMessage("Durable execution cannot start because this browser cannot safely retain its request key."); return;
    }
    if (options?.restart === true) {
      if (runId) forgetRetryKey(flowId, runId);
      forgetRun(flowId);
      monitorGenerationRef.current += 1;
      cursorRef.current = 0;
      runRef.current = null;
      setRun(null);
      setRunId(null);
      setEvents([]);
      setPendingCancel(false);
    }
    recoveredRef.current = pendingState;
    startInFlightRef.current = true; setBusy(true); onRunningChange?.(true); setMessage(stablePending ? "Recovering the pending durable start…" : null); setEvents([]);
    try {
      const result = await enqueueDurableRun({ flowId, flowVersionId: immutableVersion.id, triggerInput, idempotencyKey });
      if (generation !== lifecycleGenerationRef.current) return;
      if (result.status === "not-admitted") { recoveredRef.current = null; forgetPendingRun(flowId, immutableVersion.id); forgetRun(flowId); onRunningChange?.(false); fallbackToLegacy?.(); return; }
      if (result.status === "rejected") {
        recoveredRef.current = null; forgetPendingRun(flowId, immutableVersion.id); onRunningChange?.(false);
        setMessage("Durable execution could not start."); return;
      }
      if (result.status !== "accepted") {
        onRunningChange?.(false);
        setMessage("Durable start is pending. Retry will safely reuse the same request key.");
        return;
      }
      recoveredRef.current = { kind: "accepted", runId: result.receipt.runId, lastSequence: 0 };
      const receiptStored = rememberRun(flowId, immutableVersion.id, result.receipt.runId, 0);
      if (receiptStored) forgetPendingRun(flowId, immutableVersion.id);
      else setMessage("The run was accepted, but its receipt could not be retained. Recovery will reuse the pending request key.");
      cursorRef.current = 0; setRunId(result.receipt.runId); onRunningChange?.(true);
      requestAnimationFrame(() => receiptHeadingRef.current?.focus());
    } catch { onRunningChange?.(false); setMessage("Durable execution could not start."); }
    finally { startInFlightRef.current = false; if (generation === lifecycleGenerationRef.current) setBusy(false); }
  };

  useEffect(() => {
    const pending = recoveredRef.current;
    if (pending?.kind !== "pending") return;
    setBusy(false);
    void begin(pending);
    // The recovered identity is immutable for this mounted lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowId, immutableVersion.id]);

  const runFinished = run ? TERMINAL_DURABLE_STATES.has(run.projection.state) : false;

  const startAnotherRun = async (): Promise<void> => {
    if (startInFlightRef.current) return;
    await begin(undefined, { restart: true });
  };

  const act = async (action: DurableClientAction): Promise<void> => {
    if (!runId || actionInFlightRef.current || busy || !actions.includes(action) || !globalThis.crypto?.randomUUID) return;
    const generation = lifecycleGenerationRef.current;
    actionInFlightRef.current = true; setBusy(true); setMessage(null); actionButtonRef.current = document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
    try {
      const retryKey = action === "retry" ? retryIdempotencyKey(flowId, runId) ?? crypto.randomUUID() : null;
      if (retryKey && !rememberRetryKey(flowId, runId, retryKey)) throw new TypeError("retry key unavailable");
      const response = await fetch(durableRunUrls(runId).actions, {
        method: "POST", headers: {
          "content-type": "application/json",
          ...(retryKey ? { "idempotency-key": retryKey } : {}),
        }, body: JSON.stringify({ action }),
      });
      if (generation !== lifecycleGenerationRef.current) return;
      if (response.status === 409) {
        setMessage("The run changed before that action. Showing its latest state.");
        const latestResponse = await fetch(durableRunUrls(runId).status, { cache: "no-store" });
        const latest = latestResponse.ok ? parseDurableRunEnvelope(await readBoundedDurableJson(latestResponse)) : null;
        if (generation !== lifecycleGenerationRef.current) return;
        if (latest?.run.executionId === runId) setRun((currentRun) => !currentRun || latest.run.projection.sequence >= currentRun.projection.sequence ? latest.run : currentRun);
        if (latest?.run.executionId === runId) forgetRetryKey(flowId, runId);
        return;
      }
      if (!(response.ok || response.status === 202)) {
        if (retryKey && response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) forgetRetryKey(flowId, runId);
        throw new TypeError();
      }
      const envelope = parseDurableActionEnvelope(await readBoundedDurableJson(response));
      if (generation !== lifecycleGenerationRef.current) return;
      if (!envelope || envelope.action !== action) throw new TypeError();
      if (envelope.action === "retry") {
        // Compact mode is the run detail page (a server component keyed on
        // the runId route param); swapping local state alone would leave
        // its URL pointing at the finished run. A full navigation lands the
        // visitor on the new run's own page, matching what "Run again"
        // promises: an actual new run to look at, not just fresh state here.
        if (compact) { window.location.assign(`/runs/${encodeURIComponent(envelope.runId)}`); return; }
        const receiptStored = rememberRun(flowId, immutableVersion.id, envelope.runId, 0);
        if (receiptStored) forgetRetryKey(flowId, runId);
        else setMessage("The retry was accepted, but its child receipt could not be retained. Recovery will reuse the retry request key.");
        cursorRef.current = 0; setEvents([]); setRun(null); setRunId(envelope.runId); onRunningChange?.(true);
      } else {
        setRun((currentRun) => currentRun && envelope.run.executionId === currentRun.executionId &&
          envelope.run.sequence >= currentRun.projection.sequence ? { ...currentRun, projection: envelope.run } : currentRun);
      }
    } catch { setMessage("That durable action could not be applied."); }
    finally { actionInFlightRef.current = false; if (generation === lifecycleGenerationRef.current) { setBusy(false); requestAnimationFrame(() => action === "retry" ? receiptHeadingRef.current?.focus() : actionButtonRef.current?.isConnected ? actionButtonRef.current.focus() : statusHeadingRef.current?.focus()); } }
  };

  return <section className={`durable-run-monitor${compact ? " durable-run-monitor--compact" : ""}`} aria-labelledby="durable-run-title">
    <div className="durable-run-controls">
      {compact ? <h2 id="durable-run-title" ref={receiptHeadingRef} tabIndex={-1}>Live controls</h2> : null}
      <div><span className="eyebrow">Durable run</span><span className="durable-version-badge">{immutableVersion.versionNumber === undefined ? `Immutable ${immutableVersion.id}` : `Immutable v${immutableVersion.versionNumber}`}</span></div>
      {!compact ? <>
        <label className="eyebrow" htmlFor="durable-trigger-input">Trigger input</label>
        <textarea id="durable-trigger-input" aria-label="Trigger input JSON" value={triggerInputText} disabled={Boolean(runId) && !runFinished} onChange={(event) => onTriggerInputChange?.(event.target.value)} />
        {!runId || runFinished ? <button type="button" className="durable-primary" disabled={busy} onClick={() => void (runFinished ? startAnotherRun() : begin())}>{busy ? "Starting…" : runFinished ? "New run" : "Run durable"}</button> : null}
      </> : null}
      {run ? <div className="durable-actions" aria-label="Durable run actions">{actions.map((action) => {
        const armed = action === "cancel" && pendingCancel;
        return <button
          key={action}
          type="button"
          disabled={busy}
          onClick={() => {
            if (action !== "cancel") { void act(action); return; }
            if (!pendingCancel) { setPendingCancel(true); return; }
            setPendingCancel(false);
            void act("cancel");
          }}
          onBlur={action === "cancel" ? () => setPendingCancel(false) : undefined}
        >{armed
          ? "Confirm cancel"
          : action === "resume" ? "Restart-safe resume" : action === "retry" && compact ? "Run again" : action[0]?.toUpperCase() + action.slice(1)}</button>;
      })}</div> : null}
      {compact && run ? <p role="status" aria-live="polite" aria-atomic="true"><strong ref={statusHeadingRef} tabIndex={-1}>{run.projection.state}</strong>{run.projection.desiredState !== "running" ? ` · ${run.projection.desiredState} requested` : ""}</p> : null}
      {message ? <p role="status" aria-live="polite">{message}</p> : null}
    </div>
    {!compact ? <div className="durable-run-receipt">
      <h2 id="durable-run-title" ref={receiptHeadingRef} tabIndex={-1}>Execution receipt</h2>
      {run ? <>
        <p role="status" aria-live="polite" aria-atomic="true"><strong ref={statusHeadingRef} tabIndex={-1}>{run.projection.state}</strong>{run.projection.desiredState !== "running" ? ` · ${run.projection.desiredState} requested` : ""}</p>
        <dl><div><dt>Run</dt><dd>{run.executionId}</dd></div><div><dt>Attempt</dt><dd>{run.projection.attempt}</dd></div><div><dt>Cost</dt><dd>{formatMicroUsdc(run.projection.costMicroUsdc)}</dd></div><div><dt>Tokens</dt><dd>{run.projection.tokens}</dd></div></dl>
        <p>Draft edits are not included in this immutable execution receipt.</p>
        {run.projection.output !== null ? <div style={{ display: "grid", gap: 8 }}>
          <code className="durable-output">{formatVisibleOutput(run.projection.output)}</code>
          <ArtifactDownloadButton artifact={artifactDescriptor(run.projection.output)} />
          <ReportContentButton subject={{ subjectType: "run_output", flowId, runId: run.executionId }} />
        </div> : null}
        <a href={`/runs/${encodeURIComponent(run.executionId)}`}>Open run details</a>
      </> : <p>{runId ? "Reconnecting to the durable receipt…" : "Start from this immutable version. Draft edits are not included. Closing this page will not stop execution."}</p>}
    </div> : null}
    <div className="durable-event-summary" aria-live={compact ? "polite" : undefined} aria-relevant={compact ? "additions" : undefined}><h2>{compact ? "Persisted event timeline" : "Event summary"}</h2>{events.length ? <ol>{events.map((event) => <li key={event.sequence}>{event.label}</li>)}</ol> : <p>No persisted events loaded yet.</p>}</div>
  </section>;
}
