import type { StudioHistoryMarker, StudioHistoryPort } from "./studio-history-guard";

const MARKER_KEY = "__suedeStudioHistoryGuardV1";
const NONCE_KEY = "suede.studio-recovery.session.v1";
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;

interface BrowserHistoryLike {
  readonly state: unknown;
  pushState(data: unknown, unused: string, url?: string | URL | null): void;
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
  back(): void;
  forward(): void;
}

interface SessionNonceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function marker(value: unknown): StudioHistoryMarker | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  return candidate.v === 1 && (candidate.kind === "base" || candidate.kind === "sentinel") &&
    typeof candidate.nonce === "string" && NONCE.test(candidate.nonce)
    ? { v: 1, kind: candidate.kind, nonce: candidate.nonce }
    : null;
}

export function studioHistoryMarkerFromState(state: unknown): StudioHistoryMarker | null {
  return marker(record(state)[MARKER_KEY]);
}

export function createStudioHistoryBrowserPort(history: BrowserHistoryLike): StudioHistoryPort {
  const stateWith = (next: StudioHistoryMarker | null): Record<string, unknown> => {
    const state = record(history.state);
    if (next === null) delete state[MARKER_KEY];
    else state[MARKER_KEY] = next;
    return state;
  };
  return {
    currentMarker: () => studioHistoryMarkerFromState(history.state),
    pushMarker: (next) => history.pushState(stateWith(next), ""),
    replaceMarker: (next) => history.replaceState(stateWith(next), ""),
    back: () => history.back(),
    forward: () => history.forward(),
  };
}

export function getOrCreateStudioRecoverySessionNonce(
  storage: SessionNonceStorage,
  createNonce: () => string,
): string {
  try {
    const existing = storage.getItem(NONCE_KEY);
    if (existing !== null && NONCE.test(existing)) return existing;
  } catch {
    // Fall through to an in-memory nonce when storage is unavailable.
  }
  const created = createNonce();
  if (!NONCE.test(created)) throw new Error("Studio recovery session nonce is invalid");
  try { storage.setItem(NONCE_KEY, created); } catch { /* The caller retains the nonce in memory. */ }
  return created;
}
