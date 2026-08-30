import { describe, expect, it, vi } from "vitest";
import type { FlowGraph, FlowGraphV2, SupportedFlowGraph } from "@/lib/flow/types";

const v1 = (name = "V1"): FlowGraph => ({ id: "graph-v1", name, nodes: [], edges: [] });
const v2 = (name = "V2"): FlowGraphV2 => ({
  schemaVersion: 2,
  id: "graph-v2",
  name,
  nodes: [],
  edges: [],
  variables: [],
  groups: [],
  annotations: [],
});

describe("StudioNavigationCoordinator", () => {
  it("exports the create-path, paste, and activation policies", async () => {
    const module = await import("@/lib/flow/studio-navigation");
    expect(module.resolveStudioNavigationPathAfterCreate).toBeTypeOf("function");
    expect(module.isStudioPasteNavigationPending).toBeTypeOf("function");
    expect(module.isUnmodifiedPrimaryStudioNavigation).toBeTypeOf("function");
    expect(module.STUDIO_NAVIGATION_PASTE_WAIT_MESSAGE).toBe(
      "Wait for the navigation save to finish before pasting.",
    );
  });

  it("carries a newly authoritative row into Guided mode with an encoded query", async () => {
    const { resolveStudioNavigationPathAfterCreate } = await import("@/lib/flow/studio-navigation");
    expect(resolveStudioNavigationPathAfterCreate("/start", "row:/ opaque?&")).toBe(
      "/start?flow=row%3A%2F%20opaque%3F%26",
    );
    expect(resolveStudioNavigationPathAfterCreate("/flows", "row-id")).toBe("/flows");
  });

  it("blocks every active paste lane until reusable-flow resolution settles", async () => {
    const { isStudioPasteNavigationPending } = await import("@/lib/flow/studio-navigation");
    const idle = {
      operation: false,
      epoch: false,
      controller: false,
      deferred: false,
      resolving: false,
    };
    expect(isStudioPasteNavigationPending(idle)).toBe(false);
    for (const key of Object.keys(idle) as Array<keyof typeof idle>) {
      expect(isStudioPasteNavigationPending({ ...idle, [key]: true }), key).toBe(true);
    }
  });

  it("allows only unmodified primary and keyboard click activation", async () => {
    const { isUnmodifiedPrimaryStudioNavigation } = await import("@/lib/flow/studio-navigation");
    const primary = { button: 0, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
    expect(isUnmodifiedPrimaryStudioNavigation(primary)).toBe(true);
    expect(isUnmodifiedPrimaryStudioNavigation({ ...primary, button: 1 })).toBe(false);
    expect(isUnmodifiedPrimaryStudioNavigation({ ...primary, button: 2 })).toBe(false);
    for (const key of ["metaKey", "ctrlKey", "altKey", "shiftKey"] as const) {
      expect(isUnmodifiedPrimaryStudioNavigation({ ...primary, [key]: true }), key).toBe(false);
    }
  });

  it.each([v1(), v2()])("saves an exact detached snapshot before navigating", async (graph) => {
    const module = await import("@/lib/flow/studio-navigation").catch(() => null);
    expect(module).not.toBeNull();
    if (!module) return;
    const coordinator = new module.StudioNavigationCoordinator();
    const order: string[] = [];
    let saved: SupportedFlowGraph | null = null;

    const result = await coordinator.run({
      path: "/flows",
      graph,
      getCurrentGraph: () => graph,
      saveNow: async (snapshot) => {
        order.push("save");
        saved = snapshot;
      },
      navigate: (path) => order.push(`navigate:${path}`),
    });

    expect(result).toEqual({ status: "navigated", path: "/flows" });
    expect(saved).toEqual(graph);
    expect(saved).not.toBe(graph);
    expect(order).toEqual(["save", "navigate:/flows"]);
  });

  it("refuses navigation when the graph changes during the exact save", async () => {
    const { StudioNavigationCoordinator, STUDIO_NAVIGATION_CHANGED_MESSAGE } =
      await import("@/lib/flow/studio-navigation");
    const coordinator = new StudioNavigationCoordinator();
    let current: SupportedFlowGraph = v1("Before");
    const navigate = vi.fn();

    const result = await coordinator.run({
      path: "/agents",
      graph: current,
      getCurrentGraph: () => current,
      saveNow: async () => { current = v1("After"); },
      navigate,
    });

    expect(result).toEqual({ status: "changed", message: STUDIO_NAVIGATION_CHANGED_MESSAGE });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("refuses navigation when a paste starts during the awaited save", async () => {
    const { StudioNavigationCoordinator, STUDIO_PASTE_NAVIGATION_MESSAGE } =
      await import("@/lib/flow/studio-navigation");
    const coordinator = new StudioNavigationCoordinator();
    const graph = v1();
    let release!: () => void;
    let pastePending = false;
    const navigate = vi.fn();
    const result = coordinator.run({
      path: "/flows",
      graph,
      getCurrentGraph: () => graph,
      saveNow: () => new Promise<void>((resolve) => { release = resolve; }),
      beforeNavigate: () => pastePending ? STUDIO_PASTE_NAVIGATION_MESSAGE : null,
      navigate,
    });

    pastePending = true;
    release();
    await expect(result).resolves.toEqual({
      status: "blocked",
      message: STUDIO_PASTE_NAVIGATION_MESSAGE,
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("checks graph drift before the final navigation blocker", async () => {
    const { StudioNavigationCoordinator } = await import("@/lib/flow/studio-navigation");
    const coordinator = new StudioNavigationCoordinator();
    let current: SupportedFlowGraph = v1("Before");
    const beforeNavigate = vi.fn(() => "late blocker");
    const result = await coordinator.run({
      path: "/flows",
      graph: current,
      getCurrentGraph: () => current,
      saveNow: async () => { current = v1("After"); },
      beforeNavigate,
      navigate: vi.fn(),
    });
    expect(result.status).toBe("changed");
    expect(beforeNavigate).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent navigation so the first exact destination wins", async () => {
    const { StudioNavigationCoordinator } = await import("@/lib/flow/studio-navigation");
    const coordinator = new StudioNavigationCoordinator();
    const graph = v2();
    let release!: () => void;
    const saveNow = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const navigate = vi.fn();
    const first = coordinator.run({ path: "/flows", graph, getCurrentGraph: () => graph, saveNow, navigate });
    const duplicate = coordinator.run({ path: "/agents", graph, getCurrentGraph: () => graph, saveNow, navigate });

    expect(duplicate).toBe(first);
    expect(coordinator.isBusy()).toBe(true);
    release();
    await expect(first).resolves.toEqual({ status: "navigated", path: "/flows" });
    expect(saveNow).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("/flows");
    expect(coordinator.isBusy()).toBe(false);
  });

  it("never navigates after save rejection and permits a later retry", async () => {
    const { StudioNavigationCoordinator } = await import("@/lib/flow/studio-navigation");
    const coordinator = new StudioNavigationCoordinator();
    const graph = v1();
    const navigate = vi.fn();
    await expect(coordinator.run({
      path: "/flows",
      graph,
      getCurrentGraph: () => graph,
      saveNow: async () => { throw new Error("private transport detail"); },
      navigate,
    })).rejects.toThrow("private transport detail");
    expect(navigate).not.toHaveBeenCalled();
    expect(coordinator.isBusy()).toBe(false);

    await expect(coordinator.run({
      path: "/flows",
      graph,
      getCurrentGraph: () => graph,
      saveNow: async () => undefined,
      navigate,
    })).resolves.toEqual({ status: "navigated", path: "/flows" });
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});
