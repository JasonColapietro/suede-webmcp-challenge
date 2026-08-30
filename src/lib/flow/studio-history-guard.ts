const MARKER_VERSION = 1 as const;
const MAX_NONCE_BYTES = 128;
const NONCE_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface StudioHistoryMarker {
  readonly v: typeof MARKER_VERSION;
  readonly kind: "base" | "sentinel";
  readonly nonce: string;
}

export interface StudioHistoryPort {
  currentMarker(): StudioHistoryMarker | null;
  pushMarker(marker: StudioHistoryMarker): void;
  replaceMarker(marker: StudioHistoryMarker | null): void;
  back(): void;
  forward(): void;
}

export interface StudioBeforeUnloadEvent {
  preventDefault(): void;
  returnValue: string;
}

export interface StudioPageShowEvent {
  readonly persisted: boolean;
}

export type StudioRecoveryWriteReason = "beforeunload" | "pagehide" | "back";

export interface StudioBackDecision {
  confirm(): void;
  cancel(): void;
}

export type StudioInternalNavigationResult = "started" | "completed" | "blocked";

export interface StudioHistoryGuardOptions {
  readonly history: StudioHistoryPort;
  readonly isDirty: () => boolean;
  readonly writeRecovery: (reason: StudioRecoveryWriteReason) => void;
  readonly createNonce: () => string;
  readonly onBackRequest: (decision: StudioBackDecision) => void;
}

type Position = "unarmed" | "base" | "sentinel" | "other";
type BackChoice = "confirm" | "cancel" | null;

interface PendingBack {
  readonly generation: number;
  choice: BackChoice;
  traversal: "to-base" | "to-sentinel" | null;
}

interface PendingInternalNavigation {
  readonly generation: number;
  readonly callback: () => void;
}

function validNonce(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    NONCE_PATTERN.test(value) &&
    new TextEncoder().encode(value).byteLength <= MAX_NONCE_BYTES;
}

function validMarker(value: StudioHistoryMarker | null): value is StudioHistoryMarker {
  return value !== null &&
    value.v === MARKER_VERSION &&
    (value.kind === "base" || value.kind === "sentinel") &&
    validNonce(value.nonce);
}

/**
 * Pure history/unload state machine. Browser event wiring and history-state
 * preservation live in an adapter; this controller never performs async save.
 */
export class StudioHistoryGuard {
  private nonce: string;
  private active = true;
  private position: Position = "unarmed";
  private generation = 0;
  private pendingBack: PendingBack | null = null;
  private pendingInternal: PendingInternalNavigation | null = null;

  constructor(private readonly options: StudioHistoryGuardOptions) {
    const nonce = options.createNonce();
    if (!validNonce(nonce)) throw new Error("Studio history session nonce is invalid");
    this.nonce = nonce;
  }

  mount(): void {
    this.active = true;
    this.invalidatePendingWork();
    this.sync();
  }

  sync(): void {
    if (!this.active) return;

    const dirty = this.options.isDirty();
    const current = this.options.history.currentMarker();
    if (!dirty) {
      if (this.position === "sentinel" && this.isOwnMarker(current, "sentinel")) {
        // Remove the logical sentinel immediately. The duplicate physical entry
        // remains until Back traverses base, where leaveFromBase strips base too.
        this.options.history.replaceMarker(null);
      }
      return;
    }

    if (this.position === "sentinel" && current === null) {
      // A clean transition stripped this sentinel in place; re-arm it without
      // pushing another physical history entry.
      this.options.history.replaceMarker(this.marker("sentinel"));
      return;
    }

    if (this.isOwnMarker(current, "sentinel")) {
      this.position = "sentinel";
      return;
    }
    if (validMarker(current) && current.kind === "sentinel") {
      this.nonce = current.nonce;
      this.position = "sentinel";
      return;
    }
    if (validMarker(current) && current.kind === "base") {
      this.nonce = current.nonce;
      this.position = "base";
      this.options.history.pushMarker(this.marker("sentinel"));
      this.position = "sentinel";
      return;
    }

    this.options.history.replaceMarker(this.marker("base"));
    this.position = "base";
    this.options.history.pushMarker(this.marker("sentinel"));
    this.position = "sentinel";
  }

  handleBeforeUnload(event: StudioBeforeUnloadEvent): boolean {
    if (!this.options.isDirty()) return false;
    this.writeRecovery("beforeunload");
    event.preventDefault();
    event.returnValue = "";
    return true;
  }

  handlePageHide(): void {
    if (this.options.isDirty()) this.writeRecovery("pagehide");
  }

  handlePageShow(event: StudioPageShowEvent): void {
    if (!event.persisted) return;
    this.active = true;
    this.invalidatePendingWork();
    this.position = "unarmed";
    this.sync();
  }

