import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { UnauthenticatedOwnerError } from "@/lib/auth";
import { privateJson } from "@/lib/projects/api-response";
import { crawlSite, normalizeSiteUrl, SiteCrawlError, type CrawlOptions, type SiteCrawl } from "@/lib/site/crawl";
import { RESOURCE_FOUNDRY_ENABLED } from "./flags";
import { aggregateResourceTrust, type ResourceTrustAnalytics } from "./analytics";
import { executeResourceQuery } from "./query";
import {
  ResourceAmbiguousFinalCommitError,
  ResourcePersistenceError,
  ResourceRepositoryConflictError,
  ResourceRepositoryNotFoundError,
  type ResourceCurrentReleaseSummary,
  type ResourcePackVersion,
  type ResourcePortfolioItem,
  type ResourceRepository,
  type CreateSourceSnapshotInput,
} from "./repository";
import { ResourceStoreUnavailableError } from "./provider";
import {
  compareResourceCanonical,
  parseResourcePackContent,
  resourceSchemaAccepts,
} from "./schemas";
import type {
  EvidencePointer,
  ResourceJsonValue,
  ResourcePackBundle,
  ResourcePackContent,
  ResourceRecord,
  ResourceSourceSnapshot,
} from "./types";

const RequiredText = z.string().trim().min(1).max(4_096);
const IdText = z.string().trim().min(1).max(128);
const Hash = z.string().regex(/^[a-f0-9]{64}$/u);
const Provenance = z.enum(["mine", "licensed_or_permissioned", "public_source", "other_or_unspecified"]);
const ExactReferenceSchema = z.object({ packVersionId: IdText, semanticHash: Hash }).strict();

export const CreateResourceRequestSchema = z.object({
  name: z.string().trim().min(1).max(160),
  slug: z.string().trim().min(1).max(160),
  executionAccess: z.enum(["free", "paid", "private"]),
  discoveryAccess: z.enum(["public", "unlisted"]),
  brief: z.object({
    jobStatement: RequiredText,
    buyerIntent: RequiredText,
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    safeExample: z.unknown(),
    recordSchema: z.unknown(),
    filterFields: z.array(IdText).max(64),
    returnFields: z.array(IdText).max(64),
    taxonomy: z.array(z.object({ id: IdText, label: z.string().trim().min(1).max(160) }).strict()).max(256).optional(),
  }).strict(),
}).strict();

export const UpdateResourceRequestSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  slug: z.string().trim().min(1).max(160).optional(),
  executionAccess: z.enum(["free", "paid", "private"]).optional(),
  discoveryAccess: z.enum(["public", "unlisted"]).optional(),
}).strict().refine((value) => Object.keys(value).length > 0);

export const TransitionResourceLifecycleRequestSchema = z.object({
  action: z.enum(["pause", "resume", "retire"]),
  expectedStatus: z.enum(["live", "paused"]),
  releaseId: IdText,
  agentId: IdText,
  deploymentId: IdText,
}).strict().superRefine((value, context) => {
  if ((value.action === "pause" && value.expectedStatus !== "live") ||
      (value.action === "resume" && value.expectedStatus !== "paused")) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "invalid lifecycle transition" });
  }
});

const SourceContextSchema = z.object({
  freshnessDays: z.number().int().min(1).max(3_650),
  provenance: Provenance.optional(),
  provenanceNote: z.string().trim().min(1).max(1_024).optional(),
});
export const CreateResourceSourceRequestSchema = z.discriminatedUnion("kind", [
  SourceContextSchema.extend({
    kind: z.literal("manual_text"), locator: z.string().trim().min(1).max(1_024), text: z.string().trim().min(1).max(128_000),
  }).strict(),
  SourceContextSchema.extend({
    kind: z.literal("json_rows"), locator: z.string().trim().min(1).max(1_024), rows: z.array(z.record(z.string(), z.unknown())).min(1).max(2_000),
  }).strict(),
  SourceContextSchema.extend({
    kind: z.literal("url"), url: z.string().trim().min(1).max(2_048),
  }).strict(),
]);

export const CollectResourceSourceCandidateRequestSchema = z.object({
  source: CreateResourceSourceRequestSchema,
  candidate: z.object({
    packVersionId: IdText,
    revision: z.number().int().min(1),
    semanticHash: Hash,
  }).strict(),
}).strict();

export const ImportSiteAgentResourceRequestSchema = z.object({
  url: z.string().trim().min(1).max(2_048),
  name: z.string().trim().min(1).max(160),
  sourceUrls: z.array(z.string().trim().min(1).max(2_048)).max(6),
  suggestedJob: RequiredText,
  priceUsdc: z.number().finite().min(0).max(1_000),
}).strict();

export const ReplaceResourceCandidateRequestSchema = z.object({
  expectedCandidatePackVersionId: IdText.nullable(),
  expectedRevision: z.number().int().min(0),
  content: z.unknown(),
}).strict();

export const ApproveResourceCandidateRequestSchema = z.object({
  candidatePackVersionId: IdText,
  expectedRevision: z.number().int().min(1),
  expectedSemanticHash: Hash,
}).strict();

export const ResourcePackReferenceSchema = ExactReferenceSchema;

export const RefreshResourceRequestSchema = z.object({
  base: ExactReferenceSchema,
  expectedCandidatePackVersionId: IdText.nullable(),
  expectedRevision: z.number().int().min(1),
  content: z.unknown(),
}).strict();

