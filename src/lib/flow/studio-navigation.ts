import { flowSaveFingerprint } from "./save-queue";
import type { SupportedFlowGraph } from "./types";

export const STUDIO_NAVIGATION_CHANGED_MESSAGE =
  "The flow changed while saving. Try leaving again after the latest changes save.";
export const STUDIO_PASTE_NAVIGATION_MESSAGE =
  "Wait for the reusable-flow paste to finish before leaving.";
export const STUDIO_NAVIGATION_PASTE_WAIT_MESSAGE =
  "Wait for the navigation save to finish before pasting.";
export const STUDIO_ALTERNATE_NAVIGATION_MESSAGE =
  "Open this link normally after the current draft saves.";

export interface StudioNavigationActivation {
  readonly button: number;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

export function isUnmodifiedPrimaryStudioNavigation(
  activation: StudioNavigationActivation,
): boolean {
  return activation.button === 0 &&
    !activation.metaKey &&
    !activation.ctrlKey &&
    !activation.altKey &&
    !activation.shiftKey;
}

export interface StudioPasteNavigationState {
  readonly operation: boolean;
  readonly epoch: boolean;
  readonly controller: boolean;
  readonly deferred: boolean;
  readonly resolving: boolean;
}

export function isStudioPasteNavigationPending(state: StudioPasteNavigationState): boolean {
  return state.operation || state.epoch || state.controller || state.deferred || state.resolving;
}

export function resolveStudioNavigationPathAfterCreate(path: string, rowId: string): string {
  return path === "/start" ? `/start?flow=${encodeURIComponent(rowId)}` : path;
}

export type StudioNavigationResult =
  | { readonly status: "navigated"; readonly path: string }
  | { readonly status: "changed"; readonly message: string }
  | { readonly status: "blocked"; readonly message: string };

export interface StudioNavigationRequest {
  readonly path: string;
  readonly graph: SupportedFlowGraph;
  readonly getCurrentGraph: () => SupportedFlowGraph | null;
  readonly saveNow: (graph: SupportedFlowGraph) => Promise<void>;
  readonly beforeNavigate?: () => string | null;
  readonly navigate: (path: string) => void;
}

export class StudioNavigationCoordinator {
  private active: Promise<StudioNavigationResult> | null = null;

  isBusy(): boolean {
    return this.active !== null;
  }

  run(request: StudioNavigationRequest): Promise<StudioNavigationResult> {
    if (this.active !== null) return this.active;
    const snapshot = structuredClone(request.graph);
    const fingerprint = flowSaveFingerprint(snapshot);
    const operation = (async (): Promise<StudioNavigationResult> => {
      await request.saveNow(snapshot);
      const current = request.getCurrentGraph();
      if (current === null || flowSaveFingerprint(current) !== fingerprint) {
        return { status: "changed", message: STUDIO_NAVIGATION_CHANGED_MESSAGE };
      }
      const blocker = request.beforeNavigate?.() ?? null;
      if (blocker !== null) return { status: "blocked", message: blocker };
      request.navigate(request.path);
      return { status: "navigated", path: request.path };
    })();
    const tracked: Promise<StudioNavigationResult> = operation.finally(() => {
      if (this.active === tracked) this.active = null;
    });
    this.active = tracked;
    return tracked;
  }
}
