import { describe, expect, it } from "vitest";
import {
  RESOURCE_LIMITS,
  parseJobContract,
  parseResourcePackContent,
  parseResourceProduct,
  parseSourceSnapshot,
  resourceSchemaAccepts,
} from "@/lib/resources/schemas";

const schema = {
  type: "object",
  properties: { category: { type: "string" }, score: { type: "number" } },
  required: ["category"],
  additionalProperties: false,
};

const contract = {
  jobStatement: "Classify the requested record.",
  buyerIntent: "A buyer needs a deterministic classification.",
  inputSchema: schema,
  outputSchema: { type: "array", items: schema, maxItems: 10 },
  unsupportedRequest: "Return no records and explain unsupported filters.",
  evidenceRequirement: "Return bounded evidence pointers for matching records.",
  safeExample: [{ category: "priority", score: 2 }],
  reviewBoundary: "Owner-reviewed records only.",
  dataHandlingDisclosure: "Private source bodies are never returned.",
};

describe("Resource Foundry schema boundaries", () => {
  it("parses bounded owner product input with exact access enums", () => {
    const product = parseResourceProduct({
      id: "resource_1",
      ownerId: "owner_1",
      name: "Pricing signals",
      slug: "pricing-signals",
      status: "draft",
      executionAccess: "paid",
      discoveryAccess: "public",
    });
    expect(product).toMatchObject({ id: "resource_1", executionAccess: "paid" });
    expect(Object.isFrozen(product)).toBe(true);
    expect(() => parseResourceProduct({ ...product, ownerId: " " })).toThrow("Invalid resource input.");
    expect(() => parseResourceProduct({ ...product, name: "x".repeat(RESOURCE_LIMITS.nameBytes + 1) })).toThrow("Invalid resource input.");
    expect(() => parseResourceProduct({ ...product, executionAccess: "metered" })).toThrow("Invalid resource input.");
  });

  it("accepts optional owner-declared provenance but no rights fields", () => {
    const omitted = parseSourceSnapshot({
      id: "snapshot_1", resourceProductId: "resource_1", locator: "manual://pricing",
      sourceKind: "manual", capturedAt: "2026-08-13T12:00:00.000Z", contentHash: "a".repeat(64),
      freshnessDeadline: "2026-08-20T12:00:00.000Z",
    });
    expect(omitted.provenance).toBeUndefined();
    expect(parseSourceSnapshot({ ...omitted, provenance: "public_source" }).provenance).toBe("public_source");
    for (const key of ["rightsStatus", "verified", "licenseDocument", "rightsPredicate"]) {
      expect(() => parseSourceSnapshot({ ...omitted, [key]: true })).toThrow("Invalid resource input.");
    }
  });

  it("requires strict bounded JSON schemas and Job Contract strings", () => {
    expect(parseJobContract(contract)).toMatchObject({ jobStatement: contract.jobStatement });
    expect(() => parseJobContract({ ...contract, inputSchema: { type: "object", additionalProperties: true } })).toThrow("Invalid resource input.");
    expect(() => parseJobContract({ ...contract, jobStatement: "x".repeat(RESOURCE_LIMITS.jobTextBytes + 1) })).toThrow("Invalid resource input.");
    expect(() => parseJobContract({ ...contract, rawCorpus: "CANARY" })).toThrow("Invalid resource input.");
  });

  it("caps records, fields, taxonomy, evidence locators, freshness timestamps, and hostile prototypes", () => {
    const content = parseResourcePackContent({
      recordSchema: schema,
      filterFields: ["category"],
      returnFields: ["category", "score"],
      taxonomy: [{ id: "priority", label: "Priority" }],
      records: [{ id: "record_1", fields: { category: "priority", score: 2 }, tags: ["priority"], evidenceIds: ["evidence_1"] }],
      evidence: [{ id: "evidence_1", sourceSnapshotId: "snapshot_1", locator: "row:1", observedAt: "2026-08-13T12:00:00.000Z" }],
      sourceSnapshotIds: ["snapshot_1"],
      jobContract: contract,
    });
    expect(content.records).toHaveLength(1);
    expect(() => parseResourcePackContent({ ...content, records: Array.from({ length: RESOURCE_LIMITS.records + 1 }, () => content.records[0]) })).toThrow("Invalid resource input.");
    expect(() => parseResourcePackContent({ ...content, evidence: [{ ...content.evidence[0], locator: "x".repeat(RESOURCE_LIMITS.evidenceLocatorBytes + 1) }] })).toThrow("Invalid resource input.");
    expect(() => parseResourcePackContent({ ...content, evidence: [{ ...content.evidence[0], locator: "https://user:secret@example.com/row?token=CANARY" }] })).toThrow("Invalid resource input.");
    const hostile = Object.create({ inherited: true }) as Record<string, unknown>;
    Object.assign(hostile, content);
    expect(() => parseResourcePackContent(hostile)).toThrow("Invalid resource input.");
  });

  it("enforces enum membership by canonical JSON equality", () => {
    const job = parseJobContract({
      ...contract,
      safeExample: { beta: 2, alpha: "yes" },
      outputSchema: {
        type: "object", properties: { alpha: { type: "string" }, beta: { type: "number" } },
        required: ["alpha", "beta"], additionalProperties: false,
        enum: [{ alpha: "yes", beta: 2 }],
      },
    });
    expect(resourceSchemaAccepts(job.outputSchema, { beta: 2, alpha: "yes" })).toBe(true);
    expect(resourceSchemaAccepts(job.outputSchema, { alpha: "no", beta: 2 })).toBe(false);
  });

  it("enforces aggregate pack value and byte budgets", () => {
    const content = {
      recordSchema: schema, filterFields: ["category"], returnFields: ["category"], taxonomy: [], evidence: [], sourceSnapshotIds: [], jobContract: contract,
      records: Array.from({ length: RESOURCE_LIMITS.records }, (_value, index) => ({ id: `r_${index}`, fields: { category: "x".repeat(300) }, tags: [], evidenceIds: [] })),
    };
    expect(() => parseResourcePackContent(content)).toThrow("Invalid resource input.");
  });

  it("rejects record fields whose distinct raw keys normalize to one canonical key", () => {
    const content = {
      recordSchema: { type: "object", properties: { "é": { type: "string" } }, required: ["é"], additionalProperties: false },
      filterFields: ["é"], returnFields: ["é"], taxonomy: [], evidence: [], sourceSnapshotIds: [], jobContract: contract,
      records: [{ id: "record_1", fields: { "é": "first", "e\u0301": "second" }, tags: [], evidenceIds: [] }],
    };
    expect(() => parseResourcePackContent(content)).toThrow("Invalid resource input.");
  });

  it("rejects any record that violates the declared record schema, including a later record", () => {
    const content = {
      recordSchema: schema,
      filterFields: ["category"], returnFields: ["category", "score"], taxonomy: [], evidence: [], sourceSnapshotIds: [], jobContract: contract,
      records: [
        { id: "record_valid", fields: { category: "priority", score: 2 }, tags: [], evidenceIds: [] },
        { id: "record_invalid", fields: { category: "priority", score: "not-a-number" }, tags: [], evidenceIds: [] },
      ],
    };
    expect(() => parseResourcePackContent(content)).toThrow("Invalid resource input.");
  });

  it("rejects a Job Contract that cannot describe every possible deterministic projection", () => {
    const base = {
      recordSchema: schema,
      filterFields: ["category"], returnFields: ["category"], taxonomy: [], evidence: [], sourceSnapshotIds: [],
      records: [
        { id: "record_1", fields: { category: "priority", score: 2 }, tags: [], evidenceIds: [] },
        { id: "record_2", fields: { category: "standard", score: 1 }, tags: [], evidenceIds: [] },
      ],
    };
    expect(() => parseResourcePackContent({
      ...base,
      jobContract: {
        ...contract,
        outputSchema: {
          type: "array", minItems: 1, maxItems: 10,
          items: { type: "object", properties: { category: { type: "string" } }, required: ["category"], additionalProperties: false },
        },
      },
    })).toThrow("Invalid resource input.");
    expect(() => parseResourcePackContent({
      ...base,
      jobContract: {
        ...contract,
        outputSchema: {
          type: "array", maxItems: 10,
          items: { type: "object", properties: { category: { type: "number" } }, required: ["category"], additionalProperties: false },
        },
      },
    })).toThrow("Invalid resource input.");
  });

  it("rejects a safe public example that does not satisfy the advertised output schema", () => {
    expect(() => parseResourcePackContent({
      recordSchema: schema,
      filterFields: ["category"],
      returnFields: ["category", "score"],
      taxonomy: [],
      records: [],
      evidence: [],
      sourceSnapshotIds: [],
      jobContract: {
        ...contract,
        safeExample: { category: "synthetic", score: 1 },
      },
    })).toThrow("Invalid resource input.");
  });
});
