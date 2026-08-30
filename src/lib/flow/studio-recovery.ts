import { z } from "zod";
import { parseSupportedFlowGraph } from "./graph-schema";
import { flowSaveFingerprint } from "./save-queue";
import { sha256Utf8 } from "./subflow-reference";
import type { SupportedFlowGraph } from "./types";

export const STUDIO_RECOVERY_MAX_BYTES = 1024 * 1024;
export const STUDIO_RECOVERY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 60_000;
const HASH = /^[a-f0-9]{64}$/;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;

export interface StudioRecoveryFlags {
  readonly impact: boolean;
  readonly reference: boolean;
  readonly paste: boolean;
  readonly inflight: boolean;
  readonly scheduled: boolean;
  readonly retryable: boolean;
}

export interface StudioRecoveryEnvelope {
  readonly v: 1;
  readonly ownerScopeHash: string;
  readonly routeScope: string;
  readonly sessionNonce: string;
  readonly graph: SupportedFlowGraph;
  readonly graphFingerprint: string;
  readonly baseSavedFingerprint: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly expiresAt: number;
  readonly flags: StudioRecoveryFlags;
}

export interface StudioStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const flagsSchema = z.object({
  impact: z.boolean(), reference: z.boolean(), paste: z.boolean(), inflight: z.boolean(),
  scheduled: z.boolean(), retryable: z.boolean(),
}).strict();
const envelopeSchema = z.object({
  v: z.literal(1),
  ownerScopeHash: z.string().regex(HASH),
  routeScope: z.string().regex(HASH),
  sessionNonce: z.string().regex(NONCE),
  graph: z.unknown(),
  graphFingerprint: z.string().regex(HASH),
  baseSavedFingerprint: z.string().regex(HASH).nullable(),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(), flags: flagsSchema,
}).strict();

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function credentialKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return normalized === "apikey" || normalized.endsWith("apikey") ||
    normalized === "auth" || normalized === "authorization" || normalized.includes("credential") ||
    normalized === "cookie" || normalized === "setcookie" ||
    normalized === "password" || normalized.endsWith("password") ||
    normalized === "passwd" || normalized.endsWith("passwd") || normalized.includes("passphrase") ||
    normalized === "token" || normalized.endsWith("token") ||
    normalized === "secret" || normalized.endsWith("secret") ||
    normalized === "accesskey" || normalized.endsWith("accesskey") ||
    normalized === "clientkey" || normalized.endsWith("clientkey") || normalized.includes("clientsecret") ||
    normalized.includes("privatekey") || normalized.includes("servicerole") ||
    normalized.includes("signingkey");
}

function credentialString(value: string): boolean {
  return /-----BEGIN [A-Z0-9 ]+-----/i.test(value) || /\bbearer\s+[^\s]+/i.test(value) ||
    /\b(?:basic|digest)\s+[^\s]+/i.test(value) ||
    /(?:service.?role|signing.?(?:secret|key))\s*[:=]\s*[^\s]{4,}/i.test(value) ||
    /\b(?:sk-|sk_|rk_)[A-Za-z0-9_-]{8,}/.test(value) ||
    /\bAKIA[0-9A-Z]{16}\b/.test(value) ||
    /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}\b/.test(value) ||
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(value);
}

