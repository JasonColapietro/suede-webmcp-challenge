import type { GraphFragmentV1 } from "./graph-fragment";

const MAX_DEFERRED_PASTE_INTENTS = 8;

export interface PendingPasteContents {
  readonly fragment: GraphFragmentV1;
  readonly commandId: string;
  readonly targetOrigin: { readonly x: number; readonly y: number };
  readonly label: "Pasted nodes" | "Duplicated selection";
  readonly announcement: string;
  readonly advancePasteSequence: boolean;
}

export class PendingPasteIntent {
  toJSON(): undefined { return undefined; }
}

interface TrustedClipboardContents {
  readonly fragment: GraphFragmentV1;
  readonly externalText: string;
}

export class TrustedClipboardIntent {
  toJSON(): undefined { return undefined; }
}

const PENDING_PASTE_CONTENTS = new WeakMap<PendingPasteIntent, PendingPasteContents>();
const TRUSTED_CLIPBOARD = new WeakMap<TrustedClipboardIntent, TrustedClipboardContents>();
const STAGED_PASTE_INTENTS = new Map<string, PendingPasteIntent>();
const BOUND_PASTE_INTENTS = new Map<string, string>();
const PASTE_TOKEN_ROWS = new Map<string, string>();

function validKey(value: string): boolean {
  return typeof value === "string" && value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= 512;
}

function opaqueToken(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `pending-paste-${crypto.randomUUID()}`;
  return `pending-paste-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createPendingPasteIntent(contents: PendingPasteContents): PendingPasteIntent {
  const intent = new PendingPasteIntent();
  PENDING_PASTE_CONTENTS.set(intent, structuredClone(contents));
  return intent;
}

export function readPendingPasteIntent(intent: PendingPasteIntent): PendingPasteContents {
  const contents = PENDING_PASTE_CONTENTS.get(intent);
  if (!contents) throw new Error("Pending paste intent is invalid");
  return structuredClone(contents);
}

export function clonePendingPasteIntent(intent: PendingPasteIntent): PendingPasteIntent {
  return createPendingPasteIntent(readPendingPasteIntent(intent));
}

export function stageDeferredPasteIntent(intent: PendingPasteIntent): string {
  const token = opaqueToken();
  STAGED_PASTE_INTENTS.set(token, clonePendingPasteIntent(intent));
  while (STAGED_PASTE_INTENTS.size > MAX_DEFERRED_PASTE_INTENTS) {
    const oldest = STAGED_PASTE_INTENTS.keys().next().value as string | undefined;
    if (!oldest) break;
    discardDeferredPasteIntent(oldest);
  }
  return token;
}

export function bindDeferredPasteIntent(token: string, rowId: string): boolean {
  if (!validKey(token) || !validKey(rowId) || !STAGED_PASTE_INTENTS.has(token)) return false;
  const priorRow = PASTE_TOKEN_ROWS.get(token);
  if (priorRow && BOUND_PASTE_INTENTS.get(priorRow) === token) {
    BOUND_PASTE_INTENTS.delete(priorRow);
  }
  const previous = BOUND_PASTE_INTENTS.get(rowId);
  if (previous && previous !== token) discardDeferredPasteIntent(previous);
  BOUND_PASTE_INTENTS.set(rowId, token);
  PASTE_TOKEN_ROWS.set(token, rowId);
  return true;
}

export function consumeDeferredPasteIntent(rowId: string): PendingPasteIntent | null {
  if (!validKey(rowId)) return null;
  const token = BOUND_PASTE_INTENTS.get(rowId);
  if (!token) return null;
  const intent = STAGED_PASTE_INTENTS.get(token);
  discardDeferredPasteIntent(token);
  return intent ? clonePendingPasteIntent(intent) : null;
}

export function peekDeferredPasteIntent(rowId: string): PendingPasteIntent | null {
  if (!validKey(rowId)) return null;
  const token = BOUND_PASTE_INTENTS.get(rowId);
  if (!token) return null;
  const intent = STAGED_PASTE_INTENTS.get(token);
  return intent ? clonePendingPasteIntent(intent) : null;
}

export function discardBoundDeferredPasteIntent(rowId: string): boolean {
  if (!validKey(rowId)) return false;
  const token = BOUND_PASTE_INTENTS.get(rowId);
  if (!token) return false;
  discardDeferredPasteIntent(token);
  return true;
}

export function discardDeferredPasteIntent(token: string): void {
  STAGED_PASTE_INTENTS.delete(token);
  const rowId = PASTE_TOKEN_ROWS.get(token);
  PASTE_TOKEN_ROWS.delete(token);
  if (rowId && BOUND_PASTE_INTENTS.get(rowId) === token) BOUND_PASTE_INTENTS.delete(rowId);
}

export function fragmentHasTypedReferences(fragment: GraphFragmentV1): boolean {
  return fragment.nodes.some((node) =>
    (node.type === "subflow" || node.type === "loop") && Object.hasOwn(node.params, "reference"));
}

export function detachTypedReferencesForExternalClipboard(fragment: GraphFragmentV1): GraphFragmentV1 {
  let detached = 0;
  const nodes = fragment.nodes.map((node) => {
    if (node.type !== "subflow" && node.type !== "loop") return structuredClone(node);
    const copy = structuredClone(node);
    if (Object.hasOwn(copy.params, "reference")) {
      delete copy.params.reference;
      detached += 1;
    }
    if (Object.hasOwn(copy.params, "flowId")) {
      delete copy.params.flowId;
      detached += 1;
    }
    return copy;
  });
  return { ...structuredClone(fragment), nodes, redactionCount: fragment.redactionCount + detached };
}

export function createTrustedClipboardIntent(
  fragment: GraphFragmentV1,
  externalText: string,
): TrustedClipboardIntent {
  const intent = new TrustedClipboardIntent();
  TRUSTED_CLIPBOARD.set(intent, { fragment: structuredClone(fragment), externalText });
  return intent;
}

export function readTrustedClipboardIntent(
  intent: TrustedClipboardIntent | null,
  clipboardText: string,
): GraphFragmentV1 | null {
  if (!intent) return null;
  const contents = TRUSTED_CLIPBOARD.get(intent);
  if (!contents || clipboardText !== contents.externalText) return null;
  return structuredClone(contents.fragment);
}

export interface PendingPasteEpoch {
  readonly generation: number;
  readonly mutationEpoch: number;
  readonly signal: AbortSignal;
}

export class PendingPasteEpochGuard {
  private generation = 0;
  private mutationEpoch = 0;
  private controller: AbortController | null = null;

  begin(): PendingPasteEpoch {
    this.cancel();
    const controller = new AbortController();
    this.controller = controller;
    return { generation: this.generation, mutationEpoch: this.mutationEpoch, signal: controller.signal };
  }

  hasActiveOperation(): boolean {
    return this.controller !== null;
  }

  isCurrent(epoch: PendingPasteEpoch): boolean {
    return this.controller !== null && !epoch.signal.aborted &&
      epoch.generation === this.generation && epoch.mutationEpoch === this.mutationEpoch;
  }

  cancel(): void {
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
  }

  cancelForGraphMutation(): void {
    this.mutationEpoch += 1;
    this.cancel();
  }

  complete(epoch: PendingPasteEpoch): boolean {
    if (!this.isCurrent(epoch)) return false;
    this.mutationEpoch += 1;
    this.generation += 1;
    this.controller = null;
    return true;
  }
}
