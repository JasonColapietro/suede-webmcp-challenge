import { createHash, createHmac, randomUUID } from "node:crypto";
import {
  buildOutboundDiagnostic,
  formatOutboundDiagnosticText,
  type ScanDiagnosticHandoff,
} from "../operating-system/outbound-diagnostic";
import {
  ProspectActionSchema,
  ProspectRecordSchema,
  type ProspectAction,
  type ProspectRecord,
} from "./contracts";

export class ProspectTransitionError extends Error {}

const MAX_AUDIT_AGE_MS = 30 * 60 * 1_000;
const MAX_AUDIT_CLOCK_SKEW_MS = 5 * 1_000;
const MAX_MAILTO_URL_BYTES = 1_800;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function nowIso(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new ProspectTransitionError("A valid transition time is required.");
  return now.toISOString();
}

function time(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new ProspectTransitionError("Prospect receipt time is invalid.");
  return parsed;
}

function assertOrdered(earlier: string, later: string, label: string): void {
  if (time(earlier) > time(later)) throw new ProspectTransitionError(`${label} timestamps are out of order.`);
}

function domainOf(websiteUrl: string): string {
  return new URL(websiteUrl).hostname.toLowerCase().replace(/^www\./, "");
}

export function normalizeRecipientEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function recipientEmailDigest(email: string): string {
  const secret = process.env.PROSPECT_SUPPRESSION_HMAC_SECRET;
  if (!secret || secret.length < 32) throw new ProspectTransitionError("Prospect suppression HMAC secret is not configured.");
  return `v1:${createHmac("sha256", secret).update(normalizeRecipientEmail(email), "utf8").digest("hex")}`;
}

function requireStage(record: ProspectRecord, allowed: readonly ProspectRecord["stage"][]): void {
  if (!allowed.includes(record.stage)) {
    throw new ProspectTransitionError(`Action is not allowed while prospect is ${record.stage}.`);
  }
}

function assertDigest(actual: string, payload: unknown, label: string): void {
  if (actual !== digest(payload)) throw new ProspectTransitionError(`${label} receipt digest is invalid.`);
}

