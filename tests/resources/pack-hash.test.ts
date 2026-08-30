import { describe, expect, it } from "vitest";
import { canonicalizeResourcePack, resourcePackSemanticHash } from "@/lib/resources/pack-hash";

const base = () => ({
  recordSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
  filterFields: ["name"], returnFields: ["name"],
  taxonomy: [{ id: "tag", label: "Tag" }],
  records: [{ id: "record_1", fields: { name: "Alpha" }, tags: ["tag"], evidenceIds: ["evidence_1"] }],
  evidence: [{ id: "evidence_1", sourceSnapshotId: "snapshot_1", locator: "row:1", observedAt: "2026-08-13T12:00:00.000Z" }],
  sourceSnapshotIds: ["snapshot_1"],
  jobContract: {
    jobStatement: "Return a named record.", buyerIntent: "Find a record.",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    outputSchema: { type: "array", items: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false } },
    unsupportedRequest: "No result.", evidenceRequirement: "Evidence required.", safeExample: [{ name: "Alpha" }],
    reviewBoundary: "Reviewed.", dataHandlingDisclosure: "No private corpus.",
  },
});

describe("canonical Resource Pack hashes", () => {
  it("is independent of object and collection order", () => {
    const left = base();
    const right = { ...base(), recordSchema: { additionalProperties: false, required: ["name"], properties: { name: { type: "string" } }, type: "object" }, records: [...base().records].reverse() };
    expect(resourcePackSemanticHash(left).semanticHash).toBe(resourcePackSemanticHash(right).semanticHash);
    expect(canonicalizeResourcePack(left).canonicalBytes).toEqual(canonicalizeResourcePack(right).canonicalBytes);
  });

  it.each([
    ["record", (value: ReturnType<typeof base>) => ({ ...value, records: [{ ...value.records[0], fields: { name: "Beta" } }] })],
    ["evidence", (value: ReturnType<typeof base>) => ({ ...value, evidence: [{ ...value.evidence[0], locator: "row:2" }] })],
    ["schema", (value: ReturnType<typeof base>) => ({ ...value, recordSchema: { type: "object", properties: { name: { type: "string" }, rank: { type: "integer" } }, required: ["name"], additionalProperties: false } })],
    ["contract", (value: ReturnType<typeof base>) => ({ ...value, jobContract: { ...value.jobContract, buyerIntent: "Find an exact record." } })],
  ])("changes when the %s changes", (_label, change) => {
    const original = base();
    expect(resourcePackSemanticHash(original).semanticHash).not.toBe(resourcePackSemanticHash(change(original)).semanticHash);
  });

  it("fails closed on duplicate canonical identities and hostile keys", () => {
    const value = base();
    expect(() => resourcePackSemanticHash({ ...value, records: [value.records[0], { ...value.records[0] }] })).toThrow("Invalid resource pack.");
    expect(() => resourcePackSemanticHash({ ...value, sourceSnapshotIds: ["snapshot_1", "snapshot_1"] })).toThrow("Invalid resource pack.");
    expect(() => resourcePackSemanticHash({ ...value, extra: "CANARY" })).toThrow("Invalid resource pack.");
  });

  it("orders normalized Unicode identities by locale-independent code units", () => {
    const value = base();
    value.records = [
      { id: "\uFFFD", fields: { name: "replacement" }, tags: [], evidenceIds: [] },
      { id: "\u{1F600}", fields: { name: "emoji" }, tags: [], evidenceIds: [] },
    ];
    const canonical = JSON.parse(canonicalizeResourcePack(value).canonicalBytes.toString("utf8")) as { records: Array<{ id: string }> };
    expect(canonical.records.map((record) => record.id)).toEqual(["\u{1F600}", "\uFFFD"]);
  });

  it("rejects distinct record identities that collapse under NFC normalization", () => {
    const value = base();
    value.records = [
      { id: "é", fields: { name: "first" }, tags: [], evidenceIds: [] },
      { id: "e\u0301", fields: { name: "second" }, tags: [], evidenceIds: [] },
    ];
    expect(() => resourcePackSemanticHash(value)).toThrow("Invalid resource pack.");
  });
});
