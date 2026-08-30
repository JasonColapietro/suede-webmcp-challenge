/**
 * Pure: AgentManifest → plain-English review card strings.
 * No imports from server-only modules (manifest schema is safe — pure zod).
 * Strings verbatim from docs/copy/2026-06-11-platform-copy.md §4, except the
 * missing-wallet fallback, corrected 2026-08-09: the doc's "workspace wallet"
 * line described a wallet that does not exist until the owner saves one.
 */
import type { AgentManifest } from "@/lib/manifest/schema";
import { describeCron } from "@/lib/cron";

export interface ReviewCard {
  label: "What it does" | "When it runs" | "What it charges" | "Where the money goes";
  value: string;
}

export function buildReviewCards(manifest: AgentManifest): ReviewCard[] {
  return [
    { label: "What it does", value: whatItDoes(manifest) },
    { label: "When it runs", value: whenItRuns(manifest) },
    { label: "What it charges", value: whatItCharges(manifest) },
    { label: "Where the money goes", value: whereMoneyGoes(manifest) },
  ];
}

function whatItDoes(manifest: AgentManifest): string {
  return manifest.description.trim() !== "" ? manifest.description : manifest.name;
}

function whenItRuns(manifest: AgentManifest): string {
  const scheduleTrigger = manifest.triggers.find((t) => t.kind === "schedule");
  if (scheduleTrigger?.kind === "schedule") {
    return describeCron(scheduleTrigger.cron);
  }
  const webhookTrigger = manifest.triggers.find((t) => t.kind === "webhook");
  if (webhookTrigger) return "On webhook call.";
  return "On demand.";
}

function whatItCharges(manifest: AgentManifest): string {
  const paidCall = manifest.triggers.find((t) => t.kind === "paidCall");
  if (paidCall?.kind === "paidCall" && paidCall.priceUsdc > 0) {
    return `Other agents pay $${paidCall.priceUsdc.toFixed(2)} per call.`;
  }
  return "Free to call.";
}

function whereMoneyGoes(manifest: AgentManifest): string {
  const addr = manifest.payoutAddress;
  if (addr && addr.length >= 6) {
    const ending = addr.slice(-4);
    return `Payouts go to the wallet ending in ${ending}.`;
  }
  // Honest fallback: with no saved wallet, resolvePayout falls through to the
  // platform wallet (or the zero address), so earnings never reach the
  // creator. Say that plainly instead of promising a "workspace wallet"
  // that may not exist.
  return "No payout wallet yet. Add one so paid calls can reach you.";
}
