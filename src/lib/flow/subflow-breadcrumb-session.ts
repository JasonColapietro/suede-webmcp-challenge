export const SUBFLOW_BREADCRUMB_MAX_BYTES = 16 * 1024;
export const SUBFLOW_BREADCRUMB_MAX_DEPTH = 16;
export const SUBFLOW_BREADCRUMB_MAX_TRAIL = 12;
export const SUBFLOW_BREADCRUMB_TTL_MS = 10 * 60 * 1000;

const MAX_CLOCK_SKEW_MS = 60_000;
const NAVIGATION_KEY = "suede.subflow-breadcrumb.navigation.v1";
const NONCE_KEY = "suede.subflow-breadcrumb.nonce.v1";
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

export interface SubflowBreadcrumbStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type SubflowBreadcrumbReference =
  | {
      readonly kind: "draft";
      readonly flowId: string;
      readonly interfaceHash: string;
    }
  | {
      readonly kind: "pinned";
      readonly flowId: string;
      readonly versionId: string;
      readonly interfaceHash: string;
      readonly contentHash: string;
    };

export interface SubflowBreadcrumbEntry {
  readonly flowId: string;
  readonly via: null | {
    readonly parentFlowId: string;
    readonly originNodeId: string;
    readonly reference: SubflowBreadcrumbReference;
  };
}

export interface SubflowFocusHandoff {
  readonly targetFlowId: string;
  readonly originNodeId: string;
}

interface SubflowNavigationEnvelope {
  readonly v: 1;
  readonly nonce: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly targetFlowId: string;
  readonly trail: readonly SubflowBreadcrumbEntry[] | null;
  readonly focus: SubflowFocusHandoff | null;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function plain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function boundedTree(value: unknown): boolean {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > 2_048 || current.depth > SUBFLOW_BREADCRUMB_MAX_DEPTH) return false;
    if (current.value === null || typeof current.value !== "object") continue;
    if (Array.isArray(current.value)) {
      if (Object.keys(current.value).length !== current.value.length) return false;
      for (const item of current.value) pending.push({ value: item, depth: current.depth + 1 });
      continue;
    }
    if (!plain(current.value)) return false;
    for (const item of Object.values(current.value)) {
      pending.push({ value: item, depth: current.depth + 1 });
    }
  }
  return true;
}

function opaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && byteLength(value) <= 512 && !CONTROL.test(value);
}

function parseReference(value: unknown): SubflowBreadcrumbReference | null {
  if (!plain(value) || !opaqueId(value.flowId) || typeof value.kind !== "string" ||
      typeof value.interfaceHash !== "string" || !HASH.test(value.interfaceHash)) return null;
  if (value.kind === "draft" && exactKeys(value, ["kind", "flowId", "interfaceHash"])) {
    return { kind: "draft", flowId: value.flowId, interfaceHash: value.interfaceHash };
  }
  if (value.kind === "pinned" && exactKeys(value, ["kind", "flowId", "versionId", "interfaceHash", "contentHash"]) &&
      opaqueId(value.versionId) && typeof value.contentHash === "string" && HASH.test(value.contentHash)) {
    return {
      kind: "pinned",
      flowId: value.flowId,
      versionId: value.versionId,
      interfaceHash: value.interfaceHash,
      contentHash: value.contentHash,
    };
  }
  return null;
}

function parseTrail(value: unknown): readonly SubflowBreadcrumbEntry[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > SUBFLOW_BREADCRUMB_MAX_TRAIL ||
      Object.keys(value).length !== value.length) return null;
  const entries: SubflowBreadcrumbEntry[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const candidate = value[index];
    if (!plain(candidate) || !exactKeys(candidate, ["flowId", "via"]) || !opaqueId(candidate.flowId) ||
        seen.has(candidate.flowId)) return null;
    seen.add(candidate.flowId);
    if (index === 0) {
      if (candidate.via !== null) return null;
      entries.push({ flowId: candidate.flowId, via: null });
      continue;
    }
    if (!plain(candidate.via) || !exactKeys(candidate.via, ["parentFlowId", "originNodeId", "reference"]) ||
        candidate.via.parentFlowId !== entries[index - 1]?.flowId || !opaqueId(candidate.via.originNodeId)) return null;
    const reference = parseReference(candidate.via.reference);
    if (!reference || reference.flowId !== candidate.flowId) return null;
    entries.push({
      flowId: candidate.flowId,
      via: {
        parentFlowId: candidate.via.parentFlowId,
        originNodeId: candidate.via.originNodeId,
        reference,
      },
    });
  }
  return entries;
}