export function validateProspectIntegrity(value: ProspectRecord): ProspectRecord {
  let record: ProspectRecord;
  try {
    record = ProspectRecordSchema.parse(value);
  } catch {
    throw new ProspectTransitionError("Prospect record shape is invalid.");
  }
  if (domainOf(record.websiteUrl) !== record.domain) {
    throw new ProspectTransitionError("Prospect domain does not match its website.");
  }
  assertOrdered(record.createdAt, record.updatedAt, "Prospect record");
  if (record.suppression.suppressed !== (record.suppression.reason !== "none")) {
    throw new ProspectTransitionError("Prospect suppression state is inconsistent.");
  }
  if (record.suppression.suppressed !== (record.suppression.recordedAt !== null)) {
    throw new ProspectTransitionError("Prospect suppression timestamp is inconsistent.");
  }

  if (record.audit) {
    const { digest: receiptDigest, ...payload } = record.audit;
    assertDigest(receiptDigest, payload, "Audit");
    if (record.audit.handoff.domain.toLowerCase().replace(/^www\./, "") !== record.domain) {
      throw new ProspectTransitionError("Audit domain does not match the prospect.");
    }
    assertOrdered(record.audit.requestedAt, record.audit.receivedAt, "Audit request");
    if (time(record.audit.handoff.observedAt) + MAX_AUDIT_CLOCK_SKEW_MS < time(record.audit.requestedAt)) {
      throw new ProspectTransitionError("Audit observation predates the server request.");
    }
    if (time(record.audit.handoff.observedAt) > time(record.audit.receivedAt) + MAX_AUDIT_CLOCK_SKEW_MS) {
      throw new ProspectTransitionError("Audit observation is in the future.");
    }
    if (time(record.audit.receivedAt) - time(record.audit.handoff.observedAt) > MAX_AUDIT_AGE_MS) {
      throw new ProspectTransitionError("Audit observation is stale.");
    }
  }
  if (record.reproduction) {
    if (!record.audit || record.reproduction.auditDigest !== record.audit.digest) {
      throw new ProspectTransitionError("Reproduction is not bound to the current audit.");
    }
    const { digest: receiptDigest, ...payload } = record.reproduction;
    assertDigest(receiptDigest, payload, "Reproduction");
    if (domainOf(record.reproduction.sourceUrl) !== record.domain) {
      throw new ProspectTransitionError("Reproduction source does not match the prospect domain.");
    }
    assertOrdered(record.audit.receivedAt, record.reproduction.reproducedAt, "Reproduction");
  }
  if (record.repair) {
    if (!record.reproduction || record.repair.reproductionDigest !== record.reproduction.digest) {
      throw new ProspectTransitionError("Repair is not bound to the current reproduction.");
    }
    if (!record.audit?.handoff.findings.some((finding) => finding.id === record.repair?.primaryFindingId)) {
      throw new ProspectTransitionError("Repair does not target the current audit.");
    }
    const { digest: receiptDigest, ...payload } = record.repair;
    assertDigest(receiptDigest, payload, "Repair");
    assertOrdered(record.reproduction.reproducedAt, record.repair.createdAt, "Repair");
  }
  if (record.draft) {
    if (!record.repair || record.draft.repairDigest !== record.repair.digest) {
      throw new ProspectTransitionError("Draft is not bound to the current repair.");
    }
    if (normalizeRecipientEmail(record.draft.recipientEmail) !== record.draft.recipientEmail) {
      throw new ProspectTransitionError("Draft recipient email is not normalized.");
    }
    const { digest: receiptDigest, ...payload } = record.draft;
    assertDigest(receiptDigest, payload, "Draft");
    assertOrdered(record.repair.createdAt, record.draft.createdAt, "Draft");
  }
  if (record.approval) {
    if (!record.draft || record.approval.draftDigest !== record.draft.digest) {
      throw new ProspectTransitionError("Approval is not bound to the current draft.");
    }
    const { digest: receiptDigest, consumedAt: _consumedAt, ...payload } = record.approval;
    assertDigest(receiptDigest, payload, "Approval");
    assertOrdered(record.draft.createdAt, record.approval.approvedAt, "Approval");
    if (record.approval.suppressionCheckedAt !== record.approval.approvedAt) {
      throw new ProspectTransitionError("Approval suppression check is not current.");
    }
    if (record.approval.consumedAt) assertOrdered(record.approval.approvedAt, record.approval.consumedAt, "Approval consumption");
  }
  if (record.handoff) {
    if (!record.approval || !record.draft) throw new ProspectTransitionError("Handoff lease has no current approval.");
    if (
      record.handoff.approvalDigest !== record.approval.digest
      || record.handoff.draftDigest !== record.draft.digest
      || normalizeRecipientEmail(record.handoff.recipientEmail) !== record.draft.recipientEmail
      || record.handoff.recordRevision >= record.revision
    ) {
      throw new ProspectTransitionError("Handoff lease is not bound to the current approval revision.");
    }
    const { digest: receiptDigest, consumedAt: _consumedAt, ...payload } = record.handoff;
    assertDigest(receiptDigest, payload, "Handoff");
    assertOrdered(record.approval.approvedAt, record.handoff.createdAt, "Handoff");
    if (record.handoff.consumedAt) assertOrdered(record.handoff.createdAt, record.handoff.consumedAt, "Handoff consumption");
  }
  if (record.delivery) {
    if (!record.handoff || !record.approval || !record.draft) {
      throw new ProspectTransitionError("Delivery has no current handoff lease.");
    }
    if (
      record.delivery.approvalDigest !== record.approval.digest
      || record.delivery.draftDigest !== record.draft.digest
      || record.delivery.handoffDigest !== record.handoff.digest
      || record.delivery.recipientEmail !== record.draft.recipientEmail
      || record.delivery.idempotencyKey !== record.handoff.idempotencyKey
      || record.delivery.handoffCreatedAt !== record.handoff.createdAt
    ) {
      throw new ProspectTransitionError("Delivery is not bound to the current handoff lease.");
    }
    const { digest: receiptDigest, ...payload } = record.delivery;
    assertDigest(receiptDigest, payload, "Delivery");
    assertOrdered(record.handoff.createdAt, record.delivery.confirmedAt, "Delivery");
  }

  const noLaterThan = (last: "audit" | "reproduction" | "repair" | "draft" | "approval" | "handoff"): boolean => {
    const fields = ["audit", "reproduction", "repair", "draft", "approval", "handoff", "delivery"] as const;
    return fields.slice(fields.indexOf(last) + 1).every((field) => record[field] === null);
  };
  if (record.stage === "discovered" && !(record.audit === null && noLaterThan("audit"))) throw new ProspectTransitionError("Discovered lifecycle is impossible.");
  if (record.stage === "audited" && !(record.audit && record.reproduction === null && noLaterThan("reproduction"))) throw new ProspectTransitionError("Audited lifecycle is impossible.");
  if (record.stage === "reproduced" && !(record.reproduction && record.repair === null && noLaterThan("repair"))) throw new ProspectTransitionError("Reproduced lifecycle is impossible.");
  if (record.stage === "repair_ready" && !(record.repair && record.draft === null && noLaterThan("draft"))) throw new ProspectTransitionError("Repair-ready lifecycle is impossible.");
  if (record.stage === "draft_ready" && !(record.draft && record.approval === null && noLaterThan("approval"))) throw new ProspectTransitionError("Draft-ready lifecycle is impossible.");
  if (record.stage === "approved" && !(record.approval && record.approval.consumedAt === null && record.delivery === null && (!record.handoff || record.handoff.consumedAt === null))) throw new ProspectTransitionError("Approved lifecycle is impossible.");
  if (["sent", "follow_up_due", "replied", "opted_out"].includes(record.stage)) {
    if (!(record.delivery && record.approval?.consumedAt && record.handoff?.consumedAt)) throw new ProspectTransitionError("Delivered lifecycle is impossible.");
  }
  if (["sent", "follow_up_due"].includes(record.stage) && !record.followUpAt) throw new ProspectTransitionError("Active delivery lifecycle requires a follow-up time.");
  if (["replied", "opted_out", "closed"].includes(record.stage) && record.followUpAt !== null) throw new ProspectTransitionError("Terminal lifecycle cannot retain a follow-up time.");
  if (record.stage === "opted_out" && !(record.suppression.suppressed && record.suppression.reason === "opt-out")) throw new ProspectTransitionError("Opt-out lifecycle is impossible.");
  if (record.stage === "closed" && !record.delivery && !(record.suppression.suppressed && record.suppression.reason === "operator")) throw new ProspectTransitionError("Closed lifecycle is impossible.");
  return record;
}

