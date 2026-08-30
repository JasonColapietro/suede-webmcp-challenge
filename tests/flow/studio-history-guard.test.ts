import { describe, expect, it, vi } from "vitest";
import {
  StudioHistoryGuard,
  type StudioBackDecision,
  type StudioBeforeUnloadEvent,
  type StudioHistoryMarker,
  type StudioHistoryPort,
} from "@/lib/flow/studio-history-guard";

interface Entry {
  readonly label: string;
  marker: StudioHistoryMarker | null;
}

class FakeHistory implements StudioHistoryPort {
  entries: Entry[] = [{ label: "A", marker: null }, { label: "B", marker: null }];
  index = 1;
  pushCalls = 0;
  replaceCalls = 0;
  backCalls = 0;
  forwardCalls = 0;

  currentMarker(): StudioHistoryMarker | null {
    return this.entries[this.index]?.marker ?? null;
  }

  pushMarker(marker: StudioHistoryMarker): void {
    this.entries = this.entries.slice(0, this.index + 1);
    this.entries.push({ label: this.entries[this.index]?.label ?? "B", marker });
    this.index += 1;
    this.pushCalls += 1;
  }

  replaceMarker(marker: StudioHistoryMarker | null): void {
    const current = this.entries[this.index];
    if (!current) throw new Error("No current history entry");
    current.marker = marker;
    this.replaceCalls += 1;
  }

  back(): void {
    if (this.index > 0) this.index -= 1;
    this.backCalls += 1;
  }

  forward(): void {
    if (this.index < this.entries.length - 1) this.index += 1;
    this.forwardCalls += 1;
  }

  userBack(): StudioHistoryMarker | null {
    if (this.index > 0) this.index -= 1;
    return this.currentMarker();
  }

  pushExternal(label: string): void {
    this.entries = this.entries.slice(0, this.index + 1);
    this.entries.push({ label, marker: null });
    this.index += 1;
  }

  labels(): string[] {
    return this.entries.map(({ label }) => label);
  }
}

class AsyncFakeHistory extends FakeHistory {
  readonly traversals: Array<"back" | "forward"> = [];

  override back(): void {
    this.backCalls += 1;
    this.traversals.push("back");
  }

  override forward(): void {
    this.forwardCalls += 1;
    this.traversals.push("forward");
  }

  flushNext(): StudioHistoryMarker | null {
    const traversal = this.traversals.shift();
    if (traversal === undefined) throw new Error("No queued traversal");
    if (traversal === "back" && this.index > 0) this.index -= 1;
    if (traversal === "forward" && this.index < this.entries.length - 1) this.index += 1;
    return this.currentMarker();
  }

  userForward(): StudioHistoryMarker | null {
    if (this.index < this.entries.length - 1) this.index += 1;
    return this.currentMarker();
  }
}

function setup(initialDirty = true, history = new FakeHistory()) {
  let dirty = initialDirty;
  const writes: string[] = [];
  const decisions: StudioBackDecision[] = [];
  const guard = new StudioHistoryGuard({
    history,
    isDirty: () => dirty,
    writeRecovery: (reason) => { writes.push(reason); },
    createNonce: () => "session_nonce_1",
    onBackRequest: (decision) => { decisions.push(decision); },
  });
  return { guard, history, writes, decisions, setDirty(value: boolean) { dirty = value; } };
}

function mountPair(value: ReturnType<typeof setup>): void {
  value.guard.mount();
  expect(value.history.entries.map(({ marker }) => marker?.kind ?? null)).toEqual([
    null, "base", "sentinel",
  ]);
  expect(value.history.index).toBe(2);
}

