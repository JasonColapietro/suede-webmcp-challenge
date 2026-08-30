import { describe, expect, it, vi } from "vitest";
import { hashCallableInterface } from "@/lib/flow/subflow-reference";
import type { FlowCallableInterface, SubflowReference } from "@/lib/flow/types";
import {
  SubflowReferenceController,
  createSubflowReferenceClient,
  pickerOptionIndex,
  type SubflowReferenceClient,
} from "@/lib/flow/subflow-reference-client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SubflowReferenceControl, {
  verifiedReceiptMatchesContext,
} from "@/components/canvas/SubflowReferenceControl";
import type { FlowNodeV2 } from "@/lib/flow/types";
import { readFileSync } from "node:fs";
import { applyGraphCommand } from "@/lib/flow/graph-command-reducer";
import type { FlowGraph } from "@/lib/flow/types";

const HASH = "a".repeat(64);
const callable: FlowCallableInterface = { inputs: [], outputs: [] };

function candidatePage(name: string) {
  return {
    flows: [{
      flowId: `flow-${name}`,
      name,
      workbookName: null,
      draft: {
        interface: callable,
        interfaceHash: hashCallableInterface(callable),
        semanticHash: HASH,
      },
    }],
    truncated: false,
  };
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("subflow reference browser client", () => {
  it("uses pathless endpoints, URLSearchParams once, strict schemas, and no authorization header", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(url).toContain("/api/v2/subflows/candidates?");
      expect(url).toContain("parentFlowId=parent%2Fopaque");
      expect(url).toContain("query=music%252Fnews");
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return response(candidatePage("One"));
    });
    const client = createSubflowReferenceClient(fetcher);
    await expect(client.candidates({
      parentFlowId: "parent/opaque",
      query: "music%2Fnews",
      limit: 20,
    })).resolves.toEqual(candidatePage("One"));
    expect(fetcher).toHaveBeenCalledTimes(1);

    const hostile = createSubflowReferenceClient(async () => response({
      ...candidatePage("One"),
      secret: "must-not-project",
    }));
    await expect(hostile.candidates({ parentFlowId: "parent", query: "", limit: 20 }))
      .rejects.toThrow(/invalid|response/i);
  });

  it("aborts superseded searches and ignores late out-of-order responses", async () => {
    const pending = new Map<string, (value: ReturnType<typeof candidatePage>) => void>();
    const signals: AbortSignal[] = [];
    const client: SubflowReferenceClient = {
      candidates: ({ query, signal }) => {
        if (!signal) throw new Error("Expected candidate AbortSignal");
        signals.push(signal);
        return new Promise((resolve) => pending.set(query, resolve));
      },
      versions: async () => ({ versions: [], truncated: false }),
      resolve: async () => { throw new Error("unused"); },
    };
    const states: string[] = [];
    const controller = new SubflowReferenceController(client, (state) => {
      if (state.status === "ready") states.push(state.flows[0]?.name ?? "empty");
    });
    const first = controller.searchCandidates({ parentFlowId: "parent", query: "old" });
    const second = controller.searchCandidates({ parentFlowId: "parent", query: "new" });
    expect(signals[0]?.aborted).toBe(true);
    pending.get("new")?.(candidatePage("New"));
    await second;
    pending.get("old")?.(candidatePage("Old"));
    await first;
    expect(states).toEqual(["New"]);
    expect(controller.getState()).toMatchObject({ status: "ready", flows: [{ name: "New" }] });
  });

  it("invalidates late work across request lanes and disposed parent/reference contexts", async () => {
    let finishVersions!: (value: { versions: never[]; truncated: false }) => void;
    let finishResolve!: (value: any) => void;
    const draft: SubflowReference = {
      kind: "draft", flowId: "child", interface: callable,
      interfaceHash: hashCallableInterface(callable),
    };
    const committed: SubflowReference[] = [];
    const client: SubflowReferenceClient = {
      candidates: async () => candidatePage("New parent"),
      versions: () => new Promise((resolve) => { finishVersions = resolve; }),
      resolve: () => new Promise((resolve) => { finishResolve = resolve; }),
    };
    const controller = new SubflowReferenceController(client, () => undefined, (projection) => committed.push(projection.reference));
    const oldVersions = controller.loadVersions({ parentFlowId: "parent-a", childFlowId: "child-a" });
    await controller.searchCandidates({ parentFlowId: "parent-b", query: "" });
    finishVersions({ versions: [], truncated: false });
    await oldVersions;
    expect(controller.getState()).toMatchObject({ status: "ready", flows: [{ name: "New parent" }] });

    const oldResolve = controller.resolve({ parentFlowId: "parent-b", nodeId: "node", reference: draft });
    controller.dispose();
    finishResolve({
      reference: draft, interface: callable,
      interfaceHash: hashCallableInterface(callable), issues: [],
    });
    await oldResolve;
    expect(committed).toEqual([]);
  });

  it("never commits before resolve succeeds and holds drift for explicit review", async () => {
    const draft: SubflowReference = {
      kind: "draft",
      flowId: "child",
      interface: callable,
      interfaceHash: hashCallableInterface(callable),
    };
    let issues: ("interface-drift" | "content-drift")[] = ["interface-drift"];
    const client: SubflowReferenceClient = {
      candidates: async () => ({ flows: [], truncated: false }),
      versions: async () => ({ versions: [], truncated: false }),
      resolve: async () => ({
        reference: draft,
        interface: callable,
        interfaceHash: hashCallableInterface(callable),
        issues,
      }),
    };
    const committed: SubflowReference[] = [];
    const controller = new SubflowReferenceController(client, () => undefined, (projection) => {
      committed.push(projection.reference);
    });
    await controller.resolve({ parentFlowId: "parent", nodeId: "node", reference: draft });
    expect(committed).toEqual([]);
    expect(controller.getState()).toMatchObject({ status: "drift" });

    issues = [];
    await controller.resolve({ parentFlowId: "parent", nodeId: "node", reference: draft });
    expect(committed).toEqual([draft]);
    expect(controller.getState()).toMatchObject({ status: "resolved" });
  });

  it("appends independently paginated candidate pages without duplicates", async () => {
    const client: SubflowReferenceClient = {
      candidates: async ({ cursor }) => cursor
        ? { flows: [candidatePage("One").flows[0]!, candidatePage("Two").flows[0]!], truncated: false }
        : { ...candidatePage("One"), nextCursor: "next", truncated: true },
      versions: async () => ({ versions: [], truncated: false }),
      resolve: async () => { throw new Error("unused"); },
    };
    const controller = new SubflowReferenceController(client, () => undefined);
    await controller.searchCandidates({ parentFlowId: "parent", query: "" });
    await controller.searchCandidates({ parentFlowId: "parent", query: "", cursor: "next" });
    expect(controller.getState()).toMatchObject({
      status: "ready",
      flows: [{ name: "One" }, { name: "Two" }],
    });
  });

  it("appends version pages separately", async () => {
    const version = (versionNumber: number) => ({
      versionId: `version-${versionNumber}`,
      versionNumber,
      createdAt: versionNumber,
      interface: callable,
      interfaceHash: hashCallableInterface(callable),
      contentHash: String(versionNumber).repeat(64).slice(0, 64),
    });
    const client: SubflowReferenceClient = {
      candidates: async () => ({ flows: [], truncated: false }),
      versions: async ({ cursor }) => cursor
        ? { versions: [version(1), version(2)], truncated: false }
        : { versions: [version(1)], nextCursor: "next", truncated: true },
      resolve: async () => { throw new Error("unused"); },
    };
    const controller = new SubflowReferenceController(client, () => undefined);
    await controller.loadVersions({ parentFlowId: "parent", childFlowId: "child" });
    await controller.loadVersions({ parentFlowId: "parent", childFlowId: "child", cursor: "next" });
    expect(controller.getState()).toMatchObject({
      status: "versions",
      versions: [{ versionNumber: 1 }, { versionNumber: 2 }],
    });

  });

  it("covers Arrow/Home/End option navigation", () => {
    expect(pickerOptionIndex("ArrowDown", 0, 3)).toBe(1);
    expect(pickerOptionIndex("ArrowUp", 0, 3)).toBe(2);
    expect(pickerOptionIndex("Home", 2, 3)).toBe(0);
    expect(pickerOptionIndex("End", 0, 3)).toBe(2);
  });

  it("never carries a verification receipt across parent flow contexts", () => {
    const receipt = {
      parentFlowId: "parent-a",
      nodeId: "same-node",
      fingerprint: "same-reference",
    };
    expect(verifiedReceiptMatchesContext(receipt, "parent-a", "same-node", "same-reference")).toBe(true);
    expect(verifiedReceiptMatchesContext(receipt, "parent-b", "same-node", "same-reference")).toBe(false);
  });

  it("sets a resolved reference through one V2-upgrading command with exact undo", () => {
    const legacy: FlowGraph = {
      id: "legacy-parent",
      name: "Legacy parent",
      nodes: [{
        id: "child-node", type: "subflow", params: { flowId: "legacy-child" },
        position: { x: 0, y: 0 },
      }],
      edges: [],
    };
    const before = JSON.stringify(legacy);
    const reference: SubflowReference = {
      kind: "draft", flowId: "typed-child", interface: callable,
      interfaceHash: hashCallableInterface(callable),
    };
    const result = applyGraphCommand(legacy, {
      v: 1,
      id: "set-reference",
      kind: "subflow-reference.set",
      nodeId: "child-node",
      reference,
    });
    expect(result.graph).toMatchObject({
      schemaVersion: 2,
      nodes: [{ id: "child-node", params: { reference }, bindings: {} }],
    });
    expect(JSON.stringify(applyGraphCommand(result.graph, result.inverse).graph)).toBe(before);
  });

  it("renders labelled legacy/draft/pinned states without mutating on render", () => {
    const node: FlowNodeV2 = {
      id: "child-node", type: "subflow", params: { flowId: "legacy-child" },
      bindings: {}, position: { x: 0, y: 0 },
    };
    const onResolved = vi.fn();
    const legacy = renderToStaticMarkup(createElement(SubflowReferenceControl, {
      parentFlowId: "parent", node, onResolved,
    }));
    expect(legacy).toContain("Legacy reference");
    expect(legacy).toContain('aria-haspopup="dialog"');
    expect(onResolved).not.toHaveBeenCalled();

    const draft: SubflowReference = {
      kind: "draft", flowId: "child", interface: callable,
      interfaceHash: hashCallableInterface(callable),
    };
    const typed = renderToStaticMarkup(createElement(SubflowReferenceControl, {
      parentFlowId: "parent",
      node: { ...node, params: { reference: draft } as never },
      current: draft,
      resolutionStatus: "unresolved",
      onResolved,
    }));
    expect(typed).toContain("Draft reference");
    expect(typed).toContain("Needs verification");
    expect(onResolved).not.toHaveBeenCalled();
  });

  it("offers Open child only for the exact resolved typed reference", () => {
    const draft: SubflowReference = {
      kind: "draft", flowId: "child", interface: callable,
      interfaceHash: hashCallableInterface(callable),
    };
    const node: FlowNodeV2 = {
      id: "child-node", type: "loop", params: { reference: draft } as never,
      bindings: {}, position: { x: 0, y: 0 },
    };
    const onOpenChild = vi.fn();
    const resolved = renderToStaticMarkup(createElement(SubflowReferenceControl, {
      parentFlowId: "parent", node, current: draft, resolutionStatus: "resolved",
      onResolved: vi.fn(), onOpenChild,
    }));
    expect(resolved).toContain("Open child");
    expect(resolved).toContain('data-subflow-open-node="child-node"');
    expect(onOpenChild).not.toHaveBeenCalled();

    for (const resolutionStatus of ["legacy", "unresolved", "drift", "error"] as const) {
      const markup = renderToStaticMarkup(createElement(SubflowReferenceControl, {
        parentFlowId: "parent", node, current: draft, resolutionStatus,
        onResolved: vi.fn(), onOpenChild,
      }));
      expect(markup).not.toContain("Open child");
    }
  });

  it("contains one keyboard-labelled dialog state machine with busy and live regions", () => {
    const source = readFileSync("src/components/canvas/SubflowReferenceControl.tsx", "utf8");
    expect(source).toContain('role="dialog"');
    expect(source).toContain('role="combobox"');
    expect(source).toContain('role="listbox"');
    expect(source).toContain("aria-busy");
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain('aria-atomic="true"');
    expect(source).toContain('event.key === "Escape"');
    expect(source).toContain("aria-activedescendant");
    expect(source).toContain('event.key === "Enter"');
    expect(source).toContain("searchRef.current?.focus()");
    expect(source).toContain("focusable");
    expect(source).toContain("triggerRef.current?.focus()");
  });
});