function revise(record: ProspectRecord, patch: Partial<ProspectRecord>, now: Date): ProspectRecord {
  if (now.getTime() < time(record.updatedAt)) throw new ProspectTransitionError("Transition time precedes the current record revision.");
  return validateProspectIntegrity(ProspectRecordSchema.parse({
    ...record,
    ...patch,
    updatedAt: nowIso(now),
    revision: record.revision + 1,
  }));
}

export function createProspectRecord(input: {
  readonly ownerId: string;
  readonly websiteUrl: string;
  readonly source: { readonly kind: "manual" };
  readonly now?: Date;
}): ProspectRecord {
  const now = input.now ?? new Date();
  const timestamp = nowIso(now);
  return validateProspectIntegrity(ProspectRecordSchema.parse({
    id: randomUUID(), ownerId: input.ownerId, domain: domainOf(input.websiteUrl), websiteUrl: input.websiteUrl,
    source: { kind: "manual", attribution: "Manual website import" }, stage: "discovered",
    audit: null, reproduction: null, repair: null, draft: null, approval: null, handoff: null, delivery: null,
    suppression: { suppressed: false, reason: "none", recordedAt: null }, followUpAt: null, outcomeNote: null,
    createdAt: timestamp, updatedAt: timestamp, revision: 1,
  }));
}