describe("StudioHistoryGuard base/sentinel model", () => {
  it("marks B as base, pushes one sentinel, and Strict Mode adopts without stacking", () => {
    const value = setup();
    mountPair(value);
    value.guard.sync();
    expect(value.history.pushCalls).toBe(1);

    value.guard.dispose();
    const remount = setup(true, value.history);
    remount.guard.mount();
    expect(value.history.entries.map(({ marker }) => marker?.kind ?? null)).toEqual([
      null, "base", "sentinel",
    ]);
    expect(value.history.pushCalls).toBe(1);
  });

  it("rejects an unsafe or oversized nonce before touching history", () => {
    const history = new FakeHistory();
    expect(() => new StudioHistoryGuard({
      history,
      isDirty: () => true,
      writeRecovery: () => undefined,
      createNonce: () => "ø".repeat(80),
      onBackRequest: () => undefined,
    })).toThrow(/nonce/i);
    expect(history.entries.map(({ marker }) => marker)).toEqual([null, null]);
  });

  it("writes recovery before preventDefault and returnValue only when dirty", () => {
    const value = setup();
    const order: string[] = [];
    const guard = new StudioHistoryGuard({
      history: value.history,
      isDirty: () => true,
      writeRecovery: () => { order.push("recovery"); },
      createNonce: () => "session_nonce_1",
      onBackRequest: () => undefined,
    });
    const event: StudioBeforeUnloadEvent = {
      preventDefault: () => { order.push("preventDefault"); },
      get returnValue() { return ""; },
      set returnValue(next: string) { order.push(`returnValue:${next}`); },
    };
    expect(guard.handleBeforeUnload(event)).toBe(true);
    expect(order).toEqual(["recovery", "preventDefault", "returnValue:"]);

    const clean = setup(false);
    const cleanEvent = { preventDefault: vi.fn(), returnValue: "unchanged" };
    expect(clean.guard.handleBeforeUnload(cleanEvent)).toBe(false);
    expect(cleanEvent.preventDefault).not.toHaveBeenCalled();
    expect(clean.writes).toEqual([]);
  });

  it("Back to base writes recovery and cancel forwards to the existing sentinel", () => {
    const value = setup();
    mountPair(value);
    value.guard.handlePopState(value.history.userBack());
    expect(value.history.index).toBe(1);
    expect(value.writes).toEqual(["back"]);
    expect(value.decisions).toHaveLength(1);

    value.decisions[0]!.cancel();
    value.decisions[0]!.cancel();
    expect(value.history.index).toBe(2);
    expect(value.history.forwardCalls).toBe(1);
    value.guard.handlePopState(value.history.currentMarker());
    expect(value.history.entries).toHaveLength(3);

    value.guard.handlePopState(value.history.userBack());
    expect(value.decisions).toHaveLength(2);
  });

  it("confirm strips base and traverses B to A exactly once", () => {
    const value = setup();
    mountPair(value);
    value.guard.handlePopState(value.history.userBack());
    const decision = value.decisions[0]!;
    decision.confirm();
    decision.confirm();
    decision.cancel();

    expect(value.history.index).toBe(0);
    expect(value.history.backCalls).toBe(1);
    expect(value.history.entries[1]?.marker).toBeNull();
    value.guard.handlePopState(value.history.currentMarker());
    expect(value.decisions).toHaveLength(1);
  });

  it("forces repeated Back races forward to matching base until the decision settles", () => {
    const value = setup();
    mountPair(value);
    value.guard.handlePopState(value.history.userBack());
    const decision = value.decisions[0]!;

    value.guard.handlePopState(value.history.userBack());
    expect(value.history.index).toBe(1);
    expect(value.history.forwardCalls).toBe(1);
    value.guard.handlePopState(value.history.currentMarker());
    value.guard.handlePopState(value.history.userBack());
    expect(value.history.index).toBe(1);
    expect(value.history.forwardCalls).toBe(2);
    value.guard.handlePopState(value.history.currentMarker());
    expect(value.decisions).toHaveLength(1);

    decision.cancel();
    expect(value.history.index).toBe(2);
    value.guard.handlePopState(value.history.currentMarker());
    expect(value.history.entries).toHaveLength(3);
  });

  it.each(["cancel", "confirm"] as const)(
    "records %s while a forced return is in flight without queuing a duplicate forward",
    (choice) => {
      const history = new AsyncFakeHistory();
      const value = setup(true, history);
      mountPair(value);
      value.guard.handlePopState(history.userBack());
      const decision = value.decisions[0]!;

      value.guard.handlePopState(history.userBack());
      expect(history.traversals).toEqual(["forward"]);
      decision[choice]();
      expect(history.traversals).toEqual(["forward"]);

      value.guard.handlePopState(history.flushNext());
      if (choice === "cancel") {
        expect(history.traversals).toEqual(["forward"]);
        value.guard.handlePopState(history.flushNext());
        expect(history.index).toBe(2);
      } else {
        expect(history.traversals).toEqual(["back"]);
        value.guard.handlePopState(history.flushNext());
        expect(history.index).toBe(0);
      }
      expect(history.traversals).toEqual([]);
    },
  );

  it("treats a user Forward to sentinel as a completed cancel without overshoot", () => {
    const history = new AsyncFakeHistory();
    const value = setup(true, history);
    mountPair(value);
    value.guard.handlePopState(history.userBack());
    const firstDecision = value.decisions[0]!;

    value.guard.handlePopState(history.userForward());
    firstDecision.cancel();
    firstDecision.confirm();
    expect(history.traversals).toEqual([]);
    expect(history.index).toBe(2);

    value.guard.handlePopState(history.userBack());
    expect(value.decisions).toHaveLength(2);
  });

  it("clean Back passes from sentinel through base to A without a decision", () => {
    const value = setup();
    mountPair(value);
    value.setDirty(false);
    value.guard.sync();
    expect(value.history.entries[2]?.marker).toBeNull();
    value.guard.handlePopState(value.history.userBack());
    expect(value.history.index).toBe(0);
    expect(value.history.entries[1]?.marker).toBeNull();
    expect(value.decisions).toEqual([]);
    expect(value.writes).toEqual([]);
    value.history.forward();
    expect(value.history.currentMarker()).toBeNull();
    value.history.forward();
    expect(value.history.currentMarker()).toBeNull();
  });

  it("re-arms a stripped clean sentinel without stacking a duplicate entry", () => {
    const value = setup();
    mountPair(value);
    value.setDirty(false);
    value.guard.sync();
    expect(value.history.entries.map(({ marker }) => marker?.kind ?? null)).toEqual([null, "base", null]);
    value.setDirty(true);
    value.guard.sync();
    expect(value.history.entries.map(({ marker }) => marker?.kind ?? null)).toEqual([null, "base", "sentinel"]);
    expect(value.history.entries).toHaveLength(3);
    expect(value.history.pushCalls).toBe(1);
  });

  it("keeps dirty-to-clean Back and Forward inert and rearms without stacking a sentinel", () => {
    const value = setup();
    mountPair(value);
    value.setDirty(false);
    value.guard.sync();
    value.guard.handlePopState(value.history.userBack());
    expect(value.history.index).toBe(0);

    value.history.forward();
    value.guard.handlePopState(value.history.currentMarker());
    expect(value.history.index).toBe(1);
    expect(value.decisions).toEqual([]);
    expect(value.writes).toEqual([]);

    const remount = setup(true, value.history);
    remount.guard.mount();
    expect(value.history.entries.map(({ marker }) => marker?.kind ?? null)).toEqual([
      null, "base", "sentinel",
    ]);
    expect(value.history.entries).toHaveLength(3);
    expect(value.history.pushCalls).toBe(2);
    remount.guard.sync();
    expect(value.history.entries).toHaveLength(3);
    expect(value.history.pushCalls).toBe(2);
  });

  it("physically unwinds S to base before one internal push truncates the sentinel", () => {
    const value = setup();
    mountPair(value);
    const navigate = vi.fn(() => { value.history.pushExternal("C"); });
    expect(value.guard.beginInternalNavigation(navigate)).toBe("started");
    expect(value.guard.beginInternalNavigation(navigate)).toBe("blocked");
    expect(value.history.index).toBe(1);
    expect(navigate).not.toHaveBeenCalled();

    value.guard.handlePopState(value.history.currentMarker());
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(value.history.labels()).toEqual(["A", "B", "C"]);
    expect(value.history.entries[1]?.marker).toBeNull();
    expect(value.history.index).toBe(2);
    value.guard.handlePopState(value.history.currentMarker());
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("a stale internal callback cannot fire after dispose and remount rearms base/sentinel once", () => {
    const value = setup();
    mountPair(value);
    const navigate = vi.fn();
    expect(value.guard.beginInternalNavigation(navigate)).toBe("started");
    value.guard.dispose();
    value.guard.handlePopState(value.history.currentMarker());
    expect(navigate).not.toHaveBeenCalled();

    const remount = setup(true, value.history);
    remount.guard.mount();
    expect(value.history.entries.map(({ marker }) => marker?.kind ?? null)).toEqual([
      null, "base", "sentinel",
    ]);
    expect(value.history.entries).toHaveLength(3);
  });

  it("completes internal navigation immediately when active and safely unarmed", () => {
    const value = setup(false);
    value.guard.mount();
    const navigate = vi.fn();
    expect(value.guard.beginInternalNavigation(navigate)).toBe("completed");
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(value.history.backCalls).toBe(0);
  });

  it("blocks internal navigation while a Back decision is pending or after dispose", () => {
    const pending = setup();
    mountPair(pending);
    pending.guard.handlePopState(pending.history.userBack());
    const navigate = vi.fn();
    expect(pending.guard.beginInternalNavigation(navigate)).toBe("blocked");
    expect(navigate).not.toHaveBeenCalled();

    const inactive = setup(false);
    inactive.guard.mount();
    inactive.guard.dispose();
    expect(inactive.guard.beginInternalNavigation(navigate)).toBe("blocked");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("pagehide snapshots and bfcache pageshow rearms without stacking", () => {
    const value = setup();
    mountPair(value);
    value.guard.handlePageHide();
    expect(value.writes).toEqual(["pagehide"]);

    value.guard.handlePageShow({ persisted: true });
    value.guard.handlePageShow({ persisted: true });
    expect(value.history.entries).toHaveLength(3);
    expect(value.history.pushCalls).toBe(1);
  });
});
