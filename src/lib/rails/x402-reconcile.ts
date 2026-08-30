import {
  createPublicClient,
  getAddress,
  http,
  parseAbiItem,
  type Address,
  type Hex,
} from "viem";
import { base } from "viem/chains";

const BASE_USDC_ADDRESS = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const READ_TIMEOUT_MS = 5_000;
const EXPIRY_GRACE_SECONDS = 300;
const DISCOVERY_BLOCK_WINDOW = 2_000n;
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const AUTHORIZATION_USED_TOPIC =
  "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
const AUTHORIZATION_CANCELED_TOPIC =
  "0x1cdd46ff242716cdaa72d159d339a485b3438398348d68f09d7c8c0a59353d81";
const AUTHORIZATION_USED_EVENT = parseAbiItem(
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
);

export interface X402ReceiptLog {
  readonly address: Address;
  readonly topics: readonly Hex[];
  readonly data: Hex;
}

export interface X402TransactionReceiptEvidence {
  readonly chainId: number;
  readonly transactionHash: Hex;
  readonly status: "success" | "reverted";
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly canonicalBlockHash: Hex;
  readonly finalizedBlockNumber: bigint;
  readonly logs: readonly X402ReceiptLog[];
}

export interface X402AuthorizationUsedLogEvidence extends X402ReceiptLog {
  readonly transactionHash: Hex | null;
  readonly blockNumber: bigint | null;
  readonly blockHash: Hex | null;
}

export interface X402AuthorizationUsedDiscoveryEvidence {
  readonly chainId: number;
  readonly finalizedBlockNumber: bigint;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly logs: readonly X402AuthorizationUsedLogEvidence[];
}

export interface X402AuthorizationUsedLogReadInput {
  readonly rpcUrl: string;
  readonly asset: Address;
  readonly payer: Address;
  readonly nonce: Hex;
  readonly fromBlock?: bigint;
  readonly toBlock?: bigint;
  readonly maxBlockRange: bigint;
  readonly timeoutMs: number;
}

export type X402AuthorizationUsedLogReader = (
  input: X402AuthorizationUsedLogReadInput,
) => Promise<X402AuthorizationUsedDiscoveryEvidence>;

export interface X402TransactionReceiptReadInput {
  readonly rpcUrl: string;
  readonly asset: Address;
  readonly payer: Address;
  readonly payTo: Address;
  readonly nonce: Hex;
  readonly amountAtomic: bigint;
  readonly transactionHash: Hex;
  readonly timeoutMs: number;
}

export type X402TransactionReceiptReader = (
  input: X402TransactionReceiptReadInput,
) => Promise<X402TransactionReceiptEvidence | null>;

export interface ReconcileX402AuthorizationStateInput {
  readonly rpcUrl: string;
  readonly asset: string;
  readonly payer: string;
  readonly payTo: string;
  readonly nonce: string;
  readonly amountAtomic: string;
  readonly transactionHash?: string;
  /** Optional inclusive finalized block range for a bounded historical lookup. */
  readonly discoveryFromBlock?: bigint;
  readonly discoveryToBlock?: bigint;
  /** Unix time in seconds. Defaults to the current clock. */
  readonly now?: number;
  /** Authorization expiry as Unix time in seconds. Without it, non-settlement remains pending. */
  readonly expiresAt?: number;
  /** Test and adapter seam. It must perform only the bounded receipt/finality reads. */
  readonly readTransactionReceipt?: X402TransactionReceiptReader;
  /** Test and adapter seam. It must perform only bounded finalized-log reads. */
  readonly readAuthorizationUsedLogs?: X402AuthorizationUsedLogReader;
}

export type X402AuthorizationReconciliationResult =
  | Readonly<{ status: "used"; definitive: true; transactionHash: Hex }>
  | Readonly<{ status: "unused"; definitive: false; reason: "pending" }>
  | Readonly<{ status: "unused"; definitive: true; reason: "expired" }>
  | Readonly<{
      status: "unavailable";
      definitive: false;
      reason:
        | "invalid_input"
        | "rpc_unavailable"
        | "transaction_not_found"
        | "transaction_ambiguous";
    }>;

