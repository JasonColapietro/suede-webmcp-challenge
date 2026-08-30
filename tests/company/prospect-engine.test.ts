import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
process.env.PROSPECT_SUPPRESSION_HMAC_SECRET = "x".repeat(32);

import {
  applyProspectAction,
  attachTrustedAudit,
  buildHandoffPresentation,
  createHandoffLease,
  createProspectRecord,
  prospectDigest,
  recipientEmailDigest,
  validateProspectIntegrity,
} from "@/lib/company/prospect-engine/engine";
import type { ScanDiagnosticHandoff } from "@/lib/company/operating-system/outbound-diagnostic";
import { SqliteRepo } from "@/lib/db/sqlite-repo";

const T0 = new Date("2026-08-04T12:00:00.000Z");
const handoff: ScanDiagnosticHandoff = {
  kind: "suede.audit.prospect",
  version: 1,
  source: "suede-audit",
  domain: "fixture.example.com",
  auditedUrl: "https://fixture.example.com/",
  observedAt: "2026-08-04T12:00:00.500Z",
  totalFindings: 1,
  omittedCount: 0,
  findings: [{
    id: "broken-link-about",
    kind: "site-integrity",
    lane: "Links",
    title: "Broken internal About link",
    priority: "high",
    observed: "The About anchor points to /about-old and returns HTTP 404.",
    action: "Change the anchor target to /about and verify the destination returns HTTP 200.",
    evidence: {
      subtype: "redirect-link",
      sourceUrl: "https://fixture.example.com/",
      targetUrl: "https://fixture.example.com/about-old",
      finalUrl: "https://fixture.example.com/about",
      status: 200,
      anchorText: "About",
      redirectChain: [{
        status: 301,
        from: "https://fixture.example.com/about-old",
        to: "https://fixture.example.com/about",
      }],
    },
    preparedRepair: {
      kind: "replace-link-target",
      ready: true,
      before: "https://fixture.example.com/about-old",
      after: "https://fixture.example.com/about",
      instruction: "Replace the old About target with the verified public page.",
      verification: ["Open About from the homepage.", "Confirm the destination returns HTTP 200."],
    },
  }],
};

function readyRepair() {
  const discovered = createProspectRecord({ ownerId: "sb:owner-one", websiteUrl: "https://fixture.example.com/", source: { kind: "manual" }, now: T0 });
  const audited = attachTrustedAudit(discovered, handoff, T0, new Date(T0.getTime() + 1_000));
  const reproduced = applyProspectAction(audited, {
    action: "reproduce",
    sourceUrl: "https://fixture.example.com/",
    operatorNote: "Loaded the homepage and confirmed the About link returns HTTP 404.",
  }, new Date(T0.getTime() + 2_000));
  return applyProspectAction(reproduced, {
    action: "prepare-repair",
    primaryFindingId: "broken-link-about",
    preparedRepair: "Replace href=\"/about-old\" with href=\"/about\" in the homepage navigation component.",
    verificationStep: "Open the homepage, follow About, and confirm the destination returns HTTP 200.",
  }, new Date(T0.getTime() + 3_000));
}

