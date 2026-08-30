import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";

import { reconcileX402AuthorizationState } from "@/lib/rails/x402-reconcile";

const viem = vi.hoisted(() => ({
  createPublicClient: vi.fn(),
  getBlock: vi.fn(),
  getChainId: vi.fn(),
  getLogs: vi.fn(),
  getTransactionReceipt: vi.fn(),
  http: vi.fn(),
}));

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: (...args: unknown[]) => viem.createPublicClient(...args),
    http: (...args: unknown[]) => viem.http(...args),
  };
});

const RPC_URL = "https://base-rpc.example/v1?key=must-not-leak";
const ASSET = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const PAYER = "0x1111111111111111111111111111111111111111";
const PAY_TO = "0x2222222222222222222222222222222222222222";
const NONCE = `0x${"ab".repeat(32)}`;
const TRANSACTION_HASH = `0x${"cd".repeat(32)}`;
const BLOCK_HASH = `0x${"ef".repeat(32)}`;
const OTHER_BLOCK_HASH = `0x${"12".repeat(32)}`;
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const AUTHORIZATION_USED_TOPIC =
  "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
const AUTHORIZATION_CANCELED_TOPIC =
  "0x1cdd46ff242716cdaa72d159d339a485b3438398348d68f09d7c8c0a59353d81";

function addressTopic(address: string): `0x${string}` {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}

function uint256Data(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function input(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    rpcUrl: RPC_URL,
    asset: ASSET,
    payer: PAYER,
    payTo: PAY_TO,
    nonce: NONCE,
    amountAtomic: "250000",
    transactionHash: TRANSACTION_HASH,
    now: 1_787_000_000,
    expiresAt: 1_787_000_300,
    ...overrides,
  };
}

function transferLog(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    address: getAddress(ASSET),
    topics: [TRANSFER_TOPIC, addressTopic(PAYER), addressTopic(PAY_TO)],
    data: uint256Data(250_000n),
    ...overrides,
  };
}

function authorizationUsedLog(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    address: getAddress(ASSET),
    topics: [AUTHORIZATION_USED_TOPIC, addressTopic(PAYER), NONCE],
    data: "0x",
    ...overrides,
  };
}

function authorizationUsedDiscoveryLog(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    ...authorizationUsedLog(),
    transactionHash: TRANSACTION_HASH,
    blockNumber: 100n,
    blockHash: BLOCK_HASH,
    ...overrides,
  };
}

function authorizationCanceledDiscoveryLog(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    address: getAddress(ASSET),
    topics: [AUTHORIZATION_CANCELED_TOPIC, addressTopic(PAYER), NONCE],
    data: "0x",
    transactionHash: `0x${"34".repeat(32)}`,
    blockNumber: 101n,
    blockHash: OTHER_BLOCK_HASH,
    ...overrides,
  };
}

function discoveryEvidence(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    chainId: 8453,
    finalizedBlockNumber: 2_099n,
    fromBlock: 100n,
    toBlock: 2_099n,
    logs: [authorizationUsedDiscoveryLog()],
    ...overrides,
  };
}

