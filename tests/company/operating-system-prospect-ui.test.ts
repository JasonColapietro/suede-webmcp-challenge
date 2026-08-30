import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const operatingPage = readFileSync(
  "src/app/company/operations/page.tsx",
  "utf8",
);
const pageSource = readFileSync(
  "src/app/company/operations/prospect/page.tsx",
  "utf8",
);
const clientSource = readFileSync(
  "src/app/company/operations/prospect/prospect-lens-client.tsx",
  "utf8",
);
const diagnosticSource = readFileSync(
  "src/app/company/operations/prospect/outbound-diagnostic-workspace.tsx",
  "utf8",
);
const captureSource = readFileSync(
  "src/app/company/operations/prospect/scan-handoff-capture.tsx",
  "utf8",
);
const analyticsProviderSource = readFileSync(
  "src/components/PostHogProvider.tsx",
  "utf8",
);
const analyticsConfigSource = readFileSync(
  "src/lib/posthog.ts",
  "utf8",
);
const styles = readFileSync(
  "src/app/company/operations/prospect/prospect-lens.css",
  "utf8",
);

describe("Operating System Prospect Lens UI contract", () => {
  it("is an authenticated, no-index Company sub-surface", () => {
    expect(operatingPage).toContain('href="/company/operations/prospect"');
    expect(pageSource).toContain("resolveOperatingSystemAccess");
    expect(pageSource).toContain('access.kind === "forbidden"');
    expect(pageSource).toContain("notFound()");
    expect(pageSource).toContain("robots: { index: false, follow: false }");
    expect(pageSource).toContain("Sign in with Suede");
    expect(pageSource).toContain("<ScanHandoffCapture />");
  });

  it("keeps bounded prospect input local and validates it with Zod", () => {
    expect(clientSource).toContain("ProspectBriefInputSchema.safeParse");
    expect(diagnosticSource).toContain("OutboundDiagnosticInputSchema.safeParse");
    expect(diagnosticSource).toContain("SecurityDisclosureInputSchema.safeParse");
    expect(clientSource).toContain("Prospect Engine records are owner-scoped and saved");
    expect(clientSource).toContain("scratch forms below stay in this page");
    expect(clientSource).toContain("Do not paste secrets");
    expect(clientSource).not.toContain("fetch(");
    expect(diagnosticSource).not.toContain("fetch(");
    expect(clientSource).not.toContain("localStorage");
    expect(diagnosticSource).not.toContain("localStorage");
    expect(clientSource).not.toMatch(/@\/lib\/(?:db|projects\/provider)/);
  });

  it("keeps the auth handoff fragment-free and consumes temporary tab storage", () => {
    expect(captureSource).toContain("window.history.replaceState");
    expect(captureSource).toContain("createPendingScanHandoff");
    expect(captureSource).toContain("sessionStorage.setItem");
    expect(clientSource).toContain("parsePendingScanHandoff");
    expect(clientSource).toContain("sessionStorage.removeItem");
    expect(pageSource).toContain("const SIGN_IN_URL = signInUrl");
    expect(pageSource).not.toContain("window.location.hash");
  });

  it("excludes Prospect Lens evidence and URL fragments from product analytics", () => {
    expect(analyticsProviderSource).toContain('PROSPECT_LENS_PATH = "/company/operations/prospect"');
    expect(analyticsProviderSource).toContain("pathname.startsWith");
    expect(analyticsConfigSource).toContain("url_ignorelist");
    expect(analyticsConfigSource).toContain("disable_capture_url_hashes: true");
  });

  it("keeps Audit findings in site-integrity outreach and security evidence separate", () => {
    expect(diagnosticSource).toContain("Audit findings cannot become vulnerabilities");
    expect(diagnosticSource).toContain("Not imported from Audit");
    expect(diagnosticSource).toContain("buildOutboundDiagnostic");
    expect(diagnosticSource).toContain("buildSecurityDisclosure");
    expect(diagnosticSource).toContain("Fixed security routing notice");
    expect(diagnosticSource).toContain('name="securityCategory"');
    expect(diagnosticSource).toContain('name="evidenceReference"');
    expect(diagnosticSource).not.toContain('name="remediation"');
    expect(diagnosticSource).not.toContain('name="observedBehavior"');
    expect(diagnosticSource).not.toContain("mailto:");
  });

  it("supports operator-reviewed copy and print without outreach or publishing", () => {
    expect(clientSource).toContain("navigator.clipboard.writeText");
    expect(diagnosticSource).toContain("navigator.clipboard.writeText");
    expect(clientSource).toContain("window.print()");
    expect(diagnosticSource).toContain("window.print()");
    expect(clientSource).toContain("Draft · internal · review before sharing");
    expect(clientSource).toContain("No model call. No CRM write. No outreach.");
    expect(diagnosticSource).toContain("No model call. No CRM write. No email sent.");
    expect(diagnosticSource).toContain("JASON_OUTBOUND_PROFILE");
    expect(diagnosticSource).toContain("Fixed sender profile");
    expect(diagnosticSource).toContain("Proof as Infrastructure");
    expect(diagnosticSource).toContain("Programming Insider");
    expect(diagnosticSource).toContain(
      "I confirm Jason reproduced the primary observation on the exact public page.",
    );
    expect(diagnosticSource).not.toContain('name="senderName"');
    expect(diagnosticSource).not.toContain('name="credibilityProof"');
    expect(clientSource).not.toMatch(/\b(?:sendEmail|publishBrief|createLead)\b/);
    expect(diagnosticSource).not.toMatch(/\b(?:sendEmail|publishBrief|createLead)\b/);
  });

  it("provides responsive and print-specific presentation", () => {
    expect(styles).toContain("@media (max-width: 820px)");
    expect(styles).toContain("@media print");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(styles).toContain(".spl-boundary");
    expect(styles).toContain(".spl-diagnostic");
  });
});
