export interface ConnectorLabFlagProjection {
  readonly enabled: boolean;
  readonly badge: "Prototype: simulation only";
}

export function parseConnectorLabFlag(value: unknown): boolean {
  return value === "1";
}

export function connectorLabFlagProjection(value: unknown): ConnectorLabFlagProjection {
  return Object.freeze({
    enabled: parseConnectorLabFlag(value),
    badge: "Prototype: simulation only" as const,
  });
}

export const CONNECTOR_LAB_ENABLED = parseConnectorLabFlag(
  process.env.NEXT_PUBLIC_CONNECTOR_LAB_ENABLED,
);

export const CONNECTOR_LAB_FLAG = connectorLabFlagProjection(
  process.env.NEXT_PUBLIC_CONNECTOR_LAB_ENABLED,
);
