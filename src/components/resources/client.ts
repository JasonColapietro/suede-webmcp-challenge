import { z } from "zod";
import { isGooglePlayAccessOnlyHost } from "@/lib/google-play-access-only";

type ResourceJson = string | number | boolean | null | readonly ResourceJson[] | { readonly [key: string]: ResourceJson };

const JsonValueSchema: z.ZodType<ResourceJson> = z.lazy(() => z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(),
  z.array(JsonValueSchema), z.record(JsonValueSchema),
]));
const JsonObjectSchema = z.record(JsonValueSchema);
const ProductStatusSchema = z.enum(["draft", "test", "live", "paused", "retired"]);
const PackStatusSchema = z.enum(["candidate", "approved", "live", "retired"]);
const FreshnessSchema = z.enum(["fresh", "stale", "mixed"]);
const ExecutionAccessSchema = z.enum(["free", "paid", "private"]);
const DiscoveryAccessSchema = z.enum(["public", "unlisted"]);
const SemanticHashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const PortfolioPackReferenceSchema = z.object({
  packVersionId: z.string(), revision: z.number().int().positive(), semanticHash: SemanticHashSchema,
}).strict();
const UrlsSchema = z.object({
  run: z.string(), card: z.string(), x402: z.string(), a2a: z.string(), public: z.string(),
}).strict();
const PortfolioMoneySchema = z.object({
  count: z.number().int().nonnegative(), amountUsdc: z.number().finite().nonnegative(),
}).strict();
const PortfolioUnknownMoneySchema = z.object({ count: z.null(), amountUsdc: z.null() }).strict();
const PortfolioPaymentsSchema = z.object({
  attempted: z.null(), free: z.number().int().nonnegative(), challenged: z.null(),
  executed: z.number().int().nonnegative(), credited: PortfolioMoneySchema,
  settled: PortfolioMoneySchema, refunded: PortfolioUnknownMoneySchema, failed: z.null(),
}).strict();
const CurrentReleaseSummarySchema = z.object({
  id: z.string(), resourceProductId: z.string(), packVersionId: z.string(), semanticHash: SemanticHashSchema,
  publicationKey: z.string(), publicationRequestHash: SemanticHashSchema,
  priceUsdc: z.number().finite().nonnegative(),
  executionAccess: ExecutionAccessSchema, discoveryAccess: DiscoveryAccessSchema,
  freshness: FreshnessSchema, payoutReady: z.boolean(),
  settlementState: z.enum(["off", "on"]), agentId: z.string(),
  agentStatus: z.enum(["draft", "live"]), flowVersionId: z.string(),
  deploymentId: z.string(), deploymentStatus: z.enum(["live", "retired"]),
  deploymentRetiredAt: z.string().nullable(), createdAt: z.string(), urls: UrlsSchema,
}).strict().superRefine((release, context) => {
  if ((release.deploymentStatus === "live") !== (release.deploymentRetiredAt === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "release deployment lifecycle is inconsistent" });
  }
});
const ResourceLifecycleRequestSchema = z.object({
  action: z.enum(["pause", "resume", "retire"]),
  expectedStatus: z.enum(["live", "paused"]),
  releaseId: z.string(), agentId: z.string(), deploymentId: z.string(),
}).strict().superRefine((value, context) => {
  if ((value.action === "pause" && value.expectedStatus !== "live") ||
      (value.action === "resume" && value.expectedStatus !== "paused")) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "invalid lifecycle transition" });
  }
});

const ResourcePortfolioItemSchema = z.object({
  id: z.string(), ownerId: z.string(), name: z.string(), slug: z.string(),
  status: ProductStatusSchema,
  executionAccess: ExecutionAccessSchema,
  discoveryAccess: DiscoveryAccessSchema,
  candidateRevision: z.number().int().nonnegative().nullable(),
  approvedPackVersionId: z.string().nullable(),
  livePackVersionId: z.string().nullable(),
  currentCandidate: PortfolioPackReferenceSchema.nullable(),
  approvedPack: PortfolioPackReferenceSchema.nullable(),
  livePack: PortfolioPackReferenceSchema.nullable(),
  portfolioFreshness: FreshnessSchema.nullable(),
  portfolioPayments: PortfolioPaymentsSchema,
  currentRelease: CurrentReleaseSummarySchema.nullable(),
  releaseCount: z.number().int().nonnegative(),
  runReceiptCount: z.number().int().nonnegative(),
}).strict();