  handlePopState(marker: StudioHistoryMarker | null): void {
    if (!this.active) return;

    if (this.pendingInternal !== null) {
      this.handleInternalPop(marker);
      return;
    }
    if (this.pendingBack !== null) {
      this.handlePendingBackPop(marker);
      return;
    }

    if (this.isOwnMarker(marker, "sentinel")) {
      this.position = "sentinel";
      return;
    }
    if (this.position !== "sentinel" || !this.isOwnMarker(marker, "base")) return;

    this.position = "base";
    if (!this.options.isDirty()) {
      this.leaveFromBase();
      return;
    }

    this.writeRecovery("back");
    const generation = ++this.generation;
    this.pendingBack = { generation, choice: null, traversal: null };
    const decision: StudioBackDecision = {
      confirm: () => this.settleBackDecision(generation, "confirm"),
      cancel: () => this.settleBackDecision(generation, "cancel"),
    };
    try {
      this.options.onBackRequest(decision);
    } catch {
      decision.cancel();
    }
  }

  beginInternalNavigation(callback: () => void): StudioInternalNavigationResult {
    if (!this.active || this.pendingBack !== null || this.pendingInternal !== null) {
      return "blocked";
    }
    if (this.position === "unarmed" && !this.options.isDirty()) {
      this.active = false;
      this.invalidatePendingWork();
      callback();
      return "completed";
    }
    if (this.position !== "sentinel") return "blocked";

    const generation = ++this.generation;
    this.pendingInternal = { generation, callback };
    this.position = "other";
    this.options.history.back();
    return "started";
  }

  dispose(): void {
    this.active = false;
    this.position = "unarmed";
    this.invalidatePendingWork();
  }

  private handleInternalPop(marker: StudioHistoryMarker | null): void {
    const pending = this.pendingInternal;
    if (pending === null) return;
    if (pending.generation !== this.generation) {
      this.pendingInternal = null;
      return;
    }
    if (this.isOwnMarker(marker, "base")) {
      this.options.history.replaceMarker(null);
      this.pendingInternal = null;
      this.active = false;
      this.position = "unarmed";
      this.generation += 1;
      pending.callback();
      return;
    }
    if (this.isOwnMarker(marker, "sentinel")) {
      this.options.history.back();
      return;
    }
    this.options.history.forward();
  }

  private handlePendingBackPop(marker: StudioHistoryMarker | null): void {
    const pending = this.pendingBack;
    if (pending === null) return;
    if (pending.generation !== this.generation) {
      this.pendingBack = null;
      return;
    }

    if (this.isOwnMarker(marker, "sentinel")) {
      this.position = "sentinel";
      this.pendingBack = null;
      this.generation += 1;
      return;
    }
    if (!this.isOwnMarker(marker, "base")) {
      this.position = "other";
      if (pending.traversal === null) {
        pending.traversal = "to-base";
        this.options.history.forward();
      }
      return;
    }

    this.position = "base";
    if (pending.traversal === "to-base") pending.traversal = null;
    if (pending.choice === "confirm") {
      this.leaveFromBase();
    } else if (pending.choice === "cancel") {
      pending.traversal = "to-sentinel";
      this.options.history.forward();
    }
  }

  private settleBackDecision(generation: number, choice: Exclude<BackChoice, null>): void {
    const pending = this.pendingBack;
    if (!this.active || pending === null || pending.generation !== generation ||
      generation !== this.generation || pending.choice !== null) return;

    pending.choice = choice;
    if (this.position === "base") {
      if (choice === "confirm") this.leaveFromBase();
      else {
        pending.traversal = "to-sentinel";
        this.options.history.forward();
      }
      return;
    }
  }

  private leaveFromBase(): void {
    this.options.history.replaceMarker(null);
    this.pendingBack = null;
    this.active = false;
    this.position = "unarmed";
    this.generation += 1;
    this.options.history.back();
  }

  private invalidatePendingWork(): void {
    this.generation += 1;
    this.pendingBack = null;
    this.pendingInternal = null;
  }

  private isOwnMarker(
    marker: StudioHistoryMarker | null,
    kind: StudioHistoryMarker["kind"],
  ): boolean {
    return validMarker(marker) && marker.nonce === this.nonce && marker.kind === kind;
  }

  private marker(kind: StudioHistoryMarker["kind"]): StudioHistoryMarker {
    return { v: MARKER_VERSION, kind, nonce: this.nonce };
  }

  private writeRecovery(reason: StudioRecoveryWriteReason): void {
    try {
      this.options.writeRecovery(reason);
    } catch {
      // Recovery is best-effort; unload/back protection must still run.
    }
  }
}
