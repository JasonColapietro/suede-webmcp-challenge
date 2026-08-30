import { describe, expect, it } from "vitest";
import { executeResourceQuery, RESOURCE_QUERY_ERROR } from "@/lib/resources/query";
import { resourcePackSemanticHash } from "@/lib/resources/pack-hash";

const pack = {
  resourceProductId: "resource_1", packVersionId: "pack_1", semanticHash: "a".repeat(64), freshness: "mixed" as const,
  content: {
    recordSchema: { type: "object", properties: { name: { type: "string" }, tier: { type: "string" }, secret: { type: "string" } }, required: ["name"], additionalProperties: false },
    filterFields: ["tier"], returnFields: ["name", "tier"],
    taxonomy: [], sourceSnapshotIds: ["snapshot_1"],
    records: [
      { id: "r2", fields: { name: "Beta", tier: "paid", secret: "CANARY" }, tags: [], evidenceIds: ["e2"], unknowns: ["region"], conflicts: ["tier"] },
      { id: "r1", fields: { name: "Alpha", tier: "free", secret: "CANARY" }, tags: [], evidenceIds: ["e1"] },
    ],
    evidence: [
      { id: "e1", sourceSnapshotId: "snapshot_1", locator: "row:1", observedAt: "2026-08-13T12:00:00.000Z" },
      { id: "e2", sourceSnapshotId: "snapshot_1", locator: "row:2", observedAt: "2026-08-13T12:00:00.000Z" },
    ],
    jobContract: { jobStatement: "Find records.", buyerIntent: "Find records.", inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false }, outputSchema: { type: "array", items: { type: "object", properties: { name: { type: "string" }, tier: { type: "string" } }, required: ["name"], additionalProperties: false } }, unsupportedRequest: "No result.", evidenceRequirement: "Evidence.", safeExample: [{ name: "Alpha", tier: "free" }], reviewBoundary: "Reviewed.", dataHandlingDisclosure: "No corpus." },
  },
};
pack.semanticHash = resourcePackSemanticHash(pack.content).semanticHash;

describe("deterministic Resource Pack query", () => {
  it("matches declared exact filter fields, orders deterministically, and projects only allowlisted fields", async () => {
    const result = await executeResourceQuery({ getExactPack: async () => pack }, {
      resourceProductId: "resource_1", packVersionId: "pack_1", semanticHash: pack.semanticHash,
      filters: { tier: "paid" }, filterFields: ["tier"], returnFields: ["name", "tier"], limit: 10,
    });
    expect(result.result).toEqual([{ name: "Beta", tier: "paid" }]);
    expect(JSON.stringify(result)).not.toContain("CANARY");
    expect(result.resourceReceipt).toMatchObject({ freshness: "mixed", unknowns: ["region"], conflicts: ["tier"], outputSchemaValid: true });
  });

  it("reports missing return fields as unknowns and refuses undeclared fields, hash drift, and wrong versions", async () => {
    const reader = { getExactPack: async () => pack };
    const common = { resourceProductId: "resource_1", packVersionId: "pack_1", semanticHash: pack.semanticHash, filters: {}, filterFields: [], returnFields: ["name", "tier"], limit: 10 };
    const output = await executeResourceQuery(reader, common);
    expect(output.result.map((row) => row.name)).toEqual(["Alpha", "Beta"]);
    await expect(executeResourceQuery(reader, { ...common, returnFields: ["secret"] })).rejects.toThrow("Resource query refused.");
    await expect(executeResourceQuery(reader, { ...common, semanticHash: "b".repeat(64) })).rejects.toThrow("Resource query refused.");
    await expect(executeResourceQuery(reader, { ...common, packVersionId: "pack_other" })).rejects.toThrow("Resource query refused.");
  });

  it("refuses a reader result whose content no longer matches its pinned semantic hash", async () => {
    const tampered = {
      ...pack,
      content: { ...pack.content, records: [{ ...pack.content.records[0], fields: { ...pack.content.records[0].fields, name: "Tampered" } }] },
    };
    await expect(executeResourceQuery({ getExactPack: async () => tampered }, {
      resourceProductId: "resource_1", packVersionId: "pack_1", semanticHash: pack.semanticHash,
      filters: {}, filterFields: [], returnFields: ["name"], limit: 1,
    })).rejects.toThrow("Resource query refused.");
  });

  it("normalizes hostile query inputs and reader failures before any lookup", async () => {
    let calls = 0;
    const reader = { getExactPack: async () => { calls += 1; throw new Error("CANARY reader failure"); } };
    const common = { resourceProductId: "resource_1", packVersionId: "pack_1", semanticHash: pack.semanticHash, filters: {}, filterFields: [], returnFields: ["name"], limit: 1 };
    for (const value of [
      { ...common, filters: null },
      { ...common, filterFields: null },
      { ...common, returnFields: ["name", 1] },
      { ...common, resourceProductId: "x".repeat(129) },
      { ...common, semanticHash: "a".repeat(65) },
    ]) {
      await expect(executeResourceQuery(reader, value as never)).rejects.toThrow(RESOURCE_QUERY_ERROR);
    }
    expect(calls).toBe(0);
    await expect(executeResourceQuery(reader, common)).rejects.toThrow(RESOURCE_QUERY_ERROR);
    await expect(executeResourceQuery(reader, common)).rejects.not.toThrow("CANARY");
  });

  it("refuses an invalid reader bundle freshness without leaking its contents", async () => {
    const invalidFreshness = { ...pack, freshness: "expired" };
    await expect(executeResourceQuery({ getExactPack: async () => invalidFreshness as never }, {
      resourceProductId: "resource_1", packVersionId: "pack_1", semanticHash: pack.semanticHash,
      filters: {}, filterFields: [], returnFields: ["name"], limit: 1,
    })).rejects.toThrow(RESOURCE_QUERY_ERROR);
  });
});
