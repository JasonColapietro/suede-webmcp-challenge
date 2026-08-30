import { describe, expect, it } from "vitest";
import { runRealityLens } from "@/lib/company/operating-system/reality-lens";
import type {
  EvidenceReceipt,
  OperatingApproval,
  OperatingProject,
} from "@/lib/company/operating-system/schema";

const oldReceipt: EvidenceReceipt = {
  id: "evidence:old",
  source: "fixture",
  scope: "project",
  label: "Old status record",
  claim: "An older record says the surface is blocked.",
  observedAt: "2026-07-01T00:00:00.000Z",
  verification: "verified",
  statusClaim: "blocked",
  production: false,
};

const riskyProject: OperatingProject = {
  id: "project:risky",
  name: "Risky surface",
  surface: "example.suedeai.ai",
  objective: "Prove every rule.",
  owner: { kind: "person", label: "Jason" },
  status: "live",
  dependencies: [{
    id: "dependency:blocked",
    label: "Release approval",
    state: "blocked",
    projectId: null,
    evidenceIds: [oldReceipt.id],
  }],
  evidenceIds: [oldReceipt.id],
  lastVerifiedAt: "2026-07-01T00:00:00.000Z",
  nextAction: null,
  productionClaim: true,
  sourceAdapter: "test",
};

const missingEvidenceProject: OperatingProject = {
  ...riskyProject,
  id: "project:missing",
  name: "Missing proof surface",
  status: "building",
  dependencies: [],
  evidenceIds: [],
  lastVerifiedAt: null,
  nextAction: "Attach proof.",
  productionClaim: false,
};

const approval: OperatingApproval = {
  id: "approval:one",
  companyId: "company:one",
  companyName: "Proof Company",
  kind: "enable_live_selling",
  title: "Enable live selling",
  subject: "Proof agent",
  requestedAt: "2026-07-28T12:00:00.000Z",
  costLabel: "Quoted · $0.000 USDC",
  evidenceIds: ["approval:one:evidence"],
  href: "/company?id=company%3Aone",
};

describe("Suede Operating System Reality Lens", () => {
  it("detects every required rule deterministically and cites source evidence", () => {
    const findings = runRealityLens({
      projects: [riskyProject, missingEvidenceProject],
      evidence: [
        oldReceipt,
        {
          id: "approval:one:evidence",
          source: "approval",
          scope: "approval",
          label: "Pending approval",
          claim: "The approval is pending.",
          observedAt: approval.requestedAt,
          verification: "verified",
          production: false,
        },
      ],
      approvals: [approval],
      now: new Date("2026-07-29T12:00:00.000Z"),
    });

    expect(new Set(findings.map((finding) => finding.rule))).toEqual(new Set([
      "missing-evidence",
      "stale-evidence",
      "conflicting-status",
      "blocked-dependency",
      "unverified-production",
      "unresolved-approval",
      "missing-next-action",
    ]));
    expect(findings.every((finding) => finding.nextAction.length > 0)).toBe(true);
    expect(
      findings.find((finding) => finding.rule === "conflicting-status")?.evidenceIds,
    ).toEqual([oldReceipt.id]);
    expect(findings.find((finding) => finding.rule === "unresolved-approval")).toMatchObject({
      severity: "high",
      confidence: "high",
      evidenceIds: ["approval:one:evidence"],
    });
  });

  it("does not infer a conflict from dependency-scoped status receipts", () => {
    const findings = runRealityLens({
      projects: [{
        ...riskyProject,
        dependencies: [],
        productionClaim: false,
        nextAction: "Run the next check.",
        lastVerifiedAt: "2026-07-29T11:00:00.000Z",
      }],
      evidence: [
        {
          ...oldReceipt,
          statusClaim: "live",
        },
        {
          ...oldReceipt,
          id: "evidence:dependency",
          source: "deployment",
          scope: "dependency",
          statusClaim: "blocked",
        },
      ],
      approvals: [],
      now: new Date("2026-07-29T12:00:00.000Z"),
    });

    expect(findings.some((finding) => finding.rule === "conflicting-status")).toBe(false);
  });
});
