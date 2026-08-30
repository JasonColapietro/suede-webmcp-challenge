import {
  parseApiOperationReference,
  type ApiOperationReference,
} from "@/lib/flow/api-operation-reference";
import type {
  TestConnectionKind,
  TestConnectionMetadata,
  TestConnectionMetadataReader,
} from "@/lib/connections/test-metadata-reader";

export const TEST_CONNECTION_UNAVAILABLE = "TEST_CONNECTION_UNAVAILABLE" as const;
export const READINESS_CANCELLED = "READINESS_CANCELLED" as const;
export const TEST_READINESS_CONFIGURED_MESSAGE = "Test slot configured. Authentication unverified." as const;
export const TEST_READINESS_UNAVAILABLE_MESSAGE = "Test slot unavailable. Authentication unverified." as const;

export type ConnectorReadinessAuthentication =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "api_key_header"; headerName: string }>
  | Readonly<{ kind: "http_bearer" }>
  | Readonly<{ kind: "http_basic" }>;

export interface ConnectorReadinessRequest {
  readonly reference: ApiOperationReference;
  readonly expectedLifecycleRevision?: number;
}

export interface ConnectorReadinessOperation {
  readonly reference: ApiOperationReference;
  readonly authentication: ConnectorReadinessAuthentication;
  readonly archived: boolean;
}

export interface ConfiguredReadinessConnection {
  readonly kind: TestConnectionKind;
  readonly publicHeaderNames: readonly string[];
  readonly testSlotStatus: "configured";
  readonly idSuffix: string;
}

export type ConnectorReadinessReceipt = Readonly<{
  readonly status: "configured";
  readonly message: typeof TEST_READINESS_CONFIGURED_MESSAGE;
  readonly authentication: "unverified";
  readonly observedLifecycleRevision: number;
  readonly connection: ConfiguredReadinessConnection;
  readonly egressCount: 0;
  readonly costUsdc: 0;
}> | Readonly<{
  readonly status: "unavailable";
  readonly message: typeof TEST_READINESS_UNAVAILABLE_MESSAGE;
  readonly authentication: "unverified";
  readonly observedLifecycleRevision: null;
  readonly connection: null;
  readonly egressCount: 0;
  readonly costUsdc: 0;
}> | Readonly<{
  readonly status: "not_required";
  readonly message: "Authentication not required.";
  readonly authentication: "not_required";
  readonly observedLifecycleRevision: null;
  readonly connection: null;
  readonly egressCount: 0;
  readonly costUsdc: 0;
}>;

export type ConnectorReadinessResult =
  | Readonly<{ ok: true; receipt: ConnectorReadinessReceipt }>
  | Readonly<{
    ok: false;
    code: typeof TEST_CONNECTION_UNAVAILABLE;
    receipt: Extract<ConnectorReadinessReceipt, { status: "unavailable" }>;
  }>
  | Readonly<{ ok: false; code: typeof READINESS_CANCELLED }>;

export const TEST_CONNECTION_UNAVAILABLE_RESULT = Object.freeze({
  ok: false as const,
  code: TEST_CONNECTION_UNAVAILABLE,
  receipt: Object.freeze({
    status: "unavailable" as const,
    message: TEST_READINESS_UNAVAILABLE_MESSAGE,
    authentication: "unverified" as const,
    observedLifecycleRevision: null,
    connection: null,
    egressCount: 0 as const,
    costUsdc: 0 as const,
  }),
});
const CANCELLED = Object.freeze({ ok: false as const, code: READINESS_CANCELLED });

function exactRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    if (Object.getOwnPropertySymbols(value).length !== 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors);
    if (required.some((key) => !keys.includes(key)) ||
        keys.some((key) => !required.includes(key) && !optional.includes(key))) return null;
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

export function parseConnectorReadinessRequest(value: unknown): ConnectorReadinessRequest | null {
  const record = exactRecord(value, ["reference"], ["expectedLifecycleRevision"]);
  if (!record) return null;
  let reference: ApiOperationReference;
  try {
    reference = parseApiOperationReference(record.reference);
  } catch {
    return null;
  }
  if (Object.hasOwn(record, "expectedLifecycleRevision") &&
      (!Number.isSafeInteger(record.expectedLifecycleRevision) || (record.expectedLifecycleRevision as number) < 1)) return null;
  return Object.freeze({
    reference,
    ...(Object.hasOwn(record, "expectedLifecycleRevision")
      ? { expectedLifecycleRevision: record.expectedLifecycleRevision as number }
      : {}),
  });
}

