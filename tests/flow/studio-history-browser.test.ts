import { describe, expect, it, vi } from "vitest";
import {
  createStudioHistoryBrowserPort,
  getOrCreateStudioRecoverySessionNonce,
  studioHistoryMarkerFromState,
} from "@/lib/flow/studio-history-browser";

describe("studio history browser adapter", () => {
  it("preserves unrelated history state while replacing and pushing bounded markers", () => {
    let state: unknown = { next: "preserve" };
    const history = {
      get state() { return state; },
      pushState: vi.fn((next: unknown) => { state = next; }),
      replaceState: vi.fn((next: unknown) => { state = next; }),
      back: vi.fn(), forward: vi.fn(),
    };
    const port = createStudioHistoryBrowserPort(history);
    const base = { v: 1 as const, kind: "base" as const, nonce: "nonce_1234567890" };
    port.replaceMarker(base);
    expect(state).toMatchObject({ next: "preserve" });
    expect(port.currentMarker()).toEqual(base);
    port.pushMarker({ ...base, kind: "sentinel" });
    expect(history.pushState).toHaveBeenCalled();
    port.replaceMarker(null);
    expect(port.currentMarker()).toBeNull();
    expect(state).toEqual({ next: "preserve" });
  });

  it("parses the traversed event-state snapshot instead of mutable live history state", () => {
    let state: unknown = { next: "preserve" };
    const history = {
      get state() { return state; },
      pushState: vi.fn((next: unknown) => { state = next; }),
      replaceState: vi.fn((next: unknown) => { state = next; }),
      back: vi.fn(), forward: vi.fn(),
    };
    const port = createStudioHistoryBrowserPort(history);
    const traversed = { v: 1 as const, kind: "base" as const, nonce: "nonce_1234567890" };
    port.replaceMarker(traversed);
    const eventState = structuredClone(state);

    port.replaceMarker({ ...traversed, kind: "sentinel" });

    expect(port.currentMarker()).toEqual({ ...traversed, kind: "sentinel" });
    expect(studioHistoryMarkerFromState(eventState)).toEqual(traversed);
    expect(eventState).toMatchObject({ next: "preserve" });
  });

  it("rejects malformed event-state markers without disturbing unrelated state", () => {
    expect(studioHistoryMarkerFromState({
      next: "preserve",
      __suedeStudioHistoryGuardV1: { v: 1, kind: "base", nonce: "short" },
    })).toBeNull();
    expect(studioHistoryMarkerFromState(null)).toBeNull();
  });

  it("persists one strict tab nonce across reload and survives unavailable storage", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const first = getOrCreateStudioRecoverySessionNonce(storage, () => "nonce_abcdefghijklmnop");
    const second = getOrCreateStudioRecoverySessionNonce(storage, () => "different_nonce_value");
    expect(second).toBe(first);
    const unavailable = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(getOrCreateStudioRecoverySessionNonce(unavailable, () => "fallback_abcdefghijkl")).toBe("fallback_abcdefghijkl");
  });
});
