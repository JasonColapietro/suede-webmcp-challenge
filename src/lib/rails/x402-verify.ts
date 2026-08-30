// server-only — never import this file into a client component.
// It calls node APIs and the x402 facilitator network; importing it into a
// client bundle will break the build.

/**
 * Seller-side x402 payment verification + settlement module.
 *
 * Protocol (x402-v2, with x402-v1 payloads still accepted for backward
 * compatibility during rollout):
 *  1. Decode the payment header (base64-encoded JSON PaymentPayload) — sent
 *     as PAYMENT-SIGNATURE on v2, X-PAYMENT on legacy v1 callers.
 *  2. Build PaymentRequirements for the specific resource + amount.
 *  3. POST /verify to the facilitator — confirms the EIP-3009 signature is
 *     valid and the payer holds sufficient funds. No on-chain side effects.
 *  4. POST /settle to the facilitator — broadcasts the transferWithAuthorization.
 *     Returns the transaction hash.
 *
 * Facilitators are tried in order (see facilitatorChain): the primary is
 * X402_FACILITATOR_URL (defaults to https://api.cdp.coinbase.com/platform/v2/x402
 * — Coinbase CDP), and an optional X402_FACILITATOR_URL_SECONDARY (e.g. the open
 * PayAI facilitator) is used as a fallback when the primary fails on its side
 * (network / HTTP / auth). A definitive "payment invalid" verdict never falls
 * through to the secondary.
 *
 * CDP authentication: set CDP_API_KEY_ID (key id) + CDP_API_KEY_SECRET
 * (PEM EC private key or 64-byte base64 Ed25519 key) — same names as the Suede
 * backend + @coinbase/x402, so one key pair clones across every surface. A fresh signed JWT is
 * generated per request and attached ONLY on calls to the CDP host, so the
 * non-CDP fallback never receives a CDP-scoped token. Unauthenticated calls go
 * to the open facilitator path (works on testnet; CDP rejects production calls
 * without auth).
 */

import { SignJWT, importPKCS8, importJWK } from "jose";
import { randomBytes } from "crypto";
import { verifyTypedData, type Address, type Hex } from "viem";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Bazaar-discoverable x402 protocol version this seller advertises. */
export const X402_PROTOCOL_VERSION = 2;

/** x402-v2 CAIP-2 network string the Coinbase CDP facilitator expects. */
export const X402_FACILITATOR_NETWORK = "eip155:8453";

/** Legacy x402-v1 network string, used only when settling a v1-shaped payload. */
const X402_LEGACY_FACILITATOR_NETWORK = "base";

/** USDC on Base mainnet. */
export const USDC_TOKEN_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/** x402 payment scheme for EIP-3009 stablecoin transfers. */
export const X402_SCHEME = "exact";

/** USDC has 6 decimal places — $1.00 USDC = 1_000_000 atomic units. */
export const USDC_DECIMALS = 6;

/** Default settlement window advertised in accepts[] and sent to the facilitator (seconds). */
export const X402_DEFAULT_MAX_TIMEOUT_SECONDS = 60;

/** Response mimeType every Suede agent run endpoint advertises. */
export const X402_JSON_MIME_TYPE = "application/json";

/**
 * CDP Bazaar normalizes `/api/agents/<id>/run` to one parameterized route.
 * Keep the resource descriptor true for every published workflow so that the
 * normalized record never inherits one agent's name or task-specific copy.
 */
export const X402_AGENT_RUN_RESOURCE_DESCRIPTION =
  "Run a Suede Agent Studio workflow over x402.";

/** EIP-712 domain metadata used by Base USDC transferWithAuthorization. */
export const X402_USDC_EIP712_DOMAIN = { name: "USD Coin", version: "2" };

export interface X402BazaarMetadata {
  /** Resource responses already are their complete canonical transport envelope. */
  readonly mode?: "run" | "resource";
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema: Record<string, unknown>;
  readonly exampleInput: Readonly<Record<string, unknown>>;
  readonly exampleOutput: Readonly<Record<string, unknown>>;
}

