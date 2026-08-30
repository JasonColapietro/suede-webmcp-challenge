import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("server document production packaging", () => {
  it("keeps PDF libraries external and traces PDFKit's standard-font assets", () => {
    const source = readFileSync(join(process.cwd(), "next.config.ts"), "utf8");

    expect(source).toMatch(/serverExternalPackages:\s*\[[^\]]*"pdfkit"/su);
    expect(source).toMatch(/serverExternalPackages:\s*\[[^\]]*"unpdf"/su);
    expect(source).toContain("outputFileTracingIncludes");
    expect(source).toContain("./node_modules/pdfkit/js/data/*.afm");
  });
});
