/**
 * x402 client — ported from
 * Suede-AI-App/integrations/elizaos-plugin-suede/src/x402-client.ts
 * and extended with a dry-run mode so the Studio runs without spending USDC.
 *
 * Live mode signs an EIP-3009 transferWithAuthorization for the x402 challenge
 * and replays the request with a payment header. Speaks x402-v2 by default
 * (PAYMENT-SIGNATURE header, `amount` field, CAIP-2 network) but still
 * understands a legacy v1 challenge (X-PAYMENT header, `maxAmountRequired`)
 * from an endpoint that hasn't migrated yet. Dry-run mode skips network
 * settlement entirely and returns a synthetic, clearly-marked result.
 */
import {
  createWalletClient,
  http,
  type Account,
  type Hex,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";

export type X402Network = "base-mainnet" | "base-sepolia";

export interface X402ClientConfig {
  /** Defaults to https://api.suedeai.xyz (the paid endpoint surface). */
  serviceUrl?: string;
  /** Required for live settlement. Omit in dry-run. */
  privateKey?: Hex;
  network?: X402Network;
  rpcUrl?: string;
  /** Trusted recipient for every live authorization. Live mode fails closed without it. */
  expectedPayTo?: Hex;
  /** Trusted USDC contract. Base mainnet defaults to the canonical Circle deployment. */
  expectedAsset?: Hex;
  /** Defaults to true unless explicitly set false (env X402_SKIP_SETTLEMENT). */
  dryRun?: boolean;
}

export interface X402Result<T = unknown> {
  data: T;
  settled: boolean;
  dryRun: boolean;
  costUsdc: number;
}

export interface X402CallOptions {
  method?: "GET" | "POST";
  /** Catalog price; charged to the ledger only when actually settled. */
  priceUsdc?: number;
}

interface X402ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
}

interface PaymentRequirement {
  scheme: string;
  network: string;
  /** x402-v2 atomic-unit integer string (e.g. "100000" = $0.10 USDC). */
  amount?: string;
  /** Legacy x402-v1 atomic-unit field, read when the challenge is v1. */
  maxAmountRequired?: string;
  /** Legacy x402-v1 resource location; v2 carries this at the challenge's top level instead. */
  resource?: string;
  asset: Hex;
  payTo: Hex;
  maxTimeoutSeconds?: number;
  extra?: { name?: string; version?: string };
}

interface X402Challenge {
  x402Version?: number;
  error?: string;
  resource?: X402ResourceInfo | string;
  accepts?: PaymentRequirement[];
  extensions?: Record<string, unknown>;
}

const BASE_MAINNET_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const MAX_AUTHORIZATION_WINDOW_SECONDS = 300;

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

function encodeBase64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf-8").toString("base64");
}

function decodeBase64Json(value: string): unknown {
  return JSON.parse(Buffer.from(value.trim(), "base64").toString("utf-8"));
}

function randomNonce(): Hex {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return `0x${Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("")}` as Hex;
}

/** Read the atomic-unit amount off a requirement regardless of protocol version. */
function amountOf(requirement: PaymentRequirement): string | undefined {
  return requirement.amount ?? requirement.maxAmountRequired;
}

/** Read the resource URL a challenge advertises, from either shape. */
function resourceUrlOf(resource: X402Challenge["resource"]): string | undefined {
  if (typeof resource === "string") return resource;
  return resource?.url;
}

function usdcCeilingToAtomic(priceUsdc: number): bigint {
  if (!Number.isFinite(priceUsdc) || priceUsdc < 0) {
    throw new Error(`x402 price ceiling must be a finite non-negative number, got: ${priceUsdc}`);
  }
  const atomic = priceUsdc * 1_000_000;
  if (!Number.isSafeInteger(atomic)) {
    throw new Error("x402 price ceiling cannot use more than 6 decimal places of USDC precision");
  }
  return BigInt(atomic);
}

function assertAmountWithinCeiling(amount: string | undefined, priceUsdc: number): void {
  if (!amount || !/^(0|[1-9][0-9]*)$/.test(amount)) {
    throw new Error("x402 challenge amount must be a canonical atomic-unit integer");
  }
  const parsedAmount = BigInt(amount);
  const ceiling = usdcCeilingToAtomic(priceUsdc);
  if (parsedAmount > ceiling) {
    throw new Error(
      `x402 challenge amount ${parsedAmount} exceeds caller ceiling ${ceiling} atomic USDC`,
    );
  }
}