export function attachTrustedAudit(currentValue: ProspectRecord, handoff: ScanDiagnosticHandoff, requestedAt: Date, now: Date = new Date()): ProspectRecord {
  const current = validateProspectIntegrity(currentValue);
  requireStage(current, ["discovered", "audited"]);
  if (handoff.domain.toLowerCase().replace(/^www\./, "") !== current.domain) throw new ProspectTransitionError("Optimize audit domain does not match the prospect website.");
  const requested = nowIso(requestedAt); const received = nowIso(now); const observed = time(handoff.observedAt);
  if (requestedAt.getTime() > now.getTime() || observed + MAX_AUDIT_CLOCK_SKEW_MS < requestedAt.getTime() || observed > now.getTime() + MAX_AUDIT_CLOCK_SKEW_MS || now.getTime() - observed > MAX_AUDIT_AGE_MS) {
    throw new ProspectTransitionError("Optimize audit timing is stale or invalid.");
  }
  const payload = { kind: "optimize-operator-audit" as const, handoff, requestedAt: requested, receivedAt: received };
  return revise(current, { stage: "audited", audit: { ...payload, digest: digest(payload) }, reproduction: null, repair: null, draft: null, approval: null, handoff: null, delivery: null, followUpAt: null }, now);
}

function reproduce(current: ProspectRecord, action: Extract<ProspectAction, { action: "reproduce" }>, now: Date): ProspectRecord {
  requireStage(current, ["audited"]);
  if (!current.audit || domainOf(action.sourceUrl) !== current.domain) throw new ProspectTransitionError("Reproduction requires the audited prospect domain.");
  const payload = { sourceUrl: action.sourceUrl, reproducedAt: nowIso(now), operatorNote: action.operatorNote, auditDigest: current.audit.digest };
  return revise(current, { stage: "reproduced", reproduction: { ...payload, digest: digest(payload) } }, now);
}

function prepareRepair(current: ProspectRecord, action: Extract<ProspectAction, { action: "prepare-repair" }>, now: Date): ProspectRecord {
  requireStage(current, ["reproduced", "repair_ready"]);
  if (!current.audit || !current.reproduction) throw new ProspectTransitionError("Reproduced audit evidence is required.");
  const finding = current.audit.handoff.findings.find((candidate) => candidate.id === action.primaryFindingId);
  if (!finding) throw new ProspectTransitionError("Repair must target an audited finding.");
  const payload = { primaryFindingId: action.primaryFindingId, sourcePreparedRepair: finding.preparedRepair ?? null, preparedRepair: action.preparedRepair, verificationStep: action.verificationStep, reproductionDigest: current.reproduction.digest, createdAt: nowIso(now) };
  return revise(current, { stage: "repair_ready", repair: { ...payload, digest: digest(payload) }, draft: null, approval: null, handoff: null, delivery: null }, now);
}

function buildDraft(current: ProspectRecord, action: Extract<ProspectAction, { action: "build-draft" }>, now: Date): ProspectRecord {
  requireStage(current, ["repair_ready", "draft_ready", "approved"]);
  if (!current.audit || !current.reproduction || !current.repair) throw new ProspectTransitionError("A trusted audit, reproduction receipt, and prepared repair are required.");
  if (current.suppression.suppressed || current.handoff) throw new ProspectTransitionError("Suppressed or handed-off prospects cannot receive a replacement draft.");
  const recipientEmail = normalizeRecipientEmail(action.recipientEmail);
  const draft = buildOutboundDiagnostic({ handoff: current.audit.handoff, mode: "commercial-diagnostic", recipientName: action.recipientName, senderProfile: "jason-colapietro", postalAddress: action.postalAddress, contactSource: action.contactSource, recipientJurisdiction: action.jurisdiction, recipientType: action.recipientType, primaryFindingId: current.repair.primaryFindingId, preparedRepair: current.repair.preparedRepair, verificationStep: current.repair.verificationStep, reproducedAtSource: true, suppressionChecked: action.suppressionChecked, optOutMonitored: action.optOutMonitored, outreachRulesReviewed: action.outreachRulesReviewed }, now);
  const payload = { draft, recipientEmail, contactSource: action.contactSource, jurisdiction: action.jurisdiction, recipientType: action.recipientType, repairDigest: current.repair.digest, createdAt: nowIso(now) };
  return revise(current, { stage: "draft_ready", draft: { ...payload, digest: digest(payload) }, approval: null, handoff: null, delivery: null }, now);
}

