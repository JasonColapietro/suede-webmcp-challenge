/** Safe readers for the structured connection material supplied to action nodes. */
import { readProvenanceSecret, type NodeExecutionProvenance } from "../executor";

function connectionRecord(
  provenance: NodeExecutionProvenance | undefined,
): Readonly<Record<string, string>> | null {
  const value = readProvenanceSecret(provenance, "connection");
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return null;
  if (entries.some(([, item]) => typeof item !== "string" || item.length === 0)) return null;
  return value as Readonly<Record<string, string>>;
}

export function connectionHeader(
  provenance: NodeExecutionProvenance | undefined,
  headerName: string,
): string | null {
  const connection = connectionRecord(provenance);
  if (!connection) return null;
  const entry = Object.entries(connection).find(
    ([name]) => name.toLowerCase() === headerName.toLowerCase(),
  );
  return entry?.[1] ?? null;
}

export function connectionBearerToken(
  provenance: NodeExecutionProvenance | undefined,
): string | null {
  const authorization = connectionHeader(provenance, "authorization");
  if (!authorization) return null;
  const match = /^Bearer ([^\s].*)$/u.exec(authorization);
  return match?.[1] ?? null;
}
