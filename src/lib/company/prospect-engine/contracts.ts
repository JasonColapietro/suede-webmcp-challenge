import { z } from "zod";
import {
  OutboundDiagnosticDraftSchema,
  ScanDiagnosticHandoffSchema,
  ScanPreparedRepairSchema,
} from "../operating-system/outbound-diagnostic";

const CleanText = z.string().trim().min(1).max(500);
const IsoInstant = z.string().datetime({ offset: true });
const Digest = z.string().regex(/^[a-f0-9]{64}$/);

function isPublicHostname(value: string): boolean {
  const host = value.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".") || host.includes(":")) return false;
  if (/^\d+(?:\.\d+){3}$/.test(host)) return false;
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(host)) {
    return false;
  }
  return ![".localhost", ".local", ".internal", ".lan", ".home.arpa", ".example", ".invalid", ".test"]
    .some((suffix) => host === suffix.slice(1) || host.endsWith(suffix));
}

export const ProspectWebsiteSchema = z.string().trim().min(1).max(2_048).transform((value, context) => {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" ||
      !isPublicHostname(url.hostname)
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Use a clean public website URL without credentials, query parameters, fragments, IPs, or local names." });
      return z.NEVER;
    }
    url.hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    return url.toString();
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Use a valid public HTTP(S) website URL." });
    return z.NEVER;
  }
});

export const ProspectStageSchema = z.enum([
  "discovered",
  "audited",
  "reproduced",
  "repair_ready",
  "draft_ready",
  "approved",
  "sent",
  "follow_up_due",
  "replied",
  "opted_out",
  "closed",
]);

export const ProspectSourceSchema = z.object({
  kind: z.literal("manual"),
  attribution: z.literal("Manual website import"),
}).strict();

export const ProspectAuditReceiptSchema = z.object({
  kind: z.literal("optimize-operator-audit"),
  handoff: ScanDiagnosticHandoffSchema,
  requestedAt: IsoInstant,
  receivedAt: IsoInstant,
  digest: Digest,
}).strict();

export const ProspectReproductionReceiptSchema = z.object({
  sourceUrl: ProspectWebsiteSchema,
  reproducedAt: IsoInstant,
  operatorNote: CleanText,
  auditDigest: Digest,
  digest: Digest,
}).strict();

export const ProspectRepairReceiptSchema = z.object({
  primaryFindingId: z.string().trim().min(1).max(64),
  sourcePreparedRepair: ScanPreparedRepairSchema.nullable(),
  preparedRepair: z.string().trim().min(20).max(4_000),
  verificationStep: z.string().trim().min(10).max(1_200),
  reproductionDigest: Digest,
  createdAt: IsoInstant,
  digest: Digest,
}).strict();

export const ProspectDraftReceiptSchema = z.object({
  draft: OutboundDiagnosticDraftSchema,
  recipientEmail: z.string().trim().email().max(320),
  contactSource: z.string().trim().min(3).max(240),
  jurisdiction: z.enum(["united-states", "other-reviewed"]),
  recipientType: z.enum(["corporate-business", "individual-or-unknown"]),
  repairDigest: Digest,
  createdAt: IsoInstant,
  digest: Digest,
}).strict();

export const ProspectApprovalReceiptSchema = z.object({
  draftDigest: Digest,
  suppressionCheckedAt: IsoInstant,
  approvedAt: IsoInstant,
  digest: Digest,
  consumedAt: IsoInstant.nullable(),
}).strict();

export const ProspectHandoffReceiptSchema = z.object({
  kind: z.literal("operator-email-handoff-lease"),
  approvalDigest: Digest,
  draftDigest: Digest,
  recipientEmail: z.string().trim().email().max(320),
  idempotencyKey: z.string().trim().min(8).max(200),
  recordRevision: z.number().int().positive(),
  createdAt: IsoInstant,
  digest: Digest,
  consumedAt: IsoInstant.nullable(),
}).strict();

export const ProspectDeliveryReceiptSchema = z.object({
  kind: z.literal("operator-confirmed-email-client"),
  approvalDigest: Digest,
  draftDigest: Digest,
  handoffDigest: Digest,
  recipientEmail: z.string().trim().email().max(320),
  idempotencyKey: z.string().trim().min(8).max(200),
  handoffCreatedAt: IsoInstant,
  confirmedAt: IsoInstant,
  providerDeliveryClaimed: z.literal(false),
  digest: Digest,
}).strict();

