import type { JsonPrimitive, JsonValue } from "@/lib/flow/types";

export type ConnectorSchemaScalarType = "string" | "number" | "integer" | "boolean";
export type ConnectorSchemaContainerType = "object" | "array";
export type ConnectorSchemaNonNullType = ConnectorSchemaScalarType | ConnectorSchemaContainerType;
export type ConnectorSchemaType = ConnectorSchemaNonNullType | "null" |
  readonly [ConnectorSchemaNonNullType, "null"];

export type ConnectorStringFormat =
  | "date-time" | "date" | "time" | "email" | "hostname"
  | "ipv4" | "ipv6" | "uri" | "uuid";

export interface ConnectorSchemaV1 {
  readonly type: ConnectorSchemaType;
  readonly properties?: Readonly<Record<string, ConnectorSchemaV1>>;
  readonly required?: readonly string[];
  readonly items?: ConnectorSchemaV1;
  readonly additionalProperties?: false;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly format?: ConnectorStringFormat;
}

export type OperationAuthenticationV1 =
  | { readonly kind: "none" }
  | { readonly kind: "api_key_header"; readonly headerName: string }
  | { readonly kind: "http_bearer" }
  | { readonly kind: "http_basic" };

export interface SystemPolicyV1 {
  readonly effects: readonly ["write"];
  readonly retry: "unsafe";
  readonly cost: "unknown";
  readonly idempotency: "none";
}

export interface UnverifiedAuthorAnnotationV1 {
  readonly label: "Unverified";
  readonly effectNote?: string;
  readonly retryNote?: string;
}

export interface OperationProjectionV1 {
  readonly projectionVersion: 1;
  readonly operationId: string;
  readonly method: "GET" | "PUT" | "POST" | "DELETE" | "OPTIONS" | "HEAD" | "PATCH" | "TRACE";
  readonly path: string;
  readonly authentication: OperationAuthenticationV1;
  readonly requestSchema: ConnectorSchemaV1;
  readonly resultSchema: ConnectorSchemaV1;
  readonly redaction: {
    readonly requestValues: "omit";
    readonly responseValues: "omit";
    readonly credentialValues: "redact";
  };
  readonly testBehavior: {
    readonly mode: "schema_sentinel";
    readonly egress: "forbidden";
    readonly credentials: "forbidden";
  };
  readonly limitsProfile: "connector-import-v1";
  readonly executionAvailability: "simulation_only";
  readonly systemPolicy: SystemPolicyV1;
}

export interface ConnectorOperationIndexEntryV1 {
  readonly operationId: string;
  readonly method: OperationProjectionV1["method"];
  readonly path: string;
  readonly authentication: OperationAuthenticationV1;
  readonly operationProjection: OperationProjectionV1;
  readonly operationProjectionHash: string;
}

export interface ConnectorDefinitionProjectionV1 {
  readonly projectionVersion: 1;
  readonly origin: string;
  readonly operations: readonly ConnectorOperationIndexEntryV1[];
}

export interface ConnectorDefinitionVersionV1 {
  readonly contractVersion: 1;
  readonly id: string;
  readonly connectorId: string;
  readonly versionNumber: number;
  readonly projection: ConnectorDefinitionProjectionV1;
  readonly connectorProjectionHash: string;
  readonly executionAvailability: "simulation_only";
}

export interface OperationVersionV1 {
  readonly contractVersion: 1;
  readonly id: string;
  readonly connectorDefinitionVersionId: string;
  readonly operationId: string;
  readonly projection: OperationProjectionV1;
  readonly operationProjectionHash: string;
  readonly schemaHash: string;
  readonly executionAvailability: "simulation_only";
  readonly authorAnnotation?: UnverifiedAuthorAnnotationV1;
}

export interface OperationRequestV1 {
  readonly path: Readonly<Record<string, JsonPrimitive>>;
  readonly query: Readonly<Record<string, JsonPrimitive>>;
  readonly headers: Readonly<Record<string, JsonPrimitive>>;
  readonly body?: JsonValue;
}

export interface OperationResultV1 {
  readonly status: number;
  readonly body: JsonValue;
}
