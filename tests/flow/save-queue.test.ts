import { describe, expect, it, vi } from "vitest";
import {
  FlowSaveCoordinator,
  FlowSaveBlockedError,
  FlowSaveQueue,
  ImpactRequiredError,
  flowSaveFingerprint,
  type SaveRecord,
} from "@/lib/flow/save-queue";
import type { FlowGraph, FlowGraphV2 } from "@/lib/flow/types";

function graph(name: string): FlowGraph {
  return { id: "graph-local", name, nodes: [], edges: [] };
}

function attempt(revision: number, value: FlowGraph, impactReceipt?: string): SaveRecord {
  return {
    revision,
    graph: value,
    fingerprint: flowSaveFingerprint(value),
    ...(impactReceipt === undefined ? {} : { impactReceipt }),
  };
}

const impactPayload = {
  error: "impact confirmation required",
  receipt: "r".repeat(32),
  impact: {
    dependents: [{ flowId: "parent", name: "Parent", nodeIds: ["call-child"] }],
    truncated: false,
    total: 1,
  },
} as const;

describe("ImpactRequiredError", () => {
  it("parses only the exact bounded 409 impact allowlist", () => {
    const parsed = ImpactRequiredError.parse(409, impactPayload);
    expect(parsed).toBeInstanceOf(ImpactRequiredError);
    expect(parsed).toMatchObject({ receipt: impactPayload.receipt, impact: impactPayload.impact });
    expect(ImpactRequiredError.parse(400, impactPayload)).toBeNull();
    expect(ImpactRequiredError.parse(409, { ...impactPayload, extra: true })).toBeNull();
    expect(ImpactRequiredError.parse(409, { ...impactPayload, receipt: "short" })).toBeNull();
    const oversized = {
      ...impactPayload,
      impact: {
        dependents: Array.from({ length: 50 }, (_, index) => ({
          flowId: `${index}${"f".repeat(500)}`,
          name: "n".repeat(200),
          nodeIds: Array.from({ length: 50 }, () => "x".repeat(128)),
        })),
        truncated: true,
        total: 50,
      },
    };
    expect(ImpactRequiredError.parse(409, oversized)).toBeNull();
    let deep: Record<string, unknown> = {};
    for (let index = 0; index < 5_000; index += 1) deep = { nested: deep };
    expect(() => ImpactRequiredError.parse(409, { ...impactPayload, extra: deep })).not.toThrow();
    expect(ImpactRequiredError.parse(409, { ...impactPayload, extra: deep })).toBeNull();
    expect(ImpactRequiredError.parse(409, {
      ...impactPayload,
      impact: { ...impactPayload.impact, truncated: false, total: 2 },
    })).toBeNull();
  });
});