function approve(current: ProspectRecord, now: Date): ProspectRecord {
  requireStage(current, ["draft_ready"]);
  if (!current.draft || current.suppression.suppressed) throw new ProspectTransitionError("A current unsuppressed draft is required.");
  const approvedAt = nowIso(now); const payload = { draftDigest: current.draft.digest, suppressionCheckedAt: approvedAt, approvedAt };
  return revise(current, { stage: "approved", approval: { ...payload, digest: digest(payload), consumedAt: null }, handoff: null }, now);
}

export function createHandoffLease(currentValue: ProspectRecord, idempotencyKey: string, now: Date = new Date()): ProspectRecord {
  const current = validateProspectIntegrity(currentValue);
  requireStage(current, ["approved"]);
  if (!current.draft || !current.approval || current.approval.consumedAt || current.suppression.suppressed) throw new ProspectTransitionError("A fresh unsuppressed approval is required.");
  if (current.handoff) {
    if (current.handoff.idempotencyKey === idempotencyKey && current.handoff.approvalDigest === current.approval.digest && current.handoff.draftDigest === current.draft.digest && current.handoff.recipientEmail === current.draft.recipientEmail && current.handoff.consumedAt === null) return current;
    throw new ProspectTransitionError("An email handoff lease already exists for this approval.");
  }
  const payload = { kind: "operator-email-handoff-lease" as const, approvalDigest: current.approval.digest, draftDigest: current.draft.digest, recipientEmail: current.draft.recipientEmail, idempotencyKey, recordRevision: current.revision, createdAt: nowIso(now) };
  return revise(current, { handoff: { ...payload, digest: digest(payload), consumedAt: null } }, now);
}

function confirmDelivery(current: ProspectRecord, action: Extract<ProspectAction, { action: "confirm-delivery" }>, now: Date): ProspectRecord {
  const recipientEmail = normalizeRecipientEmail(action.recipientEmail);
  if (current.delivery) {
    if (current.delivery.idempotencyKey === action.idempotencyKey && current.delivery.approvalDigest === action.approvalDigest && current.delivery.handoffDigest === action.handoffDigest && current.delivery.recipientEmail === recipientEmail) return current;
    throw new ProspectTransitionError("Delivery is already confirmed with different bound inputs.");
  }
  requireStage(current, ["approved"]);
  if (!current.draft || !current.approval || !current.handoff || current.suppression.suppressed) throw new ProspectTransitionError("A current handoff lease is required.");
  if (current.approval.consumedAt || current.handoff.consumedAt || action.approvalDigest !== current.approval.digest || action.handoffDigest !== current.handoff.digest || action.idempotencyKey !== current.handoff.idempotencyKey || recipientEmail !== current.draft.recipientEmail) {
    throw new ProspectTransitionError("Delivery confirmation does not match the current handoff lease.");
  }
  const confirmedAt = nowIso(now);
  const payload = { kind: "operator-confirmed-email-client" as const, approvalDigest: current.approval.digest, draftDigest: current.draft.digest, handoffDigest: current.handoff.digest, recipientEmail: current.draft.recipientEmail, idempotencyKey: current.handoff.idempotencyKey, handoffCreatedAt: current.handoff.createdAt, confirmedAt, providerDeliveryClaimed: false as const };
  return revise(current, { stage: "sent", approval: { ...current.approval, consumedAt: confirmedAt }, handoff: { ...current.handoff, consumedAt: confirmedAt }, delivery: { ...payload, digest: digest(payload) }, followUpAt: new Date(now.getTime() + 4 * 24 * 60 * 60 * 1_000).toISOString() }, now);
}

