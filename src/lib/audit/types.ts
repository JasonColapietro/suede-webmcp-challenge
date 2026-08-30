export const AUDIT_ACTIONS = [
  "connector.import",
  "connector.operation.create",
  "connector.simulation",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_RESOURCE_KINDS = [
  "connector_definition",
  "operation_version",
  "simulation",
] as const;
export type AuditResourceKind = (typeof AUDIT_RESOURCE_KINDS)[number];

export const AUDIT_ERROR_CODES = [
  "PARSE_REFUSED",
  "PROJECTION_REFUSED",
  "RATE_REFUSED",
  "TIMEOUT_REFUSED",
  "PERSISTENCE_REFUSED",
  "POLICY_REFUSED",
  "CONNECTION_REFUSED",
  "DRIFT_REFUSED",
  "SIMULATION_REFUSED",
  "AUDIT_UNAVAILABLE",
] as const;
export type AuditErrorCode = (typeof AUDIT_ERROR_CODES)[number];

export const AUDIT_CONNECTION_KINDS = [
  "api_key",
  "bearer",
  "basic",
  "custom_headers",
] as const;
export type AuditConnectionKind = (typeof AUDIT_CONNECTION_KINDS)[number];
export type AuditTestSlotStatus = "configured" | "missing" | "revoked";
export type AuditOutcome = "completed" | "refused";

interface AuditResourceFields {
  readonly id: string;
  readonly versionId: string | null;
  readonly projectionHash: string | null;
  readonly schemaHash: string | null;
}

export interface ConnectorDefinitionAuditResource extends AuditResourceFields {
  readonly kind: "connector_definition";
}

export interface OperationVersionAuditResource extends AuditResourceFields {
  readonly kind: "operation_version";
}

export interface SimulationAuditResource extends AuditResourceFields {
  readonly kind: "simulation";
}

export type AuditResource =
  | ConnectorDefinitionAuditResource
  | OperationVersionAuditResource
  | SimulationAuditResource;

export type CompletedConnectorDefinitionAuditResource = ConnectorDefinitionAuditResource & {
  readonly versionId: string;
  readonly projectionHash: string;
  readonly schemaHash: null;
};

export type CompletedOperationVersionAuditResource = OperationVersionAuditResource & {
  readonly versionId: string;
  readonly projectionHash: string;
  readonly schemaHash: string;
};

export type CompletedSimulationAuditResource = SimulationAuditResource & {
  readonly versionId: string;
  readonly projectionHash: string;
  readonly schemaHash: string;
};

export interface AuditConnectionMetadata {
  readonly kind: AuditConnectionKind;
  readonly idSuffix: string;
  readonly testSlotStatus: AuditTestSlotStatus;
}

export type AuditTerminalFacts =
  | {
    readonly action: "connector.import";
    readonly resource: CompletedConnectorDefinitionAuditResource;
    readonly outcome: "completed";
    readonly errorCode: null;
    readonly connection: null;
  }
  | {
    readonly action: "connector.import";
    readonly resource: ConnectorDefinitionAuditResource;
    readonly outcome: "refused";
    readonly errorCode: AuditErrorCode;
    readonly connection: null;
  }
  | {
    readonly action: "connector.operation.create";
    readonly resource: CompletedOperationVersionAuditResource;
    readonly outcome: "completed";
    readonly errorCode: null;
    readonly connection: null;
  }
  | {
    readonly action: "connector.operation.create";
    readonly resource: OperationVersionAuditResource;
    readonly outcome: "refused";
    readonly errorCode: AuditErrorCode;
    readonly connection: null;
  }
  | {
    readonly action: "connector.simulation";
    readonly resource: CompletedSimulationAuditResource;
    readonly outcome: "completed";
    readonly errorCode: null;
    readonly connection: AuditConnectionMetadata | null;
  }
  | {
    readonly action: "connector.simulation";
    readonly resource: SimulationAuditResource;
    readonly outcome: "refused";
    readonly errorCode: AuditErrorCode;
    readonly connection: AuditConnectionMetadata | null;
  };

interface ControlAuditEventEnvelope {
  readonly id: string;
  readonly schemaVersion: 1;
  readonly ownerId: string;
  readonly actorId: string;
  readonly correlationId: string;
  readonly effect: "write";
  readonly durationMs: number;
  readonly egressCount: 0;
  readonly costUsdc: 0;
  readonly at: number;
}

export type ControlAuditEvent = Readonly<ControlAuditEventEnvelope & AuditTerminalFacts>;