/**
 * Build the x402 v2 Bazaar extension CDP indexes after settlement.
 *
 * The example is the exact POST body Bazaar may send while crawling. Its
 * schema wraps the service's input contract under the run route's `input`
 * property, so a crawler reaches the 402 challenge instead of getting a 400
 * from pre-payment input validation. The output example describes the stable
 * run envelope and exposes the service result directly for ranking and client
 * generation.
 */
export function buildX402BazaarExtensions(
  metadata: X402BazaarMetadata = {
    inputSchema: { type: "object" },
    outputSchema: { type: "object", additionalProperties: true },
    exampleInput: { prompt: "Complete the task described by this published workflow." },
    exampleOutput: { ok: true },
  },
) {
  const runExample = {
    runId: "run_123",
    status: "done",
    totalCostUsdc: 0,
    outputs: {},
    result: metadata.exampleOutput,
    settled: true,
    transaction: "0x123",
    payer: "0xabc",
  };
  const runSchema = {
    type: "object",
    additionalProperties: false,
    required: ["runId", "status", "totalCostUsdc", "outputs", "settled"],
    properties: {
      runId: { type: "string" },
      status: { type: "string", enum: ["done", "error"] },
      totalCostUsdc: { type: "number" },
      outputs: { type: "object", additionalProperties: true },
      result: metadata.outputSchema,
      settled: { type: "boolean" },
      transaction: { type: "string" },
      payer: { type: "string" },
    },
  };
  const outputExample = metadata.mode === "resource" ? metadata.exampleOutput : runExample;
  const outputSchema = metadata.mode === "resource" ? metadata.outputSchema : runSchema;
  return {
    bazaar: {
      info: {
        input: {
          type: "http",
          method: "POST",
          bodyType: "json",
          body: { input: metadata.exampleInput },
        },
        output: {
          type: "json",
          format: X402_JSON_MIME_TYPE,
          example: outputExample,
        },
      },
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: ["input", "output"],
        properties: {
          input: {
            type: "object",
            additionalProperties: false,
            required: ["type", "method", "bodyType", "body"],
            properties: {
              type: { type: "string", const: "http" },
              method: { type: "string", enum: ["POST"] },
              bodyType: { type: "string", enum: ["json"] },
              body: {
                type: "object",
                additionalProperties: false,
                required: ["input"],
                properties: {
                  input: metadata.inputSchema,
                  dryRun: { type: "boolean" },
                },
              },
            },
          },
          output: {
            type: "object",
            additionalProperties: false,
            required: ["type", "format", "example"],
            properties: {
              type: { type: "string", const: "json" },
              format: { type: "string", const: X402_JSON_MIME_TYPE },
              example: outputSchema,
            },
          },
        },
      },
    },
  };
}

export type X402BazaarExtensions = ReturnType<typeof buildX402BazaarExtensions>;

export const X402_BAZAAR_EXTENSIONS = buildX402BazaarExtensions();

/** How long (ms) to wait for facilitator /verify. */
const VERIFY_TIMEOUT_MS = 15_000;
/** How long (ms) to wait for facilitator /settle (on-chain broadcast). */
const SETTLE_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

/**
 * EIP-3009 authorization fields embedded in the payment payload. Identical
 * shape across x402-v1 and x402-v2 — only the outer envelope differs.
 */
const AuthorizationSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  value: z.string().min(1),
  validAfter: z.string().min(1),
  validBefore: z.string().min(1),
  nonce: z.string().min(1),
});

/**
 * x402-v2 resource descriptor. Separate from the per-accept payment
 * requirement because CDP's Bazaar validator expects the public resource
 * info at the top level of the v2 challenge and payment payload.
 */
const ResourceInfoSchema = z.object({
  url: z.string().url(),
  description: z.string().optional(),
  mimeType: z.string().optional(),
  serviceName: z.string().optional(),
  tags: z.array(z.string()).optional(),
  iconUrl: z.string().optional(),
});

export interface X402ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
}

const PaymentRequirementV2Schema = z.object({
  scheme: z.string().min(1),
  network: z.string().min(1),
  amount: z.string().min(1),
  asset: z.string().min(1),
  payTo: z.string().min(1),
  maxTimeoutSeconds: z.number(),
  extra: z.record(z.unknown()).optional(),
});

