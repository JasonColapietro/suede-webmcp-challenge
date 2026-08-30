import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import RunDock, { DurableRunMonitor } from "@/components/canvas/RunDock";

describe("RunDock durable mode", () => {
  it("renders immutable durable controls without changing scoped Test", () => {
    const markup = renderToStaticMarkup(createElement(RunDock, {
      flowId: "flow_1", immutableVersion: { id: "version_1", versionNumber: 7 }, defaultTriggerInput: { prompt: "hi" },
    }));
    expect(markup).toContain("Durable run");
    expect(markup).toContain("Immutable v7");
    expect(markup).toContain("Run durable");
    expect(markup).toContain("Draft edits are not included");
    expect(markup).not.toContain("/api/v2/");
  });

  it("renders a recovered receipt and exact restart-safe control matrix", () => {
    const markup = renderToStaticMarkup(createElement(DurableRunMonitor, {
      flowId: "flow_1", immutableVersion: { id: "version_1", versionNumber: 7 }, initialRunId: "run_1",
      initialRun: ownerView("paused", "paused"), initialEventSummary: [{ sequence: 2, label: "2 job.enqueued" }],
    }));
    expect(markup).toContain("Restart-safe resume");
    expect(markup).toContain("Cancel");
    expect(markup).toContain("Open run details");
    expect(markup).toContain("2 job.enqueued");
  });

  it("never exposes legacy Run while version history is loading or failed", () => {
    for (const immutableVersionStatus of ["loading", "error"] as const) {
      const markup = renderToStaticMarkup(createElement(RunDock, { flowId: "flow_1", immutableVersionStatus }));
      expect(markup).not.toContain(">Run<");
      expect(markup).toContain(immutableVersionStatus === "loading" ? "Checking immutable versions" : "Run is disabled");
    }
  });

  it("discloses the draft transport for ready-empty history and keeps compact mode controls-only", () => {
    // The disclosure is the contract: a ready-but-unversioned flow must say
    // its runs are not durable. The voice is a quiet draft notice, not a
    // warning (the red "Legacy run" jargon greeted every new draft).
    const legacy = renderToStaticMarkup(createElement(RunDock, { flowId: "flow_1", immutableVersionStatus: "ready" }));
    expect(legacy).toContain("Draft run: streams live while you build");
    expect(legacy).toContain("Save a version for durable, replayable runs");
    expect(legacy).toContain("legacy-admission-receipt--draft");
    expect(legacy).toContain(">Run<");
    const compact = renderToStaticMarkup(createElement(DurableRunMonitor, {
      compact: true, flowId: "flow_1", immutableVersion: { id: "version_1" }, initialRunId: "run_1", initialRun: ownerView("paused", "paused"),
    }));
    expect(compact).toContain("Live controls"); expect(compact).not.toContain("Execution receipt"); expect(compact).not.toContain("Event summary");
    expect(compact).toContain("Persisted event timeline"); expect(compact).not.toContain("Trigger input"); expect(compact).not.toContain("Run durable");
  });

  it.each([
    ["queued", "running", "Pause"],
    ["running", "running", "Pause"],
    ["cancelled", "cancelled", "Retry"],
    ["dead", "running", "Retry"],
  ] as const)("renders a %s/%s receipt with its authoritative %s control", (state, desiredState, control) => {
    const markup = renderToStaticMarkup(createElement(DurableRunMonitor, {
      flowId: "flow_1", immutableVersion: { id: "version_1" }, initialRunId: "run_1", initialRun: ownerView(state, desiredState),
    }));
    expect(markup).toContain(`<strong tabindex="-1">${state}</strong>`); expect(markup).toContain(`>${control}</button>`);
  });
});

function ownerView(
  state: "queued" | "running" | "paused" | "cancelled" | "dead",
  desiredState: "running" | "paused" | "cancelled",
) {
  return {
    executionId: "run_1", flowId: "flow_1", flowVersionId: "version_1", parentExecutionId: null,
    createdAt: 1, updatedAt: 2, finishedAt: null, deadlineAt: 99,
    projection: {
      schemaVersion: 1 as const, executionId: "run_1", sequence: 2, state, desiredState, attempt: 1,
      jobId: "job_1", attemptId: null, costMicroUsdc: 0, tokens: 0, output: null, error: null,
      nodes: {}, logs: [], logCount: 0, controlRequests: [], controlRequestCount: 0, retry: null, deadLetter: null,
    },
  };
}