function normalizeAddress(value: string, label: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`x402 ${label} must be a 20-byte EVM address`);
  }
  return value.toLowerCase();
}

function networkMatches(configured: X402Network, advertised: string): boolean {
  return configured === "base-mainnet"
    ? advertised === "base" || advertised === "base-mainnet" || advertised === "eip155:8453"
    : advertised === "base-sepolia" || advertised === "eip155:84532";
}

function resolveChain(network: string) {
  if (network === "base" || network === "eip155:8453" || network === "base-mainnet") return base;
  if (network === "eip155:84532" || network === "base-sepolia") return baseSepolia;
  throw new Error(`Unsupported x402 network: ${network}`);
}

async function signPaymentHeader(
  account: Account,
  walletClient: WalletClient,
  requirement: PaymentRequirement,
  challenge: X402Challenge,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const isV2 = challenge.x402Version === 2;
  const amount = amountOf(requirement);
  if (!amount) {
    throw new Error("x402 challenge missing atomic amount");
  }
  const validAfter = isV2 ? 0n : BigInt(now - 60);
  const validBefore = BigInt(now + (requirement.maxTimeoutSeconds ?? 300));
  const nonce = randomNonce();
  const chain = resolveChain(requirement.network);

  const signature = await walletClient.signTypedData({
    account,
    domain: {
      name: requirement.extra?.name ?? "USD Coin",
      version: requirement.extra?.version ?? "2",
      chainId: chain.id,
      verifyingContract: requirement.asset,
    },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: account.address,
      to: requirement.payTo,
      value: BigInt(amount),
      validAfter,
      validBefore,
      nonce,
    },
  });

  const payload = {
    payload: {
      authorization: {
        from: account.address,
        to: requirement.payTo,
        value: amount,
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
      },
      signature,
    },
  };

  if (isV2) {
    return encodeBase64Json({
      x402Version: 2,
      ...(challenge.resource ? { resource: challenge.resource } : {}),
      accepted: requirement,
      ...(challenge.extensions ? { extensions: challenge.extensions } : {}),
      ...payload,
    });
  }

  return encodeBase64Json({
    x402Version: 1,
    ...(requirement.resource || typeof challenge.resource === "string"
      ? { resource: requirement.resource ?? challenge.resource }
      : {}),
    scheme: requirement.scheme,
    network: requirement.network,
    ...payload,
  });
}

export class X402Client {
  private readonly serviceUrl: string;
  private readonly account: Account | null;
  private readonly walletClient: WalletClient | null;
  private readonly expectedPayTo: string | null;
  private readonly expectedAsset: string | null;
  readonly dryRun: boolean;
  readonly network: X402Network;

  constructor(config: X402ClientConfig = {}) {
    this.serviceUrl = (config.serviceUrl ?? "https://api.suedeai.xyz").replace(/\/+$/, "");
    this.dryRun = config.dryRun ?? true;
    this.network = config.network ?? "base-mainnet";
    this.expectedPayTo = config.expectedPayTo
      ? normalizeAddress(config.expectedPayTo, "expectedPayTo")
      : null;
    const expectedAsset =
      config.expectedAsset ?? (this.network === "base-mainnet" ? BASE_MAINNET_USDC : undefined);
    this.expectedAsset = expectedAsset
      ? normalizeAddress(expectedAsset, "expectedAsset")
      : null;

    if (!this.dryRun) {
      if (!config.privateKey) {
        throw new Error("x402 live mode requires a privateKey");
      }
      if (!this.expectedPayTo) {
        throw new Error("x402 live mode requires expectedPayTo");
      }
      if (!this.expectedAsset) {
        throw new Error("x402 live mode requires expectedAsset");
      }
      this.account = privateKeyToAccount(config.privateKey);
      const chain = this.network === "base-sepolia" ? baseSepolia : base;
      this.walletClient = createWalletClient({
        account: this.account,
        chain,
        transport: http(config.rpcUrl),
      });
    } else {
      this.account = config.privateKey ? privateKeyToAccount(config.privateKey) : null;
      this.walletClient = null;
    }
  }

  get walletAddress(): string | null {
    return this.account?.address ?? null;
  }

