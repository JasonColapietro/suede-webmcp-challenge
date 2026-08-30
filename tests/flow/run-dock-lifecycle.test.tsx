import { beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => {
  const slots: unknown[] = [];
  const effects = new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>();
  let pending = new Map<number, { effect: () => void | (() => void); deps?: readonly unknown[] }>();
  let cursor = 0;
  const next = () => cursor++;
  return {
    begin() { cursor = 0; pending = new Map(); },
    state<T>(initial: T | (() => T)) {
      const index = next();
      if (!(index in slots)) slots[index] = typeof initial === "function" ? (initial as () => T)() : initial;
      return [slots[index] as T, (value: T | ((current: T) => T)) => {
        slots[index] = typeof value === "function" ? (value as (current: T) => T)(slots[index] as T) : value;
      }] as const;
    },
    ref<T>(initial: T) {
      const index = next();
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index] as { current: T };
    },
    memo<T>(factory: () => T, deps?: readonly unknown[]) {
      const index = next();
      const prior = slots[index] as { value: T; deps?: readonly unknown[] } | undefined;
      const changed = !prior || !deps || !prior.deps || deps.length !== prior.deps.length ||
        deps.some((value, offset) => !Object.is(value, prior.deps?.[offset]));
      if (!changed) return prior.value;
      const value = factory();
      slots[index] = { value, deps };
      return value;
    },
    callback<T>(callback: T, deps?: readonly unknown[]) {
      const index = next();
      const prior = slots[index] as { value: T; deps?: readonly unknown[] } | undefined;
      const changed = !prior || !deps || !prior.deps || deps.length !== prior.deps.length ||
        deps.some((value, offset) => !Object.is(value, prior.deps?.[offset]));
      if (!changed) return prior.value;
      slots[index] = { value: callback, deps };
      return callback;
    },
    effect(effect: () => void | (() => void), deps?: readonly unknown[]) {
      pending.set(next(), { effect, deps });
    },
    id() { return `test-id-${next()}`; },
    flush() {
      for (const [index, nextEffect] of pending) {
        const prior = effects.get(index);
        const changed = !prior || !nextEffect.deps || !prior.deps ||
          nextEffect.deps.length !== prior.deps.length ||
          nextEffect.deps.some((value, offset) => !Object.is(value, prior.deps?.[offset]));
        if (!changed) continue;
        prior?.cleanup?.();
        const cleanup = nextEffect.effect();
        effects.set(index, { deps: nextEffect.deps, ...(typeof cleanup === "function" ? { cleanup } : {}) });
      }
    },
    unmount() {
      for (const effect of effects.values()) effect.cleanup?.();
      effects.clear();
      slots.splice(0, slots.length);
      cursor = 0;
    },
  };
});

const uiHook = vi.hoisted(() => ({ afterSuccessfulAssembly: null as null | (() => void) }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    default: actual,
    useState: hooks.state,
    useRef: hooks.ref,
    useMemo: hooks.memo,
    useCallback: hooks.callback,
    useEffect: hooks.effect,
    useId: hooks.id,
  };
});

vi.mock("@/lib/flow/test-run-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/flow/test-run-ui")>();
  return {
    ...actual,
    assembleTestRunRequest: (input: Parameters<typeof actual.assembleTestRunRequest>[0]) => {
      const result = actual.assembleTestRunRequest(input);
      if (result.ok) uiHook.afterSuccessfulAssembly?.();
      return result;
    },
  };
});

import RunDock, { type RunDockProps } from "@/components/canvas/RunDock";
import type { FlowGraphV2 } from "@/lib/flow/types";

const graph: FlowGraphV2 = {
  schemaVersion: 2, id: "g", name: "G",
  nodes: [{ id: "target", type: "transform", params: { expression: "input" }, bindings: {}, position: { x: 0, y: 0 } }],
  edges: [], variables: [], groups: [], annotations: [],
};

type ElementLike = { readonly props?: { readonly children?: unknown; readonly onClick?: () => void } };

function findButton(value: unknown, label: string): ElementLike | null {
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findButton(child, label);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const element = value as ElementLike;
  const children = element.props?.children;
  if (typeof children === "string" && children === label && element.props?.onClick) return element;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findButton(child, label);
    if (found) return found;
  }
  return null;
}