/**
 * x402-v2 PaymentPayload — the JSON decoded from the base64 PAYMENT-SIGNATURE
 * header. Shape produced by x402-client.ts encodeBase64Json().
 */
const PaymentPayloadV2Schema = z.object({
  x402Version: z.literal(2),
  resource: ResourceInfoSchema.optional(),
  accepted: PaymentRequirementV2Schema,
  extensions: z.record(z.unknown()).optional(),
  // Optional legacy echoes are tolerated so mixed clients can still be decoded.
  scheme: z.string().optional(),
  network: z.string().optional(),
  payload: z.object({
    authorization: AuthorizationSchema,
    signature: z.string().min(1),
  }),
});

/**
 * Legacy x402-v1 PaymentPayload — accepted only as a fallback for older
 * callers still sending X-PAYMENT while newer clients roll onto v2.
 */
const PaymentPayloadV1Schema = z.object({
  x402Version: z.literal(1).optional(),
  resource: z.string().optional(),
  extensions: z.record(z.unknown()).optional(),
  scheme: z.string().min(1),
  /**
   * The client sends its own declared network (e.g. "base-mainnet").
   * Agentix manifests use "base-mainnet"; the facilitator expects "base".
   * We accept either form and normalise when building PaymentRequirements.
   */
  network: z.string().min(1),
  payload: z.object({
    authorization: AuthorizationSchema,
    signature: z.string().min(1),
  }),
});

const PaymentPayloadSchema = z.union([PaymentPayloadV2Schema, PaymentPayloadV1Schema]);
export type PaymentPayload = z.infer<typeof PaymentPayloadSchema>;

export interface X402AuthorizationIdentity {
  readonly x402Version: 1 | 2;
  readonly payer: string;
  readonly payTo: string;
  readonly amountAtomic: string;
  readonly nonce: string;
  readonly validAfter: string;
  readonly validBefore: string;
  readonly network: string;
  readonly asset: string | null;
  readonly scheme: string;
}

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

// ---------------------------------------------------------------------------
// Public result type
// ---------------------------------------------------------------------------

export type X402SettleResult =
  | { ok: true; transaction: string | null; payer: string | null }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Facilitator response shapes (validated at runtime)
// ---------------------------------------------------------------------------

const VerifyResponseSchema = z.object({
  isValid: z.boolean().optional(),
  invalidReason: z.string().optional(),
  payer: z.string().optional(),
});