function parseFocus(value: unknown): SubflowFocusHandoff | null | undefined {
  if (value === null) return null;
  if (!plain(value) || !exactKeys(value, ["targetFlowId", "originNodeId"]) ||
      !opaqueId(value.targetFlowId) || !opaqueId(value.originNodeId)) return undefined;
  return { targetFlowId: value.targetFlowId, originNodeId: value.originNodeId };
}

function parseEnvelope(text: string, expectedNonce: string, now: number): SubflowNavigationEnvelope | null {
  if (byteLength(text) > SUBFLOW_BREADCRUMB_MAX_BYTES) return null;
  let unknownValue: unknown;
  try { unknownValue = JSON.parse(text); } catch { return null; }
  if (!boundedTree(unknownValue) || !plain(unknownValue) ||
      !exactKeys(unknownValue, ["v", "nonce", "issuedAt", "expiresAt", "targetFlowId", "trail", "focus"]) ||
      unknownValue.v !== 1 || unknownValue.nonce !== expectedNonce || !NONCE.test(expectedNonce) ||
      !Number.isSafeInteger(unknownValue.issuedAt) || !Number.isSafeInteger(unknownValue.expiresAt) ||
      typeof unknownValue.issuedAt !== "number" || typeof unknownValue.expiresAt !== "number" ||
      unknownValue.issuedAt < 0 || unknownValue.expiresAt !== unknownValue.issuedAt + SUBFLOW_BREADCRUMB_TTL_MS ||
      unknownValue.issuedAt > now + MAX_CLOCK_SKEW_MS || unknownValue.expiresAt <= now ||
      !opaqueId(unknownValue.targetFlowId)) return null;
  const trail = unknownValue.trail === null ? null : parseTrail(unknownValue.trail);
  const focus = parseFocus(unknownValue.focus);
  if ((unknownValue.trail !== null && !trail) || focus === undefined ||
      (trail !== null && trail.at(-1)?.flowId !== unknownValue.targetFlowId) ||
      (focus !== null && focus.targetFlowId !== unknownValue.targetFlowId)) return null;
  return {
    v: 1,
    nonce: expectedNonce,
    issuedAt: unknownValue.issuedAt,
    expiresAt: unknownValue.expiresAt,
    targetFlowId: unknownValue.targetFlowId,
    trail,
    focus,
  };
}

function removeEnvelope(storage: SubflowBreadcrumbStorage): void {
  try { storage.removeItem(NAVIGATION_KEY); } catch { /* Invalid state remains unusable. */ }
}

function readEnvelope(
  storage: SubflowBreadcrumbStorage,
  nonce: string,
  now: number,
): SubflowNavigationEnvelope | null {
  let text: string | null;
  try { text = storage.getItem(NAVIGATION_KEY); } catch { return null; }
  if (text === null) return null;
  const envelope = parseEnvelope(text, nonce, now);
  if (!envelope) removeEnvelope(storage);
  return envelope;
}

export function appendSubflowBreadcrumb(
  trail: readonly SubflowBreadcrumbEntry[],
  next: SubflowBreadcrumbEntry,
): readonly SubflowBreadcrumbEntry[] | null {
  const parsed = parseTrail([...trail, next]);
  return parsed ? structuredClone(parsed) : null;
}

export function deriveSubflowAncestorReturn(
  trail: readonly SubflowBreadcrumbEntry[],
  targetFlowId: string,
): {
  readonly targetFlowId: string;
  readonly trail: readonly SubflowBreadcrumbEntry[];
  readonly focus: SubflowFocusHandoff;
} | null {
  const parsed = parseTrail(trail);
  if (!parsed || !opaqueId(targetFlowId)) return null;
  const targetIndex = parsed.findIndex(({ flowId }) => flowId === targetFlowId);
  if (targetIndex < 0 || targetIndex >= parsed.length - 1) return null;
  const exitedChild = parsed[targetIndex + 1];
  if (!exitedChild?.via || exitedChild.via.parentFlowId !== targetFlowId) return null;
  return {
    targetFlowId,
    trail: structuredClone(parsed.slice(0, targetIndex + 1)),
    focus: { targetFlowId, originNodeId: exitedChild.via.originNodeId },
  };
}

