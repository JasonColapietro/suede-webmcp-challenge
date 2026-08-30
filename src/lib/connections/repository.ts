import type {
  ConnectionCreateInput,
  ConnectionEnvironment,
  ConnectionSecretInput,
  ConnectionView,
} from "./types";

export const CONNECTION_REPOSITORY_UNAVAILABLE = "Connection service unavailable";

export class ConnectionRepositoryUnavailableError extends Error {
  readonly code = "CONNECTION_REPOSITORY_UNAVAILABLE";

  constructor() {
    super(CONNECTION_REPOSITORY_UNAVAILABLE);
    this.name = "ConnectionRepositoryUnavailableError";
  }
}

export class InvalidConnectionPageError extends Error {
  readonly code = "INVALID_CONNECTION_PAGE";

  constructor() {
    super("Invalid connection page");
    this.name = "InvalidConnectionPageError";
  }
}

/** Opaque keyset page. Repository implementations validate the cursor. */
export interface ConnectionListPage {
  readonly cursor?: string;
  readonly limit: number;
}

export interface ConnectionListResult {
  readonly items: readonly ConnectionView[];
  readonly nextCursor: string | null;
}

/** Secret-free artifact metadata returned by the bounded usage scan. */
export interface ConnectionUsageItem {
  readonly artifactKind: "draft" | "active_deployment";
  readonly flowId: string;
  readonly flowName: string;
  readonly flowVersionId: string | null;
  readonly environment: "draft" | "test" | "live";
  readonly updatedAt: number;
}

export interface ConnectionUsageResult {
  readonly items: readonly ConnectionUsageItem[];
  readonly nextCursor: string | null;
  /** Matches observed so far. This is not an exact total when truncated. */
  readonly matchedLowerBound: number;
  readonly truncated: boolean;
  /** Receipt that the caller must recheck before a reviewed mutation. */
  readonly lifecycleRevision: number;
}

export type MutationResult =
  | { readonly status: "updated"; readonly connection: ConnectionView }
  | { readonly status: "conflict" | "not-found" };

/**
 * Owner-scoped connection persistence boundary.
 *
 * Implementations must apply owner and slot-status filters before reading
 * protected bytes. No method returns plaintext inputs or encrypted-row data.
 */
export interface ConnectionRepository {
  create(ownerId: string, input: ConnectionCreateInput, now: number): Promise<ConnectionView>;
  list(ownerId: string, page: ConnectionListPage): Promise<ConnectionListResult>;
  get(ownerId: string, connectionId: string): Promise<ConnectionView | null>;
  rename(
    ownerId: string,
    connectionId: string,
    expectedLifecycleRevision: number,
    name: string,
    now: number,
  ): Promise<MutationResult>;
  configureSlot(
    ownerId: string,
    connectionId: string,
    environment: ConnectionEnvironment,
    expectedLifecycleRevision: number,
    secret: ConnectionSecretInput,
    now: number,
  ): Promise<MutationResult>;
  revokeSlot(
    ownerId: string,
    connectionId: string,
    environment: ConnectionEnvironment,
    expectedLifecycleRevision: number,
    now: number,
  ): Promise<MutationResult>;
  resolveHeaders(
    ownerId: string,
    connectionId: string,
    environment: ConnectionEnvironment,
    field: "headers",
  ): Promise<Readonly<Record<string, string>> | null>;
  usage(
    ownerId: string,
    connectionId: string,
    page: ConnectionListPage,
  ): Promise<ConnectionUsageResult | null>;
}

export interface CloseableConnectionRepository extends ConnectionRepository {
  close(): void;
  dispose(): void;
}
