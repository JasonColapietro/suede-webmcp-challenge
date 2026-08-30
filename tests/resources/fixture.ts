export const RESOURCE_TEST_NOW = new Date("2026-08-13T12:00:00.000Z");

export function resourcePack(name = "Alpha") {
  return {
    recordSchema: {
      type: "object",
      properties: { name: { type: "string" }, tier: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    filterFields: ["tier"],
    returnFields: ["name", "tier"],
    taxonomy: [{ id: "pricing", label: "Pricing" }],
    records: [{ id: "record-1", fields: { name, tier: "paid" }, tags: ["pricing"], evidenceIds: ["evidence-1"] }],
    evidence: [{ id: "evidence-1", sourceSnapshotId: "snapshot-contract", locator: "row:1", observedAt: RESOURCE_TEST_NOW.toISOString() }],
    sourceSnapshotIds: ["snapshot-contract"],
    jobContract: {
      jobStatement: "Return an exact pricing record.",
      buyerIntent: "Compare one named pricing record.",
      inputSchema: { type: "object", properties: { tier: { type: "string" } }, required: [], additionalProperties: false },
      outputSchema: { type: "array", items: { type: "object", properties: { name: { type: "string" }, tier: { type: "string" } }, required: ["name"], additionalProperties: false } },
      unsupportedRequest: "Return no records.",
      evidenceRequirement: "Return bounded evidence pointers.",
      safeExample: [{ name: "Example", tier: "paid" }],
      reviewBoundary: "Owner-reviewed records only.",
      dataHandlingDisclosure: "Private source bodies are not returned.",
    },
  } as const;
}