const EvidenceSchema = z.object({
  id: z.string(), sourceSnapshotId: z.string(), locator: z.string(), observedAt: z.string(),
  fieldHash: z.string().optional(), confidence: z.number().optional(), conflict: z.string().optional(),
}).strict();
const RecordSchema = z.object({
  id: z.string(), fields: JsonObjectSchema, tags: z.array(z.string()), evidenceIds: z.array(z.string()),
  unknowns: z.array(z.string()).optional(), conflicts: z.array(z.string()).optional(),
}).strict();
const JobContractSchema = z.object({
  jobStatement: z.string(), buyerIntent: z.string(), inputSchema: JsonObjectSchema,
  outputSchema: JsonObjectSchema, unsupportedRequest: z.string(), evidenceRequirement: z.string(),
  safeExample: JsonValueSchema, reviewBoundary: z.string(), dataHandlingDisclosure: z.string(),
}).strict();
const PackContentSchema = z.object({
  recordSchema: JsonObjectSchema,
  filterFields: z.array(z.string()), returnFields: z.array(z.string()),
  taxonomy: z.array(z.object({ id: z.string(), label: z.string() }).strict()),
  records: z.array(RecordSchema), evidence: z.array(EvidenceSchema),
  sourceSnapshotIds: z.array(z.string()), jobContract: JobContractSchema,
}).strict();
const ResourcePackVersionSchema = z.object({
  id: z.string(), resourceProductId: z.string(), revision: z.number().int().positive(),
  status: PackStatusSchema, semanticHash: SemanticHashSchema, content: PackContentSchema,
  createdBy: z.string(), createdAt: z.string(), approvedBy: z.string().optional(), approvedAt: z.string().optional(),
}).strict();
const ResourcePackBundleSchema = z.object({
  resourceProductId: z.string(), packVersionId: z.string(), semanticHash: SemanticHashSchema,
  freshness: FreshnessSchema, content: PackContentSchema,
}).strict();

const CountFactSchema = z.object({
  count: z.number().int().nonnegative().nullable(),
  basis: z.enum(["resource_run_receipts", "not_recorded"]),
}).strict();
const MoneyFactSchema = CountFactSchema.extend({ amountUsdc: z.number().nonnegative().nullable() }).strict();
const TrustSchema = z.object({
  activity: z.object({ calls: CountFactSchema }).strict(),
  facts: z.object({
    attempted: CountFactSchema, free: CountFactSchema, challenged: CountFactSchema,
    executed: CountFactSchema, credited: MoneyFactSchema, settled: MoneyFactSchema,
    refunded: MoneyFactSchema, failed: CountFactSchema,
  }).strict(),
  quality: z.object({
    schemaValidExecutions: z.number().int().nonnegative(), evidenceBackedExecutions: z.number().int().nonnegative(),
    freshExecutions: z.number().int().nonnegative(), staleExecutions: z.number().int().nonnegative(),
    mixedExecutions: z.number().int().nonnegative(), unknownCount: z.number().int().nonnegative(),
    conflictCount: z.number().int().nonnegative(),
  }).strict(),
  rates: z.object({
    schemaValidRate: z.number().min(0).max(1).nullable(),
    evidenceCoverageRate: z.number().min(0).max(1).nullable(),
    freshRate: z.number().min(0).max(1).nullable(),
    staleRate: z.number().min(0).max(1).nullable(),
    mixedRate: z.number().min(0).max(1).nullable(),
    unknownRate: z.number().min(0).max(1).nullable(),
    conflictRate: z.number().min(0).max(1).nullable(),
  }).strict(),
  economics: z.object({
    price: z.object({
      executionCount: z.number().int().nonnegative(), totalUsdc: z.number().nonnegative(),
      averageUsdc: z.number().nonnegative().nullable(), basis: z.literal("resource_run_receipts"),
    }).strict(),
    cost: z.object({ status: z.literal("not_recorded"), amountUsdc: z.null() }).strict(),
    margin: z.object({ status: z.literal("not_recorded"), amountUsdc: z.null() }).strict(),
  }).strict(),
  demand: z.object({ status: z.literal("not_measured"), value: z.null() }).strict(),
  revenue: z.object({ status: z.literal("not_measured"), amountUsdc: z.null() }).strict(),
}).strict();

