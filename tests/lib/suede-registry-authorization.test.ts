import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "0x1111111111111111111111111111111111111111" as const;
const PRIVATE_KEY = `0x${"22".repeat(32)}` as const;

const mocks = vi.hoisted(() => ({
  readContract: vi.fn(),
  simulateContract: vi.fn(),
  estimateContractGas: vi.fn(),
  estimateFeesPerGas: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
  writeContract: vi.fn(),
}));

vi.mock("viem", () => ({
  createPublicClient: vi.fn(() => ({
    readContract: mocks.readContract,
    simulateContract: mocks.simulateContract,
    estimateContractGas: mocks.estimateContractGas,
    estimateFeesPerGas: mocks.estimateFeesPerGas,
    waitForTransactionReceipt: mocks.waitForTransactionReceipt,
  })),
  createWalletClient: vi.fn(() => ({ writeContract: mocks.writeContract })),
  http: vi.fn(() => "mock-transport"),
}));

vi.mock("viem/accounts", () => ({
  privateKeyToAccount: vi.fn(() => ({ address: OWNER })),
}));

vi.mock("viem/chains", () => ({
  base: { id: 8453 },
  baseSepolia: { id: 84532 },
}));

import {
  createOwnerFundedRegistryAuthorization,
  ownerFundedRegistryAuthorizationRemaining,
  registerWorkOnChain,
} from "@/lib/registry/suede-registry";

function authorization(input: { transactions?: number; gasFeeWei?: bigint } = {}) {
  return createOwnerFundedRegistryAuthorization({
    ownerId: "sb:owner-1",
    runId: "run-1",
    ownerAddress: OWNER,
    privateKey: PRIVATE_KEY,
    maxTransactions: input.transactions ?? 1,
    maxGasFeeWei: input.gasFeeWei ?? 240n,
  });
}

function register(auth: ReturnType<typeof authorization>, overrides: Partial<{
  ownerId: string;
  runId: string;
}> = {}) {
  return registerWorkOnChain({
    assetHash: `0x${"ab".repeat(32)}`,
    metadata: "{}",
    network: "base-mainnet",
    ownerId: overrides.ownerId ?? "sb:owner-1",
    runId: overrides.runId ?? "run-1",
    authorization: auth,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readContract.mockResolvedValue({ exists: false });
  mocks.simulateContract.mockResolvedValue({
    request: { functionName: "registerWork" },
    result: [1n, OWNER],
  });
  mocks.estimateContractGas.mockResolvedValue(100n);
  mocks.estimateFeesPerGas.mockResolvedValue({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n });
  mocks.writeContract.mockResolvedValue(`0x${"cd".repeat(32)}`);
  mocks.waitForTransactionReceipt.mockResolvedValue({ status: "success" });
});

describe("owner-funded registerIp gas authorization", () => {
  it("binds the capability to one authenticated owner and run before any RPC", async () => {
    const auth = authorization();

    await expect(register(auth, { ownerId: "sb:attacker" })).rejects.toThrow(
      "does not match this owner and run",
    );
    await expect(register(auth, { runId: "another-run" })).rejects.toThrow(
      "does not match this owner and run",
    );
    expect(mocks.readContract).not.toHaveBeenCalled();
    expect(mocks.writeContract).not.toHaveBeenCalled();
  });

  it("rejects a gas estimate above the remaining wei budget before signing", async () => {
    const auth = authorization({ gasFeeWei: 239n });

    await expect(register(auth)).rejects.toThrow(
      "maximum gas fee 240 wei exceeds remaining owner-funded quota 239 wei",
    );
    expect(mocks.writeContract).not.toHaveBeenCalled();
    expect(ownerFundedRegistryAuthorizationRemaining(auth)).toEqual({
      transactions: 1,
      gasFeeWei: 239n,
    });
  });

  it("pins the signed transaction to the authorized maximum and consumes quota first", async () => {
    const auth = authorization({ transactions: 2, gasFeeWei: 480n });

    await expect(register(auth)).resolves.toMatchObject({ alreadyRegistered: false });
    expect(mocks.writeContract).toHaveBeenLastCalledWith(
      expect.objectContaining({ gas: 120n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }),
    );
    expect(ownerFundedRegistryAuthorizationRemaining(auth)).toEqual({
      transactions: 1,
      gasFeeWei: 240n,
    });

    await expect(register(auth)).resolves.toMatchObject({ alreadyRegistered: false });
    expect(ownerFundedRegistryAuthorizationRemaining(auth)).toEqual({
      transactions: 0,
      gasFeeWei: 0n,
    });
    await expect(register(auth)).rejects.toThrow("transaction quota is exhausted");
    expect(mocks.writeContract).toHaveBeenCalledTimes(2);
  });

  it("does not refund a reserved quota when the wallet call fails", async () => {
    const auth = authorization();
    mocks.writeContract.mockRejectedValueOnce(new Error("wallet rejected"));

    await expect(register(auth)).rejects.toThrow("wallet rejected");
    expect(ownerFundedRegistryAuthorizationRemaining(auth)).toEqual({
      transactions: 0,
      gasFeeWei: 0n,
    });
    await expect(register(auth)).rejects.toThrow("transaction quota is exhausted");
    expect(mocks.writeContract).toHaveBeenCalledTimes(1);
  });

  it("rejects unbounded or mismatched capabilities at creation", () => {
    expect(() => authorization({ transactions: 0 })).toThrow("maxTransactions");
    expect(() => authorization({ transactions: 101 })).toThrow("maxTransactions");
    expect(() => authorization({ gasFeeWei: 0n })).toThrow("maxGasFeeWei");
    expect(() =>
      createOwnerFundedRegistryAuthorization({
        ownerId: "sb:owner-1",
        runId: "run-1",
        ownerAddress: "0x2222222222222222222222222222222222222222",
        privateKey: PRIVATE_KEY,
        maxTransactions: 1,
        maxGasFeeWei: 1n,
      }),
    ).toThrow("signer does not match ownerAddress");
  });
});
