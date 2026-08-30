import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/app/company/operations/prospect/prospect-engine-workbench.tsx", "utf8");
const route = readFileSync("src/app/api/companies/prospects/[id]/route.ts", "utf8");
const discovery = readFileSync("src/app/api/companies/prospects/discover/route.ts", "utf8");

describe("Prospect Engine UI/API contract", () => {
  it("keeps delivery in the reviewed email client and confirms separately", () => {
    expect(source).toContain("Prepare approved email handoff");
    expect(source).toContain("Confirm I manually sent this exact draft");
    expect(source).toContain("cannot know whether a mail client opened or whether anything was sent");
    expect(source).toContain("Copy approved email");
    expect(source).not.toMatch(/sendEmail|smtp|resend/i);
    expect(route).toContain("buildHandoffPresentation");
    expect(source).toContain('action: "confirm-delivery"');
  });

  it("makes Google discovery optional, attributed, and transient", () => {
    expect(source).toContain("Manual website import");
    expect(source).toContain("Source: Google Maps · transient result, not stored");
    expect(discovery).toContain("manualImportAvailable: true");
    expect(discovery).toContain("ephemeral: true");
  });

  it("uses the existing allowlisted private authorization boundary", () => {
    expect(route).toContain("resolveOperatingSystemAccess");
    expect(route).toContain("Authentication required");
    expect(route).toContain('error: "not found"');
    expect(route).toContain("privateJson");
  });
});