const SourceSnapshotSchema = z.object({
  id: z.string(), resourceProductId: z.string(), locator: z.string(), sourceKind: z.string(),
  capturedAt: z.string(), sourcePublishedAt: z.string().optional(), contentHash: z.string(),
  freshnessDeadline: z.string(),
  provenance: z.enum(["mine", "licensed_or_permissioned", "public_source", "other_or_unspecified"]).optional(),
  provenanceNote: z.string().optional(),
}).strict();
const ReceiptSchema = z.object({
  resourceProductId: z.string(), resourceVersion: z.string(), semanticHash: SemanticHashSchema,
  freshness: FreshnessSchema, evidence: z.array(EvidenceSchema), unknowns: z.array(z.string()),
  conflicts: z.array(z.string()), outputSchemaValid: z.boolean(),
}).strict();
const ResourceRefreshSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("manual_text"), locator: z.string().trim().min(1).max(1_024),
    text: z.string().trim().min(1).max(128_000), freshnessDays: z.number().int().min(1).max(3_650),
    provenance: z.enum(["mine", "licensed_or_permissioned", "public_source", "other_or_unspecified"]).optional(),
    provenanceNote: z.string().trim().min(1).max(1_024).optional(),
  }).strict(),
  z.object({
    kind: z.literal("url"), url: z.string().trim().min(1).max(2_048),
    freshnessDays: z.number().int().min(1).max(3_650),
    provenance: z.enum(["mine", "licensed_or_permissioned", "public_source", "other_or_unspecified"]).optional(),
    provenanceNote: z.string().trim().min(1).max(1_024).optional(),
  }).strict(),
  z.object({
    kind: z.literal("json_rows"), locator: z.string().trim().min(1).max(1_024),
    rows: z.array(JsonObjectSchema).min(1).max(2_000), freshnessDays: z.number().int().min(1).max(3_650),
    provenance: z.enum(["mine", "licensed_or_permissioned", "public_source", "other_or_unspecified"]).optional(),
    provenanceNote: z.string().trim().min(1).max(1_024).optional(),
  }).strict(),
]);
const ExactPackReferenceSchema = z.object({ packVersionId: z.string(), semanticHash: SemanticHashSchema }).strict();
const ExactCandidateReferenceSchema = ExactPackReferenceSchema.extend({ revision: z.number().int().positive() }).strict();
const RefreshDiffSchema = z.object({
  addedRecordIds: z.array(z.string()), removedRecordIds: z.array(z.string()), changedRecordIds: z.array(z.string()),
  addedSourceSnapshotIds: z.array(z.string()), removedSourceSnapshotIds: z.array(z.string()),
  schemaChanged: z.boolean(), taxonomyChanged: z.boolean(), evidenceChanged: z.boolean(),
  addedEvidenceIds: z.array(z.string()), removedEvidenceIds: z.array(z.string()), changedEvidenceIds: z.array(z.string()),
  jobContractChanged: z.boolean(),
  unknowns: z.object({ before: z.number().int().nonnegative(), candidate: z.number().int().nonnegative(), delta: z.number().int() }).strict(),
  conflicts: z.object({ before: z.number().int().nonnegative(), candidate: z.number().int().nonnegative(), delta: z.number().int() }).strict(),
  freshness: z.object({ before: FreshnessSchema, candidate: FreshnessSchema }).strict(),
}).strict();
const ResourceRefreshResponseSchema = z.object({
  snapshot: SourceSnapshotSchema,
  collection: z.object({
    status: z.enum(["collected", "blocked", "failed"]), records: z.array(RecordSchema),
    evidence: z.array(EvidenceSchema), warnings: z.array(z.string()),
  }).strict(),
  candidate: ResourcePackVersionSchema.nullable(),
  diff: RefreshDiffSchema.nullable(),
}).strict().superRefine((value, context) => {
  const collected = value.collection.status === "collected";
  if (collected !== (value.candidate !== null && value.diff !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "refresh state is inconsistent" });
  }
});
const ResourceRefreshRejectionSchema = z.object({
  decision: z.literal("rejected"), approved: z.literal(false), republished: z.literal(false),
}).strict();
const ResourceRecollectRequestSchema = z.object({
  action: z.literal("recollect"), base: ExactPackReferenceSchema,
  candidate: ExactCandidateReferenceSchema.nullable(),
  replaceSourceSnapshotIds: z.array(z.string()).max(64), source: ResourceRefreshSourceSchema,
}).strict();
const ResourceRejectRequestSchema = z.object({
  action: z.literal("reject"), base: ExactPackReferenceSchema, candidate: ExactCandidateReferenceSchema,
}).strict();
const ResourceImportWarningSchema = z.string().min(1).max(240).refine(
  (value) => value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value),
  "import warning must be sanitized",
);
const ResourceImportNoticeSchema = z.object({
  collectionStatus: z.enum(["collected", "blocked", "failed"]),
  warnings: z.array(ResourceImportWarningSchema).max(8),
}).strict();
const ResourceSiteImportResponseSchema = ResourceImportNoticeSchema.extend({
  resourceId: z.string().min(1).max(128).refine((value) => !/[/?#\u0000-\u001f\u007f]/u.test(value)),
  sourceCount: z.number().int().nonnegative().max(2_000),
  suggestedPriceUsdc: z.number().finite().nonnegative().max(1_000),
  redirectTo: z.string().min(1).max(512),
}).strict().superRefine((value, context) => {
  if (value.redirectTo !== `/resources/${encodeURIComponent(value.resourceId)}?tab=sources`) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "import redirect does not match resource" });
  }
});

