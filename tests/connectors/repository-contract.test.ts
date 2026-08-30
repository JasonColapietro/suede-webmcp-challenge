import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("connector repository contract", () => {
  it("is provider-neutral and exposes only compiled projection persistence", () => {
    const source = readFileSync(new URL("../../src/lib/connectors/repository.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/better-sqlite3|SQLITE_PATH|studio\.db/u);
    expect(source).not.toMatch(/rawSource|sourceJson|openapiSource/u);
    expect(source).toContain("ConnectorDefinitionProjectionV1");
    expect(source).toContain("OperationProjectionV1");
    expect(source).toContain("immediate");
    expect(source).toContain("listOperationVersions");
  });

  it("defines a bounded summary-only operation history contract", () => {
    const source = readFileSync(new URL("../../src/lib/connectors/repository.ts", import.meta.url), "utf8");
    expect(source).toContain("OperationVersionListOptions");
    expect(source).toContain("OperationVersionSummary");
    const summary = /export interface OperationVersionSummary \{([\s\S]*?)\n\}/u.exec(source)?.[1] ?? "";
    expect(summary).not.toMatch(/projection|requestSchema|resultSchema|rawSource|body|headers/u);
  });

  it("keeps identity lifecycle separate from immutable versions", async () => {
    const contract = await import("@/lib/connectors/repository");
    expect(contract.CONNECTOR_NOT_FOUND).toBe("CONNECTOR_NOT_FOUND");
    expect(contract.CONNECTOR_ANNOTATION_CONFLICT).toBe("CONNECTOR_ANNOTATION_CONFLICT");
    expect(contract.CONNECTOR_RATE_REFUSED).toBe("CONNECTOR_RATE_REFUSED");
  });
});
