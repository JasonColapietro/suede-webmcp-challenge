import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const companySource = readFileSync("src/app/company/page.tsx", "utf8");
const clientSource = readFileSync(
  "src/app/company/operations/operating-system-client.tsx",
  "utf8",
);
const styles = readFileSync(
  "src/app/company/operations/operating-system.css",
  "utf8",
);

describe("Suede Operating System UI contract", () => {
  it("is a Company sub-surface with an entry point from both Company views", () => {
    expect(companySource.match(/href="\/company\/operations"/g)).toHaveLength(2);
    expect(companySource).toContain("View company evidence");
    expect(companySource).toContain("Company evidence");
    expect(clientSource).toContain('"/api/companies/operating-system"');
    expect(clientSource).toContain("Review in Company");
  });

  it("validates snapshot and local comparison boundaries with Zod", () => {
    expect(clientSource).toContain("OperatingSystemSnapshotSchema.safeParse");
    expect(clientSource).toContain("OperatingSnapshotBaselineSchema.safeParse");
    expect(clientSource).toContain("suede-operating-system-baseline-v1");
    expect(clientSource).not.toMatch(
      /@\/lib\/(?:db|projects\/provider|company\/operating-system\/snapshot)/,
    );
  });

  it("renders the evidence rail, deterministic lens, and mobile layout accessibly", () => {
    expect(clientSource).toContain("Source evidence");
    expect(clientSource).toContain("Rules only. No model-generated summary.");
    expect(clientSource).toContain('aria-labelledby="lens-heading"');
    expect(clientSource).toContain('aria-label="Source adapters"');
    expect(styles).toContain(".sos-rail__stop");
    // 759px is the site-wide tablet tier: the exact complement of site.css's
    // `min-width: 760px` band, so the two never double-apply at 760px.
    expect(styles).toContain("@media (max-width: 759px)");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
  });
});