const ResourceReleaseSchema = z.object({
  id: z.string(), ownerId: z.string(), resourceProductId: z.string(), packVersionId: z.string(),
  semanticHash: SemanticHashSchema, publicationKey: z.string(), publicationRequestHash: SemanticHashSchema,
  graphSemanticHash: SemanticHashSchema, graphFullHash: SemanticHashSchema, priceUsdc: z.number().nonnegative(),
  executionAccess: ExecutionAccessSchema, discoveryAccess: DiscoveryAccessSchema,
  agentId: z.string(), flowId: z.string(), flowVersionId: z.string(), deploymentId: z.string(),
  environmentId: z.string(), createdAt: z.string(),
}).strict();
const AgentSchema = z.object({
  id: z.string(), flowId: z.string(), slug: z.string(), status: z.enum(["draft", "live"]),
  priceUsdc: z.number().nonnegative(), createdAt: z.number(), settlementLive: z.boolean(),
}).strict();

export type ResourcePortfolioItem = z.infer<typeof ResourcePortfolioItemSchema>;
export type ResourceLifecycleAction = z.infer<typeof ResourceLifecycleRequestSchema>["action"];
export type ResourceLifecycleRequest = z.infer<typeof ResourceLifecycleRequestSchema>;
export type ResourceCurrentReleaseSummary = z.infer<typeof CurrentReleaseSummarySchema>;
export type ResourceTrust = z.infer<typeof TrustSchema>;
export type ResourcePackVersion = z.infer<typeof ResourcePackVersionSchema>;
export type ResourcePackBundle = z.infer<typeof ResourcePackBundleSchema>;
export type ResourcePackContent = z.infer<typeof PackContentSchema>;
export type ResourceSourceResult = z.infer<typeof ResourceSourceResponseSchema>;
export type ResourceDryRun = z.infer<typeof ResourceTestResponseSchema>["test"];
export type PublishedResource = z.infer<typeof ResourcePublishResponseSchema>["published"];
export type ResourceRefreshSource = z.infer<typeof ResourceRefreshSourceSchema>;
export type ResourceRefreshResult = z.infer<typeof ResourceRefreshResponseSchema>;
export type ResourceRefreshBase = z.infer<typeof ExactPackReferenceSchema>;
export type ResourceRefreshCandidate = z.infer<typeof ExactCandidateReferenceSchema>;
export type ResourceImportNotice = z.infer<typeof ResourceImportNoticeSchema>;
export type ResourceSiteImportResponse = z.infer<typeof ResourceSiteImportResponseSchema>;