function sameHeaders(actual: readonly string[], expected: readonly string[]): boolean {
  const left = actual.map((name) => name.toLowerCase()).sort();
  const right = expected.map((name) => name.toLowerCase()).sort();
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

export function isConnectionMetadataCompatible(
  authentication: ConnectorReadinessAuthentication,
  connection: TestConnectionMetadata,
): boolean {
  if (authentication.kind === "none") return false;
  if (authentication.kind === "http_bearer") {
    return connection.kind === "bearer" && sameHeaders(connection.publicHeaderNames, ["authorization"]);
  }
  if (authentication.kind === "http_basic") {
    return connection.kind === "basic" && sameHeaders(connection.publicHeaderNames, ["authorization"]);
  }
  const required = [authentication.headerName];
  return (connection.kind === "api_key" || connection.kind === "custom_headers") &&
    sameHeaders(connection.publicHeaderNames, required);
}

function sameMetadata(left: TestConnectionMetadata, right: TestConnectionMetadata): boolean {
  return left.kind === right.kind && left.lifecycleRevision === right.lifecycleRevision &&
    left.testSlotStatus === right.testSlotStatus && left.idSuffix === right.idSuffix &&
    sameHeaders(left.publicHeaderNames, right.publicHeaderNames);
}

function configuredReceipt(value: TestConnectionMetadata): ConnectorReadinessResult {
  return Object.freeze({
    ok: true,
    receipt: Object.freeze({
      status: "configured",
      message: TEST_READINESS_CONFIGURED_MESSAGE,
      authentication: "unverified",
      observedLifecycleRevision: value.lifecycleRevision,
      connection: Object.freeze({
        kind: value.kind,
        publicHeaderNames: Object.freeze([...value.publicHeaderNames]),
        testSlotStatus: "configured",
        idSuffix: value.idSuffix,
      }),
      egressCount: 0,
      costUsdc: 0,
    }),
  });
}

interface CheckReadinessInput {
  readonly ownerId: string;
  readonly operation: ConnectorReadinessOperation;
  readonly reader?: TestConnectionMetadataReader;
  readonly expectedLifecycleRevision?: number;
  readonly signal?: AbortSignal;
}

export function checkTestConnectionReadiness(input: CheckReadinessInput): ConnectorReadinessResult {
  if (input.signal?.aborted) return CANCELLED;
  if (input.operation.archived) return TEST_CONNECTION_UNAVAILABLE_RESULT;
  if (input.operation.authentication.kind === "none") {
    if (input.operation.reference.readinessBinding !== undefined) return TEST_CONNECTION_UNAVAILABLE_RESULT;
    return Object.freeze({
      ok: true,
      receipt: Object.freeze({
        status: "not_required",
        message: "Authentication not required.",
        authentication: "not_required",
        observedLifecycleRevision: null,
        connection: null,
        egressCount: 0,
        costUsdc: 0,
      }),
    });
  }
  const binding = input.operation.reference.readinessBinding;
  if (!binding || binding.kind !== "connection" || !input.reader) return TEST_CONNECTION_UNAVAILABLE_RESULT;
  const first = input.reader.readTestMetadata(input.ownerId, binding.connectionId);
  if (input.signal?.aborted) return CANCELLED;
  if (!first || first.testSlotStatus !== "configured" ||
      !isConnectionMetadataCompatible(input.operation.authentication, first) ||
      (input.expectedLifecycleRevision !== undefined && first.lifecycleRevision !== input.expectedLifecycleRevision)) return TEST_CONNECTION_UNAVAILABLE_RESULT;
  const final = input.reader.readTestMetadata(input.ownerId, binding.connectionId);
  if (input.signal?.aborted) return CANCELLED;
  if (!final || final.testSlotStatus !== "configured" || !sameMetadata(first, final) ||
      !isConnectionMetadataCompatible(input.operation.authentication, final)) return TEST_CONNECTION_UNAVAILABLE_RESULT;
  return configuredReceipt(final);
}