export function projectSubflowBreadcrumbRequest(
  trail: readonly SubflowBreadcrumbEntry[],
  currentFlowId: string,
): {
  readonly currentFlowId: string;
  readonly trail: ReadonlyArray<{
    readonly flowId: string;
    readonly versionId?: string;
    readonly contentHash?: string;
  }>;
} | null {
  if (trail.length === 0) {
    return opaqueId(currentFlowId) ? { currentFlowId, trail: [] } : null;
  }
  const parsed = parseTrail(trail);
  if (!parsed || !opaqueId(currentFlowId) || parsed.at(-1)?.flowId !== currentFlowId) return null;
  if (parsed.length === 1) return { currentFlowId, trail: [] };
  return {
    currentFlowId,
    trail: parsed.map((entry) => entry.via?.reference.kind === "pinned"
      ? {
          flowId: entry.flowId,
          versionId: entry.via.reference.versionId,
          contentHash: entry.via.reference.contentHash,
        }
      : { flowId: entry.flowId }),
  };
}

export interface ValidatedSubflowBreadcrumb {
  readonly flowId: string;
  readonly name: string;
  readonly versionId?: string;
  readonly versionNumber?: number;
  readonly contentHash?: string;
}

export function validateSubflowBreadcrumbResponse(
  value: unknown,
  request: NonNullable<ReturnType<typeof projectSubflowBreadcrumbRequest>>,
): { readonly crumbs: readonly ValidatedSubflowBreadcrumb[] } | null {
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { return null; }
  if (byteLength(encoded) > 32 * 1024 || !boundedTree(value) || !plain(value) ||
      !exactKeys(value, ["crumbs"]) || !Array.isArray(value.crumbs) ||
      Object.keys(value.crumbs).length !== value.crumbs.length ||
      value.crumbs.length !== request.trail.length) return null;
  const crumbs: ValidatedSubflowBreadcrumb[] = [];
  for (let index = 0; index < request.trail.length; index += 1) {
    const expected = request.trail[index]!;
    const candidate = value.crumbs[index];
    if (!plain(candidate) || candidate.flowId !== expected.flowId || !opaqueId(candidate.flowId) ||
        typeof candidate.name !== "string" || candidate.name.length < 1 ||
        byteLength(candidate.name) > 200 || CONTROL.test(candidate.name)) return null;
    const pinned = expected.versionId !== undefined && expected.contentHash !== undefined;
    if (pinned) {
      if (!exactKeys(candidate, ["flowId", "name", "versionId", "versionNumber", "contentHash"]) ||
          candidate.versionId !== expected.versionId || candidate.contentHash !== expected.contentHash ||
          !opaqueId(candidate.versionId) || typeof candidate.versionNumber !== "number" ||
          !Number.isSafeInteger(candidate.versionNumber) || candidate.versionNumber <= 0 ||
          typeof candidate.contentHash !== "string" || !HASH.test(candidate.contentHash)) return null;
      crumbs.push({
        flowId: candidate.flowId,
        name: candidate.name,
        versionId: candidate.versionId,
        versionNumber: candidate.versionNumber,
        contentHash: candidate.contentHash,
      });
    } else {
      if (!exactKeys(candidate, ["flowId", "name"])) return null;
      crumbs.push({ flowId: candidate.flowId, name: candidate.name });
    }
  }
  return { crumbs };
}

export function clearSubflowBreadcrumbSession(storage: SubflowBreadcrumbStorage): void {
  removeEnvelope(storage);
}

