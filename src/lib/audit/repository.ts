import { randomUUID } from "node:crypto";
import type {
  AuditTerminalFacts,
  ControlAuditEvent,
} from "./types";

declare const auditCorrelationBrand: unique symbol;
export interface AuditCorrelation {
  readonly [auditCorrelationBrand]: true;
}

interface AuditCorrelationFacts {
  readonly id: string;
  readonly ownerId: string;
  readonly actorId: string;
}

const CORRELATIONS = new WeakMap<object, AuditCorrelationFacts>();
const CONTROL = /[\u0000-\u001f\u007f]/u;

function boundedIdentity(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value &&
    value.length > 0 && new TextEncoder().encode(value).byteLength <= 512 &&
    !CONTROL.test(value);
}

/** Create after authentication; callers cannot supply or reconstruct this authority. */
export function createAuditCorrelation(ownerId: string, actorId: string): AuditCorrelation {
  if (!boundedIdentity(ownerId) || !boundedIdentity(actorId)) {
    throw new TypeError("Invalid audit identity");
  }
  const handle = Object.freeze(Object.create(null) as object) as AuditCorrelation;
  CORRELATIONS.set(handle, Object.freeze({ id: randomUUID(), ownerId, actorId }));
  return handle;
}

export function auditCorrelationId(correlation: AuditCorrelation): string {
  const facts = CORRELATIONS.get(correlation as object);
  if (!facts) throw new TypeError("Invalid audit correlation");
  return facts.id;
}

/** Internal repository boundary; returns only server-created immutable facts. */
export function readAuditCorrelation(correlation: AuditCorrelation): AuditCorrelationFacts {
  const facts = CORRELATIONS.get(correlation as object);
  if (!facts) throw new TypeError("Invalid audit correlation");
  return facts;
}

interface ControlAuditEventInputEnvelope {
  readonly correlation: AuditCorrelation;
  readonly durationMs: number;
}

export type ControlAuditEventInput = Readonly<ControlAuditEventInputEnvelope & AuditTerminalFacts>;

export interface AuditRepository {
  /** Synchronous by design so callers can include the append in their SQLite transaction. */
  append(input: ControlAuditEventInput): ControlAuditEvent;
}
