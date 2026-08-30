import { describe, expect, it, vi } from "vitest";
import type { FlowGraph, FlowGraphV2 } from "@/lib/flow/types";

const v1 = (): FlowGraph => ({ id: "v1", name: "Draft", nodes: [], edges: [] });
const v2 = (): FlowGraphV2 => ({
  schemaVersion: 2, id: "v2", name: "Draft", nodes: [], edges: [], variables: [], groups: [], annotations: [],
});

describe("Studio recovery envelope", () => {
  it("exports a strict bounded recovery boundary", async () => {
    const module = await import("@/lib/flow/studio-recovery").catch(() => null);
    expect(module).not.toBeNull();
    if (!module) return;
    expect(module.STUDIO_RECOVERY_MAX_BYTES).toBe(1024 * 1024);
    expect(module.STUDIO_RECOVERY_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it.each([v1(), v2()])("round-trips an exact detached graph envelope", async (graph) => {
    const m = await import("@/lib/flow/studio-recovery");
    const ownerScopeHash = m.studioRecoveryOwnerScope("owner-secret");
    const routeScope = m.studioRecoveryPersistedRouteScope("row-secret");
    const encoded = m.encodeStudioRecovery({
      ownerScopeHash, routeScope, sessionNonce: "n".repeat(32), graph,
      baseSavedFingerprint: m.flowRecoveryFingerprint(graph), now: 1_000,
      flags: { impact: false, reference: false, paste: false, inflight: false, scheduled: true, retryable: false },
    });
    expect(encoded.status).toBe("ready");
    if (encoded.status !== "ready") return;
    expect(encoded.text).not.toContain("owner-secret");
    expect(encoded.text).not.toContain("row-secret");
    const parsed = m.parseStudioRecovery(encoded.text, { ownerScopeHash, routeScope, sessionNonce: "n".repeat(32), now: 1_001 });
    expect(parsed.status).toBe("ready");
    if (parsed.status !== "ready") return;
    expect(parsed.envelope.graph).toEqual(graph);
    expect(parsed.envelope.graph).not.toBe(graph);
    expect(parsed.envelope.graphFingerprint).toBe(m.flowRecoveryFingerprint(graph));
    expect(parsed.envelope.expiresAt).toBe(1_000 + m.STUDIO_RECOVERY_TTL_MS);
  });

  it("rejects malformed, extra-keyed, mismatched, expired, and oversized input", async () => {
    const m = await import("@/lib/flow/studio-recovery");
    const owner = m.studioRecoveryOwnerScope("owner");
    const route = m.studioRecoveryNewRouteScope("nonce-value");
    const ready = m.encodeStudioRecovery({ ownerScopeHash: owner, routeScope: route, sessionNonce: "s".repeat(32), graph: v1(), baseSavedFingerprint: null, now: 100, flags: m.emptyStudioRecoveryFlags() });
    expect(ready.status).toBe("ready");
    if (ready.status !== "ready") return;
    const context = { ownerScopeHash: owner, routeScope: route, sessionNonce: "s".repeat(32), now: 101 };
    expect(m.parseStudioRecovery("{", context).status).toBe("invalid");
    const extra = JSON.stringify({ ...JSON.parse(ready.text), extra: true });
    expect(m.parseStudioRecovery(extra, context).status).toBe("invalid");
    expect(m.parseStudioRecovery(ready.text, { ...context, ownerScopeHash: m.studioRecoveryOwnerScope("other") }).status).toBe("mismatch");
    expect(m.parseStudioRecovery(ready.text, { ...context, sessionNonce: "x".repeat(32) }).status).toBe("mismatch");
    expect(m.parseStudioRecovery(ready.text, { ...context, now: 100 + m.STUDIO_RECOVERY_TTL_MS }).status).toBe("expired");
    expect(m.parseStudioRecovery("x".repeat(m.STUDIO_RECOVERY_MAX_BYTES + 1), context).status).toBe("too-large");
    expect(m.encodeStudioRecovery({ ownerScopeHash: owner, routeScope: route, sessionNonce: "ø".repeat(32), graph: v1(), baseSavedFingerprint: null, now: 1, flags: m.emptyStudioRecoveryFlags() }).status).toBe("invalid");
  });

  it("fails closed on raw credential material but permits opaque v2 secret bindings", async () => {
    const m = await import("@/lib/flow/studio-recovery");
    const base = { ownerScopeHash: m.studioRecoveryOwnerScope("owner"), routeScope: m.studioRecoveryNewRouteScope("nonce"), sessionNonce: "s".repeat(32), baseSavedFingerprint: null, now: 1, flags: m.emptyStudioRecoveryFlags() };
    const raw = { ...v1(), nodes: [{ id: "n", type: "http" as const, params: { apiKey: "sk-secret-value" }, position: { x: 0, y: 0 } }] };
    expect(m.encodeStudioRecovery({ ...base, graph: raw }).status).toBe("unsafe");
    const bearer = { ...v1(), nodes: [{ id: "n", type: "http" as const, params: { header: "Bearer abcdef" }, position: { x: 0, y: 0 } }] };
    expect(m.encodeStudioRecovery({ ...base, graph: bearer }).status).toBe("unsafe");
    const opaque = { ...v2(), nodes: [{ id: "n", type: "http" as const, params: {}, position: { x: 0, y: 0 }, bindings: { auth: { kind: "secret" as const, connectionId: "conn-1", field: "token" } } }] };
    expect(m.encodeStudioRecovery({ ...base, graph: opaque }).status).toBe("ready");
    const malformed = { ...opaque, nodes: [{ ...opaque.nodes[0]!, bindings: { auth: { kind: "secret", value: "raw" } } }] } as unknown as FlowGraphV2;
    expect(m.encodeStudioRecovery({ ...base, graph: malformed }).status).toBe("unsafe");
    for (const [key, value] of [
      ["Authorization", "Basic dXNlcjpwYXNz"], ["auth", "Digest abcdef"], ["Cookie", "sid=abcdef"],
      ["passwd", "hunter2"], ["passphrase", "open sesame"], ["accessKey", "AKIAIOSFODNN7EXAMPLE"],
      ["clientSecret", "client-value"], ["sessionCredential", "session-value"],
      ["header", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature"], ["header", "ghp_abcdefghijklmnopqrstuvwxyz123456"],
    ]) {
      const candidate = { ...v1(), nodes: [{ id: "n", type: "http" as const, params: { [key]: value }, position: { x: 0, y: 0 } }] };
      expect(m.encodeStudioRecovery({ ...base, graph: candidate }).status, key).toBe("unsafe");
    }
  });

  it("uses opaque keys and converts storage quota/security failures into safe statuses", async () => {
    const m = await import("@/lib/flow/studio-recovery");
    const owner = m.studioRecoveryOwnerScope("raw-owner");
    const route = m.studioRecoveryPersistedRouteScope("raw-row");
    const key = m.studioRecoveryStorageKey(owner, route, "nonce_abcdefghijkl");
    expect(key).not.toContain("raw-owner");
    expect(key).not.toContain("raw-row");
    const storage = { getItem: vi.fn(() => null), setItem: vi.fn(() => { throw new DOMException("quota", "QuotaExceededError"); }), removeItem: vi.fn(() => { throw new DOMException("security", "SecurityError"); }) };
    expect(m.writeStudioRecovery(storage, key, "{}" ).status).toBe("unavailable");
    expect(m.removeStudioRecovery(storage, key).status).toBe("unavailable");
    expect(m.readStudioRecovery({ ...storage, getItem: vi.fn(() => { throw new Error("blocked"); }) }, key).status).toBe("unavailable");
  });

  it("chooses clear, restore, or conflict only from exact authoritative fingerprints", async () => {
    const m = await import("@/lib/flow/studio-recovery");
    const envelope = {
      graphFingerprint: "b".repeat(64),
      baseSavedFingerprint: "a".repeat(64),
    };
    expect(m.recoveryDisposition(envelope, "b".repeat(64))).toBe("clear");
    expect(m.recoveryDisposition(envelope, "a".repeat(64))).toBe("restore");
    expect(m.recoveryDisposition(envelope, "c".repeat(64))).toBe("conflict");
    expect(m.recoveryDisposition({ ...envelope, baseSavedFingerprint: null }, null)).toBe("restore");
  });

  it("isolates persisted recovery slots by tab nonce", async () => {
    const m = await import("@/lib/flow/studio-recovery");
    const owner = m.studioRecoveryOwnerScope("owner");
    const route = m.studioRecoveryPersistedRouteScope("row");
    expect(m.studioRecoveryStorageKey(owner, route, "nonce_abcdefghijkl"))
      .not.toBe(m.studioRecoveryStorageKey(owner, route, "nonce_abcdefghijkm"));
  });

  it("copies a recovery slot before deleting its old key and retains the old copy on failure", async () => {
    const m = await import("@/lib/flow/studio-recovery");
    const values = new Map([["old", "draft"]]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
    expect(m.rekeyStudioRecovery(storage, "old", "new", "draft").status).toBe("migrated");
    expect(values.get("new")).toBe("draft");
    expect(values.has("old")).toBe(false);

    values.set("old", "only-copy");
    const unavailable = { ...storage, setItem: () => { throw new Error("quota"); } };
    expect(m.rekeyStudioRecovery(unavailable, "old", "newer", "only-copy").status).toBe("unavailable");
    expect(values.get("old")).toBe("only-copy");
  });
});
