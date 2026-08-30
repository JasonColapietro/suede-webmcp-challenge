import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveOwner: vi.fn(), getDurable: vi.fn(), getRepo: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ resolveReadOnlyOwnerId: mocks.resolveOwner }));
vi.mock("@/lib/runtime/provider", () => {
  class DurableRuntimeUnavailableError extends Error {}
  return { getDurableRuntimeRepository: mocks.getDurable, DurableRuntimeUnavailableError };
});
vi.mock("@/lib/db/repo", () => ({ getRepo: mocks.getRepo }));

import RunPage from "@/app/runs/[runId]/page";
import { DurableRuntimeUnavailableError } from "@/lib/runtime/provider";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("owner-scoped run detail", () => {
  beforeEach(() => { vi.resetAllMocks(); mocks.resolveOwner.mockResolvedValue("owner_1"); });

  it("renders a bounded durable receipt before considering legacy rows", async () => {
    const base = durableView();
    const view = { ...base, projection: { ...base.projection, sequence: 150 } };
    const listEvents = vi.fn().mockResolvedValue([{ schemaVersion: 1, executionId: "run_1", sequence: 1, attempt: 0, type: "execution.created", at: 1, payload: { definitionHash: "hash" } }]);
    mocks.getDurable.mockResolvedValue({ getExecutionView: vi.fn().mockResolvedValue(view), listEvents });
    const markup = renderToStaticMarkup(await RunPage({ params: Promise.resolve({ runId: "run_1" }) }));
    expect(markup).toContain("Durable execution");
    expect(markup).toContain("Immutable version");
    expect(markup).toContain("Final output");
    expect(markup).toContain("Persisted event timeline");
    expect(markup.match(/Execution receipt/g)).toHaveLength(1);
    expect(markup.match(/Persisted event timeline/g)).toHaveLength(1);
    expect(mocks.getRepo).not.toHaveBeenCalled();
    expect(listEvents).toHaveBeenCalledWith("owner_1", "run_1", 50, 100);
  });

  it("owner-filters a legacy run before loading its steps when durable storage is unavailable", async () => {
    mocks.getDurable.mockRejectedValue(new DurableRuntimeUnavailableError());
    const listRunSteps = vi.fn();
    mocks.getRepo.mockResolvedValue({
      getRun: vi.fn().mockResolvedValue({ id: "legacy_1", flowId: "foreign_flow" }),
      getOwnedFlow: vi.fn().mockResolvedValue(null), listRunSteps,
    });
    const markup = renderToStaticMarkup(await RunPage({ params: Promise.resolve({ runId: "legacy_1" }) }));
    expect(markup).toContain("RUN NOT FOUND");
    expect(listRunSteps).not.toHaveBeenCalled();
  });

  it("preserves an honestly scoped legacy ledger when the durable provider is unavailable", async () => {
    mocks.getDurable.mockRejectedValue(new DurableRuntimeUnavailableError());
    const listRunSteps = vi.fn().mockResolvedValue([{ id: "step_1", runId: "legacy_1", nodeId: "node_1", nodeType: "transform", status: "done", costUsdc: 0, output: {}, error: null }]);
    mocks.getRepo.mockResolvedValue({
      getRun: vi.fn().mockResolvedValue({ id: "legacy_1", flowId: "flow_1", agentId: null, trigger: "manual", status: "done", totalCostUsdc: 0, startedAt: 1, finishedAt: 2, settledAt: null, triggerInput: null, runVariables: null }),
      getOwnedFlow: vi.fn().mockResolvedValue({ id: "flow_1" }), listRunSteps,
    });
    const markup = renderToStaticMarkup(await RunPage({ params: Promise.resolve({ runId: "legacy_1" }) }));
    expect(markup).toContain("Run Ledger"); expect(markup).toContain("node_1"); expect(listRunSteps).toHaveBeenCalledOnce();
  });

  it("extracts a bounded artifact descriptor before crossing the server-to-client boundary", () => {
    const source = readFileSync(join(process.cwd(), "src/app/runs/[runId]/page.tsx"), "utf8");
    expect(source).toContain("artifact={artifactDescriptor(step.output)}");
    expect(source).not.toMatch(/<ArtifactDownloadButton\s+output=/u);
  });

  it("offers Run again on a legacy run whose trigger input was stored", async () => {
    mocks.getDurable.mockRejectedValue(new DurableRuntimeUnavailableError());
    mocks.getRepo.mockResolvedValue({
      getRun: vi.fn().mockResolvedValue({ id: "legacy_1", flowId: "flow_1", agentId: null, trigger: "manual", status: "done", totalCostUsdc: 0, startedAt: 1, finishedAt: 2, settledAt: null, triggerInput: { prompt: "hi" }, runVariables: null }),
      getOwnedFlow: vi.fn().mockResolvedValue({ id: "flow_1" }), listRunSteps: vi.fn().mockResolvedValue([]),
    });
    const markup = renderToStaticMarkup(await RunPage({ params: Promise.resolve({ runId: "legacy_1" }) }));
    expect(markup).toContain("Run again");
    expect(markup).not.toContain("resubmitted from here");
  });

  it("says plainly that an input-less legacy run can't be resubmitted", async () => {
    mocks.getDurable.mockRejectedValue(new DurableRuntimeUnavailableError());
    mocks.getRepo.mockResolvedValue({
      getRun: vi.fn().mockResolvedValue({ id: "legacy_1", flowId: "flow_1", agentId: null, trigger: "manual", status: "done", totalCostUsdc: 0, startedAt: 1, finishedAt: 2, settledAt: null, triggerInput: null, runVariables: null }),
      getOwnedFlow: vi.fn().mockResolvedValue({ id: "flow_1" }), listRunSteps: vi.fn().mockResolvedValue([]),
    });
    const markup = renderToStaticMarkup(await RunPage({ params: Promise.resolve({ runId: "legacy_1" }) }));
    expect(markup).not.toContain("Run again");
    expect(markup).toContain("resubmitted from here");
  });

  it("does not offer Run again while a legacy run is still running", async () => {
    mocks.getDurable.mockRejectedValue(new DurableRuntimeUnavailableError());
    mocks.getRepo.mockResolvedValue({
      getRun: vi.fn().mockResolvedValue({ id: "legacy_1", flowId: "flow_1", agentId: null, trigger: "manual", status: "running", totalCostUsdc: 0, startedAt: 1, finishedAt: null, settledAt: null, triggerInput: { prompt: "hi" }, runVariables: null }),
      getOwnedFlow: vi.fn().mockResolvedValue({ id: "flow_1" }), listRunSteps: vi.fn().mockResolvedValue([]),
    });
    const markup = renderToStaticMarkup(await RunPage({ params: Promise.resolve({ runId: "legacy_1" }) }));
    expect(markup).not.toContain("Run again");
  });

  it("keeps missing durable and legacy IDs private", async () => {
    mocks.getDurable.mockResolvedValue({ getExecutionView: vi.fn().mockResolvedValue(null) });
    mocks.getRepo.mockResolvedValue({ getRun: vi.fn().mockResolvedValue(null) });
    const markup = renderToStaticMarkup(await RunPage({ params: Promise.resolve({ runId: "missing_1" }) }));
    expect(markup).toContain("RUN NOT FOUND");
  });

  it("renders bounded lineage, queue timing, and actual node/final outputs", async () => {
    const view = { ...durableView(), parentExecutionId: "parent_1" };
    const events = [
      { schemaVersion: 1, executionId: "run_1", sequence: 2, attempt: 1, type: "job.claimed", at: 5, payload: { jobId: "job_1", attemptId: "attempt_1", workerId: "worker_1", leaseExpiresAt: 9 } },
      { schemaVersion: 1, executionId: "run_1", sequence: 3, attempt: 1, type: "execution.succeeded", at: 8, payload: { output: { answer: 42 }, costMicroUsdc: 0, tokens: 0 } },
    ];
    mocks.getDurable.mockResolvedValue({ getExecutionView: vi.fn().mockResolvedValue(view), listEvents: vi.fn().mockResolvedValue(events) });
    const markup = renderToStaticMarkup(await RunPage({ params: Promise.resolve({ runId: "run_1" }) }));
    expect(markup).toContain("Retry of"); expect(markup).toContain("parent_1"); expect(markup).toContain("Queue wait"); expect(markup).toContain("Execution time"); expect(markup).toContain("answer");
  });

  it("does not reinterpret an unexpected durable fault as a legacy row", async () => {
    mocks.getDurable.mockRejectedValue(new Error("fault"));
    const markup = renderToStaticMarkup(await RunPage({ params: Promise.resolve({ runId: "run_1" }) }));
    expect(markup).toContain("RUN NOT FOUND"); expect(mocks.getRepo).not.toHaveBeenCalled();
  });
});

function durableView() {
  return {
    executionId: "run_1", flowId: "flow_1", flowVersionId: "version_1", parentExecutionId: null,
    createdAt: 1, updatedAt: 2, finishedAt: 2, deadlineAt: 99,
    projection: {
      schemaVersion: 1, executionId: "run_1", definitionHash: "hash", sequence: 1, state: "succeeded", desiredState: "running", attempt: 1,
      jobId: "job_1", attemptId: "attempt_1", costMicroUsdc: 0, tokens: 0, output: { answer: 42 }, error: null,
      nodes: { node_1: { state: "completed", attempt: 1, output: { answer: 42 }, error: null } },
      logs: [], logCount: 0, controlRequests: [], controlRequestCount: 0, retry: null, deadLetter: null,
    },
  };
}