describe("FlowSaveQueue", () => {
  it("queues v2 graphs without dropping variables or bindings", async () => {
    const v2: FlowGraphV2 = {
      schemaVersion: 2,
      id: "v2",
      name: "v2",
      nodes: [{
        id: "output",
        type: "output",
        params: {},
        bindings: { token: { kind: "secret", connectionId: "connection-ref", field: "token" } },
        position: { x: 0, y: 0 },
      }],
      edges: [],
      variables: [{ id: "region", name: "Region", scope: "run", schema: {} }],
      groups: [],
      annotations: [],
    };
    const update = vi.fn(async () => undefined);
    const queue = new FlowSaveQueue("row-v2", { create: vi.fn(), update });
    await queue.enqueue({ revision: 1, graph: v2, fingerprint: flowSaveFingerprint(v2) });
    expect(update).toHaveBeenCalledWith("row-v2", v2);
  });

  it("creates once then flushes the latest edit through the returned row id", async () => {
    let releaseCreate!: (id: string) => void;
    const create = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          releaseCreate = resolve;
        }),
    );
    const update = vi.fn(async () => undefined);
    const ids: string[] = [];
    const queue = new FlowSaveQueue(null, { create, update }, (id) => ids.push(id));

    const first = queue.enqueue(attempt(1, graph("first")));
    void queue.enqueue(attempt(2, graph("second")));
    void queue.enqueue(attempt(3, graph("latest")));
    releaseCreate("row-authoritative");
    await first;
    await queue.waitForIdle();

    expect(create).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith("row-authoritative", graph("latest"));
    expect(queue.getPersistedId()).toBe("row-authoritative");
    expect(ids).toEqual(["row-authoritative"]);
  });

  it("carries each whole attempt so a confirmed receipt never attaches to a newer graph", async () => {
    let releaseA!: () => void;
    let releaseConfirmedB!: () => void;
    const update = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { releaseA = resolve; }))
      .mockImplementationOnce(() => new Promise<void>((resolve) => { releaseConfirmedB = resolve; }))
      .mockResolvedValueOnce(undefined);
    const queue = new FlowSaveQueue("row-1", { create: vi.fn(), update });
    const savingA = queue.enqueue(attempt(1, graph("A")));
    void queue.enqueue(attempt(2, graph("confirmed-B"), impactPayload.receipt));
    releaseA();
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    const savingC = queue.enqueue(attempt(3, graph("newer-C")));
    releaseConfirmedB();
    await Promise.all([savingA, savingC]);

    expect(update.mock.calls).toEqual([
      ["row-1", graph("A")],
      ["row-1", graph("confirmed-B"), impactPayload.receipt],
      ["row-1", graph("newer-C")],
    ]);
  });

  it("treats a queued receipt-bearing attempt as a non-coalescible barrier", async () => {
    let releaseA!: () => void;
    const update = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { releaseA = resolve; }))
      .mockResolvedValue(undefined);
    const queue = new FlowSaveQueue("row-1", { create: vi.fn(), update });
    const savingA = queue.enqueue(attempt(1, graph("A")));
    void queue.enqueue(attempt(2, graph("confirmed-B"), impactPayload.receipt));
    const savingC = queue.enqueue(attempt(3, graph("newer-C")));
    releaseA();
    await Promise.all([savingA, savingC]);

    expect(update.mock.calls).toEqual([
      ["row-1", graph("A")],
      ["row-1", graph("confirmed-B"), impactPayload.receipt],
      ["row-1", graph("newer-C")],
    ]);
  });

  it("restarts draining when a sequential enqueue lands after its prior waiter resolves", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const queue = new FlowSaveQueue("row-1", { create: vi.fn(), update });
    await queue.enqueue(attempt(1, graph("A")));
    await queue.enqueue(attempt(2, graph("B")));
    expect(update.mock.calls).toEqual([
      ["row-1", graph("A")],
      ["row-1", graph("B")],
    ]);
  });

  it("settles coalesced ordinary waiters with the replacement attempt that actually persisted", async () => {
    let releaseA!: () => void;
    const update = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { releaseA = resolve; }))
      .mockResolvedValue(undefined);
    const queue = new FlowSaveQueue("row-1", { create: vi.fn(), update });
    const a = queue.enqueue(attempt(1, graph("A")));
    const b = queue.enqueue(attempt(2, graph("B")));
    const cRecord = attempt(3, graph("C"));
    const c = queue.enqueue(cRecord);
    releaseA();
    await a;
    expect(await b).toEqual(cRecord);
    expect(await c).toEqual(cRecord);
  });

  it("never auto-persists a blocked ordinary record before a later confirmed attempt", async () => {
    let rejectA!: (error: Error) => void;
    const update = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectA = reject; }))
      .mockResolvedValue(undefined);
    const queue = new FlowSaveQueue("row-1", { create: vi.fn(), update });
    const a = queue.enqueue(attempt(1, graph("A")));
    const b = queue.enqueue(attempt(2, graph("blocked-B")));
    rejectA(new Error("offline"));
    await Promise.allSettled([a, b]);

    await queue.enqueue(attempt(3, graph("confirmed-C"), impactPayload.receipt));
    expect(update.mock.calls).toEqual([
      ["row-1", graph("A")],
      ["row-1", graph("confirmed-C"), impactPayload.receipt],
    ]);
  });
});