const UNUSED_PENDING = Object.freeze({
  status: "unused",
  definitive: false,
  reason: "pending",
} as const);
const UNUSED_EXPIRED = Object.freeze({
  status: "unused",
  definitive: true,
  reason: "expired",
} as const);
const INVALID_INPUT = Object.freeze({
  status: "unavailable",
  definitive: false,
  reason: "invalid_input",
} as const);
const RPC_UNAVAILABLE = Object.freeze({
  status: "unavailable",
  definitive: false,
  reason: "rpc_unavailable",
} as const);

interface ValidatedInput {
  readonly rpcUrl: string;
  readonly asset: Address;
  readonly payer: Address;
  readonly payTo: Address;
  readonly nonce: Hex;
  readonly amountAtomic: bigint;
  readonly transactionHash?: Hex;
  readonly discoveryFromBlock?: bigint;
  readonly discoveryToBlock?: bigint;
  readonly now: number;
  readonly expiresAt?: number;
  readonly readTransactionReceipt: X402TransactionReceiptReader;
  readonly readAuthorizationUsedLogs: X402AuthorizationUsedLogReader;
}

function validRpcUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4_096 || value.includes("\0")) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "https:" || parsed.protocol === "http:")
      && Boolean(parsed.hostname)
      && !parsed.username
      && !parsed.password
      && !parsed.hash;
  } catch {
    return false;
  }
}

function exactAddress(value: unknown): Address | null {
  if (typeof value !== "string" || value.length > 42) return null;
  try {
    return getAddress(value);
  } catch {
    return null;
  }
}

function exactBytes32(value: unknown): Hex | null {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/u.test(value)
    ? value.toLowerCase() as Hex
    : null;
}

function exactAtomicAmount(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value) || value.length > 78) return null;
  try {
    const amount = BigInt(value);
    return amount > 0n && amount < 2n ** 256n ? amount : null;
  } catch {
    return null;
  }
}

function epochSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

async function readBaseTransactionReceipt(
  input: X402TransactionReceiptReadInput,
): Promise<X402TransactionReceiptEvidence | null> {
  const client = createPublicClient({
    chain: base,
    transport: http(input.rpcUrl, {
      retryCount: 0,
      timeout: input.timeoutMs,
    }),
  });
  const chainId = await client.getChainId();
  if (chainId !== base.id) throw new Error("unexpected_chain");
  const receipt = await client.getTransactionReceipt({ hash: input.transactionHash });
  const [finalizedBlock, canonicalBlock] = await Promise.all([
    client.getBlock({ blockTag: "finalized" }),
    client.getBlock({ blockNumber: receipt.blockNumber }),
  ]);
  if (finalizedBlock.number === null || canonicalBlock.hash === null) {
    throw new Error("incomplete_block_evidence");
  }
  return {
    chainId,
    transactionHash: receipt.transactionHash,
    status: receipt.status,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    canonicalBlockHash: canonicalBlock.hash,
    finalizedBlockNumber: finalizedBlock.number,
    logs: receipt.logs.map((log) => ({
      address: log.address,
      topics: log.topics,
      data: log.data,
    })),
  };
}

async function readBaseAuthorizationUsedLogs(
  input: X402AuthorizationUsedLogReadInput,
): Promise<X402AuthorizationUsedDiscoveryEvidence> {
  const client = createPublicClient({
    chain: base,
    transport: http(input.rpcUrl, {
      retryCount: 0,
      timeout: input.timeoutMs,
    }),
  });
  const chainId = await client.getChainId();
  if (chainId !== base.id) throw new Error("unexpected_chain");
  const finalizedBlock = await client.getBlock({ blockTag: "finalized" });
  if (finalizedBlock.number === null) throw new Error("missing_finalized_block");
  const toBlock = input.toBlock ?? finalizedBlock.number;
  const fromBlock = input.fromBlock ?? (
    toBlock >= input.maxBlockRange - 1n ? toBlock - input.maxBlockRange + 1n : 0n
  );
  if (
    fromBlock < 0n
    || toBlock < fromBlock
    || toBlock > finalizedBlock.number
    || toBlock - fromBlock + 1n > input.maxBlockRange
  ) throw new Error("invalid_log_range");
  const logs = await client.getLogs({
    address: input.asset,
    event: AUTHORIZATION_USED_EVENT,
    args: { authorizer: input.payer, nonce: input.nonce },
    strict: true,
    fromBlock,
    toBlock,
  });
  return {
    chainId,
    finalizedBlockNumber: finalizedBlock.number,
    fromBlock,
    toBlock,
    logs: logs.map((log) => ({
      address: log.address,
      topics: log.topics,
      data: log.data,
      transactionHash: log.transactionHash,
      blockNumber: log.blockNumber,
      blockHash: log.blockHash,
    })),
  };
}