const SettleResponseSchema = z.object({
  success: z.boolean().optional(),
  errorReason: z.string().optional(),
  payer: z.string().optional(),
  transaction: z.string().optional(),
  network: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert a USDC amount as a decimal number (e.g. 0.25) to atomic units
 * (6 decimals → "250000"). Uses fixed-point string arithmetic to avoid
 * floating-point rounding errors.
 */
export function usdcToAtomic(amountUsdc: number): string {
  // Reject nonsense before the digit-only regex below silently drops the sign
  // (e.g. -0.25 → "250000") or NaN/Infinity produce a garbage atomic value.
  if (!Number.isFinite(amountUsdc) || amountUsdc < 0) {
    throw new Error(`x402 usdc amount must be a finite non-negative number, got: ${amountUsdc}`);
  }
  const raw = amountUsdc.toFixed(USDC_DECIMALS);
  const [wholeRaw, fracRaw = ""] = raw.split(".");
  const whole = wholeRaw.replace(/[^0-9]/g, "") || "0";
  const fracPadded = (fracRaw.replace(/[^0-9]/g, "") + "0".repeat(USDC_DECIMALS)).slice(
    0,
    USDC_DECIMALS,
  );
  return (
    BigInt(whole) * BigInt(10) ** BigInt(USDC_DECIMALS) +
    BigInt(fracPadded || "0")
  ).toString();
}

/**
 * Generic run-endpoint outputSchema (KD-6 — Bazaar listing quality). Flow
 * outputs are arbitrary per-agent, so this describes the stable run contract
 * (runId/status/outputs/settled) rather than a specific payload shape.
 */
export const X402_RUN_OUTPUT_SCHEMA: Record<string, unknown> = {
  input: {
    type: "http",
    method: "POST",
    discoverable: true,
    bodyType: "json",
    body: { input: "<object — flow trigger input>", dryRun: "<optional boolean>" },
  },
  output: {
    type: "object",
    properties: {
      runId: { type: "string" },
      status: { type: "string", enum: ["done", "error"] },
      totalCostUsdc: { type: "number" },
      outputs: { type: "object" },
      settled: { type: "boolean" },
      transaction: { type: "string" },
      payer: { type: "string" },
    },
  },
};

export interface X402AcceptInput {
  priceUsdc: number;
  payTo: string;
  /** Must be an absolute https URL — x402-v2 and Bazaar both require it (KD-3). */
  resource: string;
  description: string;
  outputSchema?: Record<string, unknown>;
}

export interface X402Accept {
  scheme: string;
  network: string;
  amount: string;
  payTo: string;
  asset: string;
  maxTimeoutSeconds: number;
  extra: typeof X402_USDC_EIP712_DOMAIN;
}

/**
 * Build one x402-v2-conformant PaymentRequirements entry for a Suede agent
 * run endpoint. Single source of truth for every `accepts[]` entry across
 * the root index, per-agent discovery doc, and the 402 challenge itself —
 * KD-1/KD-2/KD-3 were three copies of this object drifting independently.
 */
export function buildX402Accept(input: X402AcceptInput): X402Accept {
  if (!/^https:\/\//.test(input.resource)) {
    throw new Error(`x402 accept resource must be an absolute https URL, got: ${input.resource}`);
  }
  return {
    scheme: X402_SCHEME,
    network: X402_FACILITATOR_NETWORK,
    amount: usdcToAtomic(input.priceUsdc),
    payTo: input.payTo,
    asset: USDC_TOKEN_ADDRESS,
    maxTimeoutSeconds: X402_DEFAULT_MAX_TIMEOUT_SECONDS,
    extra: X402_USDC_EIP712_DOMAIN,
  };
}

export interface X402ResourceInput {
  resource: string;
  description: string;
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
}

export interface X402PaymentRequiredInput extends X402AcceptInput {
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
  extensions?: X402BazaarExtensions;
}

export interface X402PaymentRequired {
  x402Version: typeof X402_PROTOCOL_VERSION;
  error?: string;
  resource: X402ResourceInfo;
  accepts: X402Accept[];
  extensions: X402BazaarExtensions;
}

export function buildX402ResourceInfo(input: X402ResourceInput): X402ResourceInfo {
  if (!/^https:\/\//.test(input.resource)) {
    throw new Error(`x402 resource must be an absolute https URL, got: ${input.resource}`);
  }
  return {
    url: input.resource,
    description: input.description,
    mimeType: X402_JSON_MIME_TYPE,
    serviceName: input.serviceName ?? "Suede Agent Studio",
    tags: input.tags ?? ["suede", "agent", "x402"],
    ...(input.iconUrl ? { iconUrl: input.iconUrl } : {}),
  };
}

/** Build the full x402-v2 402/discovery document for one priced resource. */
export function buildX402PaymentRequired(
  input: X402PaymentRequiredInput,
  reason?: string,
): X402PaymentRequired {
  return {
    x402Version: X402_PROTOCOL_VERSION,
    ...(reason ? { error: `payment required: ${reason}` } : { error: "payment required" }),
    resource: buildX402ResourceInfo({
      resource: input.resource,
      description: input.description,
      serviceName: input.serviceName,
      tags: input.tags,
      iconUrl: input.iconUrl,
    }),
    accepts: [buildX402Accept(input)],
    extensions: input.extensions ?? X402_BAZAAR_EXTENSIONS,
  };
}

/** Base64url-JSON-encode a value for the PAYMENT-REQUIRED response header. */
export function encodeX402Header(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf-8").toString("base64");
}

/**
 * Legacy x402-v1 PaymentRequirements shape, used only when settling a
 * v1-shaped incoming payload (an older caller still sending X-PAYMENT).
 */
function buildLegacyX402PaymentRequirements(input: X402AcceptInput) {
  const amount = usdcToAtomic(input.priceUsdc);
  return {
    scheme: X402_SCHEME,
    network: X402_LEGACY_FACILITATOR_NETWORK,
    maxAmountRequired: amount,
    asset: USDC_TOKEN_ADDRESS,
    payTo: input.payTo,
    resource: input.resource,
    description: input.description,
    mimeType: X402_JSON_MIME_TYPE,
    maxTimeoutSeconds: X402_DEFAULT_MAX_TIMEOUT_SECONDS,
    extra: X402_USDC_EIP712_DOMAIN,
    outputSchema: input.outputSchema ?? X402_RUN_OUTPUT_SCHEMA,
    extensions: X402_BAZAAR_EXTENSIONS,
  };
}

/**
 * Return true if the payload's network string refers to Base mainnet.
 * Agentix legacy x402-client uses "base-mainnet"; x402-v2 uses "eip155:8453".
 * We accept any form from decoded payloads but advertise the v2 CAIP-2 value.
 */
function isBaseMainnet(network: string): boolean {
  return network === "base" || network === "base-mainnet" || network === "eip155:8453";
}

/** Read the declared network off either a v1 or v2 decoded payload. */
function payloadNetwork(payload: PaymentPayload): string {
  return payload.x402Version === 2 ? payload.accepted.network : payload.network;
}

/** Coinbase CDP facilitator host — the only host that needs JWT auth. */
const CDP_HOST = "api.cdp.coinbase.com";

/** Default facilitator when X402_FACILITATOR_URL is unset. */
const CDP_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";

/**
 * Ordered list of facilitators to try: primary first, optional secondary
 * fallback. Primary = X402_FACILITATOR_URL (defaults to Coinbase CDP);
 * secondary = X402_FACILITATOR_URL_SECONDARY (e.g. the open PayAI facilitator).
 * verifyAndSettle attempts each in order until one settles or one returns a
 * definitive "payment invalid" verdict.
 */
export function facilitatorChain(): string[] {
  const primary = (
    process.env.X402_FACILITATOR_URL?.trim() || CDP_FACILITATOR_URL
  ).replace(/\/+$/, "");
  const chain = [primary];
  const secondary = process.env.X402_FACILITATOR_URL_SECONDARY?.trim();
  if (secondary) {
    const normalized = secondary.replace(/\/+$/, "");
    if (normalized !== primary) chain.push(normalized);
  }
  return chain;
}

/**
 * Generate a CDP-signed JWT for a single POST call to `host``path`.
 * CDP requires a fresh JWT (120-second TTL) per request with the target URI
 * in the `uris` claim. Supports both EC (PEM, ES256) and Ed25519 (64-byte
 * base64, EdDSA) key formats as issued by the CDP portal.
 */
async function cdpJwt(
  keyId: string,
  keySecret: string,
  host: string,
  path: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(16).toString("hex");
  const claims = {
    sub: keyId,
    iss: "cdp",
    iat: now,
    nbf: now,
    exp: now + 120,
    uris: [`POST ${host}${path}`],
  };

  // Detect Ed25519 (64-byte raw base64) vs PEM EC key. A PEM key carries the
  // "-----BEGIN" armor and always routes to importPKCS8; only a raw 64-byte
  // base64 blob (32 seed + 32 public) is treated as Ed25519.
  const decoded = Buffer.from(keySecret, "base64");
  if (!keySecret.includes("BEGIN") && decoded.length === 64) {
    const key = await importJWK(
      {
        kty: "OKP",
        crv: "Ed25519",
        d: decoded.subarray(0, 32).toString("base64url"),
        x: decoded.subarray(32).toString("base64url"),
      },
      "EdDSA",
    );
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "EdDSA", kid: keyId, typ: "JWT", nonce })
      .sign(key);
  }

  const key = await importPKCS8(keySecret, "ES256");
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", kid: keyId, typ: "JWT", nonce })
    .sign(key);
}