describe("FlowSaveCoordinator", () => {
  it("publishes exact current persistence and isolates recovery observers", async () => {
    const persisted: Array<{ rowId: string; revision: number; fingerprint: string; current: boolean }> = [];
    const value = graph("saved-current");
    const coordinator = new FlowSaveCoordinator(
      "row-1",
      { create: vi.fn(), update: vi.fn(async () => undefined) },
      {
        onPersisted: (event) => {
          persisted.push(event);
          throw new Error("observer failure");
        },
      },
      0,
    );
    await expect(coordinator.saveNow(value)).resolves.toBeUndefined();
    expect(persisted).toEqual([{ rowId: "row-1", revision: 1, fingerprint: flowSaveFingerprint(value), current: true }]);
  });

  it("publishes every actual success once and marks an old success non-current", async () => {
    let release!: () => void;
    const update = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }))
      .mockResolvedValueOnce(undefined);
    const onPersisted = vi.fn();
    const coordinator = new FlowSaveCoordinator("row-1", { create: vi.fn(), update }, { onPersisted }, 0);
    const old = coordinator.saveNow(graph("old"));
    const current = coordinator.saveNow(graph("current"));
    release();
    await Promise.all([old, current]);
    expect(onPersisted.mock.calls.map(([event]) => event)).toEqual([
      { rowId: "row-1", revision: 1, fingerprint: flowSaveFingerprint(graph("old")), current: false },
      { rowId: "row-1", revision: 2, fingerprint: flowSaveFingerprint(graph("current")), current: true },
    ]);
  });

  it("emits once for a coalesced actual transport record rather than once per waiter", async () => {
    let release!: () => void;
    const update = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; })).mockResolvedValue(undefined);
    const onPersisted = vi.fn();
    const coordinator = new FlowSaveCoordinator("row-1", { create: vi.fn(), update }, { onPersisted }, 0);
    const a = coordinator.saveNow(graph("A"));
    const b = coordinator.saveNow(graph("B"));
    const c = coordinator.saveNow(graph("C"));
    release();
    await Promise.all([a, b, c]);
    expect(update).toHaveBeenCalledTimes(2);
    expect(onPersisted.mock.calls.map(([event]) => event)).toEqual([
      { rowId: "row-1", revision: 1, fingerprint: flowSaveFingerprint(graph("A")), current: false },
      { rowId: "row-1", revision: 3, fingerprint: flowSaveFingerprint(graph("C")), current: true },
    ]);
  });

  it("reports a detached read-only recovery state across scheduled, inflight, retryable, and impact work", async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const update = vi.fn()
        .mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }))
        .mockRejectedValueOnce(new Error("offline"));
      const coordinator = new FlowSaveCoordinator("row-1", { create: vi.fn(), update }, {}, 800);
      expect(coordinator.recoveryState()).toEqual({ scheduled: false, inflight: false, retryable: false, impact: false });
      coordinator.schedule(graph("scheduled"));
      expect(coordinator.recoveryState().scheduled).toBe(true);
      await vi.advanceTimersByTimeAsync(800);
      expect(coordinator.recoveryState()).toMatchObject({ scheduled: false, inflight: true });
      release();
      await coordinator.waitForIdle();
      await expect(coordinator.saveNow(graph("retry"))).rejects.toThrow("offline");
      expect(coordinator.recoveryState()).toMatchObject({ inflight: false, retryable: true, impact: false });
      const state = coordinator.recoveryState() as { scheduled: boolean };
      state.scheduled = true;
      expect(coordinator.recoveryState().scheduled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
  it("supersedes pending impact without transport and retries only the latest graph unreceipted", async () => {
    const impact = ImpactRequiredError.parse(409, impactPayload)!;
    const update = vi.fn().mockRejectedValueOnce(impact).mockResolvedValueOnce(undefined);
    const emissions: Array<ReturnType<FlowSaveCoordinator["getImpactPending"]>> = [];
    const coordinator = new FlowSaveCoordinator(
      "row-1",
      { create: vi.fn(), update },
      { onImpactPendingChange: (pending) => emissions.push(pending) },
      800,
    );
    await expect(coordinator.saveNow(graph("A"))).rejects.toBe(impact);
    const blocked = graph("reference-blocked-B");
    const supersede = (coordinator as unknown as {
      supersedeWithoutSaving?: (next: FlowGraph) => void;
    }).supersedeWithoutSaving;

    expect(supersede).toBeTypeOf("function");
    supersede?.call(coordinator, blocked);
    blocked.name = "mutated-after-supersede";

    expect(update).toHaveBeenCalledTimes(1);
    expect(coordinator.getImpactPending()).toBeNull();
    expect(emissions.at(-1)).toBeNull();
    await coordinator.confirmImpact();
    expect(update).toHaveBeenCalledTimes(1);
    expect(coordinator.hasRetryableGraph()).toBe(true);

    await coordinator.retryLatest();
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenLastCalledWith("row-1", graph("reference-blocked-B"));
  });

  it("cancels an older debounce when a blocked graph supersedes without saving", async () => {
    vi.useFakeTimers();
    try {
      const update = vi.fn(async () => undefined);
      const coordinator = new FlowSaveCoordinator(
        "row-1",
        { create: vi.fn(), update },
        {},
        800,
      );
      coordinator.schedule(graph("ordinary-D"));
      await vi.advanceTimersByTimeAsync(400);
      coordinator.supersedeWithoutSaving(graph("reference-blocked-B"));
      await vi.advanceTimersByTimeAsync(1_000);

      expect(update).not.toHaveBeenCalled();
      expect(coordinator.hasRetryableGraph()).toBe(true);
      await coordinator.retryLatest();
      expect(update).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenCalledWith("row-1", graph("reference-blocked-B"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts an authoritative graph without transport or retryable work", async () => {
    vi.useFakeTimers();
    try {
      const update = vi.fn(async () => undefined);
      const coordinator = new FlowSaveCoordinator(
        "row-1",
        { create: vi.fn(), update },
        {},
        800,
      );
      coordinator.schedule(graph("draft"));
      coordinator.supersedeWithoutSaving(graph("blocked"));
      expect(coordinator.acceptAuthoritative(graph("saved"))).toBe(true);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(update).not.toHaveBeenCalled();
      expect(coordinator.hasRetryableGraph()).toBe(false);
      expect(coordinator.recoveryState()).toEqual({
        scheduled: false,
        inflight: false,
        retryable: false,
        impact: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses an authoritative reset while a recovered save is inflight", async () => {
    let finish!: () => void;
    const delayed = new Promise<void>((resolve) => { finish = resolve; });
    const update = vi.fn(() => delayed);
    const coordinator = new FlowSaveCoordinator(
      "row-1",
      { create: vi.fn(), update },
      {},
      0,
    );
    const saving = coordinator.saveNow(graph("recovered"));
    expect(coordinator.recoveryState().inflight).toBe(true);
    expect(coordinator.acceptAuthoritative(graph("saved"))).toBe(false);
    expect(coordinator.recoveryState().inflight).toBe(true);
    finish();
    await saving;
    expect(update).toHaveBeenCalledOnce();
  });

  it("keeps the superseding graph retryable when an older confirmation fails in flight", async () => {
    let rejectConfirmation: ((error: Error) => void) | undefined;
    const impact = ImpactRequiredError.parse(409, impactPayload)!;
    const update = vi.fn()
      .mockRejectedValueOnce(impact)
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
        rejectConfirmation = reject;
      }))
      .mockResolvedValueOnce(undefined);
    const coordinator = new FlowSaveCoordinator(
      "row-1",
      { create: vi.fn(), update },
      {},
      800,
    );
    await expect(coordinator.saveNow(graph("A"))).rejects.toBe(impact);
    const confirming = coordinator.confirmImpact();
    coordinator.supersedeWithoutSaving(graph("reference-blocked-B"));
    rejectConfirmation?.(new Error("confirmation outcome unknown"));
    await expect(confirming).rejects.toThrow("confirmation outcome unknown");

    expect(coordinator.hasRetryableGraph()).toBe(true);
    await coordinator.retryLatest();
    expect(update).toHaveBeenLastCalledWith("row-1", graph("reference-blocked-B"));
  });

  it("publishes defensive impact snapshots and clears synchronously on a newer revision", async () => {
    const impact = ImpactRequiredError.parse(409, impactPayload)!;
    const emissions: Array<ReturnType<FlowSaveCoordinator["getImpactPending"]>> = [];
    const coordinator = new FlowSaveCoordinator(
      "row-1",
      { create: vi.fn(), update: vi.fn().mockRejectedValueOnce(impact).mockResolvedValueOnce(undefined) },
      {
        onImpactPendingChange: (pending) => {
          emissions.push(structuredClone(pending));
          if (pending) {
            (pending as { receipt: string }).receipt = "mutated-callback-receipt";
            (pending.impact.dependents[0] as { name: string }).name = "Mutated callback name";
            (pending.impact.dependents[0]?.nodeIds as string[]).push("mutated-node");
          }
        },
      },
      800,
    );

    await expect(coordinator.saveNow(graph("breaking"))).rejects.toBe(impact);
    expect(emissions.at(-1)).toMatchObject({ receipt: impactPayload.receipt, impact: impactPayload.impact });
    expect(coordinator.getImpactPending()).toMatchObject({
      receipt: impactPayload.receipt,
      impact: { dependents: [{ name: "Parent", nodeIds: ["call-child"] }] },
    });

    const newer = coordinator.saveNow(graph("newer"));
    expect(emissions.at(-1)).toBeNull();
    expect(coordinator.getImpactPending()).toBeNull();
    await newer;
  });

  it("publishes matching confirmation success and ambiguous confirmed failure as null", async () => {
    const impact = ImpactRequiredError.parse(409, impactPayload)!;
    const successStates: Array<ReturnType<FlowSaveCoordinator["getImpactPending"]>> = [];
    const succeeds = new FlowSaveCoordinator(
      "row-1",
      { create: vi.fn(), update: vi.fn().mockRejectedValueOnce(impact).mockResolvedValueOnce(undefined) },
      { onImpactPendingChange: (pending) => successStates.push(pending) },
      800,
    );
    await expect(succeeds.saveNow(graph("breaking"))).rejects.toBe(impact);
    await succeeds.confirmImpact();
    expect(successStates.map((state) => state?.receipt ?? null)).toEqual([impactPayload.receipt, null]);

    const failureStates: Array<ReturnType<FlowSaveCoordinator["getImpactPending"]>> = [];
    const fails = new FlowSaveCoordinator(
      "row-1",
      { create: vi.fn(), update: vi.fn().mockRejectedValueOnce(impact).mockRejectedValueOnce(new Error("ambiguous")) },
      { onImpactPendingChange: (pending) => failureStates.push(pending) },
      800,
    );
    await expect(fails.saveNow(graph("breaking"))).rejects.toBe(impact);
    await expect(fails.confirmImpact()).rejects.toThrow("ambiguous");
    expect(failureStates.map((state) => state?.receipt ?? null)).toEqual([impactPayload.receipt, null]);
    expect(fails.hasRetryableGraph()).toBe(true);
  });

  it("never resurrects stale impact and republishes a refreshed receipt for the same graph", async () => {
    let rejectOld!: (error: Error) => void;
    const impact = ImpactRequiredError.parse(409, impactPayload)!;
    const refreshedPayload = { ...impactPayload, receipt: "s".repeat(32) };
    const refreshed = ImpactRequiredError.parse(409, refreshedPayload)!;
    const staleStates: Array<ReturnType<FlowSaveCoordinator["getImpactPending"]>> = [];
    const stale = new FlowSaveCoordinator(
      "row-1",
      {
        create: vi.fn(),
        update: vi.fn()
          .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectOld = reject; }))
          .mockResolvedValueOnce(undefined),
      },
      { onImpactPendingChange: (pending) => staleStates.push(pending) },
      800,
    );
    const old = stale.saveNow(graph("old"));
    const newer = stale.saveNow(graph("newer"));
    rejectOld(impact);
    await Promise.allSettled([old, newer]);
    expect(staleStates.filter((state) => state !== null)).toEqual([]);
    expect(stale.getImpactPending()).toBeNull();

    const refreshedStates: Array<ReturnType<FlowSaveCoordinator["getImpactPending"]>> = [];
    const sameGraph = graph("same");
    const refreshes = new FlowSaveCoordinator(
      "row-1",
      { create: vi.fn(), update: vi.fn().mockRejectedValueOnce(impact).mockRejectedValueOnce(refreshed) },
      { onImpactPendingChange: (pending) => refreshedStates.push(pending) },
      800,
    );
    await expect(refreshes.saveNow(sameGraph)).rejects.toBe(impact);
    const second = refreshes.saveNow(sameGraph);
    expect(refreshedStates.at(-1)).toBeNull();
    await expect(second).rejects.toBe(refreshed);
    expect(refreshedStates.map((state) => state?.receipt ?? null)).toEqual([
      impactPayload.receipt,
      null,
      refreshedPayload.receipt,
    ]);
  });

  it("suppresses impact publication while disposed and replays the current defensive state on mount", async () => {
    let rejectImpact!: (error: Error) => void;
    const impact = ImpactRequiredError.parse(409, impactPayload)!;
    const states: Array<ReturnType<FlowSaveCoordinator["getImpactPending"]>> = [];
    const coordinator = new FlowSaveCoordinator(
      "row-1",
      {
        create: vi.fn(),
        update: vi.fn(() => new Promise<void>((_resolve, reject) => { rejectImpact = reject; })),
      },
      { onImpactPendingChange: (pending) => states.push(pending) },
      800,
    );
    const saving = coordinator.saveNow(graph("breaking"));
    const disposed = coordinator.dispose();
    rejectImpact(impact);
    await expect(saving).rejects.toBe(impact);
    await disposed;
    expect(states).toEqual([]);
    expect(coordinator.getImpactPending()?.receipt).toBe(impactPayload.receipt);

    coordinator.mount();
    expect(states).toHaveLength(1);
    expect(states[0]?.receipt).toBe(impactPayload.receipt);
    if (states[0]) (states[0] as { receipt: string }).receipt = "mutated-after-replay";
    expect(coordinator.getImpactPending()?.receipt).toBe(impactPayload.receipt);
  });

  it("commits a new revision before a null observer can reenter and keeps reentrant B retryable", async () => {
    let rejectA!: (error: Error) => void;
    const impact = ImpactRequiredError.parse(409, impactPayload)!;
    const update = vi.fn()
      .mockRejectedValueOnce(impact)
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectA = reject; }))
      .mockResolvedValueOnce(undefined);
    let reentrantB: Promise<void> | null = null;
    const coordinator: FlowSaveCoordinator = new FlowSaveCoordinator(
      "row-1",
      { create: vi.fn(), update },
      {
        onImpactPendingChange: (pending) => {
          if (pending === null && reentrantB === null) {
            reentrantB = coordinator.saveNow(graph("B"));
            void reentrantB.catch(() => undefined);
          }
        },
      },
      800,
    );
    await expect(coordinator.saveNow(graph("breaking"))).rejects.toBe(impact);

    const savingA = coordinator.saveNow(graph("A"));
    expect(reentrantB).not.toBeNull();
    rejectA(new Error("offline A"));
    await Promise.allSettled([savingA, reentrantB!]);
    expect(coordinator.hasRetryableGraph()).toBe(true);
    await coordinator.retryLatest();
    expect(update).toHaveBeenLastCalledWith("row-1", graph("B"));
  });

  it("isolates impact observer exceptions so impact, clear, promises, and saving state still settle", async () => {
    const impact = ImpactRequiredError.parse(409, impactPayload)!;
    const savingStates: boolean[] = [];
    const coordinator = new FlowSaveCoordinator(
      "row-1",
      { create: vi.fn(), update: vi.fn().mockRejectedValueOnce(impact).mockResolvedValueOnce(undefined) },
      {
        onSavingChange: (saving) => savingStates.push(saving),
        onImpactPendingChange: () => { throw new Error("observer failure"); },
      },
      800,
    );

    await expect(coordinator.saveNow(graph("breaking"))).rejects.toBe(impact);
    expect(coordinator.getImpactPending()?.receipt).toBe(impactPayload.receipt);
    await expect(coordinator.confirmImpact()).resolves.toBeUndefined();
    expect(coordinator.getImpactPending()).toBeNull();
    expect(savingStates).toEqual([true, false, true, false]);
  });

  it("does not recursively replay when an impact observer calls mount", async () => {
    const impact = ImpactRequiredError.parse(409, impactPayload)!;
    let calls = 0;
    const coordinator: FlowSaveCoordinator = new FlowSaveCoordinator(
      "row-1",
      { create: vi.fn(), update: vi.fn().mockRejectedValueOnce(impact) },
      {
        onImpactPendingChange: () => {
          calls += 1;
          coordinator.mount();
        },
      },
      800,
    );
    await expect(coordinator.saveNow(graph("breaking"))).rejects.toBe(impact);
    expect(calls).toBe(1);
    await coordinator.dispose();
    coordinator.mount();
    expect(calls).toBe(2);
  });

  it("holds an exact impact rejection outside generic retry until explicit confirmation", async () => {
    const error = ImpactRequiredError.parse(409, impactPayload)!;
    const update = vi.fn().mockRejectedValueOnce(error);
    const coordinator = new FlowSaveCoordinator("row-1", { create: vi.fn(), update }, {}, 800);

    await expect(coordinator.saveNow(graph("breaking"))).rejects.toBe(error);
    const getImpactPending = (coordinator as unknown as {
      getImpactPending?: () => { revision: number; fingerprint: string; receipt: string } | null;
    }).getImpactPending;
    expect(getImpactPending?.call(coordinator)).toMatchObject({
      revision: 1,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      receipt: impactPayload.receipt,
    });
    expect(coordinator.hasRetryableGraph()).toBe(false);
    await coordinator.retryLatest();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("confirms only the latest exact rejected attempt and clears matching impact state on success", async () => {
    let releaseConfirmed!: () => void;
    const error = ImpactRequiredError.parse(409, impactPayload)!;
    const update = vi.fn()
      .mockRejectedValueOnce(error)
      .mockImplementationOnce(() => new Promise<void>((resolve) => { releaseConfirmed = resolve; }));
    const coordinator = new FlowSaveCoordinator("row-1", { create: vi.fn(), update }, {}, 800);
    const value = graph("breaking");
    await expect(coordinator.saveNow(value)).rejects.toBe(error);

    const confirmImpact = (coordinator as unknown as { confirmImpact?: () => Promise<void> }).confirmImpact;
    const confirming = confirmImpact?.call(coordinator);
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenLastCalledWith("row-1", value, impactPayload.receipt);
    releaseConfirmed();
    await confirming;
    expect(coordinator.getImpactPending()).toBeNull();
  });

  it("invalidates impact confirmation on any newer graph and never confirms the stale record", async () => {
    const error = ImpactRequiredError.parse(409, impactPayload)!;
    const update = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(undefined);
    const coordinator = new FlowSaveCoordinator("row-1", { create: vi.fn(), update }, {}, 800);
    await expect(coordinator.saveNow(graph("breaking-A"))).rejects.toBe(error);
    await coordinator.saveNow(graph("newer-B"));

    expect(coordinator.getImpactPending()).toBeNull();
    await coordinator.confirmImpact();
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenLastCalledWith("row-1", graph("newer-B"));
  });

  it("keeps a confirmed receipt on its exact in-flight record while a newer graph queues without it", async () => {
    let releaseConfirmed!: () => void;
    const error = ImpactRequiredError.parse(409, impactPayload)!;
    const update = vi.fn()
      .mockRejectedValueOnce(error)
      .mockImplementationOnce(() => new Promise<void>((resolve) => { releaseConfirmed = resolve; }))
      .mockResolvedValueOnce(undefined);
    const coordinator = new FlowSaveCoordinator("row-1", { create: vi.fn(), update }, {}, 800);
    const breaking = graph("breaking-A");
    await expect(coordinator.saveNow(breaking)).rejects.toBe(error);

    const confirming = coordinator.confirmImpact();
    const savingNewer = coordinator.saveNow(graph("newer-B"));
    expect(coordinator.getImpactPending()).toBeNull();
    releaseConfirmed();
    await Promise.all([confirming, savingNewer]);

    expect(update.mock.calls).toEqual([
      ["row-1", breaking],
      ["row-1", breaking, impactPayload.receipt],
      ["row-1", graph("newer-B")],
    ]);
  });

  it("returns one in-flight confirmation promise and never auto-retries an ambiguous confirmed failure", async () => {
    let rejectConfirmed!: (error: Error) => void;
    const impact = ImpactRequiredError.parse(409, impactPayload)!;
    const update = vi.fn()
      .mockRejectedValueOnce(impact)
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectConfirmed = reject; }))
      .mockResolvedValueOnce(undefined);
    const coordinator = new FlowSaveCoordinator("row-1", { create: vi.fn(), update }, {}, 800);
    await expect(coordinator.saveNow(graph("breaking"))).rejects.toBe(impact);

    const first = coordinator.confirmImpact();
    const second = coordinator.confirmImpact();
    expect(second).toBe(first);
    expect(update).toHaveBeenCalledTimes(2);
    rejectConfirmed(new Error("connection lost after confirmation"));
    await expect(first).rejects.toThrow("connection lost after confirmation");
    expect(coordinator.getImpactPending()).toBeNull();
    expect(coordinator.hasRetryableGraph()).toBe(true);
    expect(update).toHaveBeenCalledTimes(2);
    await coordinator.retryLatest();
    expect(update).toHaveBeenCalledTimes(3);
    expect(update).toHaveBeenLastCalledWith("row-1", graph("breaking"));
    expect(coordinator.hasRetryableGraph()).toBe(false);
  });

  it("snapshots a graph before binding its fingerprint and transport payload", async () => {
    let release!: () => void;
    const update = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const coordinator = new FlowSaveCoordinator("row-1", { create: vi.fn(), update }, {}, 800);
    const mutable = graph("before");
    const saving = coordinator.saveNow(mutable);
    mutable.name = "mutated-after-register";
    expect(update).toHaveBeenCalledWith("row-1", graph("before"));
    release();
    await saving;
  });

  it("does not attach an old impact receipt when the rejection loses the latest revision race", async () => {
    let rejectA!: (error: Error) => void;
    const impact = ImpactRequiredError.parse(409, impactPayload)!;
    const update = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectA = reject; }))
      .mockResolvedValueOnce(undefined);
    const coordinator = new FlowSaveCoordinator("row-1", { create: vi.fn(), update }, {}, 800);
    const a = coordinator.saveNow(graph("A"));
    const b = coordinator.saveNow(graph("B"));
    rejectA(impact);
    const [aResult, bResult] = await Promise.allSettled([a, b]);

    expect(aResult).toMatchObject({ status: "rejected", reason: impact });
    expect(bResult).toMatchObject({ status: "rejected", reason: expect.any(FlowSaveBlockedError) });
    expect(coordinator.getImpactPending()).toBeNull();
    expect(coordinator.hasRetryableGraph()).toBe(true);
    await coordinator.retryLatest();
    expect(update).toHaveBeenLastCalledWith("row-1", graph("B"));
  });

  it("creates once while a newer graph is pending and updates the authoritative row last", async () => {
    let releaseCreate!: (id: string) => void;
    const create = vi.fn(() => new Promise<string>((resolve) => { releaseCreate = resolve; }));
    const update = vi.fn(async () => undefined);
    const onCreated = vi.fn();
    const coordinator = new FlowSaveCoordinator(null, { create, update }, { onCreated }, 800);

    const creating = coordinator.saveNow(graph("forward"));
    const newer = coordinator.saveNow(graph("undo"));
    releaseCreate("row-1");
    await Promise.all([creating, newer]);

    expect(create).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith("row-1", graph("undo"));
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it("keeps saving state active until every per-attempt waiter settles", async () => {
    let releaseA!: () => void;
    let releaseB!: () => void;
    const update = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { releaseA = resolve; }))
      .mockImplementationOnce(() => new Promise<void>((resolve) => { releaseB = resolve; }));
    const states: boolean[] = [];
    const coordinator = new FlowSaveCoordinator(
      "row-1",
      { create: vi.fn(), update },
      { onSavingChange: (saving) => states.push(saving) },
      800,
    );
    const a = coordinator.saveNow(graph("A"));
    const b = coordinator.saveNow(graph("B"));
    releaseA();
    await a;
    expect(states).toEqual([true]);
    releaseB();
    await b;
    expect(states).toEqual([true, false]);
  });

  it("keeps latest pending B retryable when update A rejects without auto-spinning", async () => {
    let rejectA!: (error: Error) => void;
    const update = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectA = reject; }));
    const coordinator = new FlowSaveCoordinator("row-1", { create: vi.fn(), update }, {}, 800);

    const a = coordinator.saveNow(graph("A"));
    const b = coordinator.saveNow(graph("B"));
    rejectA(new Error("offline"));
    await Promise.allSettled([a, b]);

    expect(update).toHaveBeenCalledTimes(1);
    expect(coordinator.hasRetryableGraph()).toBe(true);
    await Promise.resolve();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("retryLatest writes B once and clears retry state only after success", async () => {
    let rejectA!: (error: Error) => void;
    let releaseB!: () => void;
    const update = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectA = reject; }))
      .mockImplementationOnce(() => new Promise<void>((resolve) => { releaseB = resolve; }));
    const coordinator = new FlowSaveCoordinator("row-1", { create: vi.fn(), update }, {}, 800);

    const a = coordinator.saveNow(graph("A"));
    const b = coordinator.saveNow(graph("B"));
    rejectA(new Error("offline"));
    await Promise.allSettled([a, b]);

    const retrying = coordinator.retryLatest();
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenLastCalledWith("row-1", graph("B"));
    expect(coordinator.hasRetryableGraph()).toBe(true);
    releaseB();
    await retrying;
    expect(coordinator.hasRetryableGraph()).toBe(false);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("a scheduled graph C supersedes retryable B and explicit retry writes C only", async () => {
    vi.useFakeTimers();
    try {
      const update = vi.fn()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValue(undefined);
      const coordinator = new FlowSaveCoordinator("row-1", { create: vi.fn(), update }, {}, 800);
      await expect(coordinator.saveNow(graph("B"))).rejects.toThrow("offline");
      expect(coordinator.hasRetryableGraph()).toBe(true);

      coordinator.schedule(graph("C"));
      await coordinator.retryLatest();
      expect(update).toHaveBeenLastCalledWith("row-1", graph("C"));
      expect(coordinator.hasRetryableGraph()).toBe(false);
      await vi.advanceTimersByTimeAsync(800);
      expect(update).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("saveNow C supersedes retryable B while preserving retry state until C succeeds", async () => {
    let releaseC!: () => void;
    const update = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementationOnce(() => new Promise<void>((resolve) => { releaseC = resolve; }));
    const coordinator = new FlowSaveCoordinator("row-1", { create: vi.fn(), update }, {}, 800);
    await expect(coordinator.saveNow(graph("B"))).rejects.toThrow("offline");

    const savingC = coordinator.saveNow(graph("C"));
    expect(update).toHaveBeenLastCalledWith("row-1", graph("C"));
    expect(coordinator.hasRetryableGraph()).toBe(true);
    releaseC();
    await savingC;
    expect(coordinator.hasRetryableGraph()).toBe(false);
  });

  it("flushes a debounced edit into the queue before create navigation remounts", async () => {
    vi.useFakeTimers();
    try {
      let releaseCreate!: (id: string) => void;
      const create = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            releaseCreate = resolve;
          }),
      );
      const update = vi.fn(async () => undefined);
      const onCreated = vi.fn(() => {
        void coordinator.dispose();
      });
      const coordinator: FlowSaveCoordinator = new FlowSaveCoordinator(
        null,
        { create, update },
        { onCreated },
        800,
      );

      void coordinator.saveNow(graph("first"));
      await vi.advanceTimersByTimeAsync(100);
      coordinator.schedule(graph("latest"));
      await vi.advanceTimersByTimeAsync(799);
      releaseCreate("row-authoritative");
      await coordinator.waitForIdle();

      expect(create).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenCalledWith("row-authoritative", graph("latest"));
      expect(onCreated).toHaveBeenCalledWith("row-authoritative");
    } finally {
      vi.useRealTimers();
    }
  });

  it("continues persistence without UI callbacks after unmount", async () => {
    vi.useFakeTimers();
    try {
      let releaseCreate!: (id: string) => void;
      const create = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            releaseCreate = resolve;
          }),
      );
      const update = vi.fn(async () => undefined);
      const onCreated = vi.fn();
      const savingStates: boolean[] = [];
      const coordinator = new FlowSaveCoordinator(
        null,
        { create, update },
        {
          onCreated,
          onSavingChange: (saving) => savingStates.push(saving),
        },
        800,
      );

      void coordinator.saveNow(graph("first"));
      coordinator.schedule(graph("latest"));
      const disposed = coordinator.dispose();
      releaseCreate("row-authoritative");
      await disposed;

      expect(create).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenCalledWith("row-authoritative", graph("latest"));
      expect(onCreated).not.toHaveBeenCalled();
      expect(savingStates).toEqual([true]);
    } finally {
      vi.useRealTimers();
    }
  });
});