const ResourceListResponseSchema = z.object({ resources: z.array(z.unknown()) }).strict();
const ResourceDetailResponseSchema = z.object({ resource: ResourcePortfolioItemSchema }).strict();
const ResourceLifecycleResponseSchema = z.object({ resource: ResourcePortfolioItemSchema }).strict();
const ResourceReleaseHistoryResponseSchema = z.object({
  releases: z.array(CurrentReleaseSummarySchema).max(20),
}).strict();
const ResourceTrustResponseSchema = z.object({ trust: TrustSchema }).strict();
const ResourceCreateResponseSchema = z.object({ resource: ResourcePortfolioItemSchema, candidate: ResourcePackVersionSchema }).strict();
const ResourcePackResponseSchema = z.object({ pack: ResourcePackBundleSchema }).strict();
const ResourceCandidateResponseSchema = z.object({ candidate: ResourcePackVersionSchema }).strict();
const ResourceApproveResponseSchema = z.object({ pack: ResourcePackVersionSchema }).strict();
const ResourceSourceResponseSchema = z.object({
  snapshot: SourceSnapshotSchema,
  collection: z.object({
    status: z.enum(["collected", "blocked", "failed"]),
    records: z.array(RecordSchema), evidence: z.array(EvidenceSchema), warnings: z.array(z.string()),
  }).strict(),
  candidate: ResourcePackVersionSchema,
}).strict();
const ResourceTestResponseSchema = z.object({
  test: z.object({
    packVersionId: z.string(), semanticHash: SemanticHashSchema, inputSchemaValid: z.literal(true),
    outputSchemaValid: z.literal(true), measuredCostUsdc: z.number().nonnegative(),
    externalCalls: z.number().int().nonnegative(), settlementAttempted: z.literal(false),
    result: z.array(JsonObjectSchema), resourceReceipt: ReceiptSchema,
  }).strict(),
}).strict();
const ResourcePublishResponseSchema = z.object({
  published: z.object({ agent: AgentSchema, release: ResourceReleaseSchema, urls: UrlsSchema }).strict(),
}).strict();

