import { describe, expect, it } from "vitest";
import { parsePublicJobContract } from "@/lib/resources/public-contract";

const value = {
  resourceProductId: "resource_1", packVersionId: "pack_1", semanticHash: "a".repeat(64),
  jobStatement: "Find reviewed records.", buyerIntent: "A buyer needs records.",
  inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  outputSchema: { type: "array", items: { type: "object", properties: {}, required: [], additionalProperties: false } },
  unsupportedRequest: "Return no result.", evidenceRequirement: "Evidence pointers included.",
  safeExample: [], reviewBoundary: "Owner reviewed.", dataHandlingDisclosure: "Private corpus never returned.",
};

describe("public Job Contract", () => {
  it("accepts only documented safe public contract fields", () => {
    expect(parsePublicJobContract(value)).toMatchObject({ resourceProductId: "resource_1", packVersionId: "pack_1" });
  });

  it.each(["records", "sourceBody", "privateExamples", "provenanceNote", "credentials"])("rejects private %s", (key) => {
    expect(() => parsePublicJobContract({ ...value, [key]: "CANARY" })).toThrow("Invalid public resource contract.");
  });

  it("rejects product/version/hash mismatch", () => {
    expect(() => parsePublicJobContract({ ...value, resourceProductId: "resource_2" }, { resourceProductId: "resource_1", packVersionId: "pack_1", semanticHash: "a".repeat(64) })).toThrow("Invalid public resource contract.");
  });

  it("rejects a public safe example that does not satisfy its output schema", () => {
    expect(() => parsePublicJobContract({
      ...value,
      safeExample: { records: [] },
    })).toThrow("Invalid public resource contract.");
  });
});