function receiptEvidence(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    chainId: 8453,
    transactionHash: TRANSACTION_HASH,
    status: "success" as const,
    blockNumber: 100n,
    blockHash: BLOCK_HASH,
    canonicalBlockHash: BLOCK_HASH,
    finalizedBlockNumber: 101n,
    logs: [transferLog(), authorizationUsedLog()],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  viem.http.mockReturnValue({ type: "http" });
  viem.getChainId.mockResolvedValue(8453);
  viem.getLogs.mockResolvedValue([authorizationUsedDiscoveryLog()]);
  viem.getTransactionReceipt.mockResolvedValue({
    transactionHash: TRANSACTION_HASH,
    status: "success",
    blockNumber: 100n,
    blockHash: BLOCK_HASH,
    logs: [transferLog(), authorizationUsedLog()],
  });
  viem.getBlock.mockImplementation(async (request: { blockTag?: string }) =>
    request.blockTag === "finalized"
      ? { number: 101n, hash: OTHER_BLOCK_HASH }
      : { number: 100n, hash: BLOCK_HASH });
  viem.createPublicClient.mockReturnValue({
    getBlock: viem.getBlock,
    getChainId: viem.getChainId,
    getLogs: viem.getLogs,
    getTransactionReceipt: viem.getTransactionReceipt,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("authoritative Base EIP-3009 reconciliation", () => {
  it("returns used only for the expected finalized Base transaction with exact USDC transfer and nonce logs", async () => {
    const result = await reconcileX402AuthorizationState(input());

    expect(result).toEqual({
      status: "used",
      definitive: true,
      transactionHash: TRANSACTION_HASH,
    });
    expect(viem.http).toHaveBeenCalledWith(RPC_URL, {
      retryCount: 0,
      timeout: 5_000,
    });
    expect(viem.createPublicClient).toHaveBeenCalledWith(expect.objectContaining({
      chain: expect.objectContaining({ id: 8453 }),
      transport: { type: "http" },
    }));
    expect(viem.getChainId).toHaveBeenCalledOnce();
    expect(viem.getTransactionReceipt).toHaveBeenCalledWith({ hash: TRANSACTION_HASH });
    expect(viem.getBlock).toHaveBeenCalledWith({ blockTag: "finalized" });
    expect(viem.getBlock).toHaveBeenCalledWith({ blockNumber: 100n });
  });

  it("discovers one finalized exact AuthorizationUsed transaction when its hash is absent and proves its receipt", async () => {
    const result = await reconcileX402AuthorizationState(input({
      transactionHash: undefined,
      readAuthorizationUsedLogs: async () => discoveryEvidence(),
      readTransactionReceipt: async () => receiptEvidence(),
    }));

    expect(result).toEqual({
      status: "used",
      definitive: true,
      transactionHash: TRANSACTION_HASH,
    });
  });

  it("uses the bounded no-retry Base RPC log reader when a transaction hash is absent", async () => {
    const result = await reconcileX402AuthorizationState(input({ transactionHash: undefined }));

    expect(result).toEqual({
      status: "used",
      definitive: true,
      transactionHash: TRANSACTION_HASH,
    });
    expect(viem.http).toHaveBeenNthCalledWith(1, RPC_URL, {
      retryCount: 0,
      timeout: 5_000,
    });
    expect(viem.getLogs).toHaveBeenCalledWith(expect.objectContaining({
      address: getAddress(ASSET),
      args: { authorizer: getAddress(PAYER), nonce: NONCE },
      fromBlock: 0n,
      strict: true,
      toBlock: 101n,
    }));
  });

  it("treats conflicting AuthorizationUsed and AuthorizationCanceled discovery logs as ambiguous", async () => {
    const result = await reconcileX402AuthorizationState(input({
      transactionHash: undefined,
      readAuthorizationUsedLogs: async () => discoveryEvidence({
        logs: [authorizationUsedDiscoveryLog(), authorizationCanceledDiscoveryLog()],
      }),
      readTransactionReceipt: async () => receiptEvidence(),
    }));

    expect(result).toEqual({
      status: "unavailable",
      definitive: false,
      reason: "transaction_ambiguous",
    });
  });

  it("treats multiple exact AuthorizationUsed transaction candidates as ambiguous", async () => {
    const result = await reconcileX402AuthorizationState(input({
      transactionHash: undefined,
      readAuthorizationUsedLogs: async () => discoveryEvidence({
        logs: [
          authorizationUsedDiscoveryLog(),
          authorizationUsedDiscoveryLog({
            transactionHash: `0x${"56".repeat(32)}`,
            blockNumber: 102n,
            blockHash: `0x${"78".repeat(32)}`,
          }),
        ],
      }),
      readTransactionReceipt: async () => receiptEvidence(),
    }));

    expect(result).toEqual({
      status: "unavailable",
      definitive: false,
      reason: "transaction_ambiguous",
    });
  });

  it("does not treat a matching AuthorizationCanceled log without AuthorizationUsed as payment", async () => {
    const result = await reconcileX402AuthorizationState(input({
      transactionHash: undefined,
      readAuthorizationUsedLogs: async () => discoveryEvidence({
        logs: [authorizationCanceledDiscoveryLog()],
      }),
      readTransactionReceipt: async () => receiptEvidence(),
    }));

    expect(result).toEqual({
      status: "unavailable",
      definitive: false,
      reason: "transaction_not_found",
    });
  });

  it("does not accept the same nonce used by a different payer", async () => {
    const result = await reconcileX402AuthorizationState(input({
      transactionHash: undefined,
      readAuthorizationUsedLogs: async () => discoveryEvidence({
        logs: [authorizationUsedDiscoveryLog({
          topics: [AUTHORIZATION_USED_TOPIC, addressTopic(PAY_TO), NONCE],
        })],
      }),
      readTransactionReceipt: async () => receiptEvidence(),
    }));

    expect(result).toEqual({
      status: "unavailable",
      definitive: false,
      reason: "transaction_not_found",
    });
  });

  it("does not settle a discovered transaction whose receipt transfers the wrong amount", async () => {
    const result = await reconcileX402AuthorizationState(input({
      transactionHash: undefined,
      readAuthorizationUsedLogs: async () => discoveryEvidence(),
      readTransactionReceipt: async () => receiptEvidence({
        logs: [transferLog({ data: uint256Data(249_999n) }), authorizationUsedLog()],
      }),
    }));

    expect(result).toEqual({ status: "unused", definitive: false, reason: "pending" });
  });

  it("rejects a requested discovery range larger than the bounded window", async () => {
    const result = await reconcileX402AuthorizationState(input({
      transactionHash: undefined,
      discoveryFromBlock: 0n,
      discoveryToBlock: 2_000n,
      readAuthorizationUsedLogs: async () => discoveryEvidence(),
      readTransactionReceipt: async () => receiptEvidence(),
    }));

    expect(result).toEqual({
      status: "unavailable",
      definitive: false,
      reason: "invalid_input",
    });
  });

  it("rejects log evidence outside the exact requested historical range", async () => {
    const result = await reconcileX402AuthorizationState(input({
      transactionHash: undefined,
      discoveryFromBlock: 100n,
      discoveryToBlock: 200n,
      readAuthorizationUsedLogs: async () => discoveryEvidence({
        finalizedBlockNumber: 500n,
        fromBlock: 99n,
        toBlock: 200n,
      }),
      readTransactionReceipt: async () => receiptEvidence(),
    }));

    expect(result).toEqual({
      status: "unavailable",
      definitive: false,
      reason: "rpc_unavailable",
    });
  });

  it("returns unavailable without logging when the discovery RPC fails", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await reconcileX402AuthorizationState(input({
      transactionHash: undefined,
      readAuthorizationUsedLogs: async () => {
        throw new Error(`RPC failed for ${RPC_URL} and ${NONCE}`);
      },
      readTransactionReceipt: async () => receiptEvidence(),
    }));

    expect(result).toEqual({
      status: "unavailable",
      definitive: false,
      reason: "rpc_unavailable",
    });
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("bounds discovery plus receipt proof to one reconciliation timeout", async () => {
    vi.useFakeTimers();
    const resolved = vi.fn();
    const result = reconcileX402AuthorizationState(input({
      transactionHash: undefined,
      readAuthorizationUsedLogs: () => new Promise((resolve) => {
        setTimeout(() => resolve(discoveryEvidence()), 4_000);
      }),
      readTransactionReceipt: () => new Promise(() => undefined),
    }));
    void result.then(resolved);

    await vi.advanceTimersByTimeAsync(5_001);

    expect(resolved).toHaveBeenCalledWith({
      status: "unavailable",
      definitive: false,
      reason: "rpc_unavailable",
    });
  });

  it("does not treat a finalized cancellation as settlement", async () => {
    const cancellation = {
      address: getAddress(ASSET),
      topics: [AUTHORIZATION_CANCELED_TOPIC, addressTopic(PAYER), NONCE],
      data: "0x",
    };

    const result = await reconcileX402AuthorizationState(input({
      readTransactionReceipt: async () => receiptEvidence({ logs: [cancellation] }),
    }));

    expect(result).toEqual({ status: "unused", definitive: false, reason: "pending" });
  });

  it.each([
    ["receipt success", { status: "reverted" }],
    ["USDC contract", { logs: [transferLog({ address: getAddress(PAY_TO) }), authorizationUsedLog()] }],
    ["payer", { logs: [transferLog({ topics: [TRANSFER_TOPIC, addressTopic(PAY_TO), addressTopic(PAY_TO)] }), authorizationUsedLog()] }],
    ["payee", { logs: [transferLog({ topics: [TRANSFER_TOPIC, addressTopic(PAYER), addressTopic(PAYER)] }), authorizationUsedLog()] }],
    ["amount", { logs: [transferLog({ data: uint256Data(249_999n) }), authorizationUsedLog()] }],
    ["nonce", { logs: [transferLog(), authorizationUsedLog({ topics: [AUTHORIZATION_USED_TOPIC, addressTopic(PAYER), `0x${"ff".repeat(32)}`] })] }],
  ])("does not settle a receipt with mismatched %s evidence", async (_name, receiptOverrides) => {
    const result = await reconcileX402AuthorizationState(input({
      readTransactionReceipt: async () => receiptEvidence(receiptOverrides),
    }));

    expect(result).not.toEqual({ status: "used", definitive: true });
    expect(result).toEqual({ status: "unused", definitive: false, reason: "pending" });
  });

  it.each([
    ["transaction hash", { transactionHash: `0x${"34".repeat(32)}` }],
    ["chain", { chainId: 1 }],
  ])("treats mismatched %s identity as unavailable instead of settled", async (_name, receiptOverrides) => {
    const result = await reconcileX402AuthorizationState(input({
      readTransactionReceipt: async () => receiptEvidence(receiptOverrides),
    }));

    expect(result).toEqual({
      status: "unavailable",
      definitive: false,
      reason: "rpc_unavailable",
    });
  });

  it("keeps a successful but insufficiently finalized receipt pending", async () => {
    const result = await reconcileX402AuthorizationState(input({
      readTransactionReceipt: async () => receiptEvidence({ finalizedBlockNumber: 99n }),
    }));

    expect(result).toEqual({ status: "unused", definitive: false, reason: "pending" });
  });

  it("treats a canonical block-hash mismatch as unavailable reorg evidence", async () => {
    const result = await reconcileX402AuthorizationState(input({
      readTransactionReceipt: async () => receiptEvidence({ canonicalBlockHash: OTHER_BLOCK_HASH }),
    }));

    expect(result).toEqual({
      status: "unavailable",
      definitive: false,
      reason: "rpc_unavailable",
    });
  });

  it("keeps a missing transaction receipt pending instead of inferring from nonce state", async () => {
    const result = await reconcileX402AuthorizationState(input({
      readTransactionReceipt: async () => null,
    }));

    expect(result).toEqual({
      status: "unavailable",
      definitive: false,
      reason: "rpc_unavailable",
    });
  });

  it("returns definitively unused only after expiry plus the conservative grace", async () => {
    const result = await reconcileX402AuthorizationState(input({
      now: 1_787_001_000,
      expiresAt: 1_787_000_300,
      readTransactionReceipt: async () => receiptEvidence({ status: "reverted" }),
    }));

    expect(result).toEqual({ status: "unused", definitive: true, reason: "expired" });
  });

  it("returns unavailable without leaking or logging RPC failures", async () => {
    const secret = "must-not-leak";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await reconcileX402AuthorizationState(input({
      readTransactionReceipt: async () => {
        throw new Error(`RPC ${RPC_URL} rejected secret ${secret}`);
      },
    }));

    expect(result).toEqual({
      status: "unavailable",
      definitive: false,
      reason: "rpc_unavailable",
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(RPC_URL);
    expect(JSON.stringify(result)).not.toContain(NONCE);
    expect(JSON.stringify(result)).not.toContain(TRANSACTION_HASH);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it.each([
    ["non-HTTP RPC URL", { rpcUrl: "file:///tmp/base.sock" }],
    ["non-USDC asset", { asset: "0x3333333333333333333333333333333333333333" }],
    ["malformed payer", { payer: "not-an-address" }],
    ["zero payee", { payTo: "0x0000000000000000000000000000000000000000" }],
    ["non-bytes32 nonce", { nonce: "0x1234" }],
    ["non-bytes32 transaction hash", { transactionHash: "0x1234" }],
    ["non-canonical atomic amount", { amountAtomic: "0250000" }],
    ["zero atomic amount", { amountAtomic: "0" }],
    ["invalid now", { now: Number.NaN }],
    ["invalid expiry", { expiresAt: -1 }],
  ])("rejects %s without reading the chain", async (_name, overrides) => {
    const readTransactionReceipt = vi.fn(async () => receiptEvidence());

    const result = await reconcileX402AuthorizationState(input({
      ...overrides,
      readTransactionReceipt,
    }));

    expect(result).toEqual({
      status: "unavailable",
      definitive: false,
      reason: "invalid_input",
    });
    expect(readTransactionReceipt).not.toHaveBeenCalled();
  });

  it("returns invalid input rather than throwing for a non-object invocation", async () => {
    await expect(reconcileX402AuthorizationState(null as never)).resolves.toEqual({
      status: "unavailable",
      definitive: false,
      reason: "invalid_input",
    });
  });

  it("bounds an injected receipt read that never resolves", async () => {
    vi.useFakeTimers();
    const result = reconcileX402AuthorizationState(input({
      readTransactionReceipt: () => new Promise(() => undefined),
    }));

    await vi.advanceTimersByTimeAsync(5_001);

    await expect(result).resolves.toEqual({
      status: "unavailable",
      definitive: false,
      reason: "rpc_unavailable",
    });
  });
});
