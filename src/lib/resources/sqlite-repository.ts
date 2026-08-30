import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { runSqliteMigrations } from "../db/migrations/sqlite";
import { canonicalizeResourcePack, resourcePackSemanticHash } from "./pack-hash";
import {
  RESOURCE_PERSISTENCE_INTEGRITY_ERROR,
  ResourceAmbiguousFinalCommitError,
  ResourcePersistenceError,
  ResourceRepositoryConflictError,
  ResourceRepositoryNotFoundError,
  resourceFreshness,
  type ApproveCandidateInput,
  type CreateResourceProductInput,
  type CreateResourceProductWithCandidateInput,
  type CreatedResourceProductWithCandidate,
  type CreateSourceSnapshotAndReplaceCandidateInput,
  type CreatedSourceSnapshotAndCandidate,
  type CreateResourceReleaseInput,
  type CreateResourceRunReceiptInput,
  type CreateSourceSnapshotInput,
  type OwnedResourceQueryReference,
  type ReplaceCandidateInput,
  type ResourcePackVersion,
  type ResourcePortfolioItem,
  type ResourceCurrentReleaseSummary,
  type ResourceRelease,
  type ResourceRepository,
  type ResourceRunReceipt,
  type TransitionResourceReleaseLifecycleInput,
  type TransitionResourceReleaseLifecycleResult,
  type UpdateResourceProductInput,
} from "./repository";
import { parseResourcePackContent, parseResourceProduct, parseSourceSnapshot } from "./schemas";
import type { EvidencePointer, ResourcePackBundle, ResourceProduct, ResourceSourceSnapshot } from "./types";

interface Options {
  readonly now?: () => Date;
  readonly id?: () => string;
}

type Row = Record<string, unknown>;

function integrity(): never {
  throw new ResourcePersistenceError(RESOURCE_PERSISTENCE_INTEGRITY_ERROR);
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") integrity();
  try { return JSON.parse(value); } catch { integrity(); }
}

function same(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length && left.every((value, index) => same(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined).sort();
  const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && same(leftRecord[key], rightRecord[key]));
}

function evidencePointer(value: unknown): EvidencePointer {
  if (!value || typeof value !== "object" || Array.isArray(value)) integrity();
  const row = value as Record<string, unknown>;
  const allowed = new Set(["id", "sourceSnapshotId", "locator", "observedAt", "fieldHash", "confidence", "conflict"]);
  if (Object.keys(row).some((key) => !allowed.has(key)) ||
      typeof row.id !== "string" || typeof row.sourceSnapshotId !== "string" ||
      typeof row.locator !== "string" || typeof row.observedAt !== "string" ||
      Number.isNaN(Date.parse(row.observedAt)) ||
      (row.fieldHash !== undefined && (typeof row.fieldHash !== "string" || !/^[a-f0-9]{64}$/u.test(row.fieldHash))) ||
      (row.confidence !== undefined && (typeof row.confidence !== "number" || !Number.isFinite(row.confidence) || row.confidence < 0 || row.confidence > 1)) ||
      (row.conflict !== undefined && typeof row.conflict !== "string")) integrity();
  return Object.freeze({
    id: row.id, sourceSnapshotId: row.sourceSnapshotId, locator: row.locator,
    observedAt: row.observedAt,
    ...(row.fieldHash === undefined ? {} : { fieldHash: row.fieldHash as string }),
    ...(row.confidence === undefined ? {} : { confidence: row.confidence as number }),
    ...(row.conflict === undefined ? {} : { conflict: row.conflict as string }),
  });
}

function productFromRow(row: Row): ResourceProduct {
  return parseResourceProduct({
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    executionAccess: row.execution_access,
    discoveryAccess: row.discovery_access,
  });
}

function snapshotFromRow(row: Row): ResourceSourceSnapshot {
  return parseSourceSnapshot({
    id: row.id,
    resourceProductId: row.resource_product_id,
    locator: row.locator,
    sourceKind: row.source_kind,
    capturedAt: row.captured_at,
    ...(row.source_published_at === null ? {} : { sourcePublishedAt: row.source_published_at }),
    contentHash: row.content_hash,
    freshnessDeadline: row.freshness_deadline,
    ...(row.provenance === null ? {} : { provenance: row.provenance }),
    ...(row.provenance_note === null ? {} : { provenanceNote: row.provenance_note }),
  });
}

function releaseFromRow(row: Row): ResourceRelease {
  const values = [
    "id", "owner_id", "resource_product_id", "pack_version_id", "semantic_hash",
    "publication_key", "publication_request_hash", "graph_semantic_hash", "graph_full_hash",
    "execution_access", "discovery_access", "agent_id", "flow_id", "flow_version_id",
    "deployment_id", "environment_id", "created_at",
  ];
  if (values.some((key) => typeof row[key] !== "string")) integrity();
  if (typeof row.price_usdc !== "number" || !Number.isFinite(row.price_usdc) ||
      !["free", "paid", "private"].includes(row.execution_access as string) ||
      !["public", "unlisted"].includes(row.discovery_access as string)) integrity();
  return Object.freeze({
    id: row.id as string, ownerId: row.owner_id as string,
    resourceProductId: row.resource_product_id as string,
    packVersionId: row.pack_version_id as string, semanticHash: row.semantic_hash as string,
    publicationKey: row.publication_key as string,
    publicationRequestHash: row.publication_request_hash as string,
    graphSemanticHash: row.graph_semantic_hash as string,
    graphFullHash: row.graph_full_hash as string,
    priceUsdc: row.price_usdc,
    executionAccess: row.execution_access as ResourceRelease["executionAccess"],
    discoveryAccess: row.discovery_access as ResourceRelease["discoveryAccess"],
    agentId: row.agent_id as string, flowId: row.flow_id as string,
    flowVersionId: row.flow_version_id as string, deploymentId: row.deployment_id as string,
    environmentId: row.environment_id as string, createdAt: row.created_at as string,
  });
}

function receiptFromRow(row: Row): ResourceRunReceipt {
  const values = ["id", "owner_id", "resource_product_id", "pack_version_id", "agent_id", "run_id", "flow_version_id", "deployment_id", "payment_state", "semantic_hash", "freshness", "created_at"];
  if (values.some((key) => typeof row[key] !== "string") || !["fresh", "stale", "mixed"].includes(row.freshness as string)) integrity();
  const evidence = parseJson(row.evidence_json);
  const unknowns = parseJson(row.unknowns_json);
  const conflicts = parseJson(row.conflicts_json);
  if (!Array.isArray(evidence) || !Array.isArray(unknowns) || !Array.isArray(conflicts) ||
      unknowns.some((item) => typeof item !== "string") || conflicts.some((item) => typeof item !== "string") ||
      (row.output_schema_valid !== 0 && row.output_schema_valid !== 1) ||
      !["free", "challenged", "credited", "settled", "refunded", "failed"].includes(row.payment_state as string) ||
      (row.payment_id !== null && typeof row.payment_id !== "string") ||
      typeof row.price_usdc !== "number" || !Number.isFinite(row.price_usdc) || row.price_usdc < 0) integrity();
  const parsedEvidence = evidence.map(evidencePointer);
  return Object.freeze({
    id: row.id as string, ownerId: row.owner_id as string,
    resourceProductId: row.resource_product_id as string,
    packVersionId: row.pack_version_id as string, agentId: row.agent_id as string, runId: row.run_id as string,
    flowVersionId: row.flow_version_id as string, deploymentId: row.deployment_id as string,
    paymentId: row.payment_id as string | null,
    paymentState: row.payment_state as ResourceRunReceipt["paymentState"],
    priceUsdc: row.price_usdc as number,
    resourceVersion: row.pack_version_id as string, semanticHash: row.semantic_hash as string,
    freshness: row.freshness as ResourceRunReceipt["freshness"],
    evidence: Object.freeze(parsedEvidence),
    unknowns: Object.freeze(unknowns as string[]), conflicts: Object.freeze(conflicts as string[]),
    outputSchemaValid: row.output_schema_valid === 1, createdAt: row.created_at as string,
  });
}

function nonnegativeNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) integrity();
  return value;
}

function nonnegativeInteger(value: unknown): number {
  const parsed = nonnegativeNumber(value);
  if (!Number.isSafeInteger(parsed)) integrity();
  return parsed;
}

