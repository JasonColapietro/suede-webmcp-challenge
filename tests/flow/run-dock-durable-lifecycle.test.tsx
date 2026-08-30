import { beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => {
  const slots: unknown[] = [];
  const effects = new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>();
  let pending = new Map<number, { effect: () => void | (() => void); deps?: readonly unknown[] }>();
  let cursor = 0;
  const changed = (a?: readonly unknown[], b?: readonly unknown[]) => !a || !b || a.length !== b.length || a.some((value, i) => !Object.is(value, b[i]));
  return {
    begin() { cursor = 0; pending = new Map(); },
    state<T>(initial: T | (() => T)) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? (initial as () => T)() : initial; return [slots[i] as T, (value: T | ((old: T) => T)) => { slots[i] = typeof value === "function" ? (value as (old: T) => T)(slots[i] as T) : value; }] as const; },
    ref<T>(initial: T) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i] as { current: T }; },
    memo<T>(factory: () => T, deps?: readonly unknown[]) { const i = cursor++; const old = slots[i] as { value: T; deps?: readonly unknown[] } | undefined; if (old && !changed(old.deps, deps)) return old.value; const value = factory(); slots[i] = { value, deps }; return value; },
    callback<T>(value: T, deps?: readonly unknown[]) { return this.memo(() => value, deps); },
    effect(effect: () => void | (() => void), deps?: readonly unknown[]) { pending.set(cursor++, { effect, deps }); },
    id() { return `durable-test-${cursor++}`; },
    flush() { for (const [i, next] of pending) { const old = effects.get(i); if (!changed(old?.deps, next.deps)) continue; old?.cleanup?.(); const cleanup = next.effect(); effects.set(i, { deps: next.deps, ...(typeof cleanup === "function" ? { cleanup } : {}) }); } },
    unmount() { for (const value of effects.values()) value.cleanup?.(); effects.clear(); slots.splice(0); cursor = 0; },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, default: actual, useState: hooks.state, useRef: hooks.ref, useMemo: hooks.memo, useCallback: hooks.callback.bind(hooks), useEffect: hooks.effect, useId: hooks.id };
});

import RunDock, { DurableRunMonitor, type DurableRunMonitorProps } from "@/components/canvas/RunDock";

type ElementLike = { readonly props?: { readonly children?: unknown; readonly onClick?: () => void } };
function findButton(value: unknown, label: string): ElementLike | null {
  if (Array.isArray(value)) { for (const child of value) { const found = findButton(child, label); if (found) return found; } return null; }
  if (!value || typeof value !== "object") return null;
  const element = value as ElementLike; const children = element.props?.children;
  if (children === label && element.props?.onClick) return element;
  for (const child of Array.isArray(children) ? children : [children]) { const found = findButton(child, label); if (found) return found; }
  return null;
}
function render(props: DurableRunMonitorProps, flush = true) { hooks.begin(); const tree = DurableRunMonitor(props); if (flush) hooks.flush(); return tree; }
function renderParent(flush = true) {
  hooks.begin();
  const parent = RunDock({ flowId: "flow_1", immutableVersion: { id: "version_1", versionNumber: 1 } });
  const tree = typeof parent.type === "function" ? DurableRunMonitor(parent.props as DurableRunMonitorProps) : parent;
  if (flush) hooks.flush(); return tree;
}
function textContent(value: unknown): string { if (typeof value === "string" || typeof value === "number") return String(value); if (Array.isArray(value)) return value.map(textContent).join(""); if (!value || typeof value !== "object") return ""; return textContent((value as ElementLike).props?.children); }
function findStatusRef(value: unknown): { current: unknown } | null {
  if (Array.isArray(value)) { for (const child of value) { const found = findStatusRef(child); if (found) return found; } return null; }
  if (!value || typeof value !== "object") return null;
  const props = (value as { props?: { children?: unknown; tabIndex?: number; ref?: { current: unknown } } }).props;
  if (props?.children === "running" && props.tabIndex === -1) return props.ref ?? null;
  for (const child of Array.isArray(props?.children) ? props.children : [props?.children]) { const found = findStatusRef(child); if (found) return found; }
  return null;
}
function findReceiptRef(value: unknown): { current: unknown } | null {
  if (Array.isArray(value)) { for (const child of value) { const found = findReceiptRef(child); if (found) return found; } return null; }
  if (!value || typeof value !== "object") return null;
  const props = (value as { props?: { children?: unknown; tabIndex?: number; ref?: { current: unknown } } }).props;
  if ((props?.children === "Execution receipt" || props?.children === "Live controls") && props.tabIndex === -1) return props.ref ?? null;
  for (const child of Array.isArray(props?.children) ? props.children : [props?.children]) { const found = findReceiptRef(child); if (found) return found; }
  return null;
}
function findLegacyNoticeRef(value: unknown): { current: unknown } | null {
  if (Array.isArray(value)) { for (const child of value) { const found = findLegacyNoticeRef(child); if (found) return found; } return null; }
  if (!value || typeof value !== "object") return null;
  const props = (value as { props?: { children?: unknown; tabIndex?: number; ref?: { current: unknown } } }).props;
  if (typeof props?.children === "string" && props.children.startsWith("Durable admission was refused") && props.tabIndex === -1) return props.ref ?? null;
  for (const child of Array.isArray(props?.children) ? props.children : [props?.children]) { const found = findLegacyNoticeRef(child); if (found) return found; }
  return null;
}
const tick = async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve(); };

