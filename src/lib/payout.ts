/**
 * Payout resolution — where a paid call's USDC routes. A company employee's
 * own wallet wins when the founder set one, then the creator's saved owner
 * wallet, then the platform env var as fallback; otherwise the zero address
 * (and settlement stays dry-run). Both employee and owner wallets are
 * creator-side money (source: "creator") — platform-take collection is a
 * separate, still-gated concern (split-collection design brief). Server-only.
 */
import { getRepo } from "./db/repo";
import type {
  AgentRecord,
  FlowRecord,
  FlowRepo,
} from "./db/repo";
import type { EmployeeRecord } from "./company/types";
import { isAddress } from "viem";

/** USDC contract on Base mainnet. */
export const USDC_BASE_ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface PayoutInfo {
  payTo: string;
  source: "creator" | "platform" | "unset";
}

export interface PayoutCandidate {
  readonly payTo: string | null | undefined;
  readonly source: "creator" | "platform" | "unset";
}

/** Ordered payout selection. A configured-but-invalid candidate fails closed. */
export function selectPayout(candidates: readonly PayoutCandidate[]): PayoutInfo {
  for (const candidate of candidates) {
    if (!candidate.payTo) continue;
    const payTo = candidate.payTo.trim();
    if (!isAddress(payTo)
      || payTo.toLowerCase() === ZERO_ADDRESS.toLowerCase()
      || candidate.source === "unset") {
      return { payTo: ZERO_ADDRESS, source: "unset" };
    }
    return { payTo, source: candidate.source };
  }
  return { payTo: ZERO_ADDRESS, source: "unset" };
}

export function isConfiguredPayout(payout: PayoutInfo): boolean {
  return payout.source !== "unset"
    && isAddress(payout.payTo)
    && payout.payTo.toLowerCase() !== ZERO_ADDRESS.toLowerCase();
}

export async function resolvePayoutFromRepo(
  agent: AgentRecord,
  repo: FlowRepo,
  preloaded: {
    readonly employee?: EmployeeRecord | null;
    readonly flow?: FlowRecord | null;
  } = {},
): Promise<PayoutInfo> {
  const employee = Object.prototype.hasOwnProperty.call(preloaded, "employee")
    ? preloaded.employee ?? null
    : await repo.getEmployeeByAgent(agent.id);
  const flow = Object.prototype.hasOwnProperty.call(preloaded, "flow")
    ? preloaded.flow ?? null
    : await repo.getFlow(agent.flowId);
  const wallet = flow ? await repo.getWallet(flow.ownerId) : null;
  return selectPayout([
    { payTo: employee?.payTo, source: "creator" },
    { payTo: wallet?.address, source: "creator" },
    { payTo: process.env.X402_SELLER_WALLET_ADDRESS, source: "platform" },
  ]);
}

export async function resolvePayout(agent: AgentRecord): Promise<PayoutInfo> {
  return resolvePayoutFromRepo(agent, await getRepo());
}