function validateInput(input: unknown): ValidatedInput | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const candidate = input as Partial<ReconcileX402AuthorizationStateInput>;
  if (!validRpcUrl(candidate.rpcUrl)) return null;
  const asset = exactAddress(candidate.asset);
  const payer = exactAddress(candidate.payer);
  const payTo = exactAddress(candidate.payTo);
  const nonce = exactBytes32(candidate.nonce);
  const transactionHash = candidate.transactionHash === undefined
    ? undefined
    : exactBytes32(candidate.transactionHash);
  const amountAtomic = exactAtomicAmount(candidate.amountAtomic);
  const now = candidate.now ?? Math.floor(Date.now() / 1_000);
  const hasDiscoveryFromBlock = candidate.discoveryFromBlock !== undefined;
  const hasDiscoveryToBlock = candidate.discoveryToBlock !== undefined;
  const validDiscoveryRange = hasDiscoveryFromBlock === hasDiscoveryToBlock
    && (!hasDiscoveryFromBlock || (
      typeof candidate.discoveryFromBlock === "bigint"
      && typeof candidate.discoveryToBlock === "bigint"
      && candidate.discoveryFromBlock >= 0n
      && candidate.discoveryToBlock >= candidate.discoveryFromBlock
      && candidate.discoveryToBlock - candidate.discoveryFromBlock + 1n
        <= DISCOVERY_BLOCK_WINDOW
    ));
  if (
    !asset
    || asset !== BASE_USDC_ADDRESS
    || !payer
    || payer.toLowerCase() === ZERO_ADDRESS
    || !payTo
    || payTo.toLowerCase() === ZERO_ADDRESS
    || !nonce
    || candidate.transactionHash !== undefined && !transactionHash
    || amountAtomic === null
    || !epochSeconds(now)
    || !validDiscoveryRange
    || candidate.expiresAt !== undefined && !epochSeconds(candidate.expiresAt)
    || candidate.readTransactionReceipt !== undefined
      && typeof candidate.readTransactionReceipt !== "function"
    || candidate.readAuthorizationUsedLogs !== undefined
      && typeof candidate.readAuthorizationUsedLogs !== "function"
  ) return null;
  return {
    rpcUrl: candidate.rpcUrl,
    asset,
    payer,
    payTo,
    nonce,
    amountAtomic,
    ...(transactionHash ? { transactionHash } : {}),
    ...(candidate.discoveryFromBlock === undefined
      ? {}
      : {
          discoveryFromBlock: candidate.discoveryFromBlock,
          discoveryToBlock: candidate.discoveryToBlock,
        }),
    now,
    ...(candidate.expiresAt === undefined ? {} : { expiresAt: candidate.expiresAt }),
    readTransactionReceipt: candidate.readTransactionReceipt ?? readBaseTransactionReceipt,
    readAuthorizationUsedLogs:
      candidate.readAuthorizationUsedLogs ?? readBaseAuthorizationUsedLogs,
  };
}

async function boundedReceiptRead(
  input: ValidatedInput,
  transactionHash: Hex,
): Promise<X402TransactionReceiptEvidence | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      input.readTransactionReceipt({
        rpcUrl: input.rpcUrl,
        asset: input.asset,
        payer: input.payer,
        payTo: input.payTo,
        nonce: input.nonce,
        amountAtomic: input.amountAtomic,
        transactionHash,
        timeoutMs: READ_TIMEOUT_MS,
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("transaction_receipt_timeout")), READ_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function exactTopicAddress(value: unknown, expected: Address): boolean {
  return typeof value === "string"
    && /^0x[0-9a-fA-F]{64}$/u.test(value)
    && value.slice(2, 26) === "0".repeat(24)
    && value.slice(26).toLowerCase() === expected.slice(2).toLowerCase();
}

function exactTopicBytes32(value: unknown, expected: Hex): boolean {
  return typeof value === "string"
    && /^0x[0-9a-fA-F]{64}$/u.test(value)
    && value.toLowerCase() === expected.toLowerCase();
}

function exactUint256Data(value: unknown, expected: bigint): boolean {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/u.test(value)) return false;
  try {
    return BigInt(value) === expected;
  } catch {
    return false;
  }
}

