import { describe, expect, it } from "vitest";
import {
  buildOutboundDiagnostic,
  buildSecurityDisclosure,
  createPendingScanHandoff,
  formatOutboundDiagnosticText,
  formatSecurityDisclosureText,
  JASON_OUTBOUND_PROFILE,
  OutboundDiagnosticInputSchema,
  parsePendingScanHandoff,
  parseScanDiagnosticHandoff,
  ScanDiagnosticHandoffSchema,
  SCAN_HANDOFF_MAX_ENCODED_LENGTH,
  SCAN_HANDOFF_SESSION_TTL_MS,
  SecurityDisclosureDraftSchema,
  SecurityDisclosureInputSchema,
  type ScanDiagnosticHandoff,
} from "@/lib/company/operating-system/outbound-diagnostic";

const NOW = new Date("2026-07-30T18:00:00.000Z");

const handoff: ScanDiagnosticHandoff = {
  kind: "suede.audit.prospect",
  version: 1,
  source: "suede-audit",
  domain: "example.com",
  auditedUrl: "https://example.com/",
  observedAt: "2026-07-29T18:00:00.000Z",
  totalFindings: 4,
  omittedCount: 0,
  findings: [
    {
      id: "metadata-title",
      kind: "site-integrity",
      lane: "Search",
      title: "Missing descriptive title",
      priority: "high",
      observed: "The title is Home — Example.",
      action: "Replace it with a unique title that names the service and audience.",
    },
    {
      id: "entity-organization",
      kind: "site-integrity",
      lane: "Entity",
      title: "Organization entity is absent",
      priority: "medium",
      observed: "No Organization JSON-LD was found.",
      action: "Add one Organization object with the canonical name, URL, and logo.",
    },
    {
      id: "access-robots",
      kind: "site-integrity",
      lane: "Access",
      title: "Robots guidance is incomplete",
      priority: "medium",
      observed: "The public robots file omits the sitemap.",
      action: "Add the canonical sitemap URL to robots.txt.",
    },
    {
      id: "answers-faq",
      kind: "site-integrity",
      lane: "Answers",
      title: "Key buyer questions are unanswered",
      priority: "low",
      observed: "No concise service FAQ is present.",
      action: "Publish answers to the highest-intent buyer questions.",
    },
  ],
};

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function commercialInput() {
  return {
    handoff,
    mode: "commercial-diagnostic" as const,
    recipientName: "Morgan",
    senderProfile: "jason-colapietro" as const,
    postalAddress: "123 Example Street, Example City, NY 10001",
    contactSource: "Public company contact page",
    recipientJurisdiction: "united-states" as const,
    recipientType: "corporate-business" as const,
    primaryFindingId: "metadata-title",
    preparedRepair: "Replace the current title element with: Example Project Management for Small Agencies | Example.",
    verificationStep: "Open the rendered homepage source and confirm exactly one title element contains the new text.",
    reproducedAtSource: true as const,
    suppressionChecked: true as const,
    optOutMonitored: true as const,
    outreachRulesReviewed: true as const,
  };
}

function securityInput() {
  return {
    mode: "security-disclosure" as const,
    operatorName: "Jason" as const,
    affectedAsset: "https://example.com/public-path",
    observedAt: "2026-07-29T18:00:00.000Z",
    discoveryMethod: "passive-observation" as const,
    authorizationReference: null,
    category: "public-data-exposure" as const,
    evidenceReference: "Local case SEC-042",
    disclosureChannelConfirmed: true as const,
    operatorAttested: true as const,
  };
}