export function getOrCreateSubflowBreadcrumbNonce(
  storage: Pick<SubflowBreadcrumbStorage, "getItem" | "setItem">,
  createNonce: () => string,
): string {
  try {
    const existing = storage.getItem(NONCE_KEY);
    if (existing !== null && NONCE.test(existing)) return existing;
  } catch { /* Fall through to an in-memory nonce. */ }
  const created = createNonce();
  if (!NONCE.test(created)) throw new Error("Subflow breadcrumb session nonce is invalid");
  try { storage.setItem(NONCE_KEY, created); } catch { /* Caller retains it in memory. */ }
  return created;
}

export function stageSubflowBreadcrumbRouteEffect(
  storage: SubflowBreadcrumbStorage,
  input: {
    readonly nonce: string;
    readonly targetFlowId: string;
    readonly trail: readonly SubflowBreadcrumbEntry[];
    readonly focus: SubflowFocusHandoff | null;
    readonly now: number;
  },
  approvedRouteEffect: () => void,
): { readonly status: "routed" | "refused" | "unavailable" } {
  const trail = parseTrail(input.trail);
  const focus = parseFocus(input.focus);
  if (!NONCE.test(input.nonce) || !trail || !opaqueId(input.targetFlowId) ||
      trail.at(-1)?.flowId !== input.targetFlowId || focus === undefined ||
      (focus !== null && focus.targetFlowId !== input.targetFlowId) ||
      !Number.isSafeInteger(input.now) || input.now < 0) {
    return { status: "refused" };
  }
  if (!Number.isSafeInteger(input.now + SUBFLOW_BREADCRUMB_TTL_MS)) return { status: "refused" };
  const envelope: SubflowNavigationEnvelope = {
    v: 1,
    nonce: input.nonce,
    issuedAt: input.now,
    expiresAt: input.now + SUBFLOW_BREADCRUMB_TTL_MS,
    targetFlowId: input.targetFlowId,
    trail: structuredClone(trail),
    focus,
  };
  const text = JSON.stringify(envelope);
  if (byteLength(text) > SUBFLOW_BREADCRUMB_MAX_BYTES) return { status: "refused" };
  try { storage.setItem(NAVIGATION_KEY, text); } catch { return { status: "unavailable" }; }
  try {
    approvedRouteEffect();
    return { status: "routed" };
  } catch (error) {
    removeEnvelope(storage);
    throw error;
  }
}

export function readSubflowBreadcrumbTrail(
  storage: SubflowBreadcrumbStorage,
  context: { readonly nonce: string; readonly currentFlowId: string; readonly now: number },
): readonly SubflowBreadcrumbEntry[] {
  const envelope = readEnvelope(storage, context.nonce, context.now);
  if (!envelope || envelope.targetFlowId !== context.currentFlowId) {
    if (envelope) removeEnvelope(storage);
    return [];
  }
  if (envelope.trail === null) return [];
  const claimed = structuredClone(envelope.trail);
  try {
    storage.setItem(NAVIGATION_KEY, JSON.stringify({ ...envelope, trail: null }));
  } catch {
    removeEnvelope(storage);
    return [];
  }
  return claimed;
}

export function consumeSubflowFocusAfterGraphLoad(
  storage: SubflowBreadcrumbStorage,
  context: {
    readonly nonce: string;
    readonly targetFlowId: string;
    readonly graphLoaded: boolean;
    readonly nodeIds: readonly string[];
    readonly now: number;
  },
): { readonly status: "waiting" | "none" } |
  { readonly status: "focused"; readonly originNodeId: string } {
  const envelope = readEnvelope(storage, context.nonce, context.now);
  if (!envelope) return { status: "none" };
  if (envelope.targetFlowId !== context.targetFlowId) {
    removeEnvelope(storage);
    return { status: "none" };
  }
  if (envelope.focus === null) return { status: "none" };
  if (envelope.focus.targetFlowId !== context.targetFlowId) {
    removeEnvelope(storage);
    return { status: "none" };
  }
  if (!context.graphLoaded) return { status: "waiting" };
  const originNodeId = envelope.focus.originNodeId;
  const next: SubflowNavigationEnvelope = { ...envelope, focus: null };
  try { storage.setItem(NAVIGATION_KEY, JSON.stringify(next)); } catch {
    removeEnvelope(storage);
    return { status: "none" };
  }
  return context.nodeIds.includes(originNodeId)
    ? { status: "focused", originNodeId }
    : { status: "none" };
}