function isCanonicalLog(log: X402ReceiptLog, asset: Address): boolean {
  return log.address.toLowerCase() === asset.toLowerCase();
}

function hasExactTransfer(evidence: X402TransactionReceiptEvidence, input: ValidatedInput): boolean {
  return evidence.logs.some((log) =>
    isCanonicalLog(log, input.asset)
    && log.topics.length === 3
    && log.topics[0]?.toLowerCase() === TRANSFER_TOPIC
    && exactTopicAddress(log.topics[1], input.payer)
    && exactTopicAddress(log.topics[2], input.payTo)
    && exactUint256Data(log.data, input.amountAtomic));
}

function hasExactAuthorizationUsed(
  evidence: X402TransactionReceiptEvidence,
  input: ValidatedInput,
): boolean {
  return evidence.logs.some((log) => isExactAuthorizationUsedLog(log, input));
}

function isExactAuthorizationUsedLog(
  log: X402ReceiptLog,
  input: ValidatedInput,
): boolean {
  return (
    isCanonicalLog(log, input.asset)
    && log.topics.length === 3
    && log.topics[0]?.toLowerCase() === AUTHORIZATION_USED_TOPIC
    && exactTopicAddress(log.topics[1], input.payer)
    && exactTopicBytes32(log.topics[2], input.nonce)
    && log.data === "0x"
  );
}

function receiptIdentityIsAuthoritative(
  evidence: X402TransactionReceiptEvidence,
  transactionHash: Hex,
): boolean {
  return evidence.chainId === base.id
    && exactTopicBytes32(evidence.transactionHash, transactionHash)
    && /^0x[0-9a-fA-F]{64}$/u.test(evidence.blockHash)
    && /^0x[0-9a-fA-F]{64}$/u.test(evidence.canonicalBlockHash)
    && evidence.blockHash.toLowerCase() === evidence.canonicalBlockHash.toLowerCase()
    && evidence.blockNumber >= 0n
    && evidence.finalizedBlockNumber >= 0n;
}

interface DiscoveredTransaction {
  readonly transactionHash: Hex;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
}

type DiscoveryResolution =
  | Readonly<{ status: "candidate"; transaction: DiscoveredTransaction }>
  | Readonly<{ status: "not_found" | "ambiguous" | "unavailable" }>;

function discoveryRangeIsAuthoritative(
  evidence: X402AuthorizationUsedDiscoveryEvidence,
  input: ValidatedInput,
): boolean {
  if (
    evidence.chainId !== base.id
    || typeof evidence.finalizedBlockNumber !== "bigint"
    || typeof evidence.fromBlock !== "bigint"
    || typeof evidence.toBlock !== "bigint"
    || evidence.finalizedBlockNumber < 0n
    || evidence.fromBlock < 0n
    || evidence.toBlock < evidence.fromBlock
    || evidence.toBlock > evidence.finalizedBlockNumber
    || evidence.toBlock - evidence.fromBlock + 1n > DISCOVERY_BLOCK_WINDOW
  ) return false;
  if (input.discoveryFromBlock !== undefined && input.discoveryToBlock !== undefined) {
    return evidence.fromBlock === input.discoveryFromBlock
      && evidence.toBlock === input.discoveryToBlock;
  }
  const expectedToBlock = evidence.finalizedBlockNumber;
  const expectedFromBlock = expectedToBlock >= DISCOVERY_BLOCK_WINDOW - 1n
    ? expectedToBlock - DISCOVERY_BLOCK_WINDOW + 1n
    : 0n;
  return evidence.fromBlock === expectedFromBlock && evidence.toBlock === expectedToBlock;
}

function isExactAuthorizationCanceledLog(
  log: X402ReceiptLog,
  input: ValidatedInput,
): boolean {
  return isCanonicalLog(log, input.asset)
    && log.topics.length === 3
    && log.topics[0]?.toLowerCase() === AUTHORIZATION_CANCELED_TOPIC
    && exactTopicAddress(log.topics[1], input.payer)
    && exactTopicBytes32(log.topics[2], input.nonce)
    && log.data === "0x";
}