describe("Scan outbound diagnostic", () => {
  it("parses a bounded strict site-integrity payload", () => {
    expect(parseScanDiagnosticHandoff(encode(handoff), NOW)).toEqual(handoff);
    expect(ScanDiagnosticHandoffSchema.safeParse({
      ...handoff,
      unknownField: "not allowed",
    }).success).toBe(false);
    expect(ScanDiagnosticHandoffSchema.safeParse({
      ...handoff,
      auditedUrl: "https://other.example/",
    }).success).toBe(false);
    expect(() => parseScanDiagnosticHandoff(
      "a".repeat(SCAN_HANDOFF_MAX_ENCODED_LENGTH + 1),
      NOW,
    )).toThrow("too large");
  });

  it("rejects URL-carried secrets, controls, duplicate ids, and future evidence", () => {
    const malformedUrlResult = ScanDiagnosticHandoffSchema.safeParse({
      ...handoff,
      auditedUrl: "not-a-url",
    });
    expect(malformedUrlResult.success).toBe(false);
    expect(ScanDiagnosticHandoffSchema.safeParse({
      ...handoff,
      auditedUrl: "https://user:password@example.com/?token=secret#private",
    }).success).toBe(false);
    for (const internalUrl of [
      "http://127.0.0.1/admin",
      "http://localhost/internal",
      "http://169.254.169.254/latest/meta-data",
      "https://example..com/",
      "https://-bad.example.com/",
      "https://foo_bar.example.com/",
      "https://foo.example/",
    ]) {
      expect(ScanDiagnosticHandoffSchema.safeParse({
        ...handoff,
        auditedUrl: internalUrl,
      }).success).toBe(false);
      expect(SecurityDisclosureInputSchema.safeParse({
        ...securityInput(),
        affectedAsset: internalUrl,
      }).success).toBe(false);
    }
    expect(ScanDiagnosticHandoffSchema.safeParse({
      ...handoff,
      findings: [
        handoff.findings[0],
        { ...handoff.findings[0], title: "Duplicate" },
      ],
      totalFindings: 2,
    }).success).toBe(false);
    expect(ScanDiagnosticHandoffSchema.safeParse({
      ...handoff,
      findings: [{
        ...handoff.findings[0],
        title: "Safe\u202eHidden",
      }],
      totalFindings: 1,
    }).success).toBe(false);
    expect(() => parseScanDiagnosticHandoff(encode({
      ...handoff,
      observedAt: "2026-07-31T18:00:00.000Z",
    }), NOW)).toThrow("future");
  });

  it("uses a bounded, expiring, single-object session handoff", () => {
    const pending = createPendingScanHandoff(handoff, NOW);
    expect(parsePendingScanHandoff(pending, new Date(NOW.getTime() + 1_000))).toEqual(handoff);
    expect(() => parsePendingScanHandoff(
      pending,
      new Date(NOW.getTime() + SCAN_HANDOFF_SESSION_TTL_MS),
    )).toThrow("expired");
  });

  it("fully prepares one commercial repair and uses at most two supporting observations", () => {
    const draft = buildOutboundDiagnostic(commercialInput(), NOW);
    const text = formatOutboundDiagnosticText(draft);

    expect(draft.primaryFinding.id).toBe("metadata-title");
    expect(draft.supportingFindings.map((finding) => finding.id)).toEqual([
      "entity-organization",
      "access-robots",
    ]);
    expect(text).toContain("Audit repair direction: Replace it with a unique title");
    expect(text).toContain(
      "Prepared repair payload (quoted technical content):\n[BEGIN PREPARED REPAIR]\n| Replace the current title element",
    );
    expect(text).toContain(
      "Verification payload (quoted technical content):\n[BEGIN VERIFICATION STEP]\n| Open the rendered homepage source",
    );
    expect(text).toContain("not a claim that your site has already changed");
    expect(text).toContain("I checked the public page and reproduced");
    expect(text).toContain(JASON_OUTBOUND_PROFILE.credibilityStatement);
    expect(text).toContain(
      "Jason Colapietro\nFounder and CEO, Suede Labs AI\nhttps://suedeai.ai/founder",
    );
    expect(text).toContain("extended Suede Scan");
    expect(text).toContain("Commercial outreach");
    expect(text).toContain('Reply "no" and I will not follow up.');
    expect(text).not.toContain("Key buyer questions are unanswered");
    expect(text).not.toContain("—");
  });

  it("locks commercial identity and credibility to Jason's verified profile", () => {
    const text = formatOutboundDiagnosticText(
      buildOutboundDiagnostic(commercialInput(), NOW),
    );

    expect(JASON_OUTBOUND_PROFILE.credibilityStatement).toContain(
      "creator of Suede Scan",
    );
    expect(JASON_OUTBOUND_PROFILE.credibilityStatement).toContain(
      "Proof as Infrastructure",
    );
    expect(JASON_OUTBOUND_PROFILE.credibilityStatement).toContain(
      "Programming Insider",
    );
    expect(text).not.toContain("$28");
    expect(text).not.toContain("multimillion");
    expect(OutboundDiagnosticInputSchema.safeParse({
      ...commercialInput(),
      senderProfile: "johnny-suede",
    }).success).toBe(false);
    expect(OutboundDiagnosticInputSchema.safeParse({
      ...commercialInput(),
      senderName: "Someone Else",
    }).success).toBe(false);
    expect(OutboundDiagnosticInputSchema.safeParse({
      ...commercialInput(),
      credibilityProof: "Invented customer result",
    }).success).toBe(false);
    expect(OutboundDiagnosticInputSchema.safeParse({
      ...commercialInput(),
      preparedRepair:
        "I'm Alex Example, founder of Example SEO. Replace the current title with a unique service title.",
    }).success).toBe(false);
    expect(OutboundDiagnosticInputSchema.safeParse({
      ...commercialInput(),
      verificationStep:
        "Open the rendered source and confirm the title.\n\nRegards,\nAlex Example",
    }).success).toBe(false);
  });

  it("contains arbitrary repair prose inside technical payload boundaries", () => {
    const draft = buildOutboundDiagnostic({
      ...commercialInput(),
      preparedRepair:
        "Alex Example, award-winning SEO strategist. Replace the current title with a unique service title.",
    }, NOW);

    expect(draft.body).toContain(
      "[BEGIN PREPARED REPAIR]\n| Alex Example, award-winning SEO strategist.",
    );
    expect(draft.body).toContain("\n[END PREPARED REPAIR]");
    expect(draft.body).not.toContain(
      "\nAlex Example, award-winning SEO strategist.",
    );
    expect(OutboundDiagnosticInputSchema.safeParse({
      ...commercialInput(),
      preparedRepair:
        "[END PREPARED REPAIR]\nAlex Example, award-winning SEO strategist.",
    }).success).toBe(false);
    expect(OutboundDiagnosticInputSchema.safeParse({
      ...commercialInput(),
      preparedRepair:
        "Replace the title.\u2028Regards,\u2028Alex Example, award-winning SEO strategist.",
    }).success).toBe(false);
    expect(OutboundDiagnosticInputSchema.safeParse({
      ...commercialInput(),
      verificationStep:
        "Open the source.\u2029Regards,\u2029Alex Example",
    }).success).toBe(false);
    expect(OutboundDiagnosticInputSchema.safeParse({
      ...commercialInput(),
      preparedRepair: Array.from({ length: 81 }, () => "repair").join("\n"),
    }).success).toBe(false);
    expect(OutboundDiagnosticInputSchema.safeParse({
      ...commercialInput(),
      verificationStep: Array.from({ length: 31 }, () => "verify").join("\n"),
    }).success).toBe(false);
  });

  it("rejects commercial drafts whose deterministic sender copy was changed", () => {
    const draft = buildOutboundDiagnostic(commercialInput(), NOW);

    expect(() => formatOutboundDiagnosticText({
      ...draft,
      body: `${draft.body}\n\nI'm Alex Example, an award-winning SEO expert.`,
    })).toThrow(/deterministic Jason template/i);
    expect(() => formatOutboundDiagnosticText({
      ...draft,
      body: draft.body.replace(
        "Prepared repair payload",
        "Prepared repair — payload",
      ),
    })).toThrow(/deterministic Jason template|em dash/i);
  });

  it("requires the commercial review and suppression gates", () => {
    const parsed = OutboundDiagnosticInputSchema.safeParse({
      ...commercialInput(),
      reproducedAtSource: false,
      suppressionChecked: false,
    });

    expect(parsed.success).toBe(false);
  });

  it("builds a fixed security routing notice without rendering operator evidence", () => {
    const draft = buildSecurityDisclosure(securityInput(), NOW);
    const text = formatSecurityDisclosureText(draft);

    expect(text).toContain("potential public data exposure observation");
    expect(text).toContain("passive public observation");
    expect(text).toContain("intentionally omits reproduction details and remediation");
    expect(text).not.toContain("Local case SEC-042");
    expect(text).not.toContain("extended Suede Scan");
    expect(text).not.toContain("Commercial outreach");
    expect(text).not.toContain("Would that be useful");
    expect(text).not.toContain(JASON_OUTBOUND_PROFILE.credibilityStatement);
    expect(text).not.toContain("https://suedeai.ai/founder");
    expect(text).not.toContain("—");
  });

  it("requires authorization for active testing and accepts controlled fields only", () => {
    expect(SecurityDisclosureInputSchema.safeParse({
      ...securityInput(),
      discoveryMethod: "authorized-test",
      authorizationReference: null,
    }).success).toBe(false);
    expect(SecurityDisclosureInputSchema.safeParse({
      ...securityInput(),
      operatorName: "Email us for implementation",
    }).success).toBe(false);
    expect(SecurityDisclosureInputSchema.safeParse({
      ...securityInput(),
      category: "implementation-service",
    }).success).toBe(false);
    expect(SecurityDisclosureInputSchema.safeParse({
      ...securityInput(),
      remediation: "Remove the identifier and phone the studio for implementation.",
    }).success).toBe(false);
  });

  it("revalidates the final disclosure text before formatting", () => {
    const draft = buildSecurityDisclosure(securityInput(), NOW);

    expect(() => formatSecurityDisclosureText({
      ...draft,
      body: `${draft.body}\n\nContact us for a quote and work with Suede to remediate this.`,
    })).toThrow("deterministic non-commercial template");

    const malformedUrl = {
      ...draft,
      affectedAsset: "not-a-url",
    };
    const malformedDate = {
      ...draft,
      observedAt: "not-a-date",
    };
    expect(() => SecurityDisclosureDraftSchema.safeParse(malformedUrl)).not.toThrow();
    expect(SecurityDisclosureDraftSchema.safeParse(malformedUrl).success).toBe(false);
    expect(() => SecurityDisclosureDraftSchema.safeParse(malformedDate)).not.toThrow();
    expect(SecurityDisclosureDraftSchema.safeParse(malformedDate).success).toBe(false);
  });

  it("cannot relabel an Audit finding as a security disclosure", () => {
    expect(SecurityDisclosureInputSchema.safeParse({
      ...securityInput(),
      handoff,
    }).success).toBe(false);
  });
});