const storage = new Map<string, string>();
beforeEach(() => {
  hooks.unmount(); storage.clear(); vi.restoreAllMocks();
  const sessionStorage = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); }, removeItem: (key: string) => { storage.delete(key); } };
  vi.stubGlobal("window", { sessionStorage, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
  vi.stubGlobal("document", { activeElement: null });
  vi.stubGlobal("HTMLButtonElement", class HTMLButtonElement {});
  vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "idem_1") });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
});

describe("durable monitor lifecycle", () => {
  it("enqueues once and stores the exact initial cursor", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(enqueue("run_1"), 202));
    const tree = render(base()); findButton(tree, "Run durable")?.props?.onClick?.(); await tick();
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(storage.get("suede:durable-run:flow_1") ?? "null")).toEqual({ runId: "run_1", flowVersionId: "version_1", lastSequence: 0 });
  });

  it("reports pending immediately, blocks a synchronous second start, and focuses the persistent receipt destination", async () => {
    let settle!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => { settle = resolve; });
    const fetch = vi.spyOn(globalThis, "fetch").mockReturnValue(pending);
    const running = vi.fn();
    const tree = render({ ...base(), onRunningChange: running }, false);
    const focus = vi.fn(); const receiptRef = findReceiptRef(tree); expect(receiptRef).not.toBeNull(); if (receiptRef) receiptRef.current = { focus };
    const click = findButton(tree, "Run durable")?.props?.onClick; click?.(); click?.();
    expect(fetch).toHaveBeenCalledOnce(); expect(running).toHaveBeenCalledWith(true);
    settle(jsonResponse(enqueue("run_1"), 202)); await tick(); expect(focus).toHaveBeenCalledOnce();
  });

  it("persists an ambiguous enqueue and automatically recovers with the exact key and body after remount", async () => {
    const running = vi.fn();
    const first = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("lost response"));
    const tree = render({ ...base(), triggerInputText: '{"prompt":"hello"}', onRunningChange: running }, false);
    findButton(tree, "Run durable")?.props?.onClick?.(); await tick();
    const pendingKey = "suede:durable-run:pending:flow_1:version_1";
    const saved = JSON.parse(storage.get(pendingKey) ?? "null") as { idempotencyKey: string; triggerInput: unknown };
    expect(saved).toMatchObject({ idempotencyKey: "idem_1", triggerInput: { prompt: "hello" } });
    expect(running).toHaveBeenCalledWith(true);
    expect(running).toHaveBeenLastCalledWith(false);

    hooks.unmount(); first.mockRestore();
    const recoveredFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(enqueue("run_recovered"), 202));
    render({ ...base(), triggerInputText: "{}", onRunningChange: running }); await tick();
    expect((recoveredFetch.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({ "idempotency-key": saved.idempotencyKey });
    expect((recoveredFetch.mock.calls[0]?.[1] as RequestInit).body).toBe(JSON.stringify({ flowVersionId: "version_1", triggerInput: { prompt: "hello" } }));
    expect(storage.has(pendingKey)).toBe(false);
    expect(JSON.parse(storage.get("suede:durable-run:flow_1") ?? "null").runId).toBe("run_recovered");
  });

  it.each([408, 429, 503])("keeps ambiguous status %i pending and reuses the exact enqueue key", async (status) => {
    const randomUUID = globalThis.crypto.randomUUID as ReturnType<typeof vi.fn>;
    randomUUID.mockReturnValueOnce("idem_ambiguous").mockReturnValueOnce("must_not_be_used");
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status }))
      .mockResolvedValueOnce(jsonResponse(enqueue("run_after_ambiguous"), 202));
    const running = vi.fn();
    const props = { ...base(), onRunningChange: running };
    const first = render(props, false); findButton(first, "Run durable")?.props?.onClick?.(); await tick();
    const pendingKey = "suede:durable-run:pending:flow_1:version_1";
    expect(JSON.parse(storage.get(pendingKey) ?? "null").idempotencyKey).toBe("idem_ambiguous");
    expect(running).toHaveBeenLastCalledWith(false);
    const retry = render(props, false); findButton(retry, "Run durable")?.props?.onClick?.(); await tick();
    const firstHeader = ((fetch.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>)["idempotency-key"];
    const secondHeader = ((fetch.mock.calls[1]?.[1] as RequestInit).headers as Record<string, string>)["idempotency-key"];
    expect(firstHeader).toBe("idem_ambiguous"); expect(secondHeader).toBe(firstHeader); expect(randomUUID).toHaveBeenCalledOnce();
  });

  it("retains the pending enqueue key when accepted-receipt storage throws", async () => {
    const sessionStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { if (key === "suede:durable-run:flow_1") throw new Error("quota"); storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
    };
    (globalThis.window as unknown as { sessionStorage: Storage }).sessionStorage = sessionStorage as unknown as Storage;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(enqueue("run_1"), 202));
    const tree = render(base(), false); findButton(tree, "Run durable")?.props?.onClick?.(); await tick();
    expect(storage.has("suede:durable-run:pending:flow_1:version_1")).toBe(true);
  });

  it("uses legacy fallback only for a 422 refusal", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 422 })); const fallback = vi.fn();
    const tree = render({ ...base(), fallbackToLegacy: fallback }); findButton(tree, "Run durable")?.props?.onClick?.(); await tick();
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("switches the parent RunDock to visible unchanged legacy mode after 422", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 422 })).mockResolvedValueOnce(new Response("data: {}\n\n", { status: 200 }));
    const first = renderParent(); findButton(first, "Run durable")?.props?.onClick?.(); await tick();
    const legacy = renderParent(false);
    const focus = vi.fn(); const noticeRef = findLegacyNoticeRef(legacy); expect(noticeRef).not.toBeNull(); if (noticeRef) noticeRef.current = { focus }; hooks.flush();
    expect(textContent(legacy)).toContain("Run log"); expect(findButton(legacy, "Run")).not.toBeNull(); expect(textContent(legacy)).not.toContain("Run durable");
    expect(textContent(legacy)).toContain("Durable admission was refused"); expect(textContent(legacy)).toContain("existing v2 transport");
    expect(focus).toHaveBeenCalledOnce();
  });

  it.each([400, 401, 403, 404, 409, 503])("does not fall back to legacy for v3 status %i", async (status) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status })); const fallback = vi.fn();
    const tree = render({ ...base(), fallbackToLegacy: fallback }); findButton(tree, "Run durable")?.props?.onClick?.(); await tick();
    expect(fallback).not.toHaveBeenCalled();
  });

  it("does not fall back after a network failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline")); const fallback = vi.fn();
    const tree = render({ ...base(), fallbackToLegacy: fallback }); findButton(tree, "Run durable")?.props?.onClick?.(); await tick();
    expect(fallback).not.toHaveBeenCalled();
  });

  it("persists N and treats a clean SSE close as a disconnect, not a stop", async () => {
    storage.set("suede:durable-run:flow_1", JSON.stringify({ runId: "run_1", flowVersionId: "version_1", lastSequence: 0 }));
    let third!: () => void; const thirdStarted = new Promise<void>((resolve) => { third = resolve; });
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ run: view("running", "running", 1) }))
      .mockResolvedValueOnce(sseResponse(event(1)))
      .mockImplementationOnce(() => { third(); return new Promise(() => undefined); });
    const running = vi.fn(); render({ ...base(), onRunningChange: running }); await thirdStarted; await tick();
    expect(fetch.mock.calls[1]?.[0]).toBe("/api/v3/runs/run_1/events?after=0");
    expect(JSON.parse(storage.get("suede:durable-run:flow_1") ?? "null").lastSequence).toBe(1);
    expect(running).toHaveBeenCalledWith(true); expect(running).not.toHaveBeenCalledWith(false);
  });

  it("resumes a remounted accepted receipt from its nonzero persisted cursor", async () => {
    storage.set("suede:durable-run:flow_1", JSON.stringify({ runId: "run_1", flowVersionId: "version_1", lastSequence: 7 }));
    let opened!: () => void; const streamOpened = new Promise<void>((resolve) => { opened = resolve; });
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ run: view("running", "running", 7) }))
      .mockImplementationOnce(() => { opened(); return new Promise(() => undefined); });
    render(base()); await streamOpened;
    expect(fetch.mock.calls[1]?.[0]).toBe("/api/v3/runs/run_1/events?after=7");
    expect(((fetch.mock.calls[1]?.[1] as RequestInit).headers as Record<string, string>)["Last-Event-ID"]).toBe("7");
  });

  it("renders incoming persisted events in the compact detail timeline", async () => {
    let third!: () => void; const thirdStarted = new Promise<void>((resolve) => { third = resolve; });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ run: view("running", "running", 1) }))
      .mockResolvedValueOnce(sseResponse(event(1)))
      .mockImplementationOnce(() => { third(); return new Promise(() => undefined); });
    const props = { ...base(), compact: true, initialRunId: "run_1", initialRun: view("running", "running", 1) };
    render(props); await thirdStarted; await tick();
    const updated = render(props, false);
    expect(textContent(updated)).toContain("Persisted event timeline"); expect(textContent(updated)).toContain("1 execution.created");
    expect(textContent(updated)).not.toContain("Trigger input"); expect(textContent(updated)).not.toContain("Execution receipt");
  });

  it("uses bounded backoff after a clean nonterminal close with no meaningful progress", async () => {
    storage.set("suede:durable-run:flow_1", JSON.stringify({ runId: "run_1", flowVersionId: "version_1", lastSequence: 0 }));
    const timers: Array<{ callback: () => void; delay: number }> = [];
    let scheduled!: () => void; const timerScheduled = new Promise<void>((resolve) => { scheduled = resolve; });
    (globalThis.window as unknown as { setTimeout: (callback: () => void, delay: number) => number }).setTimeout = (callback, delay) => { timers.push({ callback, delay }); scheduled(); return timers.length; };
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ run: view("running", "running", 1) }))
      .mockResolvedValueOnce(sseResponse(event(1)))
      .mockResolvedValueOnce(jsonResponse({ run: view("running", "running", 1) }))
      .mockResolvedValueOnce(new Response("", { headers: { "content-type": "text/event-stream" } }));
    render(base()); await timerScheduled;
    expect(fetch).toHaveBeenCalledTimes(4); expect(timers[0]?.delay).toBe(250);
  });

  it("switches retry monitoring and storage to the returned child", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ action: "retry", ...enqueue("child_1") }, 202));
    const tree = render({ ...base(), initialRunId: "run_1", initialRun: view("failed", "running", 8) }, false);
    const focus = vi.fn(); const receiptRef = findReceiptRef(tree); expect(receiptRef).not.toBeNull(); if (receiptRef) receiptRef.current = { focus };
    findButton(tree, "Retry")?.props?.onClick?.(); await tick();
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/v3/runs/run_1/actions");
    expect(JSON.parse(storage.get("suede:durable-run:flow_1") ?? "null").runId).toBe("child_1");
    expect(focus).toHaveBeenCalledOnce();
  });

  it("starts another durable run from a terminal receipt without a reload", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(enqueue("run_2"), 202));
    const props = { ...base(), initialRunId: "run_1", initialRun: view("failed", "running", 8) };
    const tree = render(props, false);

    expect(findButton(tree, "New run")).not.toBeNull();
    findButton(tree, "New run")?.props?.onClick?.();
    await tick();

    expect(fetch.mock.calls[0]?.[0]).toBe("/api/v3/flows/flow_1/runs");
    expect(JSON.parse(storage.get("suede:durable-run:flow_1") ?? "null").runId).toBe("run_2");
  });

  it("requires an explicit second click before cancelling a durable run", () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => undefined));
    const props = { ...base(), initialRunId: "run_1", initialRun: view("running", "running", 8) };
    const tree = render(props, false);

    findButton(tree, "Cancel")?.props?.onClick?.();
    expect(fetch).not.toHaveBeenCalled();

    const armed = render(props, false);
    expect(findButton(armed, "Confirm cancel")).not.toBeNull();
    findButton(armed, "Confirm cancel")?.props?.onClick?.();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("locks a synchronous double action and reuses a persisted retry key after an ambiguous response", async () => {
    let reject!: (reason: Error) => void;
    const pending = new Promise<Response>((_resolve, rejectPromise) => { reject = rejectPromise; });
    const fetch = vi.spyOn(globalThis, "fetch").mockReturnValue(pending);
    const props = { ...base(), initialRunId: "run_1", initialRun: view("failed", "running", 8) };
    const tree = render(props, false); const click = findButton(tree, "Retry")?.props?.onClick; click?.(); click?.();
    expect(fetch).toHaveBeenCalledOnce();
    const firstKey = ((fetch.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>)["idempotency-key"];
    reject(new Error("lost response")); await tick();
    expect(storage.get("suede:durable-run:retry:flow_1:run_1")).toBe(firstKey);

    hooks.unmount(); fetch.mockRestore();
    const recovered = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ action: "retry", ...enqueue("child_1") }, 202));
    const remounted = render(props, false); findButton(remounted, "Retry")?.props?.onClick?.(); await tick();
    expect(((recovered.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>)["idempotency-key"]).toBe(firstKey);
    expect(storage.has("suede:durable-run:retry:flow_1:run_1")).toBe(false);
  });

  it("retains the retry key when the accepted child receipt cannot be read back", async () => {
    const sessionStorage = {
      getItem: (key: string) => key === "suede:durable-run:flow_1" ? null : storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
    };
    (globalThis.window as unknown as { sessionStorage: Storage }).sessionStorage = sessionStorage as unknown as Storage;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ action: "retry", ...enqueue("child_1") }, 202));
    const tree = render({ ...base(), initialRunId: "run_1", initialRun: view("failed", "running", 8) }, false);
    findButton(tree, "Retry")?.props?.onClick?.(); await tick();
    expect(storage.get("suede:durable-run:retry:flow_1:run_1")).toBe("idem_1");
  });

  it.each([408, 429, 503])("retains the retry key after ambiguous action status %i", async (status) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status }));
    const tree = render({ ...base(), initialRunId: "run_1", initialRun: view("failed", "running", 8) }, false);
    findButton(tree, "Retry")?.props?.onClick?.(); await tick();
    expect(storage.get("suede:durable-run:retry:flow_1:run_1")).toBe("idem_1");
  });

  it("never lets a stale action envelope regress a newer projection", async () => {
    const newest = view("running", "running", 10); const stale = { ...newest.projection, sequence: 9, desiredState: "paused" as const };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ action: "pause", run: stale }));
    const props = { ...base(), initialRunId: "run_1", initialRun: newest };
    const tree = render(props, false); findButton(tree, "Pause")?.props?.onClick?.(); await tick();
    const refreshed = render(props, false); expect(findButton(refreshed, "Pause")).not.toBeNull();
  });

  it("refreshes authoritative state after an action conflict", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 409 })).mockResolvedValueOnce(jsonResponse({ run: view("running", "paused", 9) }));
    const props = { ...base(), initialRunId: "run_1", initialRun: view("running", "running", 8) };
    const tree = render(props, false); findButton(tree, "Pause")?.props?.onClick?.(); await tick();
    expect(fetch).toHaveBeenCalledTimes(2);
    const refreshed = render(props, false); expect(findButton(refreshed, "Pause")).toBeNull(); expect(findButton(refreshed, "Cancel")).not.toBeNull();
  });

  it("does not let a stale 409 refresh regress a newer projection", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 409 })).mockResolvedValueOnce(jsonResponse({ run: view("running", "paused", 9) }));
    const props = { ...base(), initialRunId: "run_1", initialRun: view("running", "running", 10) };
    const tree = render(props, false); findButton(tree, "Pause")?.props?.onClick?.(); await tick();
    const refreshed = render(props, false); expect(findButton(refreshed, "Pause")).not.toBeNull(); expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("returns focus to live status when an applied action removes its button", async () => {
    const initial = view("running", "running", 8); const applied = { ...initial.projection, desiredState: "paused" as const };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ action: "pause", run: applied }));
    const tree = render({ ...base(), initialRunId: "run_1", initialRun: initial }, false);
    const focus = vi.fn(); const statusRef = findStatusRef(tree); expect(statusRef).not.toBeNull(); if (statusRef) statusRef.current = { focus };
    const Button = globalThis.HTMLButtonElement as unknown as new () => { isConnected: boolean; focus(): void };
    const active = new Button(); active.isConnected = false; active.focus = vi.fn(); (globalThis.document as unknown as { activeElement: unknown }).activeElement = active;
    findButton(tree, "Pause")?.props?.onClick?.(); await tick(); expect(focus).toHaveBeenCalledOnce();
  });

  it("clears malformed and missing saved receipts so a fresh start is available", async () => {
    storage.set("suede:durable-run:flow_1", "{bad");
    let tree = render(base(), false); expect(storage.has("suede:durable-run:flow_1")).toBe(false); expect(findButton(tree, "Run durable")).not.toBeNull();
    hooks.unmount(); storage.set("suede:durable-run:flow_1", JSON.stringify({ runId: "run_1", flowVersionId: "version_1", lastSequence: 3 }));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 })); render(base()); await tick();
    tree = render(base(), false); expect(storage.has("suede:durable-run:flow_1")).toBe(false); expect(findButton(tree, "Run durable")).not.toBeNull();
  });

  it("aborts the stale monitor generation when immutable identity changes", () => {
    storage.set("suede:durable-run:flow_1", JSON.stringify({ runId: "run_1", flowVersionId: "version_1", lastSequence: 0 }));
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => undefined));
    render(base());
    const firstSignal = (fetch.mock.calls[0]?.[1] as RequestInit).signal as AbortSignal;
    render({ ...base(), immutableVersion: { id: "version_2", versionNumber: 2 } });
    expect(firstSignal.aborted).toBe(true);
  });
});

