export const CONNECTOR_IMPORT_V1_LIMITS = Object.freeze({
  profile: "connector-import-v1" as const,
  maxInputBytes: 2 * 1024 * 1024,
  maxJsonDepth: 64,
  maxContainerEntries: 50_000,
  maxOperations: 250,
  maxParametersPerOperation: 64,
  maxSchemaDepth: 32,
  maxLocalReferenceExpansions: 1_000,
  maxInspectedValues: 100_000,
  compilerDeadlineMs: 5_000,
  maxImportsPerOwnerPerMinute: 10,
  maxCanonicalProjectionBytes: 256 * 1024,
  maxTerminalReceiptBytes: 64 * 1024,
});

export type ConnectorImportV1Limits = typeof CONNECTOR_IMPORT_V1_LIMITS;
