import type { ConnectorOperationClosure, ConnectorRepository } from "./repository";
import type { SupportedFlowGraph } from "../flow/types";
import { parseConnectorDefinitionVersionV1, parseOperationVersionV1 } from "./schema";
import type {
  OperationAuthenticationV1,
  SystemPolicyV1,
  UnverifiedAuthorAnnotationV1,
} from "./types";
import {
  API_OPERATION_V1_UNSUPPORTED,
  API_OPERATION_V1_UNSUPPORTED_RESULT,
  ApiOperationV1UnsupportedError,
  graphContainsApiOperation,
} from "../flow/api-operation-contract";
import {
  ApiOperationReferenceSchema,
  ApiOperationNodeParamsSchema,
  parseApiOperationReference,
  parseApiOperationNodeParams,
  sameApiOperationNodeParams,
  type ApiOperationReference,
  type ApiOperationNodeParams,
} from "../flow/api-operation-reference";

export {
  API_OPERATION_V1_UNSUPPORTED,
  API_OPERATION_V1_UNSUPPORTED_RESULT,
  ApiOperationV1UnsupportedError,
  graphContainsApiOperation,
  ApiOperationReferenceSchema,
  ApiOperationNodeParamsSchema,
  parseApiOperationReference,
  parseApiOperationNodeParams,
  sameApiOperationNodeParams,
};
export type { ApiOperationReference, ApiOperationNodeParams };

export const API_OPERATION_LIVE_UNAVAILABLE = "API_OPERATION_LIVE_UNAVAILABLE" as const;
export const API_OPERATION_ASSET_UNAVAILABLE = "API_OPERATION_ASSET_UNAVAILABLE" as const;

export class ApiOperationLiveUnavailableError extends Error {
  readonly code = API_OPERATION_LIVE_UNAVAILABLE;
  constructor() {
    super(API_OPERATION_LIVE_UNAVAILABLE);
    this.name = "ApiOperationLiveUnavailableError";
  }
}

export class ApiOperationAssetUnavailableError extends Error {
  readonly code = API_OPERATION_ASSET_UNAVAILABLE;
  constructor() {
    super(API_OPERATION_ASSET_UNAVAILABLE);
    this.name = "ApiOperationAssetUnavailableError";
  }
}

export interface OperationClosureSnapshot {
  readonly reference: ApiOperationReference;
  readonly closure: ConnectorOperationClosure;
  readonly identity: ConnectorOperationClosure["identity"];
  readonly definition: ConnectorOperationClosure["definition"];
  readonly operation: ConnectorOperationClosure["operation"];
  readonly operationId: string;
  readonly authentication: OperationAuthenticationV1;
  readonly readinessCapability: "none" | "http.headers";
  readonly requestSchema: ConnectorOperationClosure["operation"]["projection"]["requestSchema"];
  readonly resultSchema: ConnectorOperationClosure["operation"]["projection"]["resultSchema"];
  readonly systemPolicy: SystemPolicyV1;
  readonly authorAnnotation: UnverifiedAuthorAnnotationV1 | null;
  readonly executionAvailability: "simulation_only";
}

export type ApiOperationClosureSnapshot = OperationClosureSnapshot;

/** Secret-free, owner-free projection safe to batch-hydrate into browser authoring code. */
export interface ApiOperationBrowserClosureProjection {
  readonly reference: ApiOperationReference;
  readonly connectorId: string;
  readonly connectorDisplayLabel: string;
  readonly lifecycleRevision: number;
  readonly archivedAt: number | null;
  readonly definitionVersionNumber: number;
  readonly method: OperationClosureSnapshot["operation"]["projection"]["method"];
  readonly path: string;
  readonly authentication: OperationAuthenticationV1;
  readonly requestSchema: OperationClosureSnapshot["requestSchema"];
  readonly resultSchema: OperationClosureSnapshot["resultSchema"];
  readonly systemPolicy: SystemPolicyV1;
  readonly authorAnnotation: UnverifiedAuthorAnnotationV1 | null;
  readonly executionAvailability: "simulation_only";
}

function freezeDeep<Value>(value: Value, seen = new WeakSet<object>()): Value {
  if (value === null || typeof value !== "object" || seen.has(value as object)) return value;
  seen.add(value as object);
  for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child, seen);
  return Object.freeze(value);
}