describe("Prospect Engine lifecycle", () => {
  it("uses a versioned keyed recipient digest and fails closed without its server secret", () => {
    expect(recipientEmailDigest(" Owner@Example.com ")).toMatch(/^v1:[a-f0-9]{64}$/);
    const secret = process.env.PROSPECT_SUPPRESSION_HMAC_SECRET;
    delete process.env.PROSPECT_SUPPRESSION_HMAC_SECRET;
    expect(() => recipientEmailDigest("owner@example.com")).toThrow(/not configured/i);
    process.env.PROSPECT_SUPPRESSION_HMAC_SECRET = secret;
  });
  it("completes the fixture lifecycle without an external send", () => {
    const repair = readyRepair();
    expect(repair.repair?.sourcePreparedRepair?.kind).toBe("replace-link-target");
    const drafted = applyProspectAction(repair, {
      action: "build-draft",
      recipientEmail: "owner@fixture.example.com",
      recipientName: "Morgan",
      postalAddress: "123 Example Street, Tampa, FL 33602",
      contactSource: "Public business contact page",
      jurisdiction: "united-states",
      recipientType: "corporate-business",
      suppressionChecked: true,
      optOutMonitored: true,
      outreachRulesReviewed: true,
    }, new Date(T0.getTime() + 4_000));
    expect(drafted.stage).toBe("draft_ready");
    expect(drafted.draft?.draft.body).toContain("Broken internal About link");

    const approved = applyProspectAction(drafted, { action: "approve", suppressionChecked: true }, new Date(T0.getTime() + 5_000));
    const leased = createHandoffLease(approved, "fixture-send-0001", new Date(T0.getTime() + 6_000));
    const handoffReceipt = buildHandoffPresentation(leased);
    expect(handoffReceipt.copyFallback.recipientEmail).toBe("owner@fixture.example.com");
    expect(approved.delivery).toBeNull();

    const sent = applyProspectAction(leased, {
      action: "confirm-delivery",
      approvalDigest: handoffReceipt.approvalDigest,
      handoffDigest: handoffReceipt.handoffDigest,
      recipientEmail: "owner@fixture.example.com",
      idempotencyKey: "fixture-send-0001",
    }, new Date(T0.getTime() + 7_000));
    expect(sent.stage).toBe("sent");
    expect(sent.delivery?.providerDeliveryClaimed).toBe(false);
    expect(sent.approval?.consumedAt).not.toBeNull();

    const retry = applyProspectAction(sent, {
      action: "confirm-delivery",
      approvalDigest: handoffReceipt.approvalDigest,
      handoffDigest: handoffReceipt.handoffDigest,
      recipientEmail: "owner@fixture.example.com",
      idempotencyKey: "fixture-send-0001",
    }, new Date(T0.getTime() + 8_000));
    expect(retry).toEqual(sent);
    expect(() => applyProspectAction(sent, {
      action: "confirm-delivery", approvalDigest: handoffReceipt.approvalDigest,
      handoffDigest: "0".repeat(64), recipientEmail: "owner@fixture.example.com",
      idempotencyKey: "fixture-send-0001",
    }, new Date(T0.getTime() + 9_000))).toThrow(/different bound inputs/i);
  });

  it("rejects stale approvals, duplicate delivery, and suppressed recipients", () => {
    const repair = readyRepair();
    const suppressed = applyProspectAction(repair, { action: "suppress", note: "Existing do-not-contact record." }, new Date(T0.getTime() + 4_000));
    expect(suppressed.stage).toBe("closed");
    expect(suppressed.suppression.suppressed).toBe(true);
    expect(() => applyProspectAction(suppressed, { action: "approve", suppressionChecked: true }, new Date(T0.getTime() + 5_000))).toThrow();
  });

  it("never marks follow-up due before its receipt date", () => {
    const repair = readyRepair();
    expect(() => applyProspectAction(repair, { action: "mark-follow-up-due" }, T0)).toThrow(/not allowed/i);
  });

  it("rejects tampered receipt digests and impossible lifecycle stages", () => {
    const repair = readyRepair();
    expect(() => validateProspectIntegrity({ ...repair, repair: { ...repair.repair!, digest: "0".repeat(64) } })).toThrow(/digest/i);
    expect(() => validateProspectIntegrity({ ...repair, stage: "approved" })).toThrow(/lifecycle/i);
    const audited = attachTrustedAudit(createProspectRecord({ ownerId: "sb:owner-one", websiteUrl: "https://fixture.example.com/", source: { kind: "manual" }, now: T0 }), handoff, T0, new Date(T0.getTime() + 1_000));
    const tamperedAudit = { ...audited.audit!, handoff: { ...audited.audit!.handoff, observedAt: "2026-08-04T11:59:00.000Z" } };
    const payload = { ...tamperedAudit }; delete (payload as Partial<typeof tamperedAudit>).digest;
    expect(() => validateProspectIntegrity({ ...audited, audit: { ...tamperedAudit, digest: prospectDigest(payload) } })).toThrow(/predates/i);
  });
});

describe("Prospect Engine SQLite repository", () => {
  let repo: SqliteRepo;
  beforeAll(() => { repo = new SqliteRepo(":memory:"); });

  it("deduplicates by owner and domain and isolates owners", async () => {
    const one = createProspectRecord({ ownerId: "sb:owner-one", websiteUrl: "https://fixture.example.com/", source: { kind: "manual" }, now: T0 });
    await repo.createProspect(one);
    expect(await repo.getProspect(one.id, "sb:owner-one")).toEqual(one);
    expect(await repo.getProspect(one.id, "sb:owner-two")).toBeNull();
    expect(await repo.listProspects("sb:owner-two")).toEqual([]);
    const duplicate = createProspectRecord({ ownerId: "sb:owner-one", websiteUrl: "https://fixture.example.com/about", source: { kind: "manual" }, now: T0 });
    await expect(repo.createProspect(duplicate)).rejects.toThrow(/unique/i);
  });

  it("uses optimistic revision checks", async () => {
    const current = (await repo.listProspects("sb:owner-one"))[0]!;
    const audited = attachTrustedAudit(current, handoff, T0, new Date(T0.getTime() + 1_000));
    expect(await repo.updateProspect(audited, current.revision)).toEqual(audited);
    expect(await repo.updateProspect(audited, current.revision)).toBeNull();
  });

  it("atomically rejects a pre-send transition after suppression wins the race", async () => {
    const repair = readyRepair();
    const drafted = applyProspectAction(repair, {
      action: "build-draft", recipientEmail: "race@fixture.example.com", recipientName: null,
      postalAddress: "123 Example Street, Tampa, FL 33602", contactSource: "Public contact page",
      jurisdiction: "united-states", recipientType: "corporate-business", suppressionChecked: true,
      optOutMonitored: true, outreachRulesReviewed: true,
    }, new Date(T0.getTime() + 4_000));
    const raceRepo = new SqliteRepo(":memory:"); await raceRepo.createProspect(drafted);
    const suppressed = applyProspectAction(drafted, { action: "suppress", note: "Operator suppression." }, new Date(T0.getTime() + 5_000));
    const approved = applyProspectAction(drafted, { action: "approve", suppressionChecked: true }, new Date(T0.getTime() + 5_000));
    const emailDigest = recipientEmailDigest("RACE@fixture.example.com ");
    expect(await raceRepo.suppressProspect(suppressed, drafted.revision, emailDigest, "operator")).toEqual(suppressed);
    expect(await raceRepo.updateProspectUnlessSuppressed(approved, drafted.revision, emailDigest)).toBeNull();
  });
});
