import { describe, expect, it } from "vitest";
import {
  buildProspectBrief,
  formatProspectBriefText,
  ProspectBriefInputSchema,
  type ProspectBriefInput,
} from "@/lib/company/operating-system/prospect-lens";

const NOW = new Date("2026-07-29T16:00:00.000Z");

const riskyInput: ProspectBriefInput = {
  prospectName: "Example Company",
  buyerRole: "COO",
  objective: "Ship the operating program with current evidence and one accountable next action.",
  primarySurface: "Product and delivery portfolio",
  observedStatus: "blocked",
  declaredStatus: "live",
  workstreams: ["Product", "Delivery", "Approvals"],
  evidenceNotes: ["A launch update says the program is live."],
  evidenceObservedAt: "2026-07-01T12:00:00.000Z",
  evidenceTier: "prospect-claimed",
  productionEvidence: null,
  blockers: ["Verified release receipt from the delivery team"],
  pendingDecisions: ["The executive sponsor must approve the rollout sequence."],
  productionClaim: true,
  nextAction: null,
};

describe("Operating System Prospect Lens", () => {
  it("validates a bounded, strict operator-input contract", () => {
    expect(ProspectBriefInputSchema.safeParse(riskyInput).success).toBe(true);
    expect(ProspectBriefInputSchema.safeParse({
      ...riskyInput,
      prospectName: "",
    }).success).toBe(false);
    expect(ProspectBriefInputSchema.safeParse({
      ...riskyInput,
      unknownField: "not allowed",
    }).success).toBe(false);
  });

  it("turns supplied gaps into deterministic findings with source citations", () => {
    const brief = buildProspectBrief(riskyInput, NOW);
    const rules = new Set(brief.findings.map((finding) => finding.rule));

    expect(rules).toEqual(new Set([
      "missing-evidence",
      "conflicting-status",
      "blocked-dependency",
      "unverified-production",
      "unresolved-approval",
      "missing-next-action",
    ]));
    expect(
      brief.findings.every((finding) => (
        finding.sourceEvidence.length > 0 && finding.nextAction.length > 0
      )),
    ).toBe(true);
    expect(brief.engagement.map((step) => step.title)).toEqual([
      "Map the execution spine",
      "Install evidence receipts",
      "Run the decision cadence",
    ]);
    expect(
      brief.findings.find((finding) => finding.rule === "missing-next-action")?.sourceEvidence,
    ).toEqual(["Operator input: the current next action was left blank."]);
    expect(
      brief.findings.find((finding) => finding.rule === "unverified-production")?.sourceEvidence,
    ).toEqual([
      "Operator input: a production claim was supplied without verified production evidence.",
    ]);
    expect(
      brief.findings.find((finding) => finding.rule === "blocked-dependency")?.title,
    ).toBe("Example Company has a blocked dependency");
  });

  it("does not raise evidence, conflict, or production gaps when the input supports them", () => {
    const brief = buildProspectBrief({
      ...riskyInput,
      observedStatus: "live",
      declaredStatus: "live",
      evidenceObservedAt: "2026-07-29T12:00:00.000Z",
      evidenceTier: "verified",
      productionEvidence: "The exact production deployment and route were checked at source.",
      blockers: [],
      pendingDecisions: [],
      nextAction: "Verify the next release receipt with the accountable owner.",
    }, NOW);
    const rules = new Set(brief.findings.map((finding) => finding.rule));

    expect(rules.has("missing-evidence")).toBe(false);
    expect(rules.has("stale-evidence")).toBe(false);
    expect(rules.has("conflicting-status")).toBe(false);
    expect(rules.has("unverified-production")).toBe(false);
  });

  it("does not treat a verified tier or generic note as production proof by itself", () => {
    const brief = buildProspectBrief({
      ...riskyInput,
      evidenceObservedAt: "2026-07-29T12:00:00.000Z",
      evidenceTier: "verified",
      productionEvidence: null,
    }, NOW);

    expect(brief.findings.some((finding) => finding.rule === "unverified-production")).toBe(true);
  });

  it("keeps the exported sales brief draft-only and free of invented quantified outcomes", () => {
    const text = formatProspectBriefText(buildProspectBrief(riskyInput, NOW));

    expect(text).toContain("DRAFT · INTERNAL · REVIEW BEFORE SHARING");
    expect(text).toContain("Evidence boundary:");
    expect(text).toContain("A launch update says the program is live.");
    expect(text).not.toMatch(/\b(?:revenue|ROI|savings|growth)\s+(?:of|by)\s+\d/i);
  });

  it("rejects evidence dates in the future", () => {
    expect(() => buildProspectBrief({
      ...riskyInput,
      evidenceObservedAt: "2026-07-30T12:00:00.000Z",
    }, NOW)).toThrow("cannot be in the future");
  });
});
