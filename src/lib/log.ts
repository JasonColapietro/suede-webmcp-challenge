/** RunLogger — buffers run events + ledger rows and exposes them for SSE. */
import type { LedgerRow, RunEvent } from "./flow/types";

export class RunLogger {
  private readonly events: RunEvent[] = [];
  private readonly ledger: LedgerRow[] = [];
  private listeners: Array<(e: RunEvent) => void> = [];

  emit(event: RunEvent): void {
    this.events.push(event);
    for (const fn of this.listeners) fn(event);
  }

  record(row: LedgerRow): void {
    this.ledger.push(row);
  }

  onEvent(fn: (e: RunEvent) => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  getEvents(): readonly RunEvent[] {
    return this.events;
  }

  getLedger(): readonly LedgerRow[] {
    return this.ledger;
  }

  totalCostUsdc(): number {
    return this.ledger.reduce((sum, row) => sum + row.costUsdc, 0);
  }
}