  /** Call a priced Suede endpoint, settling via x402 unless in dry-run. */
  async call<T = unknown>(
    path: string,
    body?: unknown,
    opts: X402CallOptions = {},
  ): Promise<X402Result<T>> {
    const method = opts.method ?? "POST";
    const price = opts.priceUsdc ?? 0;

    if (this.dryRun) {
      return {
        data: { dryRun: true, path, method, echo: body ?? null } as T,
        settled: false,
        dryRun: true,
        costUsdc: 0,
      };
    }

    const url = `${this.serviceUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const init: RequestInit = {
      method,
      headers: { "Content-Type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
    };

    const challengeRes = await fetch(url, init);
    if (challengeRes.status === 200) {
      return { data: (await challengeRes.json()) as T, settled: false, dryRun: false, costUsdc: 0 };
    }
    if (challengeRes.status !== 402) {
      throw new Error(
        `Suede call failed (status ${challengeRes.status}): ${await challengeRes.text()}`,
      );
    }

    const paymentRequiredHeader = challengeRes.headers?.get?.("PAYMENT-REQUIRED");
    const challenge = (
      paymentRequiredHeader ? decodeBase64Json(paymentRequiredHeader) : await challengeRes.json()
    ) as X402Challenge;
    const requirement = challenge.accepts?.[0];
    if (!requirement) {
      throw new Error("x402 challenge missing payment requirements");
    }
    if (!this.account || !this.walletClient) {
      throw new Error("x402 live settlement unavailable: no signer");
    }

    if (challenge.x402Version !== 1 && challenge.x402Version !== 2) {
      throw new Error(`Unsupported x402 challenge version: ${String(challenge.x402Version)}`);
    }
    if (requirement.scheme !== "exact") {
      throw new Error(`Unsupported x402 payment scheme: ${requirement.scheme}`);
    }
    if (!networkMatches(this.network, requirement.network)) {
      throw new Error(
        `x402 challenge network ${requirement.network} does not match configured ${this.network}`,
      );
    }
    if (normalizeAddress(requirement.asset, "challenge asset") !== this.expectedAsset) {
      throw new Error("x402 challenge asset does not match the trusted USDC contract");
    }
    const advertisedResource = resourceUrlOf(challenge.resource) ?? requirement.resource;
    if (advertisedResource !== url) {
      throw new Error("x402 challenge resource does not match the requested URL");
    }
    if (
      requirement.maxTimeoutSeconds !== undefined &&
      (!Number.isInteger(requirement.maxTimeoutSeconds) ||
        requirement.maxTimeoutSeconds <= 0 ||
        requirement.maxTimeoutSeconds > MAX_AUTHORIZATION_WINDOW_SECONDS)
    ) {
      throw new Error("x402 challenge timeout exceeds the authorization safety window");
    }
    assertAmountWithinCeiling(amountOf(requirement), price);
    if (normalizeAddress(requirement.payTo, "challenge payTo") !== this.expectedPayTo) {
      throw new Error("x402 challenge payTo does not match the trusted recipient");
    }

    const paymentHeader = await signPaymentHeader(
      this.account,
      this.walletClient,
      requirement,
      challenge,
    );
    const paymentHeaderName = challenge.x402Version === 2 ? "PAYMENT-SIGNATURE" : "X-PAYMENT";
    const paidRes = await fetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), [paymentHeaderName]: paymentHeader },
    });
    if (!paidRes.ok) {
      throw new Error(
        `Suede paid call failed (status ${paidRes.status}): ${await paidRes.text()}`,
      );
    }
    return { data: (await paidRes.json()) as T, settled: true, dryRun: false, costUsdc: price };
  }
}

/** Build a client from environment (X402_SKIP_SETTLEMENT defaults to dry-run). */
export function createX402Client(overrides: X402ClientConfig = {}): X402Client {
  const skip = process.env.X402_SKIP_SETTLEMENT;
  const dryRun = overrides.dryRun ?? (skip === undefined ? true : skip !== "false");
  return new X402Client({
    serviceUrl: overrides.serviceUrl ?? process.env.SUEDE_API_URL,
    privateKey: overrides.privateKey ?? (process.env.X402_PRIVATE_KEY as Hex | undefined),
    network: overrides.network,
    rpcUrl: overrides.rpcUrl ?? process.env.BASE_RPC_URL,
    expectedPayTo:
      overrides.expectedPayTo ?? (process.env.X402_SELLER_WALLET_ADDRESS as Hex | undefined),
    expectedAsset:
      overrides.expectedAsset ?? (process.env.X402_USDC_ASSET_ADDRESS as Hex | undefined),
    dryRun,
  });
}