export const ProspectSuppressionSchema = z.object({
  suppressed: z.boolean(),
  reason: z.enum(["none", "operator", "opt-out"]),
  recordedAt: IsoInstant.nullable(),
}).strict();

export const ProspectRecordSchema = z.object({
  id: z.string().uuid(),
  ownerId: z.string().trim().min(1).max(512),
  domain: z.string().trim().min(1).max(253),
  websiteUrl: ProspectWebsiteSchema,
  source: ProspectSourceSchema,
  stage: ProspectStageSchema,
  audit: ProspectAuditReceiptSchema.nullable(),
  reproduction: ProspectReproductionReceiptSchema.nullable(),
  repair: ProspectRepairReceiptSchema.nullable(),
  draft: ProspectDraftReceiptSchema.nullable(),
  approval: ProspectApprovalReceiptSchema.nullable(),
  handoff: ProspectHandoffReceiptSchema.nullable(),
  delivery: ProspectDeliveryReceiptSchema.nullable(),
  suppression: ProspectSuppressionSchema,
  followUpAt: IsoInstant.nullable(),
  outcomeNote: z.string().trim().min(1).max(500).nullable(),
  createdAt: IsoInstant,
  updatedAt: IsoInstant,
  revision: z.number().int().positive(),
}).strict();

export const ImportProspectRequestSchema = z.object({
  websiteUrl: ProspectWebsiteSchema,
  source: z.object({ kind: z.literal("manual") }).strict(),
}).strict();

export const DiscoverProspectsRequestSchema = z.object({
  query: z.string().trim().min(2).max(160),
}).strict();

export const EphemeralPlaceCandidateSchema = z.object({
  placeId: z.string().trim().min(1).max(256),
  displayName: z.string().trim().min(1).max(300),
  websiteUrl: ProspectWebsiteSchema.nullable(),
  mapsUri: z.string().url().max(2_048).nullable(),
  sourceAttribution: z.literal("Google Maps"),
}).strict();

export const ProspectActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("audit") }).strict(),
  z.object({
    action: z.literal("reproduce"),
    sourceUrl: ProspectWebsiteSchema,
    operatorNote: CleanText,
  }).strict(),
  z.object({
    action: z.literal("prepare-repair"),
    primaryFindingId: z.string().trim().min(1).max(64),
    preparedRepair: z.string().trim().min(20).max(4_000),
    verificationStep: z.string().trim().min(10).max(1_200),
  }).strict(),
  z.object({
    action: z.literal("build-draft"),
    recipientEmail: z.string().trim().email().max(320),
    recipientName: z.string().trim().min(1).max(120).nullable(),
    postalAddress: z.string().trim().min(10).max(300),
    contactSource: z.string().trim().min(3).max(240),
    jurisdiction: z.enum(["united-states", "other-reviewed"]),
    recipientType: z.enum(["corporate-business", "individual-or-unknown"]),
    suppressionChecked: z.literal(true),
    optOutMonitored: z.literal(true),
    outreachRulesReviewed: z.literal(true),
  }).strict(),
  z.object({ action: z.literal("approve"), suppressionChecked: z.literal(true) }).strict(),
  z.object({
    action: z.literal("email-handoff"),
    idempotencyKey: z.string().trim().min(8).max(200),
  }).strict(),
  z.object({
    action: z.literal("confirm-delivery"),
    approvalDigest: Digest,
    handoffDigest: Digest,
    recipientEmail: z.string().trim().email().max(320),
    idempotencyKey: z.string().trim().min(8).max(200),
  }).strict(),
  z.object({ action: z.literal("mark-follow-up-due") }).strict(),
  z.object({ action: z.literal("mark-replied"), note: CleanText }).strict(),
  z.object({ action: z.literal("opt-out"), note: CleanText.optional() }).strict(),
  z.object({ action: z.literal("close"), note: CleanText }).strict(),
  z.object({ action: z.literal("suppress"), note: CleanText }).strict(),
]);

export type ProspectRecord = z.infer<typeof ProspectRecordSchema>;
export type ProspectAction = z.infer<typeof ProspectActionSchema>;
export type EphemeralPlaceCandidate = z.infer<typeof EphemeralPlaceCandidateSchema>;
