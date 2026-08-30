import type { ControlAuditEvent } from "@/lib/audit/types";
import type { ControlAuditEventInput } from "@/lib/audit/repository";
import type {
  ConnectorDefinitionProjectionV1,
  ConnectorDefinitionVersionV1,
  OperationProjectionV1,
  OperationVersionV1,
  UnverifiedAuthorAnnotationV1,
} from "./types";

export const CONNECTOR_NOT_FOUND = "CONNECTOR_NOT_FOUND";
export const CONNECTOR_ANNOTATION_CONFLICT = "CONNECTOR_ANNOTATION_CONFLICT";
export const CONNECTOR_RATE_REFUSED = "CONNECTOR_RATE_REFUSED";

export interface ConnectorIdentityView {
  readonly id: string;
  readonly displayLabel: string;
  readonly archivedAt: number | null;
  readonly lifecycleRevision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ConnectorListCursor {
  readonly updatedAt: number;
  readonly id: string;
}

export interface ConnectorListOptions {
  readonly limit: number;
  readonly search?: string;
  readonly includeArchived?: boolean;
  readonly after?: ConnectorListCursor;
}

export interface ConnectorIdentityPage {
  readonly items: readonly ConnectorIdentityView[];
  readonly nextCursor: ConnectorListCursor | null;
}

export interface ConnectorDefinitionHistoryOptions {
  readonly limit: number;
  readonly beforeVersionNumber?: number;
}

export interface ConnectorDefinitionHistoryPage {
  readonly items: readonly ConnectorDefinitionVersionV1[];
  readonly nextBeforeVersionNumber: number | null;
}

export interface OperationVersionListCursor {
  readonly createdAt: number;
  readonly id: string;
}

export interface OperationVersionListOptions {
  readonly limit: number;
  readonly after?: OperationVersionListCursor;
}

export interface OperationVersionSummary {
  readonly operationVersionId: string;
  readonly connectorDefinitionVersionId: string;
  readonly definitionVersionNumber: number;
  readonly operationId: string;
  readonly connectorProjectionHash: string;
  readonly operationProjectionHash: string;
  readonly schemaHash: string;
  readonly executionAvailability: "simulation_only";
  readonly authorAnnotation?: UnverifiedAuthorAnnotationV1;
}

export interface OperationVersionPage {
  readonly items: readonly OperationVersionSummary[];
  readonly nextCursor: OperationVersionListCursor | null;
}

export interface CompiledOperationAssetInput {
  readonly operationId: string;
  readonly projection: OperationProjectionV1;
  readonly operationProjectionHash: string;
  readonly schemaHash: string;
}

export interface PersistCompiledImportInput {
  readonly ownerId: string;
  readonly connectorId: string | null;
  readonly newConnectorId: string;
  readonly definitionVersionId: string;
  readonly operationVersionId: string;
  readonly displayLabel: string;
  readonly connectorProjection: ConnectorDefinitionProjectionV1;
  readonly connectorProjectionHash: string;
  readonly operation: CompiledOperationAssetInput;
  readonly authorAnnotation?: UnverifiedAuthorAnnotationV1;
  readonly now: number;
}

export type PersistCompiledDefinitionInput = Omit<
  PersistCompiledImportInput,
  "operation" | "operationVersionId" | "authorAnnotation"
>;

export type DefinitionDisposition =
  | "created"
  | "version-created"
  | "reused-current"
  | "reused-historical";

export interface ConnectorDriftVersionReceipt {
  readonly versionId: string;
  readonly versionNumber: number;
  readonly connectorProjectionHash: string;
}

export interface ConnectorDriftReceipt {
  readonly before: ConnectorDriftVersionReceipt;
  readonly after: ConnectorDriftVersionReceipt;
}

export type PersistCompiledImportResult =
  | Readonly<{ status: "not-found" | "annotation-conflict" }>
  | Readonly<{
      status: "ok";
      identity: ConnectorIdentityView;
      definition: ConnectorDefinitionVersionV1;
      operation: OperationVersionV1;
      identityDisposition: "created" | "reused";
      definitionDisposition: DefinitionDisposition;
      operationDisposition: "created" | "reused";
      drift: ConnectorDriftReceipt | null;
    }>;

export type PersistCompiledDefinitionResult =
  | Readonly<{ status: "not-found" }>
  | Readonly<{
      status: "ok";
      identity: ConnectorIdentityView;
      definition: ConnectorDefinitionVersionV1;
      identityDisposition: "created" | "reused";
      definitionDisposition: DefinitionDisposition;
      drift: ConnectorDriftReceipt | null;
    }>;

export interface ConnectorOperationClosure {
  readonly identity: ConnectorIdentityView;
  readonly definition: ConnectorDefinitionVersionV1;
  readonly operation: OperationVersionV1;
}

export interface MaterializeStoredOperationInput {
  readonly ownerId: string;
  readonly connectorDefinitionVersionId: string;
  readonly operationId: string;
  readonly operationVersionId: string;
  readonly authorAnnotation?: UnverifiedAuthorAnnotationV1;
  readonly now: number;
}

export type MaterializeStoredOperationResult =
  | Readonly<{ status: "not-found" | "annotation-conflict" }>
  | Readonly<{ status: "ok"; operation: OperationVersionV1; disposition: "created" | "reused" }>;

export interface ImportRateReservationInput {
  readonly id: string;
  readonly ownerId: string;
  readonly correlationId: string;
  readonly now: number;
}

export interface ConnectorRepositoryTransaction {
  /** Same-handle owner-scoped immutable closure re-read for commit-boundary authority checks. */
  getOperationClosure(ownerId: string, operationVersionId: string): ConnectorOperationClosure | null;
  /** One indexed active-only exact projection lookup; never paginates or returns archived assets. */
  findActiveDefinitionForOperation(
    ownerId: string,
    connectorProjectionHash: string,
    operationId: string,
    authorAnnotation: UnverifiedAuthorAnnotationV1 | undefined,
  ): ConnectorDefinitionVersionV1 | null;
  reserveImport(input: ImportRateReservationInput): boolean;
  persistCompiledDefinition(input: PersistCompiledDefinitionInput): PersistCompiledDefinitionResult;
  persistCompiledImport(input: PersistCompiledImportInput): PersistCompiledImportResult;
  materializeStoredOperation(input: MaterializeStoredOperationInput): MaterializeStoredOperationResult;
  appendAudit(input: ControlAuditEventInput): ControlAuditEvent;
}

export type ConnectorIdentityMutationResult =
  | Readonly<{ status: "updated"; identity: ConnectorIdentityView }>
  | Readonly<{ status: "conflict" | "not-found" }>;

/** Provider-neutral owner-scoped persistence boundary. */
export interface ConnectorRepository {
  immediate<T>(work: (transaction: ConnectorRepositoryTransaction) => T): T;
  getConnectorIdentity(ownerId: string, connectorId: string): ConnectorIdentityView | null;
  listConnectorIdentities(ownerId: string, options: ConnectorListOptions): ConnectorIdentityPage;
  getDefinitionVersion(ownerId: string, definitionVersionId: string): ConnectorDefinitionVersionV1 | null;
  getOperationVersion(ownerId: string, operationVersionId: string): OperationVersionV1 | null;
  getOperationClosure(ownerId: string, operationVersionId: string): ConnectorOperationClosure | null;
  listOperationVersions(
    ownerId: string,
    connectorId: string,
    options: OperationVersionListOptions,
  ): OperationVersionPage;
  listDefinitionHistoryPage(
    ownerId: string,
    connectorId: string,
    options: ConnectorDefinitionHistoryOptions,
  ): ConnectorDefinitionHistoryPage;
  listDefinitionHistory(ownerId: string, connectorId: string): readonly ConnectorDefinitionVersionV1[];
  rename(ownerId: string, connectorId: string, expectedRevision: number, label: string, now: number): ConnectorIdentityMutationResult;
  archive(ownerId: string, connectorId: string, expectedRevision: number, now: number): ConnectorIdentityMutationResult;
}

export interface CloseableConnectorRepository extends ConnectorRepository {
  close(): void;
  dispose(): void;
}