function currentReleaseSummaryFromRow(row: Row): ResourceCurrentReleaseSummary | null {
  if (row.release_id === null) return null;
  const stringKeys = [
    "release_id", "release_resource_product_id", "release_pack_version_id", "release_semantic_hash",
    "release_publication_key", "release_publication_request_hash", "release_agent_id",
    "release_agent_status", "release_flow_version_id", "release_deployment_id",
    "release_deployment_status", "release_created_at", "release_agent_slug",
  ];
  if (stringKeys.some((key) => typeof row[key] !== "string") ||
      !/^[a-f0-9]{64}$/u.test(row.release_semantic_hash as string) ||
      !/^[a-f0-9]{64}$/u.test(row.release_publication_request_hash as string) ||
      (row.release_settlement_live !== 0 && row.release_settlement_live !== 1) ||
      !["paid", "free", "private"].includes(row.release_execution_access as string) ||
      !["public", "unlisted"].includes(row.release_discovery_access as string) ||
      !["fresh", "stale", "mixed"].includes(row.release_freshness as string) ||
      !["draft", "live"].includes(row.release_agent_status as string) ||
      !["live", "retired"].includes(row.release_deployment_status as string) ||
      (row.release_deployment_retired_at !== null &&
        (typeof row.release_deployment_retired_at !== "number" ||
          !Number.isSafeInteger(row.release_deployment_retired_at) || row.release_deployment_retired_at < 0)) ||
      ((row.release_deployment_status === "live") !== (row.release_deployment_retired_at === null))) {
    integrity();
  }
  const slug = row.release_agent_slug as string;
  const root = `/api/agents/${encodeURIComponent(slug)}`;
  return Object.freeze({
    id: row.release_id as string,
    resourceProductId: row.release_resource_product_id as string,
    packVersionId: row.release_pack_version_id as string,
    semanticHash: row.release_semantic_hash as string,
    publicationKey: row.release_publication_key as string,
    publicationRequestHash: row.release_publication_request_hash as string,
    priceUsdc: nonnegativeNumber(row.release_price_usdc),
    executionAccess: row.release_execution_access as ResourceCurrentReleaseSummary["executionAccess"],
    discoveryAccess: row.release_discovery_access as ResourceCurrentReleaseSummary["discoveryAccess"],
    freshness: row.release_freshness as ResourceCurrentReleaseSummary["freshness"],
    payoutReady: row.release_execution_access !== "paid" || row.wallet_owner_id !== null,
    settlementState: row.release_settlement_live === 1 ? "on" : "off",
    agentId: row.release_agent_id as string,
    agentStatus: row.release_agent_status as ResourceCurrentReleaseSummary["agentStatus"],
    flowVersionId: row.release_flow_version_id as string,
    deploymentId: row.release_deployment_id as string,
    deploymentStatus: row.release_deployment_status as ResourceCurrentReleaseSummary["deploymentStatus"],
    deploymentRetiredAt: row.release_deployment_retired_at === null
      ? null
      : new Date(row.release_deployment_retired_at as number).toISOString(),
    createdAt: row.release_created_at as string,
    urls: Object.freeze({
      run: `${root}/run`,
      card: `${root}/.well-known/agent-card.json`,
      x402: `${root}/.well-known/x402`,
      a2a: `${root}/a2a`,
      public: `/a/${encodeURIComponent(slug)}`,
    }),
  });
}

export class SqliteResourceRepository implements ResourceRepository {
  private readonly db: Database.Database;
  private readonly now: () => Date;
  private readonly nextId: () => string;

  constructor(path: string | Database.Database = "studio.db", options: Options = {}) {
    this.now = options.now ?? (() => new Date());
    this.nextId = options.id ?? randomUUID;
    if (typeof path !== "string") {
      this.db = path;
    } else {
      this.db = new Database(path);
      this.db.pragma("journal_mode = WAL");
      runSqliteMigrations(this.db);
    }
  }

  private iso(): string { return this.now().toISOString(); }

  private ownedProduct(ownerId: string, productId: string): Row | undefined {
    return this.db.prepare("SELECT * FROM resource_products WHERE id=? AND owner_id=?").get(productId, ownerId) as Row | undefined;
  }

  private requireOwned(ownerId: string, productId: string): Row {
    const row = this.ownedProduct(ownerId, productId);
    if (!row) throw new ResourceRepositoryNotFoundError();
    return row;
  }

  private persistPack(input: { id: string; productId: string; revision: number; status: "candidate"; semanticHash: string; content: ReturnType<typeof parseResourcePackContent>; createdBy: string; createdAt: string }): void {
    this.db.prepare(`INSERT INTO resource_pack_versions
      (id,resource_product_id,revision,status,semantic_hash,content_json,created_by,created_at,approved_by,approved_at)
      VALUES (?,?,?,?,?,?,?,?,NULL,NULL)`).run(
      input.id, input.productId, input.revision, input.status, input.semanticHash,
      canonicalizeResourcePack(input.content).canonicalBytes.toString("utf8"), input.createdBy, input.createdAt,
    );
    const recordInsert = this.db.prepare(`INSERT INTO resource_records
      (pack_version_id,id,fields_json,tags_json,evidence_ids_json,unknowns_json,conflicts_json)
      VALUES (?,?,?,?,?,?,?)`);
    for (const record of input.content.records) recordInsert.run(
      input.id, record.id, json(record.fields), json(record.tags), json(record.evidenceIds),
      record.unknowns === undefined ? null : json(record.unknowns),
      record.conflicts === undefined ? null : json(record.conflicts),
    );
    const evidenceInsert = this.db.prepare(`INSERT INTO resource_evidence_refs
      (pack_version_id,id,source_snapshot_id,locator,observed_at,field_hash,confidence,conflict)
      VALUES (?,?,?,?,?,?,?,?)`);
    for (const evidence of input.content.evidence) evidenceInsert.run(
      input.id, evidence.id, evidence.sourceSnapshotId, evidence.locator, evidence.observedAt,
      evidence.fieldHash ?? null, evidence.confidence ?? null, evidence.conflict ?? null,
    );
  }

  private parsedSnapshot(input: CreateSourceSnapshotInput): ResourceSourceSnapshot {
    return parseSourceSnapshot({
      id: input.id ?? this.nextId(),
      resourceProductId: input.resourceProductId,
      locator: input.locator,
      sourceKind: input.sourceKind,
      capturedAt: input.capturedAt,
      ...(input.sourcePublishedAt === undefined ? {} : { sourcePublishedAt: input.sourcePublishedAt }),
      contentHash: input.contentHash,
      freshnessDeadline: input.freshnessDeadline,
      ...(input.provenance === undefined ? {} : { provenance: input.provenance }),
      ...(input.provenanceNote === undefined ? {} : { provenanceNote: input.provenanceNote }),
    });
  }

