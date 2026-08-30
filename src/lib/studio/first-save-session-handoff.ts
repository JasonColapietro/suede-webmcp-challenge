import type { GraphSelection, NodeBounds } from "@/lib/flow/graph-command-types";
import type { GraphHistoryState } from "@/lib/flow/graph-history";

export interface CanvasViewport {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export interface FirstSaveSessionHandoff {
  readonly rowId: string;
  readonly persistedFingerprint: string;
  readonly currentFingerprint: string;
  readonly acceptedAuthoritativeFingerprints: readonly string[];
  readonly history: GraphHistoryState;
  readonly selection: GraphSelection;
  readonly measuredBounds: Readonly<Record<string, NodeBounds>>;
  readonly viewport: CanvasViewport | null;
  readonly createdAt: number;
}

const HANDOFF_TTL_MS = 30_000;
const HANDOFF_LIMIT = 8;
const pending = new Map<string, FirstSaveSessionHandoff>();

function cloneHandoff(handoff: FirstSaveSessionHandoff): FirstSaveSessionHandoff {
  return structuredClone(handoff);
}

function removeExpired(now: number): void {
  for (const [rowId, handoff] of pending) {
    if (now - handoff.createdAt > HANDOFF_TTL_MS) pending.delete(rowId);
  }
}

/**
 * Preserve transient Studio editor state across the App Router remount caused by
 * replacing `/build/new` with the newly-created row id.
 *
 * This is deliberately process-local and short lived. The durable recovery
 * envelope remains authoritative across reloads, crashes, and other tabs.
 */
export function storeFirstSaveSessionHandoff(
  handoff: FirstSaveSessionHandoff,
  now = Date.now(),
): void {
  removeExpired(now);
  pending.delete(handoff.rowId);
  if (pending.size >= HANDOFF_LIMIT) {
    const oldest = [...pending.entries()].sort(
      ([, left], [, right]) => left.createdAt - right.createdAt,
    )[0]?.[0];
    if (oldest) pending.delete(oldest);
  }
  pending.set(handoff.rowId, cloneHandoff(handoff));
}

/**
 * Read without mutating so callers can validate the authoritative graph before
 * consuming the handoff.
 */
export function readFirstSaveSessionHandoff(
  rowId: string,
  now = Date.now(),
): FirstSaveSessionHandoff | null {
  const handoff = pending.get(rowId);
  if (!handoff || now - handoff.createdAt > HANDOFF_TTL_MS) return null;
  return cloneHandoff(handoff);
}

/**
 * Consume the exact handoff after the authoritative graph has arrived.
 * A later navigation to the same row must start a normal editor session.
 */
export function consumeFirstSaveSessionHandoff(
  handoff: FirstSaveSessionHandoff,
  now = Date.now(),
): boolean {
  const stored = pending.get(handoff.rowId);
  if (!stored) return false;
  if (now - stored.createdAt > HANDOFF_TTL_MS) {
    pending.delete(handoff.rowId);
    return false;
  }
  if (
    stored.createdAt !== handoff.createdAt ||
    stored.persistedFingerprint !== handoff.persistedFingerprint ||
    stored.currentFingerprint !== handoff.currentFingerprint ||
    stored.acceptedAuthoritativeFingerprints.length !==
      handoff.acceptedAuthoritativeFingerprints.length ||
    stored.acceptedAuthoritativeFingerprints.some(
      (fingerprint, index) =>
        fingerprint !== handoff.acceptedAuthoritativeFingerprints[index],
    )
  ) {
    return false;
  }
  pending.delete(handoff.rowId);
  return true;
}

export function firstSaveSessionHandoffMatches(
  handoff: FirstSaveSessionHandoff,
  authoritativeFingerprint: string,
): boolean {
  return handoff.acceptedAuthoritativeFingerprints.includes(
    authoritativeFingerprint,
  );
}

/**
 * Atomically read, validate, and consume the one-use handoff after the route's
 * authoritative graph arrives. Mismatches are discarded so a later ordinary
 * navigation cannot replay editor state from the first-save transition.
 */
export function takeMatchingFirstSaveSessionHandoff(
  rowId: string,
  authoritativeFingerprint: string,
  now = Date.now(),
): FirstSaveSessionHandoff | null {
  const handoff = readFirstSaveSessionHandoff(rowId, now);
  if (!handoff) return null;
  if (!firstSaveSessionHandoffMatches(handoff, authoritativeFingerprint)) {
    consumeFirstSaveSessionHandoff(handoff, now);
    return null;
  }
  return consumeFirstSaveSessionHandoff(handoff, now) ? handoff : null;
}

/** Test-only reset for this process-local, module-scoped handoff store. */
export function resetFirstSaveSessionHandoffsForTest(): void {
  pending.clear();
}