function terminal(current: ProspectRecord, stage: "replied" | "opted_out" | "closed", note: string | null, now: Date): ProspectRecord {
  requireStage(current, ["sent", "follow_up_due"]);
  return revise(current, { stage, outcomeNote: note, followUpAt: null, ...(stage === "opted_out" ? { suppression: { suppressed: true, reason: "opt-out" as const, recordedAt: nowIso(now) } } : {}) }, now);
}

export function applyProspectAction(value: ProspectRecord, rawAction: ProspectAction, now: Date = new Date()): ProspectRecord {
  const current = validateProspectIntegrity(value); const action = ProspectActionSchema.parse(rawAction);
  if (action.action === "audit" || action.action === "email-handoff") throw new ProspectTransitionError(`${action.action} requires its server adapter.`);
  if (action.action === "reproduce") return reproduce(current, action, now);
  if (action.action === "prepare-repair") return prepareRepair(current, action, now);
  if (action.action === "build-draft") return buildDraft(current, action, now);
  if (action.action === "approve") return approve(current, now);
  if (action.action === "confirm-delivery") return confirmDelivery(current, action, now);
  if (action.action === "mark-follow-up-due") { requireStage(current, ["sent"]); if (!current.followUpAt || time(current.followUpAt) > now.getTime()) throw new ProspectTransitionError("Follow-up is not due yet."); return revise(current, { stage: "follow_up_due" }, now); }
  if (action.action === "mark-replied") return terminal(current, "replied", action.note, now);
  if (action.action === "opt-out") return terminal(current, "opted_out", action.note ?? "Recipient opted out.", now);
  if (action.action === "close") return terminal(current, "closed", action.note, now);
  if (action.action === "suppress") { if (["sent", "follow_up_due", "replied", "opted_out", "closed"].includes(current.stage)) throw new ProspectTransitionError("Use the opt-out or close outcome after delivery."); return revise(current, { suppression: { suppressed: true, reason: "operator", recordedAt: nowIso(now) }, outcomeNote: action.note, stage: "closed" }, now); }
  return current;
}

export interface HandoffPresentation {
  readonly mailtoUrl: string | null;
  readonly approvalDigest: string;
  readonly handoffDigest: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly copyFallback: { readonly recipientEmail: string; readonly subject: string; readonly body: string };
}

export function buildHandoffPresentation(value: ProspectRecord): HandoffPresentation {
  const current = validateProspectIntegrity(value); requireStage(current, ["approved"]);
  if (!current.draft || !current.approval || !current.handoff || current.approval.consumedAt || current.handoff.consumedAt || current.suppression.suppressed) throw new ProspectTransitionError("A fresh handoff lease is required.");
  const text = formatOutboundDiagnosticText(current.draft.draft); const body = text.replace(/^Subject: .*\n\n/u, "");
  const mailtoUrl = `mailto:${encodeURIComponent(current.draft.recipientEmail)}?subject=${encodeURIComponent(current.draft.draft.subject)}&body=${encodeURIComponent(body)}`;
  return { mailtoUrl: Buffer.byteLength(mailtoUrl, "utf8") <= MAX_MAILTO_URL_BYTES ? mailtoUrl : null, approvalDigest: current.approval.digest, handoffDigest: current.handoff.digest, idempotencyKey: current.handoff.idempotencyKey, createdAt: current.handoff.createdAt, copyFallback: { recipientEmail: current.draft.recipientEmail, subject: current.draft.draft.subject, body } };
}

export { digest as prospectDigest };