export const RefreshResourceSourceRequestSchema = z.object({
  base: ExactReferenceSchema,
  candidate: ExactReferenceSchema.extend({ revision: z.number().int().min(1) }).strict().nullable(),
  replaceSourceSnapshotIds: z.array(IdText).max(64),
  source: CreateResourceSourceRequestSchema,
}).strict();

export const RejectResourceRefreshRequestSchema = z.object({
  base: ExactReferenceSchema,
  candidate: ExactReferenceSchema.extend({ revision: z.number().int().min(1) }).strict(),
}).strict();

export const TestResourceRequestSchema = ExactReferenceSchema.extend({
  input: z.unknown(),
  filters: z.record(z.string(), z.unknown()),
  filterFields: z.array(IdText).max(64),
  returnFields: z.array(IdText).max(64),
  expectedProperties: z.array(IdText).min(1).max(64).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict();

export class ResourceFoundryUnavailableError extends Error {
  constructor() { super("resource foundry unavailable"); this.name = "ResourceFoundryUnavailableError"; }
}
export class ResourceServiceInvalidError extends Error {
  constructor() { super("invalid request"); this.name = "ResourceServiceInvalidError"; }
}

export function assertResourceFoundryEnabled(): void {
  if (!RESOURCE_FOUNDRY_ENABLED) throw new ResourceFoundryUnavailableError();
}

export function resourceApiErrorResponse(error: unknown): Response {
  if (error instanceof ResourceFoundryUnavailableError) return privateJson({ error: "resource foundry unavailable" }, 503);
  if (error instanceof UnauthenticatedOwnerError) return privateJson({ error: "Authentication required" }, 401);
  if (error instanceof ResourceRepositoryNotFoundError) return privateJson({ error: "not found" }, 404);
  if (error instanceof ResourceRepositoryConflictError) return privateJson({ error: "resource conflict" }, 409);
  if (error instanceof ResourceAmbiguousFinalCommitError) {
    return privateJson({ error: "resource outcome unknown", code: "RESOURCE_OUTCOME_UNKNOWN" }, 503);
  }
  if (error instanceof ResourceStoreUnavailableError || error instanceof ResourcePersistenceError) {
    return privateJson({ error: "resource store unavailable" }, 503);
  }
  if (error instanceof ResourceServiceInvalidError || error instanceof z.ZodError || error instanceof TypeError) {
    return privateJson({ error: "invalid request" }, 400);
  }
  return privateJson({ error: "internal server error" }, 500);
}

interface JsonBudget { values: number; bytes: number }

function privateJsonValue(value: unknown, budget: JsonBudget = { values: 0, bytes: 0 }, depth = 0): ResourceJsonValue {
  if (depth > 16) throw new ResourceServiceInvalidError();
  budget.values += 1;
  if (budget.values > 10_000) throw new ResourceServiceInvalidError();
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ResourceServiceInvalidError();
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "string") {
    const normalized = value.normalize("NFC");
    budget.bytes += Buffer.byteLength(normalized, "utf8");
    if (normalized.length === 0 || normalized.trim() !== normalized || /[\u0000-\u001f\u007f]/u.test(normalized) || budget.bytes > 512 * 1024) {
      throw new ResourceServiceInvalidError();
    }
    return normalized;
  }
  if (Array.isArray(value)) return Object.freeze(value.map((entry) => privateJsonValue(entry, budget, depth + 1)));
  if (typeof value !== "object") throw new ResourceServiceInvalidError();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new ResourceServiceInvalidError();
  const source = value as Readonly<Record<string, unknown>>;
  const result = Object.create(null) as Record<string, ResourceJsonValue>;
  const keys = Object.keys(source).sort(compareResourceCanonical);
  if (keys.length > 64 || new Set(keys.map((key) => key.normalize("NFC"))).size !== keys.length) throw new ResourceServiceInvalidError();
  for (const rawKey of keys) {
    const key = rawKey.normalize("NFC");
    if (key.length === 0 || key.trim() !== key || key === "__proto__" || key === "prototype" || key === "constructor" || /[\u0000-\u001f\u007f]/u.test(key)) {
      throw new ResourceServiceInvalidError();
    }
    budget.bytes += Buffer.byteLength(key, "utf8");
    if (budget.bytes > 512 * 1024) throw new ResourceServiceInvalidError();
    result[key] = privateJsonValue(source[rawKey], budget, depth + 1);
  }
  return Object.freeze(result);
}

function canonicalJson(value: ResourceJsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Readonly<Record<string, ResourceJsonValue>>;
  return `{${Object.keys(record).sort(compareResourceCanonical).map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key]!)}`).join(",")}}`;
}

function sha256(value: ResourceJsonValue): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function recordSchemaFields(schema: ResourcePackContent["recordSchema"]): readonly string[] {
  const properties = schema.properties;
  return properties && typeof properties === "object" && !Array.isArray(properties)
    ? Object.keys(properties as Readonly<Record<string, ResourceJsonValue>>).sort(compareResourceCanonical)
    : [];
}

function initialContent(input: z.infer<typeof CreateResourceRequestSchema>): ResourcePackContent {
  const content = parseResourcePackContent({
    recordSchema: input.brief.recordSchema,
    filterFields: input.brief.filterFields,
    returnFields: input.brief.returnFields,
    taxonomy: input.brief.taxonomy ?? [], records: [], evidence: [], sourceSnapshotIds: [],
    jobContract: {
      jobStatement: input.brief.jobStatement,
      buyerIntent: input.brief.buyerIntent,
      inputSchema: input.brief.inputSchema,
      outputSchema: input.brief.outputSchema,
      unsupportedRequest: "Return an explicit unknown or refusal outside this reviewed job.",
      evidenceRequirement: "Supported results must carry evidence from this exact Resource Pack.",
      safeExample: input.brief.safeExample,
      reviewBoundary: "Owner-reviewed records and declared return fields only.",
      dataHandlingDisclosure: "Private source bodies are not returned by default.",
    },
  });
  return content;
}

export interface CollectedSource {
  readonly snapshot: ResourceSourceSnapshot;
  readonly collection: {
    readonly status: "collected" | "blocked" | "failed";
    readonly records: readonly ResourceRecord[];
    readonly evidence: readonly EvidencePointer[];
    readonly warnings: readonly string[];
  };
}

interface PreparedCollectedSource {
  readonly snapshot: CreateSourceSnapshotInput;
  readonly collection: CollectedSource["collection"];
}

function collectionRecords(snapshotId: string, rows: readonly Readonly<Record<string, ResourceJsonValue>>[], locators: readonly string[], observedAt: string): Pick<CollectedSource["collection"], "records" | "evidence"> {
  const namespace = createHash("sha256").update(snapshotId).digest("hex");
  const evidence = rows.map((_row, index): EvidencePointer => Object.freeze({
    id: `evidence-${namespace}-${index + 1}`,
    sourceSnapshotId: snapshotId,
    locator: locators[index] ?? `row:${index + 1}`,
    observedAt,
  }));
  const records = rows.map((fields, index): ResourceRecord => Object.freeze({
    id: `record-${namespace}-${index + 1}`,
    fields,
    tags: Object.freeze([]),
    evidenceIds: Object.freeze([evidence[index]!.id]),
  }));
  return { records: Object.freeze(records), evidence: Object.freeze(evidence) };
}

const SENSITIVE_URL_PARAMETER = /(?:token|secret|signature|password|passwd|api[_-]?key|auth|credential|session)/iu;

function validatePublicSourceUrl(value: string): URL {
  const normalized = normalizeSiteUrl(value);
  if (normalized.username !== "" || normalized.password !== "" ||
      [...normalized.searchParams.keys()].some((key) => SENSITIVE_URL_PARAMETER.test(key))) {
    throw new ResourceServiceInvalidError();
  }
  return normalized;
}

function canonicalCrawlPages(crawl: SiteCrawl): SiteCrawl["pages"] {
  const seen = new Set<string>();
  return Object.freeze(crawl.pages.filter((page) => {
    let canonical = page.url;
    try {
      const canonicalUrl = new URL(page.canonical || page.url, page.url);
      canonicalUrl.hash = "";
      canonical = canonicalUrl.toString();
    } catch { /* use the already-normalized crawled URL */ }
    if (seen.has(canonical)) return false;
    seen.add(canonical);
    return true;
  }));
}

function crawlRows(pages: SiteCrawl["pages"]): readonly Readonly<Record<string, ResourceJsonValue>>[] {
  return Object.freeze(pages.map((page) => Object.freeze({
    url: page.url,
    title: page.title || "Untitled page",
    description: page.description || "No description supplied.",
    text: page.text,
  })));
}

function diffIds<T extends { readonly id: string }>(before: readonly T[], after: readonly T[]): { added: string[]; removed: string[]; changed: string[] } {
  const left = new Map(before.map((item) => [item.id, canonicalJson(privateJsonValue(item))]));
  const right = new Map(after.map((item) => [item.id, canonicalJson(privateJsonValue(item))]));
  return {
    added: [...right.keys()].filter((id) => !left.has(id)).sort(compareResourceCanonical),
    removed: [...left.keys()].filter((id) => !right.has(id)).sort(compareResourceCanonical),
    changed: [...right.keys()].filter((id) => left.has(id) && left.get(id) !== right.get(id)).sort(compareResourceCanonical),
  };
}

export interface ResourceRefreshDiff {
  readonly addedRecordIds: readonly string[];
  readonly removedRecordIds: readonly string[];
  readonly changedRecordIds: readonly string[];
  readonly addedSourceSnapshotIds: readonly string[];
  readonly removedSourceSnapshotIds: readonly string[];
  readonly schemaChanged: boolean;
  readonly taxonomyChanged: boolean;
  readonly evidenceChanged: boolean;
  readonly addedEvidenceIds: readonly string[];
  readonly removedEvidenceIds: readonly string[];
  readonly changedEvidenceIds: readonly string[];
  readonly jobContractChanged: boolean;
  readonly unknowns: { readonly before: number; readonly candidate: number; readonly delta: number };
  readonly conflicts: { readonly before: number; readonly candidate: number; readonly delta: number };
  readonly freshness: { readonly before: ResourcePackBundle["freshness"]; readonly candidate: ResourcePackBundle["freshness"] };
}

function findingCount(content: ResourcePackContent, field: "unknowns" | "conflicts"): number {
  return content.records.reduce((sum, record) => sum + (record[field]?.length ?? 0), 0);
}

function refreshDiff(
  base: ResourcePackBundle,
  candidate: ResourcePackBundle,
): ResourceRefreshDiff {
  const records = diffIds(base.content.records, candidate.content.records);
  const evidence = diffIds(base.content.evidence, candidate.content.evidence);
  const beforeSources = new Set(base.content.sourceSnapshotIds);
  const afterSources = new Set(candidate.content.sourceSnapshotIds);
  const beforeUnknowns = findingCount(base.content, "unknowns");
  const afterUnknowns = findingCount(candidate.content, "unknowns");
  const beforeConflicts = findingCount(base.content, "conflicts");
  const afterConflicts = findingCount(candidate.content, "conflicts");
  return Object.freeze({
    addedRecordIds: Object.freeze(records.added),
    removedRecordIds: Object.freeze(records.removed),
    changedRecordIds: Object.freeze(records.changed),
    addedSourceSnapshotIds: Object.freeze([...afterSources].filter((id) => !beforeSources.has(id)).sort(compareResourceCanonical)),
    removedSourceSnapshotIds: Object.freeze([...beforeSources].filter((id) => !afterSources.has(id)).sort(compareResourceCanonical)),
    schemaChanged: canonicalJson(privateJsonValue(base.content.recordSchema)) !== canonicalJson(privateJsonValue(candidate.content.recordSchema)),
    taxonomyChanged: canonicalJson(privateJsonValue(base.content.taxonomy)) !== canonicalJson(privateJsonValue(candidate.content.taxonomy)),
    evidenceChanged: evidence.added.length > 0 || evidence.removed.length > 0 || evidence.changed.length > 0,
    addedEvidenceIds: Object.freeze(evidence.added),
    removedEvidenceIds: Object.freeze(evidence.removed),
    changedEvidenceIds: Object.freeze(evidence.changed),
    jobContractChanged: canonicalJson(privateJsonValue(base.content.jobContract)) !== canonicalJson(privateJsonValue(candidate.content.jobContract)),
    unknowns: Object.freeze({ before: beforeUnknowns, candidate: afterUnknowns, delta: afterUnknowns - beforeUnknowns }),
    conflicts: Object.freeze({ before: beforeConflicts, candidate: afterConflicts, delta: afterConflicts - beforeConflicts }),
    freshness: Object.freeze({ before: base.freshness, candidate: candidate.freshness }),
  });
}

function reviewedReplacementContent(
  base: ResourcePackContent,
  prepared: PreparedCollectedSource,
  replaceSourceSnapshotIds: readonly string[],
): ResourcePackContent {
  const replacedSnapshots = new Set(replaceSourceSnapshotIds);
  if (replacedSnapshots.size !== replaceSourceSnapshotIds.length ||
      replaceSourceSnapshotIds.some((id) => !base.sourceSnapshotIds.includes(id))) {
    throw new ResourceServiceInvalidError();
  }
  const replacedEvidence = base.evidence.filter((pointer) => replacedSnapshots.has(pointer.sourceSnapshotId));
  const replacedEvidenceIds = new Set(replacedEvidence.map((pointer) => pointer.id));
  const oldEvidenceByLocator = new Map(replacedEvidence.map((pointer) => [pointer.locator, pointer]));
  const oldRecordByEvidenceId = new Map<string, ResourceRecord>();
  for (const record of base.records) {
    for (const evidenceId of record.evidenceIds) {
      if (!oldRecordByEvidenceId.has(evidenceId)) oldRecordByEvidenceId.set(evidenceId, record);
    }
  }
  const nextEvidence = prepared.collection.evidence.map((pointer) => {
    const previous = oldEvidenceByLocator.get(pointer.locator);
    return Object.freeze({ ...pointer, ...(previous ? { id: previous.id } : {}) });
  });
  const nextRecords = prepared.collection.records.map((record, index) => {
    const collectedEvidence = prepared.collection.evidence[index];
    const previousEvidence = collectedEvidence ? oldEvidenceByLocator.get(collectedEvidence.locator) : undefined;
    const previousRecord = previousEvidence ? oldRecordByEvidenceId.get(previousEvidence.id) : undefined;
    const evidence = nextEvidence[index];
    return Object.freeze({
      ...record,
      ...(previousRecord ? { id: previousRecord.id } : {}),
      evidenceIds: Object.freeze(evidence ? [evidence.id] : []),
    });
  });
  const retainedRecords = base.records.flatMap((record) => {
    const retainedEvidenceIds = record.evidenceIds.filter((id) => !replacedEvidenceIds.has(id));
    if (retainedEvidenceIds.length === 0 && record.evidenceIds.some((id) => replacedEvidenceIds.has(id))) return [];
    return retainedEvidenceIds.length === record.evidenceIds.length
      ? [record]
      : [Object.freeze({ ...record, evidenceIds: Object.freeze(retainedEvidenceIds) })];
  });
  return parseResourcePackContent({
    ...base,
    records: [...retainedRecords, ...nextRecords],
    evidence: [...base.evidence.filter((pointer) => !replacedEvidenceIds.has(pointer.id)), ...nextEvidence],
    sourceSnapshotIds: [
      ...base.sourceSnapshotIds.filter((id) => !replacedSnapshots.has(id)),
      prepared.snapshot.id!,
    ],
  });
}

export class ResourceFoundryService {
  constructor(
    private readonly repository: ResourceRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly nextId: () => string = randomUUID,
  ) {}

  async listProducts(ownerId: string): Promise<readonly ResourcePortfolioItem[]> {
    assertResourceFoundryEnabled();
    return this.repository.listOwnedProducts(ownerId);
  }

  async getProduct(ownerId: string, resourceProductId: string): Promise<ResourcePortfolioItem> {
    assertResourceFoundryEnabled();
    const item = await this.repository.getOwnedPortfolioItem(ownerId, resourceProductId);
    if (!item) throw new ResourceRepositoryNotFoundError();
    return item;
  }

  async listReleaseHistory(
    ownerId: string,
    resourceProductId: string,
  ): Promise<readonly ResourceCurrentReleaseSummary[]> {
    assertResourceFoundryEnabled();
    await this.getProduct(ownerId, resourceProductId);
    return this.repository.listOwnedReleaseHistory(ownerId, resourceProductId, 20);
  }

  async createProduct(ownerId: string, input: z.infer<typeof CreateResourceRequestSchema>): Promise<{ resource: ResourcePortfolioItem; candidate: ResourcePackVersion }> {
    assertResourceFoundryEnabled();
    const content = initialContent(input);
    const created = await this.repository.createProductWithCandidate({
      ownerId, name: input.name, slug: input.slug,
      executionAccess: input.executionAccess, discoveryAccess: input.discoveryAccess,
      content, createdBy: ownerId,
    });
    return { resource: await this.getProduct(ownerId, created.product.id), candidate: created.candidate };
  }

  async updateDraft(ownerId: string, resourceProductId: string, input: z.infer<typeof UpdateResourceRequestSchema>) {
    assertResourceFoundryEnabled();
    await this.getProduct(ownerId, resourceProductId);
    return this.repository.updateOwnedDraft({
      ownerId, resourceProductId, expectedStatus: "draft", ...input,
    });
  }

  async transitionReleaseLifecycle(
    ownerId: string,
    resourceProductId: string,
    input: z.infer<typeof TransitionResourceLifecycleRequestSchema>,
  ): Promise<ResourcePortfolioItem> {
    assertResourceFoundryEnabled();
    const parsed = TransitionResourceLifecycleRequestSchema.parse(input);
    const current = await this.getProduct(ownerId, resourceProductId);
    if (current.status !== parsed.expectedStatus || !current.currentRelease ||
        current.currentRelease.id !== parsed.releaseId ||
        current.currentRelease.agentId !== parsed.agentId ||
        current.currentRelease.deploymentId !== parsed.deploymentId) {
      throw new ResourceRepositoryConflictError();
    }
    await this.repository.transitionReleaseLifecycle({
      ownerId, resourceProductId, ...parsed,
    });
    try {
      return await this.getProduct(ownerId, resourceProductId);
    } catch {
      throw new ResourceAmbiguousFinalCommitError();
    }
  }

  private async prepareSource(
    ownerId: string,
    resourceProductId: string,
    input: z.infer<typeof CreateResourceSourceRequestSchema>,
    crawlOptions?: Pick<CrawlOptions, "includeUrls" | "maxPages">,
  ): Promise<PreparedCollectedSource> {
    const capturedAt = this.now();
    const capturedAtIso = capturedAt.toISOString();
    const freshnessDeadline = new Date(capturedAt.getTime() + input.freshnessDays * 86_400_000).toISOString();
    const snapshotId = this.nextId();
    const context = {
      id: snapshotId, ownerId, resourceProductId, capturedAt: capturedAtIso, freshnessDeadline,
      ...(input.provenance === undefined ? {} : { provenance: input.provenance }),
      ...(input.provenanceNote === undefined ? {} : { provenanceNote: input.provenanceNote }),
    };

    if (input.kind === "manual_text") {
      const fields = Object.freeze({ text: privateJsonValue(input.text) });
      const rows = Object.freeze([fields]);
      const snapshot = {
        ...context, locator: input.locator, sourceKind: input.kind,
        contentHash: sha256(privateJsonValue({ kind: input.kind, rows })),
      } satisfies CreateSourceSnapshotInput;
      const material = collectionRecords(snapshotId, rows, ["row:1"], capturedAtIso);
      return Object.freeze({ snapshot, collection: Object.freeze({ status: "collected", ...material, warnings: Object.freeze([]) }) });
    }
    if (input.kind === "json_rows") {
      const rows = Object.freeze(input.rows.map((row) => privateJsonValue(row) as Readonly<Record<string, ResourceJsonValue>>));
      const snapshot = {
        ...context, locator: input.locator, sourceKind: input.kind,
        contentHash: sha256(privateJsonValue({ kind: input.kind, rows })),
      } satisfies CreateSourceSnapshotInput;
      const material = collectionRecords(snapshotId, rows, rows.map((_row, index) => `row:${index + 1}`), capturedAtIso);
      return Object.freeze({ snapshot, collection: Object.freeze({ status: "collected", ...material, warnings: Object.freeze([]) }) });
    }

    validatePublicSourceUrl(input.url);
    try {
      const crawl = crawlOptions === undefined
        ? await crawlSite(input.url)
        : await crawlSite(input.url, crawlOptions);
      const pages = canonicalCrawlPages(crawl);
      const rows = crawlRows(pages);
      const snapshot = {
        ...context, locator: crawl.homeUrl, sourceKind: "url",
        contentHash: sha256(privateJsonValue({ pages: rows })),
      } satisfies CreateSourceSnapshotInput;
      const material = collectionRecords(snapshotId, rows, pages.map((_page, index) => `page:${index + 1}`), capturedAtIso);
      const warnings = Object.freeze([
        ...(crawl.truncated ? ["source collection was truncated"] : []),
        ...(crawl.skippedByRobots.length > 0 ? ["some pages were skipped by robots policy"] : []),
      ]);
      return Object.freeze({ snapshot, collection: Object.freeze({ status: "collected", ...material, warnings }) });
    } catch (error) {
      const blocked = error instanceof SiteCrawlError && error.code === "robots-blocked";
      const invalid = error instanceof SiteCrawlError && error.code === "invalid-url";
      let locator = input.url;
      if (!invalid) {
        try { locator = normalizeSiteUrl(input.url).toString(); } catch { /* retain bounded private input */ }
      }
      const warning = blocked ? "source collection blocked by robots policy" : "source collection failed";
      const sourceKind = blocked ? "url_blocked_robots" : "url_failed";
      const snapshot = {
        ...context, locator, sourceKind,
        contentHash: sha256(privateJsonValue({ sourceKind, warning })),
      } satisfies CreateSourceSnapshotInput;
      return Object.freeze({
        snapshot,
        collection: Object.freeze({
          status: blocked ? "blocked" : "failed",
          records: Object.freeze([]), evidence: Object.freeze([]), warnings: Object.freeze([warning]),
        }),
      });
    }
  }

  async collectSource(ownerId: string, resourceProductId: string, input: z.infer<typeof CreateResourceSourceRequestSchema>): Promise<CollectedSource> {
    assertResourceFoundryEnabled();
    await this.getProduct(ownerId, resourceProductId);
    const prepared = await this.prepareSource(ownerId, resourceProductId, input);
    const snapshot = await this.repository.createSourceSnapshot(prepared.snapshot);
    return Object.freeze({ snapshot, collection: prepared.collection });
  }

  async collectSourceAndReplaceCandidate(
    ownerId: string,
    resourceProductId: string,
    input: z.infer<typeof CollectResourceSourceCandidateRequestSchema>,
  ): Promise<CollectedSource & { readonly candidate: ResourcePackVersion }> {
    assertResourceFoundryEnabled();
    const product = await this.getProduct(ownerId, resourceProductId);
    const reference = product.currentCandidate;
    if (!reference || reference.packVersionId !== input.candidate.packVersionId ||
        reference.revision !== input.candidate.revision ||
        reference.semanticHash !== input.candidate.semanticHash) {
      throw new ResourceRepositoryConflictError();
    }
    const pack = await this.getPack(ownerId, resourceProductId, {
      packVersionId: reference.packVersionId,
      semanticHash: reference.semanticHash,
    });
    const prepared = await this.prepareSource(ownerId, resourceProductId, input.source);
    if (prepared.collection.status !== "collected") throw new ResourceServiceInvalidError();
    const content = parseResourcePackContent({
      ...pack.content,
      records: [...pack.content.records, ...prepared.collection.records],
      evidence: [...pack.content.evidence, ...prepared.collection.evidence],
      sourceSnapshotIds: [...pack.content.sourceSnapshotIds, prepared.snapshot.id!],
    });
    const created = await this.repository.createSourceSnapshotAndReplaceCandidate({
      snapshot: prepared.snapshot,
      candidate: {
        ownerId, resourceProductId,
        expectedCandidatePackVersionId: reference.packVersionId,
        expectedRevision: reference.revision,
        content,
        createdBy: ownerId,
      },
    });
    return Object.freeze({
      snapshot: created.snapshot,
      collection: prepared.collection,
      candidate: created.candidate,
    });
  }

  async importSiteAgentDraft(
    ownerId: string,
    input: z.infer<typeof ImportSiteAgentResourceRequestSchema>,
  ): Promise<{
    readonly resourceId: string;
    readonly sourceCount: number;
    readonly suggestedPriceUsdc: number;
    readonly collectionStatus: CollectedSource["collection"]["status"];
    readonly warnings: readonly string[];
  }> {
    assertResourceFoundryEnabled();
    const parsed = ImportSiteAgentResourceRequestSchema.parse(input);
    let normalizedPrimary: string;
    const normalizedSources: string[] = [];
    try {
      normalizedPrimary = validatePublicSourceUrl(parsed.url).toString();
      for (const sourceUrl of [parsed.url, ...parsed.sourceUrls]) {
        const normalized = validatePublicSourceUrl(sourceUrl).toString();
        if (!normalizedSources.includes(normalized)) normalizedSources.push(normalized);
      }
    } catch {
      throw new ResourceServiceInvalidError();
    }
    if (!normalizedSources.includes(normalizedPrimary)) normalizedSources.unshift(normalizedPrimary);
    if (normalizedSources.length === 0 || normalizedSources.length > 6) throw new ResourceServiceInvalidError();
    const slugBase = parsed.name.normalize("NFKD").toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 120) || "resource";
    const suffix = this.nextId().replace(/[^a-z0-9]/giu, "").toLowerCase().slice(0, 12) || "draft";
    const created = await this.createProduct(ownerId, {
      name: parsed.name,
      slug: `${slugBase}-${suffix}`,
      executionAccess: parsed.priceUsdc > 0 ? "paid" : "free",
      discoveryAccess: "unlisted",
      brief: {
        jobStatement: parsed.suggestedJob,
        buyerIntent: "Complete this named recurring job from reviewed website records.",
        inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
        outputSchema: {
          type: "array",
          items: {
            type: "object",
            properties: {
              url: { type: "string" }, title: { type: "string" },
              description: { type: "string" },
            },
            required: ["url", "title", "description"],
            additionalProperties: false,
          },
        },
        safeExample: [],
        recordSchema: {
          type: "object",
          properties: {
            url: { type: "string" }, title: { type: "string" },
            description: { type: "string" }, text: { type: "string" },
          },
          required: ["url", "title", "description", "text"],
          additionalProperties: false,
        },
        filterFields: [],
        returnFields: ["url", "title", "description"],
      },
    });
    const prepared = await this.prepareSource(ownerId, created.resource.id, {
      kind: "url", url: normalizedPrimary, freshnessDays: 30,
    }, { includeUrls: normalizedSources, maxPages: 6 });
    if (prepared.collection.status === "collected") {
      const content = parseResourcePackContent({
        ...created.candidate.content,
        records: [...created.candidate.content.records, ...prepared.collection.records],
        evidence: [...created.candidate.content.evidence, ...prepared.collection.evidence],
        sourceSnapshotIds: [...created.candidate.content.sourceSnapshotIds, prepared.snapshot.id!],
      });
      await this.repository.createSourceSnapshotAndReplaceCandidate({
        snapshot: prepared.snapshot,
        candidate: {
          ownerId, resourceProductId: created.resource.id,
          expectedCandidatePackVersionId: created.candidate.id,
          expectedRevision: created.candidate.revision,
          content, createdBy: ownerId,
        },
      });
    } else {
      await this.repository.createSourceSnapshot(prepared.snapshot);
    }
    return Object.freeze({
      resourceId: created.resource.id,
      sourceCount: prepared.collection.records.length,
      suggestedPriceUsdc: parsed.priceUsdc,
      collectionStatus: prepared.collection.status,
      warnings: prepared.collection.warnings,
    });
  }

  async replaceCandidate(ownerId: string, resourceProductId: string, input: z.infer<typeof ReplaceResourceCandidateRequestSchema>): Promise<ResourcePackVersion> {
    assertResourceFoundryEnabled();
    await this.getProduct(ownerId, resourceProductId);
    return this.repository.replaceCandidate({
      ownerId, resourceProductId,
      expectedCandidatePackVersionId: input.expectedCandidatePackVersionId,
      expectedRevision: input.expectedRevision,
      content: parseResourcePackContent(input.content),
      createdBy: ownerId,
    });
  }

  async approveCandidate(ownerId: string, resourceProductId: string, input: z.infer<typeof ApproveResourceCandidateRequestSchema>): Promise<ResourcePackVersion> {
    assertResourceFoundryEnabled();
    await this.getProduct(ownerId, resourceProductId);
    const candidate = await this.repository.getOwnedPack({
      ownerId,
      resourceProductId,
      packVersionId: input.candidatePackVersionId,
      semanticHash: input.expectedSemanticHash,
    });
    if (!candidate) throw new ResourceRepositoryConflictError();
    return this.repository.approveCandidate({
      ownerId, resourceProductId,
      candidatePackVersionId: input.candidatePackVersionId,
      expectedRevision: input.expectedRevision,
      expectedSemanticHash: input.expectedSemanticHash,
      approvedBy: ownerId,
    });
  }

  async getPack(ownerId: string, resourceProductId: string, reference: z.infer<typeof ExactReferenceSchema>): Promise<ResourcePackBundle> {
    assertResourceFoundryEnabled();
    await this.getProduct(ownerId, resourceProductId);
    const pack = await this.repository.getOwnedPack({ ownerId, resourceProductId, ...reference });
    if (!pack) throw new ResourceRepositoryNotFoundError();
    return pack;
  }

  private async approvedPack(ownerId: string, resourceProductId: string, reference: z.infer<typeof ExactReferenceSchema>): Promise<ResourcePackBundle> {
    const product = await this.getProduct(ownerId, resourceProductId);
    if (product.approvedPackVersionId !== reference.packVersionId && product.livePackVersionId !== reference.packVersionId) {
      throw new ResourceRepositoryNotFoundError();
    }
    return this.getPack(ownerId, resourceProductId, reference);
  }

  async refresh(ownerId: string, resourceProductId: string, input: z.infer<typeof RefreshResourceRequestSchema>): Promise<{ candidate: ResourcePackVersion; diff: ResourceRefreshDiff }> {
    assertResourceFoundryEnabled();
    const base = await this.approvedPack(ownerId, resourceProductId, input.base);
    const content = parseResourcePackContent(input.content);
    const candidate = await this.repository.replaceCandidate({
      ownerId, resourceProductId,
      expectedCandidatePackVersionId: input.expectedCandidatePackVersionId,
      expectedRevision: input.expectedRevision,
      content, createdBy: ownerId,
    });
    const candidateBundle = await this.getPack(ownerId, resourceProductId, {
      packVersionId: candidate.id, semanticHash: candidate.semanticHash,
    });
    return {
      candidate,
      diff: refreshDiff(base, candidateBundle),
    };
  }

  async refreshFromSource(
    ownerId: string,
    resourceProductId: string,
    input: z.infer<typeof RefreshResourceSourceRequestSchema>,
  ): Promise<{
    readonly snapshot: ResourceSourceSnapshot;
    readonly collection: CollectedSource["collection"];
    readonly candidate: ResourcePackVersion | null;
    readonly diff: ResourceRefreshDiff | null;
  }> {
    assertResourceFoundryEnabled();
    const parsed = RefreshResourceSourceRequestSchema.parse(input);
    const base = await this.approvedPack(ownerId, resourceProductId, parsed.base);
    const product = await this.getProduct(ownerId, resourceProductId);
    const current = product.currentCandidate;
    if ((current === null) !== (parsed.candidate === null) ||
        current && parsed.candidate && (
          current.packVersionId !== parsed.candidate.packVersionId ||
          current.revision !== parsed.candidate.revision ||
          current.semanticHash !== parsed.candidate.semanticHash
        )) {
      throw new ResourceRepositoryConflictError();
    }
    const working = parsed.candidate === null ? base : await this.getPack(ownerId, resourceProductId, {
      packVersionId: parsed.candidate.packVersionId,
      semanticHash: parsed.candidate.semanticHash,
    });
    const expectedRevision = parsed.candidate?.revision ?? Math.max(
      product.approvedPack?.revision ?? 0,
      product.livePack?.revision ?? 0,
    );
    const prepared = await this.prepareSource(ownerId, resourceProductId, parsed.source);
    if (prepared.collection.status !== "collected") {
      const snapshot = await this.repository.createSourceSnapshot(prepared.snapshot);
      return Object.freeze({ snapshot, collection: prepared.collection, candidate: null, diff: null });
    }
    const content = reviewedReplacementContent(working.content, prepared, parsed.replaceSourceSnapshotIds);
    const created = await this.repository.createSourceSnapshotAndReplaceCandidate({
      snapshot: prepared.snapshot,
      candidate: {
        ownerId,
        resourceProductId,
        expectedCandidatePackVersionId: parsed.candidate?.packVersionId ?? null,
        expectedRevision,
        content,
        createdBy: ownerId,
      },
    });
    const candidateBundle = await this.getPack(ownerId, resourceProductId, {
      packVersionId: created.candidate.id,
      semanticHash: created.candidate.semanticHash,
    });
    return Object.freeze({
      snapshot: created.snapshot,
      collection: prepared.collection,
      candidate: created.candidate,
      diff: refreshDiff(base, candidateBundle),
    });
  }

  async rejectRefreshCandidate(
    ownerId: string,
    resourceProductId: string,
    input: z.infer<typeof RejectResourceRefreshRequestSchema>,
  ): Promise<{ readonly decision: "rejected"; readonly approved: false; readonly republished: false }> {
    assertResourceFoundryEnabled();
    const parsed = RejectResourceRefreshRequestSchema.parse(input);
    await this.approvedPack(ownerId, resourceProductId, parsed.base);
    const product = await this.getProduct(ownerId, resourceProductId);
    if (!product.currentCandidate ||
        product.currentCandidate.packVersionId !== parsed.candidate.packVersionId ||
        product.currentCandidate.revision !== parsed.candidate.revision ||
        product.currentCandidate.semanticHash !== parsed.candidate.semanticHash) {
      throw new ResourceRepositoryConflictError();
    }
    await this.repository.rejectCandidate({
      ownerId, resourceProductId,
      candidatePackVersionId: parsed.candidate.packVersionId,
      expectedRevision: parsed.candidate.revision,
      expectedSemanticHash: parsed.candidate.semanticHash,
    });
    return Object.freeze({ decision: "rejected", approved: false, republished: false });
  }

  async dryRun(ownerId: string, resourceProductId: string, input: z.infer<typeof TestResourceRequestSchema>) {
    assertResourceFoundryEnabled();
    const pack = await this.approvedPack(ownerId, resourceProductId, input);
    const parsedInput = privateJsonValue(input.input);
    const parsedFilters = privateJsonValue(input.filters) as Readonly<Record<string, ResourceJsonValue>>;
    if (canonicalJson(parsedInput) !== canonicalJson(parsedFilters) ||
        !resourceSchemaAccepts(pack.content.jobContract.inputSchema, parsedInput)) {
      throw new ResourceServiceInvalidError();
    }
    const query = await executeResourceQuery({ getExactPack: () => pack }, {
      resourceProductId, packVersionId: input.packVersionId, semanticHash: input.semanticHash,
      filters: parsedFilters,
      filterFields: input.filterFields, returnFields: input.returnFields,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
    const expectedProperties = input.expectedProperties ?? input.returnFields;
    if (expectedProperties.length === 0 ||
        expectedProperties.some((property) => !input.returnFields.includes(property)) ||
        query.result.length === 0 ||
        query.result.some((row) => expectedProperties.some((property) => !Object.hasOwn(row, property)))) {
      throw new ResourceServiceInvalidError();
    }
    if (!query.resourceReceipt.outputSchemaValid) throw new ResourceRepositoryConflictError();
    return Object.freeze({
      packVersionId: input.packVersionId,
      semanticHash: input.semanticHash,
      inputSchemaValid: true,
      outputSchemaValid: true,
      measuredCostUsdc: 0,
      externalCalls: 0,
      settlementAttempted: false,
      result: query.result,
      resourceReceipt: query.resourceReceipt,
    });
  }

  async trust(ownerId: string, resourceProductId: string): Promise<ResourceTrustAnalytics> {
    assertResourceFoundryEnabled();
    await this.getProduct(ownerId, resourceProductId);
    return aggregateResourceTrust(await this.repository.listRunReceipts(ownerId, resourceProductId));
  }
}

export function resourceRecordFields(content: ResourcePackContent): readonly string[] {
  return recordSchemaFields(content.recordSchema);
}