export function parseResourceListResponse(value: unknown): readonly ResourcePortfolioItem[] {
  const envelope = ResourceListResponseSchema.parse(value);
  const resources = envelope.resources.flatMap((item) => {
    const parsed = ResourcePortfolioItemSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
  if (resources.length === 0 && envelope.resources.length > 0) {
    ResourcePortfolioItemSchema.parse(envelope.resources[0]);
  }
  return resources;
}
export function parseResourceDetailResponse(value: unknown): ResourcePortfolioItem {
  return ResourceDetailResponseSchema.parse(value).resource;
}
export function parseResourceLifecycleResponse(value: unknown): ResourcePortfolioItem {
  return ResourceLifecycleResponseSchema.parse(value).resource;
}
export function parseResourceReleaseHistoryResponse(
  value: unknown,
  resourceProductId: string,
): readonly ResourceCurrentReleaseSummary[] {
  const releases = ResourceReleaseHistoryResponseSchema.parse(value).releases;
  if (releases.some((release) => release.resourceProductId !== resourceProductId)) {
    throw new Error("Release history does not match the requested resource.");
  }
  return Object.freeze(releases);
}
export function parseResourceTrustResponse(value: unknown): ResourceTrust {
  return ResourceTrustResponseSchema.parse(value).trust;
}
export function parseResourceCreateResponse(value: unknown): { readonly resource: ResourcePortfolioItem; readonly candidate: ResourcePackVersion } {
  return ResourceCreateResponseSchema.parse(value);
}
export function parseResourcePackResponse(value: unknown): ResourcePackBundle {
  return ResourcePackResponseSchema.parse(value).pack;
}
export function parseResourceCandidateResponse(value: unknown): ResourcePackVersion {
  return ResourceCandidateResponseSchema.parse(value).candidate;
}
export function parseResourceApproveResponse(value: unknown): ResourcePackVersion {
  return ResourceApproveResponseSchema.parse(value).pack;
}
export function parseResourceSourceResponse(value: unknown): ResourceSourceResult {
  return ResourceSourceResponseSchema.parse(value);
}
export function parseResourceTestResponse(value: unknown): ResourceDryRun {
  return ResourceTestResponseSchema.parse(value).test;
}
export function parseResourcePublishResponse(value: unknown): PublishedResource {
  return ResourcePublishResponseSchema.parse(value).published;
}
export function parseResourceRefreshResponse(value: unknown): ResourceRefreshResult {
  return ResourceRefreshResponseSchema.parse(value);
}
export function parseResourceRefreshRejection(value: unknown): z.infer<typeof ResourceRefreshRejectionSchema> {
  return ResourceRefreshRejectionSchema.parse(value);
}

export function buildResourceRecollectRequest(
  base: ResourceRefreshBase,
  candidate: ResourceRefreshCandidate | null,
  replaceSourceSnapshotIds: readonly string[],
  source: ResourceRefreshSource,
): z.infer<typeof ResourceRecollectRequestSchema> {
  return ResourceRecollectRequestSchema.parse({ action: "recollect", base, candidate, replaceSourceSnapshotIds, source });
}

export function buildResourceRejectRequest(
  base: ResourceRefreshBase,
  candidate: ResourceRefreshCandidate,
): z.infer<typeof ResourceRejectRequestSchema> {
  return ResourceRejectRequestSchema.parse({ action: "reject", base, candidate });
}

export function buildResourceLifecycleRequest(
  product: ResourcePortfolioItem,
  action: ResourceLifecycleAction,
): ResourceLifecycleRequest {
  const release = product.currentRelease;
  if (!release || (product.status !== "live" && product.status !== "paused")) {
    throw new Error("The current release cannot transition.");
  }
  return ResourceLifecycleRequestSchema.parse({
    action,
    expectedStatus: product.status,
    releaseId: release.id,
    agentId: release.agentId,
    deploymentId: release.deploymentId,
  });
}

type ResourceSessionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const resourceImportNoticeKey = (resourceId: string): string => `suede:resource-import-notice:${resourceId}`;

export function finishResourceSiteImport(
  value: unknown,
  storage: ResourceSessionStorage,
): ResourceSiteImportResponse {
  const parsed = ResourceSiteImportResponseSchema.parse(value);
  try {
    storage.setItem(resourceImportNoticeKey(parsed.resourceId), JSON.stringify({
      collectionStatus: parsed.collectionStatus,
      warnings: parsed.warnings,
    } satisfies ResourceImportNotice));
  } catch {
    // The honest private draft remains the destination even when browser storage is unavailable.
  }
  return parsed;
}

export function consumeResourceImportNotice(
  resourceId: string,
  storage: ResourceSessionStorage,
): ResourceImportNotice | null {
  let raw: string | null;
  try {
    raw = storage.getItem(resourceImportNoticeKey(resourceId));
    storage.removeItem(resourceImportNoticeKey(resourceId));
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    return ResourceImportNoticeSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function resourceMutationAllowedForHost(host: string): boolean {
  return !isGooglePlayAccessOnlyHost(host);
}

export function requestIsCurrent(generation: number, current: number, aborted: boolean): boolean {
  return generation === current && !aborted;
}

export class ResourceClientError extends Error {
  constructor(readonly status: number, message: string, readonly code: string | null = null) {
    super(message);
    this.name = "ResourceClientError";
  }
}

export const RESOURCE_OUTCOME_UNKNOWN = "RESOURCE_OUTCOME_UNKNOWN";

export function resourceLifecycleNeedsReconciliation(error: unknown): boolean {
  if (error instanceof ResourceClientError) {
    return error.status === 409 || error.status >= 500 ||
      error.code === RESOURCE_OUTCOME_UNKNOWN;
  }
  // This helper is called only after a lifecycle POST is dispatched. Native
  // transport/abort errors and strict response-parser failures cannot prove
  // whether the exact pinned mutation committed, so the owner read must win.
  return error instanceof Error;
}

function fixedError(status: number, code: string | null = null): string {
  if (code === RESOURCE_OUTCOME_UNKNOWN) {
    return "The lifecycle write may have committed. Reloading the server-current receipt before another action.";
  }
  if (status === 400) return "The resource request was not accepted. Review the fields and try again.";
  if (status === 401) return "This mutation is unavailable from an Authorization-based session.";
  if (status === 404) return "This resource is unavailable in the current workspace.";
  if (status === 409) return "The resource changed in another action. Reload its current receipt and try again.";
  if (status === 429) return "Resource actions are temporarily limited. Wait, then retry.";
  if (status === 503) return "Resource Foundry is temporarily unavailable.";
  return "The resource service could not complete this request.";
}

export async function resourceJsonRequest(
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD" && typeof window !== "undefined" &&
      !resourceMutationAllowedForHost(window.location.host)) {
    throw new ResourceClientError(403, "Resource mutations are unavailable in this Google Play build.");
  }
  const response = await fetch(path, {
    ...init,
    cache: "no-store",
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    },
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = body !== null && typeof body === "object" && !Array.isArray(body) &&
      Reflect.get(body, "code") === RESOURCE_OUTCOME_UNKNOWN
      ? RESOURCE_OUTCOME_UNKNOWN
      : null;
    throw new ResourceClientError(response.status, fixedError(response.status, code), code);
  }
  if (body === null) throw new ResourceClientError(502, "The resource service returned an unreadable response.");
  return body;
}

/** Explicitly completes signed-in anonymous-workspace adoption before reads. */
export async function adoptResourceWorkspace(): Promise<void> {
  await resourceJsonRequest("/api/v2/resources/adopt", { method: "POST" });
}

export async function bootstrapResourceWorkspace<T>(read: () => Promise<T>): Promise<T> {
  await adoptResourceWorkspace();
  return read();
}

export interface ResourcePackPointer {
  readonly id: string;
  readonly revision: number;
  readonly status: "candidate" | "approved" | "live" | "retired";
  readonly semanticHash: string;
}

const PointerSchema = z.object({
  id: z.string(), revision: z.number().int().positive(), status: PackStatusSchema, semanticHash: SemanticHashSchema,
}).strict();
const pointerKey = (resourceId: string): string => `suede:resource-pack:${resourceId}`;

export function readResourcePackPointer(resourceId: string): ResourcePackPointer | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(pointerKey(resourceId));
    return raw === null ? null : PointerSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function writeResourcePackPointer(resourceId: string, pack: ResourcePackVersion): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    const pointer: ResourcePackPointer = {
      id: pack.id, revision: pack.revision, status: pack.status, semanticHash: pack.semanticHash,
    };
    sessionStorage.setItem(pointerKey(resourceId), JSON.stringify(pointer));
  } catch {
    // Session storage is continuity only; every mutation remains server-authoritative.
  }
}
