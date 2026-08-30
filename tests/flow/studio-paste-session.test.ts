import { describe, expect, it } from "vitest";
import type { GraphFragmentV1 } from "@/lib/flow/graph-fragment";
import {
  PendingPasteEpochGuard,
  bindDeferredPasteIntent,
  consumeDeferredPasteIntent,
  discardBoundDeferredPasteIntent,
  createPendingPasteIntent,
  createTrustedClipboardIntent,
  detachTypedReferencesForExternalClipboard,
  discardDeferredPasteIntent,
  readPendingPasteIntent,
  peekDeferredPasteIntent,
  readTrustedClipboardIntent,
  stageDeferredPasteIntent,
} from "@/lib/flow/studio-paste-session";
import { hashCallableInterface } from "@/lib/flow/subflow-reference";
import { FlowSaveCoordinator } from "@/lib/flow/save-queue";
import { createReferenceBootstrapGraph } from "@/lib/flow/studio-reference-session-gate";

const callable = { inputs: [], outputs: [] } as const;

function typedFragment(flowId = "child"): GraphFragmentV1 {
  return {
    kind: "suede.graph-fragment",
    version: 1,
    redactionCount: 0,
    nodes: [{
      id: "typed",
      type: "subflow",
      params: {
        reference: {
          kind: "draft",
          flowId,
          interface: callable,
          interfaceHash: hashCallableInterface(callable),
        },
      },
      bindings: {},
      position: { x: 0, y: 0 },
    }],
    edges: [],
  };
}

function intent(flowId = "child") {
  return createPendingPasteIntent({
    fragment: typedFragment(flowId),
    commandId: `paste-${flowId}`,
    targetOrigin: { x: 10, y: 20 },
    label: "Pasted nodes",
    announcement: "Pasted one node.",
    advancePasteSequence: true,
  });
}

describe("studio paste session", () => {
  it("keeps pending intent opaque and consumes only its exact bound row once", () => {
    const first = intent("first");
    const firstToken = stageDeferredPasteIntent(first);
    const second = intent("second");
    const secondToken = stageDeferredPasteIntent(second);
    discardDeferredPasteIntent(firstToken);
    expect(bindDeferredPasteIntent(firstToken, "wrong-row")).toBe(false);
    expect(bindDeferredPasteIntent(secondToken, "parent-row")).toBe(true);
    expect(JSON.stringify(second)).toBeUndefined();
    expect(consumeDeferredPasteIntent("wrong-row")).toBeNull();
    const consumed = consumeDeferredPasteIntent("parent-row");
    expect(readPendingPasteIntent(consumed!).fragment.nodes[0]?.params).toMatchObject({
      reference: { flowId: "second" },
    });
    expect(consumeDeferredPasteIntent("parent-row")).toBeNull();
  });

  it("peeks a deferred paste without consuming it and discards only by explicit choice", () => {
    const token = stageDeferredPasteIntent(intent("held"));
    expect(bindDeferredPasteIntent(token, "held-row")).toBe(true);
    expect(readPendingPasteIntent(peekDeferredPasteIntent("held-row")!).fragment.nodes[0]?.params)
      .toMatchObject({ reference: { flowId: "held" } });
    expect(peekDeferredPasteIntent("held-row")).not.toBeNull();
    expect(discardBoundDeferredPasteIntent("held-row")).toBe(true);
    expect(consumeDeferredPasteIntent("held-row")).toBeNull();
  });

  it("keeps one exact row alias per bounded token and evicts the oldest staged intent", () => {
    const rebound = intent("rebound");
    const reboundToken = stageDeferredPasteIntent(rebound);
    expect(bindDeferredPasteIntent(reboundToken, "first-row")).toBe(true);
    expect(bindDeferredPasteIntent(reboundToken, "second-row")).toBe(true);
    expect(consumeDeferredPasteIntent("first-row")).toBeNull();
    expect(readPendingPasteIntent(consumeDeferredPasteIntent("second-row")!).fragment.nodes[0]?.params)
      .toMatchObject({ reference: { flowId: "rebound" } });

    const tokens = Array.from({ length: 9 }, (_, index) =>
      stageDeferredPasteIntent(intent(`bounded-${index}`)));
    expect(bindDeferredPasteIntent(tokens[0]!, "evicted-row")).toBe(false);
    expect(bindDeferredPasteIntent(tokens[8]!, "kept-row")).toBe(true);
    expect(consumeDeferredPasteIntent("kept-row")).not.toBeNull();
    for (const token of tokens.slice(1, 8)) discardDeferredPasteIntent(token);

    const oversized = "ø".repeat(300);
    const bounded = stageDeferredPasteIntent(intent("bounded-key"));
    expect(bindDeferredPasteIntent(bounded, oversized)).toBe(false);
    expect(bindDeferredPasteIntent("", "row")).toBe(false);
    discardDeferredPasteIntent(bounded);
  });

  it("binds trusted typed copy only to the exact detached clipboard text", () => {
    const fragment = typedFragment();
    const external = detachTypedReferencesForExternalClipboard(fragment);
    const text = JSON.stringify(external);
    const trusted = createTrustedClipboardIntent(fragment, text);

    expect(JSON.stringify(trusted)).toBeUndefined();
    expect(JSON.stringify(external)).not.toContain("interfaceHash");
    expect(external.redactionCount).toBeGreaterThan(0);
    expect(readTrustedClipboardIntent(trusted, `${text} `)).toBeNull();
    expect(readTrustedClipboardIntent(trusted, text)?.nodes[0]?.params).toMatchObject({
      reference: { flowId: "child" },
    });
  });

  it("rejects an ignored abort response after any graph mutation epoch", async () => {
    const guard = new PendingPasteEpochGuard();
    const operation = guard.begin();
    let finish!: (value: string) => void;
    const ignoredAbort = new Promise<string>((resolve) => { finish = resolve; });
    guard.cancelForGraphMutation();
    finish("late projection");
    await expect(ignoredAbort).resolves.toBe("late projection");
    expect(operation.signal.aborted).toBe(true);
    expect(guard.isCurrent(operation)).toBe(false);

    const next = guard.begin();
    expect(guard.isCurrent(next)).toBe(true);
    expect(guard.complete(next)).toBe(true);
    expect(guard.isCurrent(next)).toBe(false);
  });

  it("keeps deferred intent across a failed safe create and binds it on a fresh safe retry", async () => {
    const pending = intent("retry-child");
    const pendingToken = stageDeferredPasteIntent(pending);
    const graph = { id: "local", name: "Parent", nodes: [], edges: [] };
    const createPayloads: typeof graph[] = [];
    const coordinator = new FlowSaveCoordinator(
      null,
      {
        create: async (submitted) => {
          createPayloads.push(structuredClone(submitted) as typeof graph);
          if (createPayloads.length === 1) throw new Error("temporary create failure");
          bindDeferredPasteIntent(pendingToken, "parent-after-retry");
          return "parent-after-retry";
        },
        update: async () => undefined,
      },
      {},
      0,
    );
    await expect(coordinator.saveNow(createReferenceBootstrapGraph(graph))).rejects.toThrow();
    await coordinator.saveNow(createReferenceBootstrapGraph(graph));

    expect(createPayloads).toHaveLength(2);
    expect(createPayloads.every((submitted) => submitted.nodes.length === 0)).toBe(true);
    const resumed = consumeDeferredPasteIntent("parent-after-retry");
    expect(readPendingPasteIntent(resumed!).fragment.nodes[0]?.params).toMatchObject({
      reference: { flowId: "retry-child" },
    });
  });
});