/**
 * Build fetch headers for a call to `${facilitator}${endpoint}`. A CDP Bearer
 * JWT is attached ONLY when the target host is the Coinbase CDP facilitator AND
 * CDP creds are set — so a fallback call to a non-CDP facilitator (e.g. PayAI)
 * never receives a CDP-scoped token.
 */
async function facilitatorHeaders(
  facilitator: string,
  endpoint: string,
): Promise<Record<string, string>> {
  const base: Record<string, string> = { "Content-Type": "application/json" };
  let host: string;
  let path: string;
  try {
    const url = new URL(facilitator);
    host = url.host;
    path = `${url.pathname.replace(/\/+$/, "")}${endpoint}`;
  } catch {
    return base;
  }
  if (host !== CDP_HOST) return base;
  const keyId = process.env.CDP_API_KEY_ID;
  const keySecret = process.env.CDP_API_KEY_SECRET;
  if (!keyId || !keySecret) return base;
  const jwt = await cdpJwt(keyId, keySecret, host, path);
  return { ...base, Authorization: `Bearer ${jwt}` };
}

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------

/**
 * Decode a raw PAYMENT-SIGNATURE or legacy X-PAYMENT header value
 * (base64-encoded JSON) into a typed PaymentPayload. Returns null for any
 * decode or validation failure — never throws.
 */