function resolveDiscoveredTransaction(
  evidence: X402AuthorizationUsedDiscoveryEvidence,
  input: ValidatedInput,
): DiscoveryResolution {
  if (!discoveryRangeIsAuthoritative(evidence, input) || !Array.isArray(evidence.logs)) {
    return { status: "unavailable" };
  }
  const matching = evidence.logs.filter((log) => isExactAuthorizationUsedLog(log, input));
  if (matching.length === 0) return { status: "not_found" };
  if (
    matching.length > 1
    || evidence.logs.some((log) => isExactAuthorizationCanceledLog(log, input))
  ) return { status: "ambiguous" };
  const [log] = matching;
  if (
    !log
    || typeof log.blockNumber !== "bigint"
    || log.blockNumber < evidence.fromBlock
    || log.blockNumber > evidence.toBlock
  ) return { status: "unavailable" };
  const transactionHash = exactBytes32(log.transactionHash);
  const blockHash = exactBytes32(log.blockHash);
  if (!transactionHash || !blockHash) return { status: "unavailable" };
  return {
    status: "candidate",
    transaction: { transactionHash, blockNumber: log.blockNumber, blockHash },
  };
}

async function boundedDiscoveryRead(
  input: ValidatedInput,
): Promise<X402AuthorizationUsedDiscoveryEvidence | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      input.readAuthorizationUsedLogs({
        rpcUrl: input.rpcUrl,
        asset: input.asset,
        payer: input.payer,
        nonce: input.nonce,
        ...(input.discoveryFromBlock === undefined
          ? {}
          : {
              fromBlock: input.discoveryFromBlock,
              toBlock: input.discoveryToBlock,
            }),
        maxBlockRange: DISCOVERY_BLOCK_WINDOW,
        timeoutMs: READ_TIMEOUT_MS,
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("authorization_log_timeout")), READ_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function definitivelyExpired(input: ValidatedInput): boolean {
  return input.expiresAt !== undefined
    && input.now >= input.expiresAt
    && input.now - input.expiresAt >= EXPIRY_GRACE_SECONDS;
}

async function reconcileValidatedInput(
  validated: ValidatedInput,
): Promise<X402AuthorizationReconciliationResult> {
  let transactionHash = validated.transactionHash;
  let discovered: DiscoveredTransaction | null = null;
  if (!transactionHash) {
    const discovery = await boundedDiscoveryRead(validated);
    if (!discovery) {
      return {
        status: "unavailable",
        definitive: false,
        reason: "transaction_not_found",
      };
    }
    const resolution = resolveDiscoveredTransaction(discovery, validated);
    if (resolution.status !== "candidate") {
      return {
        status: "unavailable",
        definitive: false,
        reason: resolution.status === "ambiguous"
          ? "transaction_ambiguous"
          : resolution.status === "not_found"
            ? "transaction_not_found"
            : "rpc_unavailable",
      };
    }
    discovered = resolution.transaction;
    transactionHash = discovered.transactionHash;
  }
  const evidence = await boundedReceiptRead(validated, transactionHash);
  if (!evidence) return RPC_UNAVAILABLE;
  if (!receiptIdentityIsAuthoritative(evidence, transactionHash)) return RPC_UNAVAILABLE;
  if (
    discovered
    && (
      evidence.blockNumber !== discovered.blockNumber
      || evidence.blockHash.toLowerCase() !== discovered.blockHash.toLowerCase()
    )
  ) return RPC_UNAVAILABLE;
  if (evidence.finalizedBlockNumber < evidence.blockNumber) return UNUSED_PENDING;
  if (
    evidence.status === "success"
    && hasExactTransfer(evidence, validated)
    && hasExactAuthorizationUsed(evidence, validated)
  ) {
    return {
      status: "used",
      definitive: true,
      transactionHash,
    };
  }
  return definitivelyExpired(validated) ? UNUSED_EXPIRED : UNUSED_PENDING;
}

/**
 * Prove a Base USDC EIP-3009 settlement from one exact finalized transaction,
 * discovering that transaction from a bounded finalized-log range when needed.
 * A consumed/canceled nonce alone is never payment evidence. This function only
 * reads chain state; it never settles, broadcasts, retries, or logs inputs.
 */
export async function reconcileX402AuthorizationState(
  input: ReconcileX402AuthorizationStateInput,
): Promise<X402AuthorizationReconciliationResult> {
  const validated = validateInput(input);
  if (!validated) return INVALID_INPUT;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reconcileValidatedInput(validated),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("reconciliation_timeout")), READ_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return RPC_UNAVAILABLE;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