function base(): DurableRunMonitorProps { return { flowId: "flow_1", immutableVersion: { id: "version_1", versionNumber: 1 }, triggerInputText: "{}" }; }
function enqueue(runId: string) { return { runId, state: "queued", statusUrl: `/api/v3/runs/${runId}`, eventsUrl: `/api/v3/runs/${runId}/events` }; }
function jsonResponse(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
function sseResponse(value: unknown) { return new Response(`id: 1\nevent: durable-execution-event\ndata: ${JSON.stringify(value)}\n\n`, { headers: { "content-type": "text/event-stream" } }); }
function event(sequence: number) { return { schemaVersion: 1, executionId: "run_1", sequence, attempt: 0, type: "execution.created", at: 1, payload: { definitionHash: "a".repeat(64) } }; }
function view(state: "running" | "failed", desiredState: "running" | "paused", sequence: number) {
  return { executionId: "run_1", flowId: "flow_1", flowVersionId: "version_1", parentExecutionId: null, createdAt: 1, updatedAt: 2, finishedAt: state === "failed" ? 2 : null, deadlineAt: 99,
    projection: { schemaVersion: 1 as const, executionId: "run_1", sequence, state, desiredState, attempt: 1, jobId: "job_1", attemptId: null, costMicroUsdc: 0, tokens: 0, output: null, error: state === "failed" ? "failed" : null, nodes: {}, logs: [], logCount: 0, controlRequests: [], controlRequestCount: 0, retry: null, deadLetter: null } };
}