function textContent(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textContent).join("");
  if (!value || typeof value !== "object") return "";
  const children = (value as ElementLike).props?.children;
  return (Array.isArray(children) ? children : [children]).map(textContent).join("");
}

function findWithRole(value: unknown, role: string): ElementLike | null {
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findWithRole(child, role);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const element = value as ElementLike & { readonly props?: ElementLike["props"] & { readonly role?: string } };
  if (element.props?.role === role) return element;
  const children = element.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findWithRole(child, role);
    if (found) return found;
  }
  return null;
}

function render(props: RunDockProps) {
  hooks.begin();
  const tree = RunDock(props);
  hooks.flush();
  return tree;
}

const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

beforeEach(() => {
  hooks.unmount();
  uiHook.afterSuccessfulAssembly = null;
  vi.restoreAllMocks();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
});

describe("RunDock active-run lifecycle", () => {
  it("announces a legacy run outcome with its final cost", async () => {
    const event = { kind: "run:done", runId: "legacy-1", totalCostUsdc: 0.125, status: "done" };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      `data: ${JSON.stringify(event)}\n\n`,
      { status: 200 },
    ));
    const props: RunDockProps = { flowId: "flow-1", graph };
    const ready = render(props);

    findButton(ready, "Run")?.props?.onClick?.();
    for (let index = 0; index < 8; index += 1) await tick();

    expect(textContent(render(props))).toContain("Run finished. 0.125 USDC.");
  });

  it("persists an unsaved template and runs the returned row id on the same click", async () => {
    const order: string[] = [];
    const prepareRun = vi.fn(async () => { order.push("persist"); return "persisted-flow"; });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      order.push("run");
      expect(input).toBe("/api/v2/flows/persisted-flow/run");
      return new Response("data: {}\n\n", { status: 200 });
    });
    const tree = render({ flowId: "template-graph", graph, prepareRun });

    findButton(tree, "Save to run")?.props?.onClick?.();
    await tick();

    expect(prepareRun).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(order).toEqual(["persist", "run"]);
  });

  it("persists before a scoped test and sends that test to the returned row id", async () => {
    const order: string[] = [];
    const prepareRun = vi.fn(async () => { order.push("persist"); return "persisted-flow"; });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      order.push("test");
      expect(input).toBe("/api/v2/flows/persisted-flow/test");
      return new Response(null, { status: 500 });
    });
    const props: RunDockProps = {
      flowId: "template-graph", graph, prepareRun,
      testEnvironment: { id: "test-env", name: "Test" },
      testScope: { kind: "node", nodeId: "target" },
    };
    render(props);
    const tree = render(props);

    findButton(tree, "Save to run")?.props?.onClick?.();
    await tick();

    expect(prepareRun).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(order).toEqual(["persist", "test"]);
  });

  it("aborts hidden generic work when entering dedicated API operation mode", async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    let readerPullStarted!: () => void;
    const pullStarted = new Promise<void>((resolve) => { readerPullStarted = resolve; });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { streamController = controller; },
      pull() { readerPullStarted(); return new Promise(() => undefined); },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(stream, { status: 200 }));
    const statuses = vi.fn();
    const running = vi.fn();
    const base = { flowId: "flow-1", graph, onStatuses: statuses, onRunningChange: running };
    const full = render(base);
    findButton(full, "Run")?.props?.onClick?.();
    await pullStarted;
    const signal = (fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined)?.signal as AbortSignal;
    expect(signal.aborted).toBe(false);

    const dedicated = render({ ...base, apiOperationSimulation: { status: "idle" } });
    expect(signal.aborted).toBe(true);
    expect(textContent(dedicated)).toContain("Choose Simulate workflow");
    expect(textContent(dedicated)).not.toContain("Run log");
    const statusCount = statuses.mock.calls.length;
    streamController.enqueue(new TextEncoder().encode(
      "data: {\"kind\":\"node:start\",\"runId\":\"old\",\"at\":0,\"nodeId\":\"old\",\"nodeType\":\"transform\"}\n\n",
    ));
    streamController.close();
    await tick();
    expect(statuses.mock.calls.length).toBe(statusCount);
  });

  it("aborts a pending full-stream reader on scoped rerender and ignores its late frame and finally", async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    let readerPullStarted!: () => void;
    const pullStarted = new Promise<void>((resolve) => { readerPullStarted = resolve; });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { streamController = controller; },
      pull() { readerPullStarted(); return new Promise(() => undefined); },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(stream, { status: 200 }));
    const statuses = vi.fn();
    const running = vi.fn();
    const base = { flowId: "flow-1", graph, onStatuses: statuses, onRunningChange: running };
    const full = render(base);
    findButton(full, "Run")?.props?.onClick?.();
    await pullStarted;
    const signal = (fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined)?.signal as AbortSignal;
    expect(signal.aborted).toBe(false);

    render({
      ...base,
      testEnvironment: { id: "test-env", name: "Test" },
      testScope: { kind: "node", nodeId: "target" },
    });
    expect(signal.aborted).toBe(true);
    const statusCallsAfterTransition = statuses.mock.calls.length;
    const runningCallsAfterTransition = running.mock.calls.length;
    streamController.enqueue(new TextEncoder().encode(
      "data: {\"kind\":\"node:start\",\"runId\":\"old\",\"at\":0,\"nodeId\":\"old\",\"nodeType\":\"transform\"}\n\n",
    ));
    streamController.close();
    await tick();
    expect(statuses.mock.calls.length).toBe(statusCallsAfterTransition);
    expect(running.mock.calls.length).toBe(runningCallsAfterTransition);
    expect(statuses).toHaveBeenLastCalledWith({});
  });

  it("rechecks a dynamic blocker after assembly and performs zero fetches", async () => {
    let blocked = false;
    const blocker = vi.fn(() => blocked ? "Testing is blocked now." : null);
    uiHook.afterSuccessfulAssembly = () => { blocked = true; };
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const props: RunDockProps = {
      flowId: "flow-1", graph, testEnvironment: { id: "test-env", name: "Test" },
      testScope: { kind: "node", nodeId: "target" }, runBlocker: blocker,
    };
    render(props);
    const ready = render(props);
    findButton(ready, "Run test")?.props?.onClick?.();
    await tick();
    expect(blocker.mock.results.slice(0, -1).every(({ value }) => value === null)).toBe(true);
    expect(blocker).toHaveLastReturnedWith("Testing is blocked now.");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders a successful bounded output receipt and clears canvas status on transition", async () => {
    const runId = "scoped-success";
    const captured = { kind: "value", value: { answer: 42 } } as const;
    const result = {
      runId, status: "done", costUsdc: 0, latencyMs: 9,
      outputs: { target: captured },
      events: [
        { kind: "test:start", sequence: 0, runId },
        { kind: "node:start", sequence: 1, runId, nodeId: "target", nodeType: "transform" },
        { kind: "node:done", sequence: 2, runId, nodeId: "target", nodeType: "transform", outputs: captured, costUsdc: 0 },
        { kind: "test:done", sequence: 3, runId, status: "done", costUsdc: 0, latencyMs: 9 },
      ],
      logs: [{ level: "info", message: "completed safely" }],
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const statuses = vi.fn();
    const running = vi.fn();
    const scoped: RunDockProps = {
      flowId: "flow-1", graph, testEnvironment: { id: "test-env", name: "Test" },
      testScope: { kind: "node", nodeId: "target" }, onStatuses: statuses, onRunningChange: running,
    };
    render(scoped);
    const ready = render(scoped);
    findButton(ready, "Run test")?.props?.onClick?.();
    for (let index = 0; index < 8; index += 1) await tick();
    const completed = render(scoped);
    const receipt = textContent(completed);
    expect(receipt).toContain("Test outputs");
    expect(receipt).toContain('target: {"answer":42}');
    expect(receipt).not.toContain('"kind":"value"');
    expect(receipt).toContain("$0.000 USDC · 9 ms");
    expect(textContent(findWithRole(completed, "status"))).toContain("Scoped test done.");
    expect(statuses).toHaveBeenLastCalledWith({ target: "done" });

    render({ flowId: "flow-1", graph, onStatuses: statuses, onRunningChange: running });
    expect(statuses).toHaveBeenLastCalledWith({});
    expect(running).toHaveBeenLastCalledWith(false);
  });
});
