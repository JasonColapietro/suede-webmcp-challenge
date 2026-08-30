/**
 * Server wallet helpers. Derives the Studio's settlement address from
 * X402_PRIVATE_KEY and (when a Base RPC is configured) reads its on-chain USDC
 * balance. Every path is defensive: missing/invalid config returns null rather
 * than throwing, so the UI can degrade gracefully.
 */
import { createPublicClient, http, formatUnits, getAddress } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

/** USDC on Base mainnet. */
const USDC_BASE: `0x${string}` = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const USDC_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "a", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** Returns the server wallet address, or null if the key is missing/invalid. */
export function getServerWalletAddress(): string | null {
  const key = process.env.X402_PRIVATE_KEY;
  if (!key) return null;
  try {
    const normalized = key.startsWith("0x") ? key : `0x${key}`;
    const account = privateKeyToAccount(normalized as `0x${string}`);
    return account.address;
  } catch {
    return null;
  }
}

/** Reads the USDC balance (6-decimal formatted) for an address on Base. */
export async function readUsdcBalance(address: string): Promise<string | null> {
  const rpcUrl = process.env.BASE_RPC_URL;
  if (!rpcUrl) return null;
  try {
    const checksummed = getAddress(address);
    const client = createPublicClient({ chain: base, transport: http(rpcUrl) });
    const balance = await client.readContract({
      address: USDC_BASE,
      abi: USDC_ABI,
      functionName: "balanceOf",
      args: [checksummed],
    });
    return formatUnits(balance, 6);
  } catch {
    return null;
  }
}