export function decodePaymentHeader(header: string): PaymentPayload | null {
  let raw: unknown;
  try {
    const json = Buffer.from(header.trim(), "base64").toString("utf-8");
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const result = PaymentPayloadSchema.safeParse(raw);
  return result.success ? result.data : null;
}

/**
 * Return only the signed authorization identity needed for replay reservation
 * and AP2-to-x402 binding. The payment signature itself is deliberately not
 * exposed so callers cannot accidentally persist or log it.
 */
export function x402AuthorizationIdentity(header: string): X402AuthorizationIdentity | null {
  const payment = decodePaymentHeader(header);
  if (!payment) return null;
  const authorization = payment.payload.authorization;
  if (payment.x402Version === 2) {
    return {
      x402Version: 2,
      payer: authorization.from,
      payTo: authorization.to,
      amountAtomic: authorization.value,
      nonce: authorization.nonce,
      validAfter: authorization.validAfter,
      validBefore: authorization.validBefore,
      network: payment.accepted.network,
      asset: payment.accepted.asset,
      scheme: payment.accepted.scheme,
    };
  }
  return {
    x402Version: 1,
    payer: authorization.from,
    payTo: authorization.to,
    amountAtomic: authorization.value,
    nonce: authorization.nonce,
    validAfter: authorization.validAfter,
    validBefore: authorization.validBefore,
    network: payment.network,
    asset: null,
    scheme: payment.scheme,
  };
}

/**
 * Locally authenticate the v2 EIP-3009 authorizer before a durable AP2
 * reservation is consumed. This is deterministic and performs no network I/O.
 */
export async function verifyX402AuthorizationSignature(header: string): Promise<boolean> {
  const payment = decodePaymentHeader(header);
  if (!payment || payment.x402Version !== 2) return false;
  const authorization = payment.payload.authorization;
  if (
    payment.accepted.network !== X402_FACILITATOR_NETWORK
    || payment.accepted.asset.toLowerCase() !== USDC_TOKEN_ADDRESS.toLowerCase()
    || !/^0x[0-9a-fA-F]{40}$/u.test(authorization.from)
    || !/^0x[0-9a-fA-F]{40}$/u.test(authorization.to)
    || !/^0x[0-9a-fA-F]{64}$/u.test(authorization.nonce)
    || !/^0x[0-9a-fA-F]{130}$/u.test(payment.payload.signature)
    || !/^(?:0|[1-9][0-9]*)$/u.test(authorization.value)
    || !/^(?:0|[1-9][0-9]*)$/u.test(authorization.validAfter)
    || !/^(?:0|[1-9][0-9]*)$/u.test(authorization.validBefore)
  ) return false;
  try {
    return await verifyTypedData({
      address: authorization.from as Address,
      domain: {
        name: X402_USDC_EIP712_DOMAIN.name,
        version: X402_USDC_EIP712_DOMAIN.version,
        chainId: 8453,
        verifyingContract: USDC_TOKEN_ADDRESS as Address,
      },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: authorization.from as Address,
        to: authorization.to as Address,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce as Hex,
      },
      signature: payment.payload.signature as Hex,
    });
  } catch {
    return false;
  }
}