function validIdentityView(identity: ConnectorOperationClosure["identity"]): boolean {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  const labelBytes = typeof identity.displayLabel === "string"
    ? new TextEncoder().encode(identity.displayLabel).byteLength
    : 0;
  const validTimestamp = (value: unknown): value is number =>
    Number.isSafeInteger(value) && (value as number) >= 0;
  return typeof identity.id === "string" && uuid.test(identity.id) &&
    typeof identity.displayLabel === "string" &&
    identity.displayLabel.length > 0 &&
    identity.displayLabel.trim() === identity.displayLabel &&
    labelBytes <= 120 &&
    Number.isSafeInteger(identity.lifecycleRevision) &&
    identity.lifecycleRevision >= 1 &&
    validTimestamp(identity.createdAt) &&
    validTimestamp(identity.updatedAt) &&
    identity.createdAt <= identity.updatedAt &&
    (identity.archivedAt === null || (
      validTimestamp(identity.archivedAt) &&
      identity.archivedAt >= identity.createdAt &&
      identity.archivedAt <= identity.updatedAt
    ));
}

export function validateApiOperationReference(
  referenceValue: unknown,
  closureValue: ConnectorOperationClosure,
): OperationClosureSnapshot {
  try {
    const reference = parseApiOperationReference(referenceValue);
    const definition = parseConnectorDefinitionVersionV1(closureValue.definition);
    const operation = parseOperationVersionV1(closureValue.operation);
    const parent = definition.projection.operations.find((entry) => entry.operationId === operation.operationId);
    if (definition.id !== reference.connectorDefinitionVersionId ||
        operation.id !== reference.operationVersionId ||
        operation.connectorDefinitionVersionId !== reference.connectorDefinitionVersionId ||
        operation.operationId !== reference.operationId ||
        definition.connectorProjectionHash !== reference.connectorProjectionHash ||
        operation.operationProjectionHash !== reference.operationProjectionHash ||
        operation.schemaHash !== reference.schemaHash ||
        closureValue.identity.id !== definition.connectorId ||
        !validIdentityView(closureValue.identity) ||
        !parent || parent.operationProjectionHash !== operation.operationProjectionHash ||
        parent.operationId !== operation.operationId ||
        JSON.stringify(parent.operationProjection) !== JSON.stringify(operation.projection) ||
        (operation.projection.authentication.kind === "none" && reference.readinessBinding !== undefined) ||
        definition.executionAvailability !== "simulation_only" ||
        operation.executionAvailability !== "simulation_only") {
      throw new Error();
    }
    const closure = freezeDeep(closureValue);
    return Object.freeze({
      reference,
      closure,
      identity: closure.identity,
      definition: closure.definition,
      operation: closure.operation,
      operationId: closure.operation.operationId,
      authentication: closure.operation.projection.authentication,
      readinessCapability: closure.operation.projection.authentication.kind === "none" ? "none" : "http.headers",
      requestSchema: closure.operation.projection.requestSchema,
      resultSchema: closure.operation.projection.resultSchema,
      systemPolicy: closure.operation.projection.systemPolicy,
      authorAnnotation: closure.operation.authorAnnotation ?? null,
      executionAvailability: "simulation_only",
    });
  } catch {
    throw new ApiOperationAssetUnavailableError();
  }
}

export function projectApiOperationClosureForBrowser(
  snapshot: OperationClosureSnapshot,
): ApiOperationBrowserClosureProjection {
  return freezeDeep({
    reference: snapshot.reference,
    connectorId: snapshot.definition.connectorId,
    connectorDisplayLabel: snapshot.identity.displayLabel,
    lifecycleRevision: snapshot.identity.lifecycleRevision,
    archivedAt: snapshot.identity.archivedAt,
    definitionVersionNumber: snapshot.definition.versionNumber,
    method: snapshot.operation.projection.method,
    path: snapshot.operation.projection.path,
    authentication: snapshot.authentication,
    requestSchema: snapshot.requestSchema,
    resultSchema: snapshot.resultSchema,
    systemPolicy: snapshot.systemPolicy,
    authorAnnotation: snapshot.authorAnnotation,
    executionAvailability: snapshot.executionAvailability,
  });
}

export function resolveApiOperationClosure(
  repository: Pick<ConnectorRepository, "getOperationClosure">,
  ownerId: string,
  value: unknown,
): OperationClosureSnapshot {
  const reference = parseApiOperationReference(value);
  let closure: ConnectorOperationClosure | null;
  try {
    closure = repository.getOperationClosure(ownerId, reference.operationVersionId);
  } catch {
    throw new ApiOperationAssetUnavailableError();
  }
  if (!closure) throw new ApiOperationAssetUnavailableError();
  return validateApiOperationReference(reference, closure);
}

export function refuseApiOperationLive(graph: SupportedFlowGraph): void {
  if (graphContainsApiOperation(graph)) throw new ApiOperationLiveUnavailableError();
}