  private insertSnapshotRow(input: CreateSourceSnapshotInput, parsed: ResourceSourceSnapshot): Row {
    const sourceAssetId = input.sourceAssetId ?? this.nextId();
    this.db.prepare(`INSERT INTO resource_source_assets (id,resource_product_id,locator,source_kind,created_at)
      VALUES (?,?,?,?,?) ON CONFLICT(resource_product_id,locator,source_kind) DO NOTHING`).run(
      sourceAssetId, input.resourceProductId, parsed.locator, parsed.sourceKind, this.iso(),
    );
    const asset = this.db.prepare("SELECT id FROM resource_source_assets WHERE resource_product_id=? AND locator=? AND source_kind=?")
      .get(input.resourceProductId, parsed.locator, parsed.sourceKind) as { id: string };
    this.db.prepare(`INSERT INTO resource_source_snapshots
      (id,resource_product_id,source_asset_id,locator,source_kind,captured_at,source_published_at,content_hash,freshness_deadline,provenance,provenance_note,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      parsed.id, parsed.resourceProductId, asset.id, parsed.locator, parsed.sourceKind,
      parsed.capturedAt, parsed.sourcePublishedAt ?? null, parsed.contentHash,
      parsed.freshnessDeadline, parsed.provenance ?? null, parsed.provenanceNote ?? null, this.iso(),
    );
    return this.db.prepare("SELECT * FROM resource_source_snapshots WHERE id=?").get(parsed.id) as Row;
  }

  private replaceCandidateRow(
    input: ReplaceCandidateInput,
    content: ReturnType<typeof parseResourcePackContent>,
    semanticHash: string,
  ): Row {
    const product = this.requireOwned(input.ownerId, input.resourceProductId);
    if (product.status === "retired") throw new ResourceRepositoryConflictError();
    const current = this.db.prepare("SELECT id,revision FROM resource_pack_versions WHERE resource_product_id=? AND status='candidate'")
      .get(input.resourceProductId) as { id: string; revision: number } | undefined;
    const maximum = this.db.prepare("SELECT COALESCE(MAX(revision),0) revision FROM resource_pack_versions WHERE resource_product_id=?")
      .get(input.resourceProductId) as { revision: number };
    if ((current?.id ?? null) !== input.expectedCandidatePackVersionId || maximum.revision !== input.expectedRevision) {
      throw new ResourceRepositoryConflictError();
    }
    for (const snapshotId of content.sourceSnapshotIds) {
      if (!this.db.prepare("SELECT 1 FROM resource_source_snapshots WHERE id=? AND resource_product_id=?")
        .get(snapshotId, input.resourceProductId)) throw new ResourceRepositoryConflictError();
    }
    if (current) this.db.prepare("DELETE FROM resource_pack_versions WHERE id=? AND status='candidate'").run(current.id);
    const row = {
      id: this.nextId(), productId: input.resourceProductId, revision: maximum.revision + 1,
      status: "candidate" as const, semanticHash, content, createdBy: input.createdBy,
      createdAt: this.iso(),
    };
    this.persistPack(row);
    return this.db.prepare("SELECT * FROM resource_pack_versions WHERE id=?").get(row.id) as Row;
  }

  private packFromRow(row: Row): ResourcePackVersion {
    if (typeof row.content_json !== "string" || typeof row.semantic_hash !== "string" ||
        typeof row.id !== "string" || typeof row.resource_product_id !== "string" ||
        typeof row.revision !== "number" || typeof row.status !== "string" ||
        typeof row.created_by !== "string" || typeof row.created_at !== "string") integrity();
    let content;
    try { content = parseResourcePackContent(parseJson(row.content_json)); } catch { integrity(); }
    const recomputed = resourcePackSemanticHash(content).semanticHash;
    if (recomputed !== row.semantic_hash) integrity();
    const records = this.db.prepare("SELECT * FROM resource_records WHERE pack_version_id=? ORDER BY id").all(row.id) as Row[];
    const evidence = this.db.prepare("SELECT * FROM resource_evidence_refs WHERE pack_version_id=? ORDER BY id").all(row.id) as Row[];
    const projectedRecords = records.map((item) => ({
      id: item.id, fields: parseJson(item.fields_json), tags: parseJson(item.tags_json),
      evidenceIds: parseJson(item.evidence_ids_json),
      ...(item.unknowns_json === null ? {} : { unknowns: parseJson(item.unknowns_json) }),
      ...(item.conflicts_json === null ? {} : { conflicts: parseJson(item.conflicts_json) }),
    }));
    const projectedEvidence = evidence.map((item) => ({
      id: item.id, sourceSnapshotId: item.source_snapshot_id, locator: item.locator,
      observedAt: item.observed_at,
      ...(item.field_hash === null ? {} : { fieldHash: item.field_hash }),
      ...(item.confidence === null ? {} : { confidence: item.confidence }),
      ...(item.conflict === null ? {} : { conflict: item.conflict }),
    }));
    if (!same(projectedRecords, content.records) || !same(projectedEvidence, content.evidence)) integrity();
    if (!["candidate", "approved", "live", "retired"].includes(row.status)) integrity();
    return Object.freeze({
      id: row.id, resourceProductId: row.resource_product_id, revision: row.revision,
      status: row.status as ResourcePackVersion["status"], semanticHash: row.semantic_hash,
      content, createdBy: row.created_by, createdAt: row.created_at,
      ...(row.approved_by === null ? {} : { approvedBy: row.approved_by as string }),
      ...(row.approved_at === null ? {} : { approvedAt: row.approved_at as string }),
    });
  }

  async createProduct(input: CreateResourceProductInput): Promise<ResourceProduct> {
    const id = input.id ?? this.nextId();
    const parsed = parseResourceProduct({ ...input, id, status: "draft" });
    const now = this.iso();
    try {
      this.db.prepare(`INSERT INTO resource_products
        (id,owner_id,name,slug,status,execution_access,discovery_access,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(parsed.id, parsed.ownerId, parsed.name, parsed.slug, parsed.status, parsed.executionAccess, parsed.discoveryAccess, now, now);
      return parsed;
    } catch (error) {
      if (String(error).includes("UNIQUE") || String(error).includes("PRIMARY KEY")) throw new ResourceRepositoryConflictError();
      throw error;
    }
  }

  async createProductWithCandidate(input: CreateResourceProductWithCandidateInput): Promise<CreatedResourceProductWithCandidate> {
    const productId = input.id ?? this.nextId();
    const candidateId = this.nextId();
    const parsedProduct = parseResourceProduct({
      id: productId, ownerId: input.ownerId, name: input.name, slug: input.slug,
      status: "draft", executionAccess: input.executionAccess, discoveryAccess: input.discoveryAccess,
    });
    const content = parseResourcePackContent(input.content);
    const hashed = resourcePackSemanticHash(content);
    const operation = this.db.transaction(() => {
      const now = this.iso();
      this.db.prepare(`INSERT INTO resource_products
        (id,owner_id,name,slug,status,execution_access,discovery_access,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(
        parsedProduct.id, parsedProduct.ownerId, parsedProduct.name, parsedProduct.slug,
        parsedProduct.status, parsedProduct.executionAccess, parsedProduct.discoveryAccess, now, now,
      );
      this.persistPack({
        id: candidateId, productId: parsedProduct.id, revision: 1, status: "candidate",
        semanticHash: hashed.semanticHash, content, createdBy: input.createdBy, createdAt: now,
      });
      return this.db.prepare("SELECT * FROM resource_pack_versions WHERE id=?").get(candidateId) as Row;
    });
    try {
      return Object.freeze({ product: parsedProduct, candidate: this.packFromRow(operation.immediate()) });
    } catch (error) {
      if (String(error).includes("UNIQUE") || String(error).includes("PRIMARY KEY")) throw new ResourceRepositoryConflictError();
      throw error;
    }
  }

  async getOwnedProduct(ownerId: string, productId: string): Promise<ResourceProduct | null> {
    const row = this.ownedProduct(ownerId, productId);
    return row ? productFromRow(row) : null;
  }

  private ownedPortfolioItems(ownerId: string, productId?: string): readonly ResourcePortfolioItem[] {
    const ownedScope = productId === undefined
      ? "SELECT * FROM resource_products WHERE owner_id=? ORDER BY updated_at DESC,id DESC LIMIT 100"
      : "SELECT * FROM resource_products WHERE owner_id=? AND id=? LIMIT 1";
    const ownedParameters = productId === undefined ? [ownerId] : [ownerId, productId];
    const rows = this.db.prepare(`WITH owned AS (
        ${ownedScope}
      ), refs AS (
        SELECT p.*,
          (SELECT revision FROM resource_pack_versions v WHERE v.resource_product_id=p.id AND v.status='candidate' ORDER BY revision DESC LIMIT 1) candidate_revision,
          (SELECT id FROM resource_pack_versions v WHERE v.resource_product_id=p.id AND v.status='candidate' ORDER BY revision DESC LIMIT 1) candidate_pack_id,
          (SELECT semantic_hash FROM resource_pack_versions v WHERE v.resource_product_id=p.id AND v.status='candidate' ORDER BY revision DESC LIMIT 1) candidate_pack_hash,
          (SELECT id FROM resource_pack_versions v WHERE v.resource_product_id=p.id AND v.status='approved' ORDER BY revision DESC LIMIT 1) approved_pack_id,
          (SELECT revision FROM resource_pack_versions v WHERE v.resource_product_id=p.id AND v.status='approved' ORDER BY revision DESC LIMIT 1) approved_pack_revision,
          (SELECT semantic_hash FROM resource_pack_versions v WHERE v.resource_product_id=p.id AND v.status='approved' ORDER BY revision DESC LIMIT 1) approved_pack_hash,
          (SELECT id FROM resource_pack_versions v WHERE v.resource_product_id=p.id AND v.status='live' ORDER BY revision DESC LIMIT 1) live_pack_id,
          (SELECT revision FROM resource_pack_versions v WHERE v.resource_product_id=p.id AND v.status='live' ORDER BY revision DESC LIMIT 1) live_pack_revision,
          (SELECT semantic_hash FROM resource_pack_versions v WHERE v.resource_product_id=p.id AND v.status='live' ORDER BY revision DESC LIMIT 1) live_pack_hash
        FROM owned p
      ), selected AS (
        SELECT refs.*,COALESCE(candidate_pack_id,
          CASE WHEN COALESCE(approved_pack_revision,0)>COALESCE(live_pack_revision,0) THEN approved_pack_id ELSE live_pack_id END,
          approved_pack_id) selected_pack_id FROM refs
      )
      SELECT selected.*,
        (SELECT CASE
          WHEN json_array_length(v.content_json,'$.sourceSnapshotIds')=0 THEN 'fresh'
          WHEN EXISTS(SELECT 1 FROM json_each(v.content_json,'$.sourceSnapshotIds') d
            LEFT JOIN resource_source_snapshots s ON s.id=d.value AND s.resource_product_id=v.resource_product_id
            WHERE s.id IS NULL) THEN 'invalid'
          WHEN NOT EXISTS(SELECT 1 FROM json_each(v.content_json,'$.sourceSnapshotIds') d
            JOIN resource_source_snapshots s ON s.id=d.value AND s.resource_product_id=v.resource_product_id
            WHERE s.freshness_deadline < ?) THEN 'fresh'
          WHEN NOT EXISTS(SELECT 1 FROM json_each(v.content_json,'$.sourceSnapshotIds') d
            JOIN resource_source_snapshots s ON s.id=d.value AND s.resource_product_id=v.resource_product_id
            WHERE s.freshness_deadline >= ?) THEN 'stale'
          ELSE 'mixed' END FROM resource_pack_versions v WHERE v.id=selected.selected_pack_id
        ) portfolio_freshness,
        (SELECT COUNT(*) FROM resource_releases r WHERE r.resource_product_id=selected.id) release_count,
        (SELECT COUNT(*) FROM resource_run_receipts r WHERE r.resource_product_id=selected.id) receipt_count,
        (SELECT COUNT(*) FROM resource_run_receipts r WHERE r.resource_product_id=selected.id AND r.payment_state='free') free_count,
        (SELECT COUNT(*) FROM resource_run_receipts r WHERE r.resource_product_id=selected.id AND r.payment_state='challenged') challenged_count,
        (SELECT COUNT(*) FROM resource_run_receipts r WHERE r.resource_product_id=selected.id AND r.payment_state IN ('free','credited','settled','refunded')) executed_count,
        (SELECT COUNT(*) FROM resource_run_receipts r WHERE r.resource_product_id=selected.id AND r.payment_state='credited') credited_count,
        (SELECT ROUND(COALESCE(SUM(r.price_usdc),0),6) FROM resource_run_receipts r WHERE r.resource_product_id=selected.id AND r.payment_state='credited') credited_amount,
        (SELECT COUNT(*) FROM resource_run_receipts r WHERE r.resource_product_id=selected.id AND r.payment_state='settled') settled_count,
        (SELECT ROUND(COALESCE(SUM(r.price_usdc),0),6) FROM resource_run_receipts r WHERE r.resource_product_id=selected.id AND r.payment_state='settled') settled_amount,
        (SELECT COUNT(*) FROM resource_run_receipts r WHERE r.resource_product_id=selected.id AND r.payment_state='refunded') refunded_count,
        (SELECT ROUND(COALESCE(SUM(r.price_usdc),0),6) FROM resource_run_receipts r WHERE r.resource_product_id=selected.id AND r.payment_state='refunded') refunded_amount,
        (SELECT COUNT(*) FROM resource_run_receipts r WHERE r.resource_product_id=selected.id AND r.payment_state='failed') failed_count,
        rel.id release_id,rel.resource_product_id release_resource_product_id,
        rel.pack_version_id release_pack_version_id,
        rel.semantic_hash release_semantic_hash,rel.publication_key release_publication_key,
        rel.publication_request_hash release_publication_request_hash,
        rel.price_usdc release_price_usdc,rel.execution_access release_execution_access,
        rel.discovery_access release_discovery_access,
        (SELECT CASE
          WHEN json_array_length(v.content_json,'$.sourceSnapshotIds')=0 THEN 'fresh'
          WHEN EXISTS(SELECT 1 FROM json_each(v.content_json,'$.sourceSnapshotIds') d
            LEFT JOIN resource_source_snapshots s ON s.id=d.value AND s.resource_product_id=v.resource_product_id
            WHERE s.id IS NULL) THEN 'invalid'
          WHEN NOT EXISTS(SELECT 1 FROM json_each(v.content_json,'$.sourceSnapshotIds') d
            JOIN resource_source_snapshots s ON s.id=d.value AND s.resource_product_id=v.resource_product_id
            WHERE s.freshness_deadline < ?) THEN 'fresh'
          WHEN NOT EXISTS(SELECT 1 FROM json_each(v.content_json,'$.sourceSnapshotIds') d
            JOIN resource_source_snapshots s ON s.id=d.value AND s.resource_product_id=v.resource_product_id
            WHERE s.freshness_deadline >= ?) THEN 'stale'
          ELSE 'mixed' END FROM resource_pack_versions v WHERE v.id=rel.pack_version_id
        ) release_freshness,
        rel.agent_id release_agent_id,agent.status release_agent_status,
        rel.flow_version_id release_flow_version_id,
        rel.deployment_id release_deployment_id,deployment.status release_deployment_status,
        deployment.retired_at release_deployment_retired_at,rel.created_at release_created_at,
        agent.slug release_agent_slug,agent.settlement_live release_settlement_live,
        wallet.owner_id wallet_owner_id
      FROM selected
      LEFT JOIN resource_releases rel ON rel.id=(SELECT r.id FROM resource_releases r
        WHERE r.owner_id=? AND r.resource_product_id=selected.id ORDER BY r.created_at DESC,r.id DESC LIMIT 1)
      LEFT JOIN agents agent ON agent.id=rel.agent_id
      LEFT JOIN deployments deployment ON deployment.id=rel.deployment_id
      LEFT JOIN wallets wallet ON wallet.owner_id=selected.owner_id
      ORDER BY selected.updated_at DESC,selected.id DESC`).all(
        ...ownedParameters, this.iso(), this.iso(), this.iso(), this.iso(), ownerId,
      ) as Row[];
    const reference = (id: unknown, revision: unknown, semanticHash: unknown) => id === null ? null : Object.freeze({
      packVersionId: String(id), revision: Number(revision), semanticHash: String(semanticHash),
    });
    return Object.freeze(rows.map((row) => {
      const currentCandidate = reference(row.candidate_pack_id, row.candidate_revision, row.candidate_pack_hash);
      const approvedPack = reference(row.approved_pack_id, row.approved_pack_revision, row.approved_pack_hash);
      const livePack = reference(row.live_pack_id, row.live_pack_revision, row.live_pack_hash);
      if (row.portfolio_freshness !== null && !["fresh", "stale", "mixed"].includes(String(row.portfolio_freshness))) integrity();
      return Object.freeze({
        ...productFromRow(row), candidateRevision: row.candidate_revision === null ? null : Number(row.candidate_revision),
        approvedPackVersionId: approvedPack?.packVersionId ?? null,
        livePackVersionId: livePack?.packVersionId ?? null,
        currentCandidate, approvedPack, livePack,
        portfolioFreshness: row.portfolio_freshness as ResourcePortfolioItem["portfolioFreshness"],
        portfolioPayments: Object.freeze({
          attempted: null,
          free: nonnegativeInteger(row.free_count),
          challenged: null,
          executed: nonnegativeInteger(row.executed_count),
          credited: Object.freeze({ count: nonnegativeInteger(row.credited_count), amountUsdc: nonnegativeNumber(row.credited_amount) }),
          settled: Object.freeze({ count: nonnegativeInteger(row.settled_count), amountUsdc: nonnegativeNumber(row.settled_amount) }),
          refunded: Object.freeze({ count: null, amountUsdc: null }),
          failed: null,
        }),
        currentRelease: currentReleaseSummaryFromRow(row),
        releaseCount: nonnegativeInteger(row.release_count), runReceiptCount: nonnegativeInteger(row.receipt_count),
      });
    }));
  }

  async getOwnedPortfolioItem(ownerId: string, productId: string): Promise<ResourcePortfolioItem | null> {
    return this.ownedPortfolioItems(ownerId, productId)[0] ?? null;
  }

  async listOwnedProducts(ownerId: string): Promise<readonly ResourcePortfolioItem[]> {
    return this.ownedPortfolioItems(ownerId);
  }

  async listOwnedReleaseHistory(
    ownerId: string,
    resourceProductId: string,
    limit: number,
  ): Promise<readonly ResourceCurrentReleaseSummary[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) integrity();
    const rows = this.db.prepare(`SELECT
        rel.id release_id,rel.resource_product_id release_resource_product_id,
        rel.pack_version_id release_pack_version_id,rel.semantic_hash release_semantic_hash,
        rel.publication_key release_publication_key,
        rel.publication_request_hash release_publication_request_hash,
        rel.price_usdc release_price_usdc,rel.execution_access release_execution_access,
        rel.discovery_access release_discovery_access,
        (SELECT CASE
          WHEN json_array_length(v.content_json,'$.sourceSnapshotIds')=0 THEN 'fresh'
          WHEN EXISTS(SELECT 1 FROM json_each(v.content_json,'$.sourceSnapshotIds') d
            LEFT JOIN resource_source_snapshots s ON s.id=d.value AND s.resource_product_id=v.resource_product_id
            WHERE s.id IS NULL) THEN 'invalid'
          WHEN NOT EXISTS(SELECT 1 FROM json_each(v.content_json,'$.sourceSnapshotIds') d
            JOIN resource_source_snapshots s ON s.id=d.value AND s.resource_product_id=v.resource_product_id
            WHERE s.freshness_deadline < ?) THEN 'fresh'
          WHEN NOT EXISTS(SELECT 1 FROM json_each(v.content_json,'$.sourceSnapshotIds') d
            JOIN resource_source_snapshots s ON s.id=d.value AND s.resource_product_id=v.resource_product_id
            WHERE s.freshness_deadline >= ?) THEN 'stale'
          ELSE 'mixed' END FROM resource_pack_versions v WHERE v.id=rel.pack_version_id
        ) release_freshness,
        rel.agent_id release_agent_id,agent.status release_agent_status,
        rel.flow_version_id release_flow_version_id,
        rel.deployment_id release_deployment_id,deployment.status release_deployment_status,
        deployment.retired_at release_deployment_retired_at,rel.created_at release_created_at,
        agent.slug release_agent_slug,agent.settlement_live release_settlement_live,
        wallet.owner_id wallet_owner_id
      FROM resource_releases rel
      JOIN resource_products product ON product.id=rel.resource_product_id
        AND product.owner_id=rel.owner_id AND product.owner_id=? AND product.id=?
      LEFT JOIN agents agent ON agent.id=rel.agent_id
      LEFT JOIN deployments deployment ON deployment.id=rel.deployment_id
      LEFT JOIN wallets wallet ON wallet.owner_id=rel.owner_id
      ORDER BY rel.created_at DESC,rel.id DESC LIMIT ?`).all(
        this.iso(), this.iso(), ownerId, resourceProductId, limit,
      ) as Row[];
    return Object.freeze(rows.map((row) => {
      const summary = currentReleaseSummaryFromRow(row);
      if (!summary || summary.resourceProductId !== resourceProductId) integrity();
      return summary;
    }));
  }

  async updateOwnedDraft(input: UpdateResourceProductInput): Promise<ResourceProduct> {
    const current = productFromRow(this.requireOwned(input.ownerId, input.resourceProductId));
    if (current.status !== input.expectedStatus) throw new ResourceRepositoryConflictError();
    const nextStatus = input.status ?? current.status;
    const transitions: Record<string, readonly string[]> = {
      draft: ["draft", "test", "retired"], test: ["test", "retired"], live: ["live"],
      paused: ["paused"], retired: ["retired"],
    };
    if (!transitions[current.status]?.includes(nextStatus)) throw new ResourceRepositoryConflictError();
    if (current.status === "retired" && (input.name !== undefined || input.slug !== undefined || input.executionAccess !== undefined || input.discoveryAccess !== undefined)) throw new ResourceRepositoryConflictError();
    const parsed = parseResourceProduct({
      ...current, name: input.name ?? current.name, slug: input.slug ?? current.slug,
      status: nextStatus, executionAccess: input.executionAccess ?? current.executionAccess,
      discoveryAccess: input.discoveryAccess ?? current.discoveryAccess,
    });
    try {
      const result = this.db.prepare(`UPDATE resource_products SET name=?,slug=?,status=?,execution_access=?,discovery_access=?,updated_at=?
        WHERE id=? AND owner_id=? AND status=?`).run(parsed.name, parsed.slug, parsed.status, parsed.executionAccess, parsed.discoveryAccess, this.iso(), parsed.id, parsed.ownerId, input.expectedStatus);
      if (result.changes !== 1) throw new ResourceRepositoryConflictError();
      return parsed;
    } catch (error) {
      if (error instanceof ResourceRepositoryConflictError) throw error;
      if (String(error).includes("UNIQUE")) throw new ResourceRepositoryConflictError();
      throw error;
    }
  }

  async createSourceSnapshot(input: CreateSourceSnapshotInput): Promise<ResourceSourceSnapshot> {
    this.requireOwned(input.ownerId, input.resourceProductId);
    const parsed = this.parsedSnapshot(input);
    const insert = this.db.transaction(() => this.insertSnapshotRow(input, parsed));
    try { return snapshotFromRow(insert.immediate()); } catch (error) {
      if (String(error).includes("UNIQUE") || String(error).includes("PRIMARY KEY")) throw new ResourceRepositoryConflictError();
      throw error;
    }
  }

  async replaceCandidate(input: ReplaceCandidateInput): Promise<ResourcePackVersion> {
    const content = parseResourcePackContent(input.content);
    const hashed = resourcePackSemanticHash(content);
    const operation = this.db.transaction(() => this.replaceCandidateRow(input, content, hashed.semanticHash));
    return this.packFromRow(operation.immediate());
  }

  async rejectCandidate(input: import("./repository").RejectCandidateInput): Promise<void> {
    const operation = this.db.transaction(() => {
      const product = this.requireOwned(input.ownerId, input.resourceProductId);
      if (product.status === "retired") throw new ResourceRepositoryConflictError();
      const result = this.db.prepare(`DELETE FROM resource_pack_versions
        WHERE id=? AND resource_product_id=? AND status='candidate' AND revision=? AND semantic_hash=?`).run(
        input.candidatePackVersionId, input.resourceProductId,
        input.expectedRevision, input.expectedSemanticHash,
      );
      if (result.changes !== 1) throw new ResourceRepositoryConflictError();
    });
    operation.immediate();
  }

  async createSourceSnapshotAndReplaceCandidate(
    input: CreateSourceSnapshotAndReplaceCandidateInput,
  ): Promise<CreatedSourceSnapshotAndCandidate> {
    if (input.snapshot.ownerId !== input.candidate.ownerId ||
        input.snapshot.resourceProductId !== input.candidate.resourceProductId) {
      throw new ResourceRepositoryConflictError();
    }
    const snapshot = this.parsedSnapshot(input.snapshot);
    const content = parseResourcePackContent(input.candidate.content);
    const semanticHash = resourcePackSemanticHash(content).semanticHash;
    const operation = this.db.transaction(() => {
      this.requireOwned(input.snapshot.ownerId, input.snapshot.resourceProductId);
      const snapshotRow = this.insertSnapshotRow(input.snapshot, snapshot);
      const candidateRow = this.replaceCandidateRow(input.candidate, content, semanticHash);
      return { snapshotRow, candidateRow };
    });
    try {
      const result = operation.immediate();
      return Object.freeze({
        snapshot: snapshotFromRow(result.snapshotRow),
        candidate: this.packFromRow(result.candidateRow),
      });
    } catch (error) {
      if (error instanceof ResourceRepositoryConflictError || error instanceof ResourceRepositoryNotFoundError) throw error;
      if (String(error).includes("UNIQUE") || String(error).includes("PRIMARY KEY")) throw new ResourceRepositoryConflictError();
      throw error;
    }
  }

  async approveCandidate(input: ApproveCandidateInput): Promise<ResourcePackVersion> {
    const operation = this.db.transaction(() => {
      const product = this.requireOwned(input.ownerId, input.resourceProductId);
      if (product.status === "retired") throw new ResourceRepositoryConflictError();
      const result = this.db.prepare(`UPDATE resource_pack_versions SET status='approved',approved_by=?,approved_at=?
        WHERE id=? AND resource_product_id=? AND status='candidate' AND revision=? AND semantic_hash=?`).run(input.approvedBy, this.iso(), input.candidatePackVersionId, input.resourceProductId, input.expectedRevision, input.expectedSemanticHash);
      if (result.changes !== 1) throw new ResourceRepositoryConflictError();
      this.db.prepare("UPDATE resource_products SET status='test',updated_at=? WHERE id=? AND status='draft'").run(this.iso(), input.resourceProductId);
      return this.db.prepare("SELECT * FROM resource_pack_versions WHERE id=?").get(input.candidatePackVersionId) as Row;
    });
    return this.packFromRow(operation.immediate());
  }

  async getOwnedPack(reference: OwnedResourceQueryReference): Promise<ResourcePackBundle | null> {
    const row = this.db.prepare(`SELECT v.* FROM resource_pack_versions v JOIN resource_products p ON p.id=v.resource_product_id
      WHERE p.owner_id=? AND p.id=? AND v.id=? AND v.semantic_hash=?`).get(reference.ownerId, reference.resourceProductId, reference.packVersionId, reference.semanticHash) as Row | undefined;
    if (!row) return null;
    const pack = this.packFromRow(row);
    const snapshot = this.db.prepare(`SELECT freshness_deadline FROM resource_source_snapshots
      WHERE resource_product_id=? AND id=?`);
    const deadlines = pack.content.sourceSnapshotIds.map((snapshotId) => {
      const row = snapshot.get(reference.resourceProductId, snapshotId) as { freshness_deadline: string } | undefined;
      if (!row) integrity();
      return row.freshness_deadline;
    });
    return Object.freeze({ resourceProductId: reference.resourceProductId, packVersionId: pack.id, semanticHash: pack.semanticHash, freshness: resourceFreshness(deadlines, this.now()), content: pack.content });
  }

  async getOwnedSourceDisclosure(reference: OwnedResourceQueryReference) {
    const pack = await this.getOwnedPack(reference);
    if (!pack) return null;
    const statement = this.db.prepare(`SELECT source_kind FROM resource_source_snapshots
      WHERE resource_product_id=? AND id=?`);
    const sourceKinds = pack.content.sourceSnapshotIds.map((snapshotId) => {
      const row = statement.get(reference.resourceProductId, snapshotId) as { source_kind: unknown } | undefined;
      if (!row || typeof row.source_kind !== "string" || row.source_kind.length === 0) integrity();
      return row.source_kind;
    });
    return Object.freeze({
      sourceCount: sourceKinds.length,
      sourceKinds: Object.freeze([...new Set(sourceKinds)].sort((left, right) => left.localeCompare(right))),
    });
  }

  async getOwnedApprovedPack(ownerId: string, resourceProductId: string): Promise<ResourcePackBundle | null> {
    const row = this.db.prepare(`SELECT v.* FROM resource_pack_versions v
      JOIN resource_products p ON p.id=v.resource_product_id
      WHERE p.owner_id=? AND p.id=? AND v.status='approved'
      ORDER BY v.revision DESC,v.id DESC LIMIT 1`).get(ownerId, resourceProductId) as Row | undefined;
    if (!row) return null;
    const pack = this.packFromRow(row);
    return this.getOwnedPack({
      ownerId, resourceProductId, packVersionId: pack.id, semanticHash: pack.semanticHash,
    });
  }

  async createRelease(input: CreateResourceReleaseInput): Promise<ResourceRelease> {
    const operation = this.db.transaction(() => {
      const existingByDeployment = this.db.prepare("SELECT * FROM resource_releases WHERE deployment_id=?")
        .get(input.deploymentId) as Row | undefined;
      const existingByPublication = this.db.prepare(`SELECT * FROM resource_releases
        WHERE owner_id=? AND resource_product_id=? AND publication_key=?`)
        .get(input.ownerId, input.resourceProductId, input.publicationKey) as Row | undefined;
      if (existingByDeployment && existingByPublication && existingByDeployment.id !== existingByPublication.id) {
        throw new ResourceRepositoryConflictError();
      }
      const existing = existingByDeployment ?? existingByPublication;
      if (existing) {
        const parsed = releaseFromRow(existing);
        const comparable = { ...parsed, id: undefined, createdAt: undefined };
        const requested = { ...input, id: undefined, createdAt: undefined };
        if (!same(comparable, requested)) throw new ResourceRepositoryConflictError();
        const liveIdentity = this.db.prepare(`SELECT 1 FROM agents a
          JOIN flows f ON f.id=a.flow_id
          JOIN flow_versions v ON v.id=? AND v.flow_id=f.id AND v.semantic_hash=? AND v.full_hash=?
          JOIN deployments d ON d.id=? AND d.flow_id=f.id AND d.flow_version_id=v.id
          JOIN environments e ON e.id=d.environment_id
          JOIN resource_products p ON p.id=?
          JOIN resource_pack_versions rp ON rp.id=? AND rp.resource_product_id=p.id
          WHERE a.id=? AND a.flow_id=? AND a.status='live' AND a.settlement_live=0 AND a.price_usdc=?
            AND f.owner_id=? AND d.environment_id=? AND d.status='live' AND d.retired_at IS NULL
            AND e.kind='live' AND p.owner_id=? AND p.status='live'
            AND p.execution_access=? AND p.discovery_access=? AND rp.status='live'
            AND rp.semantic_hash=? AND EXISTS(SELECT 1 FROM dependency_pins dp
              WHERE dp.flow_version_id=v.id AND dp.kind='resource' AND dp.resource_id=p.id
                AND dp.version=rp.id AND dp.content_hash=rp.semantic_hash)`).get(
          input.flowVersionId, input.graphSemanticHash, input.graphFullHash,
          input.deploymentId, input.resourceProductId, input.packVersionId,
          input.agentId, input.flowId, input.priceUsdc, input.ownerId, input.environmentId,
          input.ownerId, input.executionAccess, input.discoveryAccess, input.semanticHash,
        );
        if (!liveIdentity) throw new ResourceRepositoryConflictError();
        return existing;
      }
      const product = this.requireOwned(input.ownerId, input.resourceProductId);
      if (product.status === "retired") throw new ResourceRepositoryConflictError();
      if (product.execution_access !== input.executionAccess ||
          product.discovery_access !== input.discoveryAccess ||
          !Number.isFinite(input.priceUsdc) || input.priceUsdc < 0 ||
          (input.executionAccess !== "paid" && input.priceUsdc !== 0) ||
          !/^[a-f0-9]{64}$/u.test(input.publicationRequestHash) ||
          !/^[a-f0-9]{64}$/u.test(input.graphSemanticHash) ||
          !/^[a-f0-9]{64}$/u.test(input.graphFullHash)) {
        throw new ResourceRepositoryConflictError();
      }
      const pack = this.db.prepare("SELECT * FROM resource_pack_versions WHERE id=? AND resource_product_id=? AND semantic_hash=? AND status='approved'").get(input.packVersionId, input.resourceProductId, input.semanticHash) as Row | undefined;
      if (!pack) throw new ResourceRepositoryConflictError();
      const verifiedPack = this.packFromRow(pack);
      const snapshot = this.db.prepare(`SELECT freshness_deadline FROM resource_source_snapshots
        WHERE resource_product_id=? AND id=?`);
      const deadlines = verifiedPack.content.sourceSnapshotIds.map((snapshotId) => {
        const row = snapshot.get(input.resourceProductId, snapshotId) as { freshness_deadline: string } | undefined;
        if (!row) integrity();
        return row.freshness_deadline;
      });
      if (resourceFreshness(deadlines, this.now()) !== "fresh") throw new ResourceRepositoryConflictError();
      const identity = this.db.prepare(`SELECT 1 FROM agents a
        JOIN flows f ON f.id=a.flow_id
        JOIN flow_versions v ON v.id=? AND v.flow_id=f.id AND v.created_by=?
          AND v.semantic_hash=? AND v.full_hash=?
        JOIN deployments d ON d.id=? AND d.flow_id=f.id AND d.flow_version_id=v.id
        JOIN environments e ON e.id=d.environment_id
        WHERE a.id=? AND a.flow_id=? AND a.status='draft' AND a.settlement_live=0
          AND a.price_usdc=?
          AND f.id=? AND f.owner_id=? AND d.environment_id=? AND d.status='live'
          AND d.retired_at IS NULL AND e.kind='live'`).get(
        input.flowVersionId, input.ownerId, input.graphSemanticHash, input.graphFullHash,
        input.deploymentId, input.agentId, input.flowId, input.priceUsdc,
        input.flowId, input.ownerId, input.environmentId,
      );
      const dependency = this.db.prepare(`SELECT 1 FROM dependency_pins
        WHERE flow_version_id=? AND kind='resource' AND resource_id=? AND version=? AND content_hash=?`)
        .get(input.flowVersionId, input.resourceProductId, input.packVersionId, input.semanticHash);
      if (!identity || !dependency) throw new ResourceRepositoryConflictError();
      const id = input.id ?? this.nextId();
      const createdAt = input.createdAt ?? this.iso();
      this.db.prepare(`INSERT INTO resource_releases
        (id,owner_id,resource_product_id,pack_version_id,semantic_hash,publication_key,
          publication_request_hash,graph_semantic_hash,graph_full_hash,price_usdc,
          execution_access,discovery_access,agent_id,flow_id,flow_version_id,deployment_id,
          environment_id,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          id, input.ownerId, input.resourceProductId, input.packVersionId, input.semanticHash,
          input.publicationKey, input.publicationRequestHash, input.graphSemanticHash,
          input.graphFullHash, input.priceUsdc, input.executionAccess, input.discoveryAccess,
          input.agentId, input.flowId, input.flowVersionId, input.deploymentId,
          input.environmentId, createdAt,
        );
      const packUpdate = this.db.prepare(`UPDATE resource_pack_versions SET status='live'
        WHERE id=? AND resource_product_id=? AND semantic_hash=? AND status='approved'`)
        .run(input.packVersionId, input.resourceProductId, input.semanticHash);
      const productUpdate = this.db.prepare(`UPDATE resource_products SET status='live',updated_at=?
        WHERE id=? AND owner_id=? AND execution_access=? AND discovery_access=?
          AND status IN ('draft','test','paused','live')`)
        .run(this.iso(), input.resourceProductId, input.ownerId, input.executionAccess, input.discoveryAccess);
      const agentUpdate = this.db.prepare(`UPDATE agents SET status='live'
        WHERE id=? AND flow_id=? AND status='draft' AND settlement_live=0 AND price_usdc=?`)
        .run(input.agentId, input.flowId, input.priceUsdc);
      if (packUpdate.changes !== 1 || productUpdate.changes !== 1 || agentUpdate.changes !== 1) {
        throw new ResourceRepositoryConflictError();
      }
      return this.db.prepare("SELECT * FROM resource_releases WHERE id=?").get(id) as Row;
    });
    const row = operation.immediate();
    try {
      return releaseFromRow(row);
    } catch (error) {
      if (error instanceof ResourcePersistenceError) throw new ResourceAmbiguousFinalCommitError();
      throw error;
    }
  }

  async transitionReleaseLifecycle(
    input: TransitionResourceReleaseLifecycleInput,
  ): Promise<TransitionResourceReleaseLifecycleResult> {
    const operation = this.db.transaction(() => {
      const allowed = input.action === "pause"
        ? input.expectedStatus === "live"
        : input.action === "resume"
          ? input.expectedStatus === "paused"
          : input.expectedStatus === "live" || input.expectedStatus === "paused";
      if (!allowed) throw new ResourceRepositoryConflictError();

      const releaseRow = this.db.prepare(`SELECT release.* FROM resource_releases release
        JOIN resource_products product
          ON product.id=release.resource_product_id AND product.owner_id=release.owner_id
        JOIN resource_pack_versions pack
          ON pack.id=release.pack_version_id AND pack.resource_product_id=release.resource_product_id
        JOIN flows flow ON flow.id=release.flow_id AND flow.owner_id=release.owner_id
        JOIN agents agent ON agent.id=release.agent_id AND agent.flow_id=release.flow_id
        JOIN deployments deployment
          ON deployment.id=release.deployment_id
          AND deployment.flow_id=release.flow_id
          AND deployment.flow_version_id=release.flow_version_id
          AND deployment.environment_id=release.environment_id
        WHERE release.id=? AND release.owner_id=? AND release.resource_product_id=?
          AND release.agent_id=? AND release.deployment_id=?
          AND release.id=(SELECT current.id FROM resource_releases current
            WHERE current.owner_id=? AND current.resource_product_id=?
            ORDER BY current.created_at DESC,current.id DESC LIMIT 1)
          AND product.status=? AND pack.status='live'
          AND agent.status=?
          AND deployment.status=?
          AND ((?='live' AND deployment.retired_at IS NULL)
            OR (?='paused' AND deployment.retired_at IS NOT NULL))`)
        .get(
          input.releaseId, input.ownerId, input.resourceProductId,
          input.agentId, input.deploymentId,
          input.ownerId, input.resourceProductId,
          input.expectedStatus,
          input.expectedStatus === "live" ? "live" : "draft",
          input.expectedStatus === "live" ? "live" : "retired",
          input.expectedStatus, input.expectedStatus,
        ) as Row | undefined;
      if (!releaseRow) throw new ResourceRepositoryConflictError();
      const release = releaseFromRow(releaseRow);

      if (input.action === "resume") {
        const competing = this.db.prepare(`SELECT 1 FROM deployments
          WHERE flow_id=? AND environment_id=? AND id<>? AND retired_at IS NULL LIMIT 1`)
          .get(release.flowId, release.environmentId, release.deploymentId);
        if (competing) throw new ResourceRepositoryConflictError();
      }

      if (input.expectedStatus === "live") {
        const deployment = this.db.prepare(`UPDATE deployments
          SET status='retired',retired_at=?
          WHERE id=? AND flow_id=? AND flow_version_id=? AND environment_id=?
            AND status='live' AND retired_at IS NULL`).run(
          this.now().getTime(), release.deploymentId, release.flowId,
          release.flowVersionId, release.environmentId,
        );
        const agent = this.db.prepare(`UPDATE agents SET status='draft'
          WHERE id=? AND flow_id=? AND status='live'`).run(release.agentId, release.flowId);
        if (deployment.changes !== 1 || agent.changes !== 1) throw new ResourceRepositoryConflictError();
      } else if (input.action === "resume") {
        const deployment = this.db.prepare(`UPDATE deployments
          SET status='live',retired_at=NULL
          WHERE id=? AND flow_id=? AND flow_version_id=? AND environment_id=?
            AND status='retired' AND retired_at IS NOT NULL`).run(
          release.deploymentId, release.flowId, release.flowVersionId, release.environmentId,
        );
        const agent = this.db.prepare(`UPDATE agents SET status='live'
          WHERE id=? AND flow_id=? AND status='draft'`).run(release.agentId, release.flowId);
        if (deployment.changes !== 1 || agent.changes !== 1) throw new ResourceRepositoryConflictError();
      }

      if (input.action === "retire") {
        const pack = this.db.prepare(`UPDATE resource_pack_versions SET status='retired'
          WHERE id=? AND resource_product_id=? AND semantic_hash=? AND status='live'`)
          .run(release.packVersionId, release.resourceProductId, release.semanticHash);
        if (pack.changes !== 1) throw new ResourceRepositoryConflictError();
      }

      const nextStatus = input.action === "pause" ? "paused" : input.action === "resume" ? "live" : "retired";
      const product = this.db.prepare(`UPDATE resource_products SET status=?,updated_at=?
        WHERE id=? AND owner_id=? AND status=?`).run(
        nextStatus, this.iso(), input.resourceProductId, input.ownerId, input.expectedStatus,
      );
      if (product.changes !== 1) throw new ResourceRepositoryConflictError();
      const productRow = this.db.prepare("SELECT * FROM resource_products WHERE id=? AND owner_id=?")
        .get(input.resourceProductId, input.ownerId) as Row | undefined;
      if (!productRow) throw new ResourceRepositoryConflictError();
      return { product: productFromRow(productRow), release };
    });
    const result = operation.immediate();
    return Object.freeze({ product: result.product, release: result.release });
  }

  async getPublishedReleaseByAgent(agentId: string): Promise<ResourceRelease | null> {
    const row = this.db.prepare(`SELECT release.* FROM resource_releases release
      JOIN resource_products product
        ON product.id=release.resource_product_id AND product.owner_id=release.owner_id AND product.status='live'
      JOIN resource_pack_versions pack
        ON pack.id=release.pack_version_id AND pack.resource_product_id=release.resource_product_id AND pack.status='live'
      JOIN agents agent
        ON agent.id=release.agent_id AND agent.flow_id=release.flow_id AND agent.status='live'
      JOIN deployments deployment
        ON deployment.id=release.deployment_id
        AND deployment.flow_id=release.flow_id
        AND deployment.flow_version_id=release.flow_version_id
        AND deployment.environment_id=release.environment_id
        AND deployment.status='live' AND deployment.retired_at IS NULL
      WHERE release.agent_id=? ORDER BY release.created_at DESC,release.id DESC LIMIT 1`)
      .get(agentId) as Row | undefined;
    return row ? releaseFromRow(row) : null;
  }

  async listPublishedReleasesByAgentIds(agentIds: readonly string[]): Promise<readonly ResourceRelease[]> {
    const ids = [...new Set(agentIds.filter((id) => id.length > 0))];
    if (ids.length === 0) return Object.freeze([]);
    const rows = this.db.prepare(
      `SELECT release.* FROM resource_releases release
       JOIN resource_products product
         ON product.id=release.resource_product_id AND product.owner_id=release.owner_id AND product.status='live'
       JOIN resource_pack_versions pack
         ON pack.id=release.pack_version_id AND pack.resource_product_id=release.resource_product_id AND pack.status='live'
       JOIN agents agent
         ON agent.id=release.agent_id AND agent.flow_id=release.flow_id AND agent.status='live'
       JOIN deployments deployment
         ON deployment.id=release.deployment_id
         AND deployment.flow_id=release.flow_id
         AND deployment.flow_version_id=release.flow_version_id
         AND deployment.environment_id=release.environment_id
         AND deployment.status='live' AND deployment.retired_at IS NULL
       WHERE release.agent_id IN (${ids.map(() => "?").join(",")})
       ORDER BY release.agent_id,release.created_at DESC,release.id DESC`,
    ).all(...ids) as Row[];
    const seen = new Set<string>();
    return Object.freeze(rows.flatMap((row) => {
      const agentId = String(row.agent_id);
      if (seen.has(agentId)) return [];
      seen.add(agentId);
      return [releaseFromRow(row)];
    }));
  }

  async getOwnedPublishedReleaseByPublicationKey(
    ownerId: string,
    resourceProductId: string,
    publicationKey: string,
  ): Promise<ResourceRelease | null> {
    const row = this.db.prepare(`SELECT release.* FROM resource_releases release
      JOIN resource_products product ON product.id=release.resource_product_id
      WHERE release.owner_id=? AND release.resource_product_id=? AND release.publication_key=?
        AND product.owner_id=? ORDER BY release.created_at DESC,release.id DESC LIMIT 1`)
      .get(ownerId, resourceProductId, publicationKey, ownerId) as Row | undefined;
    return row ? releaseFromRow(row) : null;
  }

  async recordRunReceipt(input: CreateResourceRunReceiptInput): Promise<ResourceRunReceipt> {
    const operation = this.db.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM resource_run_receipts WHERE run_id=?").get(input.runId) as Row | undefined;
      if (existing) {
        const parsed = receiptFromRow(existing);
        const exact = parsed.ownerId === input.ownerId && parsed.resourceProductId === input.resourceProductId && parsed.packVersionId === input.packVersionId && parsed.agentId === input.agentId && parsed.flowVersionId === input.flowVersionId && parsed.deploymentId === input.deploymentId && parsed.paymentId === input.paymentId && parsed.paymentState === input.paymentState && parsed.priceUsdc === input.priceUsdc &&
          parsed.resourceVersion === input.receipt.resourceVersion && parsed.semanticHash === input.receipt.semanticHash && parsed.freshness === input.receipt.freshness && same(parsed.evidence, input.receipt.evidence) && same(parsed.unknowns, input.receipt.unknowns) && same(parsed.conflicts, input.receipt.conflicts) && parsed.outputSchemaValid === input.receipt.outputSchemaValid;
        if (!exact) throw new ResourceRepositoryConflictError();
        return existing;
      }
      this.requireOwned(input.ownerId, input.resourceProductId);
      if (input.receipt.resourceProductId !== input.resourceProductId || input.receipt.resourceVersion !== input.packVersionId) throw new ResourceRepositoryConflictError();
      if (!Number.isFinite(input.priceUsdc) || input.priceUsdc < 0 ||
          !["free", "challenged", "credited", "settled", "refunded", "failed"].includes(input.paymentState) ||
          (input.paymentId !== null && (typeof input.paymentId !== "string" || input.paymentId.length === 0))) {
        throw new ResourceRepositoryConflictError();
      }
      const release = this.db.prepare(`SELECT 1 FROM resource_releases
        WHERE owner_id=? AND resource_product_id=? AND pack_version_id=? AND agent_id=?
          AND flow_version_id=? AND deployment_id=? AND price_usdc=?`).get(
        input.ownerId, input.resourceProductId, input.packVersionId, input.agentId,
        input.flowVersionId, input.deploymentId, input.priceUsdc,
      );
      if (!release) throw new ResourceRepositoryConflictError();
      const packRow = this.db.prepare("SELECT * FROM resource_pack_versions WHERE id=? AND resource_product_id=? AND semantic_hash=? AND status IN ('approved','live')").get(input.packVersionId, input.resourceProductId, input.receipt.semanticHash) as Row | undefined;
      if (!packRow) throw new ResourceRepositoryConflictError();
      const verifiedPack = this.packFromRow(packRow);
      if (!["fresh", "stale", "mixed"].includes(input.receipt.freshness) ||
          typeof input.receipt.outputSchemaValid !== "boolean" ||
          !Array.isArray(input.receipt.evidence) || !Array.isArray(input.receipt.unknowns) || !Array.isArray(input.receipt.conflicts) ||
          input.receipt.unknowns.some((value) => typeof value !== "string") || input.receipt.conflicts.some((value) => typeof value !== "string") ||
          input.receipt.evidence.some((value) => !verifiedPack.content.evidence.some((candidate) => same(candidate, value)))) {
        throw new ResourceRepositoryConflictError();
      }
      const id = input.id ?? this.nextId();
      const createdAt = input.createdAt ?? this.iso();
      this.db.prepare(`INSERT INTO resource_run_receipts
        (id,owner_id,resource_product_id,pack_version_id,agent_id,run_id,flow_version_id,deployment_id,payment_id,payment_state,price_usdc,semantic_hash,freshness,evidence_json,unknowns_json,conflicts_json,output_schema_valid,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.ownerId, input.resourceProductId, input.packVersionId, input.agentId, input.runId, input.flowVersionId, input.deploymentId, input.paymentId, input.paymentState, input.priceUsdc, input.receipt.semanticHash, input.receipt.freshness, json(input.receipt.evidence), json(input.receipt.unknowns), json(input.receipt.conflicts), input.receipt.outputSchemaValid ? 1 : 0, createdAt);
      return this.db.prepare("SELECT * FROM resource_run_receipts WHERE id=?").get(id) as Row;
    });
    return receiptFromRow(operation.immediate());
  }

  async listRunReceipts(ownerId: string, productId: string): Promise<readonly ResourceRunReceipt[]> {
    if (!this.ownedProduct(ownerId, productId)) return [];
    const rows = this.db.prepare("SELECT * FROM resource_run_receipts WHERE owner_id=? AND resource_product_id=? ORDER BY created_at DESC,id DESC").all(ownerId, productId) as Row[];
    return Object.freeze(rows.map(receiptFromRow));
  }

  async adoptOwner(fromOwnerId: string, toOwnerId: string): Promise<void> {
    if (fromOwnerId === toOwnerId) return;
    const operation = this.db.transaction(() => {
      this.db.prepare("UPDATE resource_releases SET owner_id=? WHERE owner_id=?").run(toOwnerId, fromOwnerId);
      this.db.prepare("UPDATE resource_run_receipts SET owner_id=? WHERE owner_id=?").run(toOwnerId, fromOwnerId);
      this.db.prepare("UPDATE resource_products SET owner_id=?,updated_at=? WHERE owner_id=?").run(toOwnerId, this.iso(), fromOwnerId);
    });
    operation.immediate();
  }
}