/**
 * Verify and settle an x402 payment via the configured facilitator. Accepts
 * both v2-shaped and legacy v1-shaped payloads.
 *
 * Steps:
 *  1. Decode + zod-validate the header (returns error on garbage).
 *  2. Reject if the payload's network is not Base mainnet.
 *  3. Build PaymentRequirements for the resource + amount.
 *  4. POST facilitator /verify.
 *  5. POST facilitator /settle.
 *
 * USDC amounts: `amountUsdc` is a decimal number (e.g. 0.25). This function
 * converts it to atomic units (6 decimals) before sending to the facilitator.
 */
export async function verifyAndSettle(input: {
  paymentHeader: string;
  payTo: string;
  amountUsdc: number;
  resource: string;
  description?: string;
  serviceName?: string;
  tags?: string[];
  outputSchema?: Record<string, unknown>;
  extensions?: X402BazaarExtensions;
  /** AP2 binds the user to the exact signed amount; overpayment is not accepted. */
  requireExactAmount?: boolean;
}): Promise<X402SettleResult> {
  // 1. Decode header
  const payload = decodePaymentHeader(input.paymentHeader);
  if (payload === null) {
    return { ok: false, reason: "x_payment_header_invalid_base64_json" };
  }

  // 2. Network guard — only accept Base mainnet payments
  const network = payloadNetwork(payload);
  if (!isBaseMainnet(network)) {
    return {
      ok: false,
      reason: `unsupported_network_${network.replace(/[^a-z0-9-]/gi, "_")}`,
    };
  }

  // 2a. Local recipient + amount guards — defense-in-depth. The facilitator
  //     /verify is authoritative, but never let a payment whose signed
  //     authorization pays the wrong address or underpays reach it. A legit
  //     x402-client signs authorization.to = payTo and value = the
  //     advertised atomic amount verbatim, so these never reject an honest
  //     caller on either protocol version.
  const auth = payload.payload.authorization;
  if (auth.to.toLowerCase() !== input.payTo.toLowerCase()) {
    return { ok: false, reason: "payment_recipient_mismatch" };
  }
  let requiredAtomic: bigint;
  let paidAtomic: bigint;
  try {
    requiredAtomic = BigInt(usdcToAtomic(input.amountUsdc));
    paidAtomic = BigInt(auth.value);
  } catch {
    return { ok: false, reason: "payment_amount_unparseable" };
  }
  if (input.requireExactAmount && paidAtomic !== requiredAtomic) {
    return { ok: false, reason: "payment_amount_mismatch" };
  }
  if (paidAtomic < requiredAtomic) {
    return { ok: false, reason: "payment_amount_insufficient" };
  }

  const description = input.description ?? "Run a Suede Agent Studio workflow over x402.";

  // 3. Build the facilitator body. Public callers should use x402-v2, but the
  //    legacy v1 branch remains for older X-PAYMENT clients during rollout.
  const body =
    payload.x402Version === 2
      ? JSON.stringify({
          x402Version: X402_PROTOCOL_VERSION,
          paymentPayload: {
            ...payload,
            x402Version: X402_PROTOCOL_VERSION,
            resource: buildX402ResourceInfo({
              resource: input.resource,
              description,
              serviceName: input.serviceName,
              tags: input.tags,
            }),
            accepted: buildX402Accept({
              priceUsdc: input.amountUsdc,
              payTo: input.payTo,
              resource: input.resource,
              description,
            }),
            extensions: {
              ...(payload.extensions ?? {}),
              ...(input.extensions ?? X402_BAZAAR_EXTENSIONS),
            },
          },
          paymentRequirements: buildX402Accept({
            priceUsdc: input.amountUsdc,
            payTo: input.payTo,
            resource: input.resource,
            description,
          }),
        })
      : JSON.stringify({
          x402Version: 1,
          paymentPayload: {
            ...payload,
            x402Version: 1,
            resource: input.resource,
            extensions: {
              ...(payload.extensions ?? {}),
              ...(input.extensions ?? X402_BAZAAR_EXTENSIONS),
            },
          },
          paymentRequirements: buildLegacyX402PaymentRequirements({
            priceUsdc: input.amountUsdc,
            payTo: input.payTo,
            resource: input.resource,
            description,
            outputSchema: input.outputSchema ?? X402_RUN_OUTPUT_SCHEMA,
          }),
        });

  // 4–5. Try each facilitator in the chain (CDP primary, optional fallback).
  //      A "retry" failure (facilitator-side: network/HTTP/auth/bad JSON) moves
  //      on to the next facilitator; a "final" verdict (payment invalid) stops.
  let lastReason = "no_facilitator_configured";
  for (const facilitator of facilitatorChain()) {
    const attempt = await attemptSettle(facilitator, body);
    if (attempt.kind === "ok") return attempt.value;
    if (attempt.kind === "final") return { ok: false, reason: attempt.reason };
    lastReason = attempt.reason;
  }
  return { ok: false, reason: lastReason };
}

