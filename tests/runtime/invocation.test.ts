import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDurableInvocation, parseDurableInvocationJson } from "@/lib/runtime/invocation";
import { invocationFor } from "./task3-fixture";

describe("durable invocation snapshot", () => {
  it("round-trips immutable canonical bytes and verifies its hash", () => {
    const snapshot = invocationFor({ id: "root", nodes: [], edges: [] });
    const parsed = parseDurableInvocationJson(snapshot.json, snapshot.hash);
    expect(parsed.rootKey).toBe(JSON.stringify(["root", "root"]));
    expect(parsed.graphs).toHaveLength(1);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.graphs[0]!.graph)).toBe(true);
    expect(() => parseDurableInvocationJson(snapshot.json, "f".repeat(64))).toThrow(/invalid durable invocation/i);
  });

  it("rejects noncanonical and duplicate-key JSON even with a matching outer hash", () => {
    const snapshot = invocationFor({ id: "root", nodes: [], edges: [] });
    const duplicate = snapshot.json.replace("{", '{"schemaVersion":1,');
    const hash = createHash("sha256").update(duplicate).digest("hex");
    expect(() => parseDurableInvocationJson(duplicate, hash)).toThrow(/invalid durable invocation/i);
    const spaced = snapshot.json.replace(":1,", ": 1,");
    expect(() => parseDurableInvocationJson(spaced, createHash("sha256").update(spaced).digest("hex"))).toThrow();
  });

  it("rejects unsafe input data, duplicate graph keys, and independent input bounds", () => {
    const base = invocationFor({ id: "root", nodes: [], edges: [] }).invocation;
    const identity = { execution: base.execution, policyFingerprint: base.policyFingerprint };
    const root = base.graphs[0]!;
    expect(() => createDurableInvocation({
      executionPackage: { schemaVersion: 1, rootKey: base.rootKey, graphs: [
        { ...root, canonicalJson: JSON.stringify(root.graph), byteLength: Buffer.byteLength(JSON.stringify(root.graph)) },
        { ...root, canonicalJson: JSON.stringify(root.graph), byteLength: Buffer.byteLength(JSON.stringify(root.graph)) },
      ] }, ...identity,
    })).toThrow();
    const unsafe = Object.create(null) as Record<string, unknown>; unsafe.x = 1;
    expect(() => createDurableInvocation({ executionPackage: {
      schemaVersion: 1, rootKey: base.rootKey, graphs: [{ ...root, canonicalJson: JSON.stringify(root.graph), byteLength: Buffer.byteLength(JSON.stringify(root.graph)) }],
    }, ...identity, triggerInput: unsafe })).toThrow();
    expect(() => createDurableInvocation({ executionPackage: {
      schemaVersion: 1, rootKey: base.rootKey, graphs: [{ ...root, canonicalJson: JSON.stringify(root.graph), byteLength: Buffer.byteLength(JSON.stringify(root.graph)) }],
    }, ...identity, runVariables: { huge: "x".repeat(256 * 1024) } })).toThrow();
  });

  it("rejects malformed identities, identity-key drift, duplicate roots, and unsorted graphs", () => {
    const snapshot = invocationFor({ id: "root", name: "root", nodes: [], edges: [] });
    const reject = (mutate: (value: any) => void): void => {
      const value = JSON.parse(snapshot.json); mutate(value);
      const json = JSON.stringify(value); const hash = createHash("sha256").update(json).digest("hex");
      expect(() => parseDurableInvocationJson(json, hash)).toThrow(/invalid durable invocation/i);
    };
    reject((value) => { value.graphs[0].identity.graphId = 7; });
    reject((value) => { value.graphs[0].key = JSON.stringify(["root", "other"]); });
    reject((value) => { value.graphs.push(structuredClone(value.graphs[0])); });
    reject((value) => {
      const child = structuredClone(value.graphs[0]);
      child.key = JSON.stringify(["legacy", "z"]); child.identity = { flowId: "z", kind: "legacy" };
      value.graphs.push(child);
    });
  });
});
