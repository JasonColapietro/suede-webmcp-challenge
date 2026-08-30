/**
 * On-chain SuedeRegistry client for the registerIp node. Server-only.
 *
 * The registry contract is the IP Registry's (ip.suedeai.ai) system of
 * record on Base. ABI fragment and the verified mainnet address are copied
 * from Suede-AI-App/landing-site (src/abi/SuedeRegistry.json,
 * src/lib/networks.ts) — the repos share no package, so keep this file in
 * sync if the registry is ever redeployed (env overrides below win).
 *
 * registerWork() hard-codes creator = msg.sender and has no delegated path.
 * Consequently this client accepts only an explicit owner-funded signing
 * capability. It never reads a platform private key from the environment.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";

/** Minimal ABI: just what the node calls. */
export const SUEDE_REGISTRY_ABI = [
  {
    inputs: [
      { internalType: "bytes32", name: "assetHash", type: "bytes32" },
      { internalType: "string", name: "metadata", type: "string" },
    ],
    name: "registerWork",
    outputs: [
      { internalType: "uint256", name: "tokenId", type: "uint256" },
      { internalType: "address", name: "ipAccount", type: "address" },
    ],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "bytes32", name: "assetHash", type: "bytes32" }],
    name: "getEntry",
    outputs: [
      {
        components: [
          { internalType: "address", name: "creator", type: "address" },
          { internalType: "address", name: "ipAccount", type: "address" },
          { internalType: "uint256", name: "timestamp", type: "uint256" },
          { internalType: "uint256", name: "tokenId", type: "uint256" },
          { internalType: "bytes32", name: "assetHash", type: "bytes32" },
          { internalType: "string", name: "metadata", type: "string" },
          { internalType: "bool", name: "exists", type: "bool" },
        ],
        internalType: "struct SuedeRegistry.RegistryEntry",
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

/** Verified production deployment (landing-site networks.ts fallback). */
const BASE_MAINNET_REGISTRY = "0x264eFed8135c36aD15a068d475d99c4030c27a3A" as const;

export type RegistryNetwork = "base-mainnet" | "base-sepolia";

export interface RegisterWorkResult {
  txHash: Hex;
  tokenId: string | null;
  ipAccount: string | null;
  registryAddress: `0x${string}`;
  network: RegistryNetwork;
  /** True when the hash was already registered (idempotent success). */
  alreadyRegistered: boolean;
  creator: `0x${string}`;
}

/**
 * An unforgeable, non-serializable authority to spend an owner's ETH on one
 * bounded run. The private key and mutable quota live only in the WeakMap.
 */
export type OwnerFundedRegistryAuthorization = Readonly<{
  kind: "owner-funded-registry-gas";
}>;

interface OwnerFundedRegistryAuthorizationState {
  readonly ownerId: string;
  readonly runId: string;
  readonly ownerAddress: `0x${string}`;
  readonly privateKey: Hex;
  remainingTransactions: number;
  remainingGasFeeWei: bigint;
}

const ownerFundedRegistryAuthorizations = new WeakMap<
  OwnerFundedRegistryAuthorization,
  OwnerFundedRegistryAuthorizationState
>();

const MAX_AUTHORIZED_REGISTRY_TRANSACTIONS = 100;

export function createOwnerFundedRegistryAuthorization(input: {
  ownerId: string;
  runId: string;
  ownerAddress: `0x${string}`;
  privateKey: Hex;
  maxTransactions: number;
  maxGasFeeWei: bigint;
}): OwnerFundedRegistryAuthorization {
  if (!input.ownerId || !input.runId) {
    throw new Error("Owner-funded registry authorization requires an ownerId and runId");
  }
  if (
    !Number.isSafeInteger(input.maxTransactions) ||
    input.maxTransactions < 1 ||
    input.maxTransactions > MAX_AUTHORIZED_REGISTRY_TRANSACTIONS
  ) {
    throw new Error(
      `Owner-funded registry authorization maxTransactions must be between 1 and ${MAX_AUTHORIZED_REGISTRY_TRANSACTIONS}`,
    );
  }
  if (input.maxGasFeeWei <= 0n) {
    throw new Error("Owner-funded registry authorization maxGasFeeWei must be positive");
  }
  const account = privateKeyToAccount(input.privateKey);
  if (account.address.toLowerCase() !== input.ownerAddress.toLowerCase()) {
    throw new Error("Owner-funded registry signer does not match ownerAddress");
  }
  const authorization = Object.freeze({
    kind: "owner-funded-registry-gas" as const,
  });
  ownerFundedRegistryAuthorizations.set(authorization, {
    ownerId: input.ownerId,
    runId: input.runId,
    ownerAddress: account.address,
    privateKey: input.privateKey,
    remainingTransactions: input.maxTransactions,
    remainingGasFeeWei: input.maxGasFeeWei,
  });
  return authorization;
}

function requireOwnerFundedAuthorization(input: {
  authorization?: OwnerFundedRegistryAuthorization;
  ownerId?: string | null;
  runId: string;
}): OwnerFundedRegistryAuthorizationState {
  if (!input.authorization) {
    throw new Error(
      "registerIp live mode is disabled without explicit bounded owner-funded gas authorization",
    );
  }
  const state = ownerFundedRegistryAuthorizations.get(input.authorization);
  if (!state) {
    throw new Error("registerIp owner-funded gas authorization is invalid or forged");
  }
  if (!input.ownerId || state.ownerId !== input.ownerId || state.runId !== input.runId) {
    throw new Error("registerIp owner-funded gas authorization does not match this owner and run");
  }
  return state;
}

export function ownerFundedRegistryAddress(input: {
  authorization?: OwnerFundedRegistryAuthorization;
  ownerId?: string | null;
  runId: string;
}): `0x${string}` {
  return requireOwnerFundedAuthorization(input).ownerAddress;
}

export function ownerFundedRegistryAuthorizationRemaining(
  authorization: OwnerFundedRegistryAuthorization,
): Readonly<{ transactions: number; gasFeeWei: bigint }> | null {
  const state = ownerFundedRegistryAuthorizations.get(authorization);
  return state
    ? Object.freeze({
        transactions: state.remainingTransactions,
        gasFeeWei: state.remainingGasFeeWei,
      })
    : null;
}

function consumeOwnerFundedGasQuota(
  state: OwnerFundedRegistryAuthorizationState,
  maximumGasFeeWei: bigint,
): void {
  if (state.remainingTransactions < 1) {
    throw new Error("registerIp owner-funded transaction quota is exhausted");
  }
  if (maximumGasFeeWei > state.remainingGasFeeWei) {
    throw new Error(
      `registerIp maximum gas fee ${maximumGasFeeWei} wei exceeds remaining owner-funded quota ${state.remainingGasFeeWei} wei`,
    );
  }
  // Consume before the asynchronous wallet call. Failed or concurrent sends
  // never restore quota, so the authorization cannot overspend its bound.
  state.remainingTransactions -= 1;
  state.remainingGasFeeWei -= maximumGasFeeWei;
}

export function registryAddressFor(network: RegistryNetwork): `0x${string}` | null {
  const override = process.env.SUEDE_REGISTRY_ADDRESS;
  if (override && /^0x[0-9a-fA-F]{40}$/.test(override)) {
    return override as `0x${string}`;
  }
  // Only mainnet has a known deployment; sepolia requires the env override.
  return network === "base-mainnet" ? BASE_MAINNET_REGISTRY : null;
}

/**
 * Register `assetHash` on the SuedeRegistry, or recognize it as already
 * registered. Throws with a human-readable message on any hard failure —
 * the node executor turns that into an ok:false NodeResult.
 */
export async function registerWorkOnChain(input: {
  assetHash: Hex;
  metadata: string;
  network: RegistryNetwork;
  ownerId?: string | null;
  runId: string;
  authorization?: OwnerFundedRegistryAuthorization;
}): Promise<RegisterWorkResult> {
  const authorization = requireOwnerFundedAuthorization(input);
  const registryAddress = registryAddressFor(input.network);
  if (!registryAddress) {
    throw new Error(`No SuedeRegistry address for ${input.network}; set SUEDE_REGISTRY_ADDRESS`);
  }

  const chain = input.network === "base-sepolia" ? baseSepolia : base;
  const transport = http(process.env.BASE_RPC_URL);
  const account = privateKeyToAccount(authorization.privateKey);
  const publicClient = createPublicClient({ chain, transport });

  // Idempotency: an asset hash can only be registered once on-chain.
  // A re-run of the same flow output is a success that points at the
  // existing entry, not a revert surfaced to the flow author.
  const existing = await publicClient.readContract({
    address: registryAddress,
    abi: SUEDE_REGISTRY_ABI,
    functionName: "getEntry",
    args: [input.assetHash],
  });
  if (existing.exists) {
    return {
      txHash: "0x0" as Hex,
      tokenId: existing.tokenId.toString(),
      ipAccount: existing.ipAccount,
      registryAddress,
      network: input.network,
      alreadyRegistered: true,
      creator: existing.creator,
    };
  }

  // simulate first: surfaces reverts as readable errors and yields the
  // return values (tokenId, ipAccount) that a raw tx receipt doesn't carry.
  const { request, result } = await publicClient.simulateContract({
    address: registryAddress,
    abi: SUEDE_REGISTRY_ABI,
    functionName: "registerWork",
    args: [input.assetHash, input.metadata],
    account,
  });

  // Pin an explicit gas limit and EIP-1559 fee ceiling before signing. The
  // 20% estimate buffer is included in the charged maximum, not added after
  // authorization. writeContract therefore cannot spend beyond this bound.
  const estimatedGas = await publicClient.estimateContractGas(request);
  const gas = (estimatedGas * 120n + 99n) / 100n;
  const { maxFeePerGas, maxPriorityFeePerGas } = await publicClient.estimateFeesPerGas({
    type: "eip1559",
  });
  const maximumGasFeeWei = gas * maxFeePerGas;
  consumeOwnerFundedGasQuota(authorization, maximumGasFeeWei);

  const walletClient = createWalletClient({ account, chain, transport });
  const txHash = await walletClient.writeContract({
    address: registryAddress,
    abi: SUEDE_REGISTRY_ABI,
    functionName: "registerWork",
    args: [input.assetHash, input.metadata],
    account,
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    timeout: 60_000,
  });
  if (receipt.status !== "success") {
    throw new Error(`registerWork tx reverted: ${txHash}`);
  }

  const [tokenId, ipAccount] = result;
  return {
    txHash,
    tokenId: tokenId != null ? tokenId.toString() : null,
    ipAccount: ipAccount ?? null,
    registryAddress,
    network: input.network,
    alreadyRegistered: false,
    creator: account.address,
  };
}
