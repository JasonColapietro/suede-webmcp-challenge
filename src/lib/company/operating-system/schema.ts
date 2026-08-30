import { z } from "zod";

export const OperatingLifecycleSchema = z.enum([
  "planned",
  "building",
  "blocked",
  "live",
  "paused",
  "complete",
]);

export const EvidenceVerificationSchema = z.enum([
  "verified",
  "declared",
  "missing",
  "conflicted",
]);

export const EvidenceSourceSchema = z.enum([
  "fixture",
  "company",
  "agent",
  "run",
  "approval",
  "version",
  "deployment",
  "operator",
]);

const EvidenceHrefSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine(
    (value) =>
      (value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")) ||
      value.startsWith("https://"),
    "Evidence links must be internal paths or HTTPS URLs",
  );

export const EvidenceReceiptSchema = z.object({
  id: z.string().trim().min(1).max(240),
  source: EvidenceSourceSchema,
  scope: z.enum(["project", "dependency", "milestone", "approval"]),
  label: z.string().trim().min(1).max(160),
  claim: z.string().trim().min(1).max(500),
  observedAt: z.string().datetime({ offset: true }).nullable(),
  verification: EvidenceVerificationSchema,
  statusClaim: OperatingLifecycleSchema.optional(),
  production: z.boolean(),
  href: EvidenceHrefSchema.optional(),
}).strict();

export const AccountableOwnerSchema = z.object({
  kind: z.enum(["person", "team", "agent"]),
  label: z.string().trim().min(1).max(160),
}).strict();

export const OperatingDependencySchema = z.object({
  id: z.string().trim().min(1).max(240),
  label: z.string().trim().min(1).max(200),
  state: z.enum(["ready", "blocked", "unknown"]),
  projectId: z.string().trim().min(1).max(240).nullable(),
  evidenceIds: z.array(z.string().trim().min(1).max(240)).max(30),
}).strict();

export const OperatingProjectSchema = z.object({
  id: z.string().trim().min(1).max(240),
  name: z.string().trim().min(1).max(200),
  surface: z.string().trim().min(1).max(240),
  objective: z.string().trim().min(1).max(600),
  owner: AccountableOwnerSchema,
  status: OperatingLifecycleSchema,
  dependencies: z.array(OperatingDependencySchema).max(50),
  evidenceIds: z.array(z.string().trim().min(1).max(240)).max(100),
  lastVerifiedAt: z.string().datetime({ offset: true }).nullable(),
  nextAction: z.string().trim().min(1).max(500).nullable(),
  productionClaim: z.boolean(),
  sourceAdapter: z.string().trim().min(1).max(120),
}).strict();

export const OperatingMilestoneSchema = z.object({
  id: z.string().trim().min(1).max(240),
  projectId: z.string().trim().min(1).max(240),
  title: z.string().trim().min(1).max(240),
  outcome: z.string().trim().min(1).max(500),
  state: z.enum(["planned", "in-progress", "blocked", "complete"]),
  target: z.string().trim().min(1).max(160).nullable(),
  blocker: z.string().trim().min(1).max(500).nullable(),
  owner: AccountableOwnerSchema,
  evidenceIds: z.array(z.string().trim().min(1).max(240)).max(50),
  href: EvidenceHrefSchema.optional(),
}).strict();

export const OperatingApprovalSchema = z.object({
  id: z.string().trim().min(1).max(240),
  companyId: z.string().trim().min(1).max(240),
  companyName: z.string().trim().min(1).max(200),
  kind: z.enum([
    "enable_live_selling",
    "fire_publish_gated",
    "fire_over_threshold",
    "hire_employee",
  ]),
  title: z.string().trim().min(1).max(240),
  subject: z.string().trim().min(1).max(240),
  requestedAt: z.string().datetime({ offset: true }),
  costLabel: z.string().trim().min(1).max(240),
  evidenceIds: z.array(z.string().trim().min(1).max(240)).max(20),
  href: EvidenceHrefSchema,
}).strict();

export const OperatingAdapterResultSchema = z.object({
  adapterId: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(160),
  status: z.enum(["ok", "partial", "unavailable"]),
  checkedAt: z.string().datetime({ offset: true }),
  note: z.string().trim().min(1).max(500),
  projects: z.array(OperatingProjectSchema).max(100),
  milestones: z.array(OperatingMilestoneSchema).max(300),
  evidence: z.array(EvidenceReceiptSchema).max(1_000),
  approvals: z.array(OperatingApprovalSchema).max(100),
}).strict();

export const RealityFindingSchema = z.object({
  id: z.string().trim().min(1).max(320),
  rule: z.enum([
    "missing-evidence",
    "stale-evidence",
    "conflicting-status",
    "blocked-dependency",
    "unverified-production",
    "unresolved-approval",
    "missing-next-action",
  ]),
  projectId: z.string().trim().min(1).max(240).nullable(),
  title: z.string().trim().min(1).max(240),
  explanation: z.string().trim().min(1).max(700),
  severity: z.enum(["critical", "high", "medium", "low"]),
  confidence: z.enum(["high", "medium", "low"]),
  evidenceIds: z.array(z.string().trim().min(1).max(240)).max(50),
  nextAction: z.string().trim().min(1).max(500),
}).strict();

export const SnapshotProjectBaselineSchema = z.object({
  id: z.string().trim().min(1).max(240),
  status: OperatingLifecycleSchema,
  evidenceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  nextAction: z.string().trim().min(1).max(500).nullable(),
}).strict();

export const SnapshotFindingBaselineSchema = z.object({
  id: z.string().trim().min(1).max(320),
  severity: z.enum(["critical", "high", "medium", "low"]),
}).strict();

export const OperatingSnapshotBaselineSchema = z.object({
  scopeId: z.string().regex(/^[a-f0-9]{64}$/),
  snapshotId: z.string().regex(/^[a-f0-9]{64}$/),
  generatedAt: z.string().datetime({ offset: true }),
  projects: z.array(SnapshotProjectBaselineSchema).max(100),
  findings: z.array(SnapshotFindingBaselineSchema).max(500),
}).strict();

export const SnapshotChangeSchema = z.object({
  kind: z.enum(["project-added", "project-removed", "status", "evidence", "next-action", "finding"]),
  projectId: z.string().trim().min(1).max(240).nullable(),
  summary: z.string().trim().min(1).max(500),
}).strict();

export const ExecutiveSnapshotSchema = z.object({
  changed: z.array(SnapshotChangeSchema).max(100),
  blockedProjectIds: z.array(z.string().trim().min(1).max(240)).max(100),
  needsJason: z.array(z.string().trim().min(1).max(500)).max(50),
  nextActions: z.array(z.string().trim().min(1).max(500)).max(20),
}).strict();

export const OperatingSystemSnapshotSchema = z.object({
  snapshotId: z.string().regex(/^[a-f0-9]{64}$/),
  generatedAt: z.string().datetime({ offset: true }),
  coverageNote: z.string().trim().min(1).max(700),
  adapters: z.array(
    OperatingAdapterResultSchema.pick({
      adapterId: true,
      label: true,
      status: true,
      checkedAt: true,
      note: true,
    }),
  ).max(20),
  projects: z.array(OperatingProjectSchema).max(100),
  milestones: z.array(OperatingMilestoneSchema).max(300),
  evidence: z.array(EvidenceReceiptSchema).max(1_000),
  approvals: z.array(OperatingApprovalSchema).max(100),
  findings: z.array(RealityFindingSchema).max(500),
  executive: ExecutiveSnapshotSchema,
  baseline: OperatingSnapshotBaselineSchema,
}).strict();

export const OperatingRefreshRequestSchema = z.object({
  baseline: OperatingSnapshotBaselineSchema.optional(),
}).strict();

export type OperatingLifecycle = z.infer<typeof OperatingLifecycleSchema>;
export type EvidenceReceipt = z.infer<typeof EvidenceReceiptSchema>;
export type OperatingProject = z.infer<typeof OperatingProjectSchema>;
export type OperatingMilestone = z.infer<typeof OperatingMilestoneSchema>;
export type OperatingApproval = z.infer<typeof OperatingApprovalSchema>;
export type OperatingAdapterResult = z.infer<typeof OperatingAdapterResultSchema>;
export type RealityFinding = z.infer<typeof RealityFindingSchema>;
export type OperatingSnapshotBaseline = z.infer<typeof OperatingSnapshotBaselineSchema>;
export type SnapshotChange = z.infer<typeof SnapshotChangeSchema>;
export type ExecutiveSnapshot = z.infer<typeof ExecutiveSnapshotSchema>;
export type OperatingSystemSnapshot = z.infer<typeof OperatingSystemSnapshotSchema>;