function plain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function opaqueSecret(value: unknown): boolean {
  if (!plain(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === 3 && keys.join("\0") === ["connectionId", "field", "kind"].join("\0") &&
    value.kind === "secret" && typeof value.connectionId === "string" && value.connectionId.length > 0 &&
    typeof value.field === "string" && value.field.length > 0 &&
    !credentialString(value.connectionId) && !credentialString(value.field);
}

function recoverySafe(value: unknown, seen = new Set<object>(), depth = 0): boolean {
  if (depth > 64) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return !credentialString(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  if (opaqueSecret(value)) return true;
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.every((item) => recoverySafe(item, seen, depth + 1));
    if (!plain(value) || Object.getOwnPropertySymbols(value).length > 0) return false;
    for (const key of Object.keys(value)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) return false;
      if (credentialKey(key) && !opaqueSecret(value[key])) return false;
      if (!recoverySafe(value[key], seen, depth + 1)) return false;
    }
    return true;
  } finally {
    seen.delete(value);
  }
}

export function emptyStudioRecoveryFlags(): StudioRecoveryFlags {
  return { impact: false, reference: false, paste: false, inflight: false, scheduled: false, retryable: false };
}

export function studioRecoveryOwnerScope(ownerId: string): string {
  return sha256Utf8(`suede-studio-recovery-owner\0${ownerId}`);
}

export function studioRecoveryPersistedRouteScope(rowId: string): string {
  return sha256Utf8(`suede-studio-recovery-row\0${rowId}`);
}

export function studioRecoveryNewRouteScope(opaqueSession: string): string {
  return sha256Utf8(`suede-studio-recovery-new\0${opaqueSession}`);
}

export function studioRecoveryStorageKey(
  ownerScopeHash: string,
  routeScope: string,
  sessionNonce: string,
): string {
  if (!HASH.test(ownerScopeHash) || !HASH.test(routeScope) || !NONCE.test(sessionNonce)) {
    throw new Error("Invalid recovery scope");
  }
  // v2: fingerprints are canonical (see flowSaveFingerprint). An envelope written
  // under v1 carries key-order-dependent hashes that cannot be compared against
  // canonical ones, so it must never be read back rather than be misjudged as a
  // conflict. Old keys live in sessionStorage and die with the tab.
  return `suede.studio-recovery.v2.${ownerScopeHash}.${routeScope}.${sha256Utf8(sessionNonce)}`;
}

export const flowRecoveryFingerprint = flowSaveFingerprint;

export function recoveryDisposition(
  envelope: Pick<StudioRecoveryEnvelope, "graphFingerprint" | "baseSavedFingerprint">,
  authoritativeFingerprint: string | null,
): "clear" | "restore" | "conflict" {
  if (authoritativeFingerprint !== null && envelope.graphFingerprint === authoritativeFingerprint) return "clear";
  return envelope.baseSavedFingerprint === authoritativeFingerprint ? "restore" : "conflict";
}

export function encodeStudioRecovery(input: {
  readonly ownerScopeHash: string; readonly routeScope: string; readonly sessionNonce: string;
  readonly graph: SupportedFlowGraph; readonly baseSavedFingerprint: string | null;
  readonly now: number; readonly flags: StudioRecoveryFlags;
}): { readonly status: "ready"; readonly text: string } |
  { readonly status: "invalid" | "unsafe" | "too-large" } {
  let graph: SupportedFlowGraph;
  try {
    graph = structuredClone(parseSupportedFlowGraph(input.graph));
  } catch {
    return { status: "unsafe" };
  }
  if (!recoverySafe(graph)) return { status: "unsafe" };
  const candidate: StudioRecoveryEnvelope = {
    v: 1, ownerScopeHash: input.ownerScopeHash, routeScope: input.routeScope,
    sessionNonce: input.sessionNonce, graph, graphFingerprint: flowRecoveryFingerprint(graph),
    baseSavedFingerprint: input.baseSavedFingerprint, createdAt: input.now, updatedAt: input.now,
    expiresAt: input.now + STUDIO_RECOVERY_TTL_MS, flags: { ...input.flags },
  };
  if (!envelopeSchema.safeParse(candidate).success) return { status: "invalid" };
  const text = JSON.stringify(candidate);
  return bytes(text) <= STUDIO_RECOVERY_MAX_BYTES ? { status: "ready", text } : { status: "too-large" };
}

export function parseStudioRecovery(text: string, context: {
  readonly ownerScopeHash: string; readonly routeScope: string; readonly sessionNonce: string; readonly now: number;
}): { readonly status: "ready"; readonly envelope: StudioRecoveryEnvelope } |
  { readonly status: "invalid" | "unsafe" | "too-large" | "mismatch" | "expired" } {
  if (bytes(text) > STUDIO_RECOVERY_MAX_BYTES) return { status: "too-large" };
  let unknownValue: unknown;
  try { unknownValue = JSON.parse(text); } catch { return { status: "invalid" }; }
  const parsed = envelopeSchema.safeParse(unknownValue);
  if (!parsed.success) return { status: "invalid" };
  const value = parsed.data;
  if (value.ownerScopeHash !== context.ownerScopeHash || value.routeScope !== context.routeScope ||
      value.sessionNonce !== context.sessionNonce) return { status: "mismatch" };
  if (value.expiresAt <= context.now) return { status: "expired" };
  if (value.createdAt > context.now + MAX_CLOCK_SKEW_MS || value.updatedAt < value.createdAt ||
      value.updatedAt > context.now + MAX_CLOCK_SKEW_MS || value.updatedAt > value.expiresAt ||
      value.expiresAt !== value.createdAt + STUDIO_RECOVERY_TTL_MS) return { status: "invalid" };
  let graph: SupportedFlowGraph;
  try { graph = structuredClone(parseSupportedFlowGraph(value.graph)); } catch { return { status: "invalid" }; }
  if (!recoverySafe(graph)) return { status: "unsafe" };
  if (flowRecoveryFingerprint(graph) !== value.graphFingerprint) return { status: "invalid" };
  return { status: "ready", envelope: { ...value, graph, flags: { ...value.flags } } };
}

export function writeStudioRecovery(storage: StudioStorage, key: string, text: string): { readonly status: "stored" | "too-large" | "unavailable" } {
  if (bytes(text) > STUDIO_RECOVERY_MAX_BYTES) return { status: "too-large" };
  try { storage.setItem(key, text); return { status: "stored" }; } catch { return { status: "unavailable" }; }
}

export function readStudioRecovery(storage: StudioStorage, key: string): { readonly status: "found"; readonly text: string } | { readonly status: "missing" | "too-large" | "unavailable" } {
  try {
    const text = storage.getItem(key);
    if (text === null) return { status: "missing" };
    return bytes(text) <= STUDIO_RECOVERY_MAX_BYTES ? { status: "found", text } : { status: "too-large" };
  } catch { return { status: "unavailable" }; }
}

export function removeStudioRecovery(storage: StudioStorage, key: string): { readonly status: "removed" | "unavailable" } {
  try { storage.removeItem(key); return { status: "removed" }; } catch { return { status: "unavailable" }; }
}

export function rekeyStudioRecovery(
  storage: StudioStorage,
  previousKey: string,
  nextKey: string,
  text: string,
): { readonly status: "migrated" | "too-large" | "unavailable" } {
  const written = writeStudioRecovery(storage, nextKey, text);
  if (written.status === "too-large") return { status: "too-large" };
  if (written.status === "unavailable") return { status: "unavailable" };
  const readBack = readStudioRecovery(storage, nextKey);
  if (readBack.status !== "found" || readBack.text !== text) return { status: "unavailable" };
  const removed = removeStudioRecovery(storage, previousKey);
  return removed.status === "removed" ? { status: "migrated" } : { status: "unavailable" };
}