/**
 * Outcome of one facilitator attempt:
 *  - "ok":    verified + settled — use this result.
 *  - "final": the facilitator gave a definitive verdict that the payment is
 *             invalid (bad signature, insufficient funds). Do NOT try another
 *             facilitator — the answer won't change, and a fallback must never
 *             settle a payment the primary correctly rejected.
 *  - "retry": a facilitator-side failure (network, HTTP, auth, bad JSON).
 *             Worth trying the next facilitator in the chain.
 */
type SettleAttempt =
  | { kind: "ok"; value: X402SettleResult }
  | { kind: "final"; reason: string }
  | { kind: "retry"; reason: string };

/** Run verify→settle against a single facilitator. */
async function attemptSettle(facilitator: string, body: string): Promise<SettleAttempt> {
  // POST /verify
  let verifyRes: Response;
  try {
    verifyRes = await fetch(`${facilitator}/verify`, {
      method: "POST",
      headers: await facilitatorHeaders(facilitator, "/verify"),
      body,
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
  } catch (err) {
    return { kind: "retry", reason: `facilitator_verify_network_error_${String(err).slice(0, 80)}` };
  }

  if (!verifyRes.ok) {
    return { kind: "retry", reason: `facilitator_verify_http_${verifyRes.status}` };
  }

  let verifyData: z.infer<typeof VerifyResponseSchema>;
  try {
    const raw: unknown = await verifyRes.json();
    const parsed = VerifyResponseSchema.safeParse(raw);
    if (!parsed.success) return { kind: "retry", reason: "facilitator_verify_bad_json" };
    verifyData = parsed.data;
  } catch {
    return { kind: "retry", reason: "facilitator_verify_bad_json" };
  }

  if (!verifyData.isValid) {
    return { kind: "final", reason: verifyData.invalidReason ?? "verify_invalid" };
  }

  // POST /settle
  //
  // Settle-phase failures are TERMINAL, never "retry". Once /verify has passed
  // against this facilitator, the settle call may already have broadcast the
  // transferWithAuthorization on-chain before it timed out or 5xx'd. Falling
  // through to a second facilitator would re-verify + re-settle the SAME signed
  // authorization — an ambiguous double-broadcast. The EIP-3009 nonce makes the
  // second broadcast fail, but that surfaces as a spurious "nonce used" error on
  // a payment that actually succeeded. Verify-phase failures above stay "retry"
  // (nothing was broadcast), so the CDP→PayAI resilience story is intact.
  let settleRes: Response;
  try {
    settleRes = await fetch(`${facilitator}/settle`, {
      method: "POST",
      headers: await facilitatorHeaders(facilitator, "/settle"),
      body,
      signal: AbortSignal.timeout(SETTLE_TIMEOUT_MS),
    });
  } catch (err) {
    return { kind: "final", reason: `facilitator_settle_network_error_${String(err).slice(0, 80)}` };
  }

  if (!settleRes.ok) {
    return { kind: "final", reason: `facilitator_settle_http_${settleRes.status}` };
  }

  let settleData: z.infer<typeof SettleResponseSchema>;
  try {
    const raw: unknown = await settleRes.json();
    const parsed = SettleResponseSchema.safeParse(raw);
    if (!parsed.success) return { kind: "final", reason: "facilitator_settle_bad_json" };
    settleData = parsed.data;
  } catch {
    return { kind: "final", reason: "facilitator_settle_bad_json" };
  }

  if (!settleData.success) {
    return { kind: "final", reason: settleData.errorReason ?? "settle_failed" };
  }

  return {
    kind: "ok",
    value: {
      ok: true,
      transaction: settleData.transaction ?? null,
      payer: settleData.payer ?? verifyData.payer ?? null,
    },
  };
}
