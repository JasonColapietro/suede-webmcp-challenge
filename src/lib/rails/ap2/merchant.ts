import { randomUUID } from "node:crypto";

import {
  SignJWT,
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
  type JWK,
} from "jose";
import { z } from "zod";

import { canonicalizeJson, sha256Base64Url } from "./codec";
import {
  merchantPrivateKey,
  merchantPublicJwk,
  merchantRetiredPublicJwks,
} from "./keys";
import {
  Ap2ProtocolError,
  type Ap2CheckoutSnapshot,
  type Ap2ExpectedBinding,
  type Ap2Jwks,
  type Ap2MerchantSigningConfig,
} from "./types";

const merchantSchema = z.object({
  id: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
  website: z.string().url().max(2_048).optional(),
}).strict();

const checkoutSnapshotSchema = z.object({
  profile: z.literal("ap2-v0.2-experimental"),
  nonce: z.string().min(16).max(256),
  agentId: z.string().min(1).max(256),
  agentSlug: z.string().min(1).max(256),
  flowId: z.string().min(1).max(256),
  deploymentId: z.string().min(1).max(256),
  flowVersionId: z.string().min(1).max(256),
  fullHash: z.string().regex(/^[0-9a-f]{64}$/u),
  resource: z.string().url().max(2_048),
  method: z.literal("POST"),
  requestDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  priceUsdc: z.number().finite().nonnegative(),
  amountAtomic: z.string().regex(/^(?:0|[1-9][0-9]*)$/u).max(78),
  amountMinorUsd: z.number().int().nonnegative().safe(),
  payee: merchantSchema,
  payTo: z.string().regex(/^0x[0-9A-Fa-f]{40}$/u),
  network: z.literal("eip155:8453"),
  asset: z.string().regex(/^0x[0-9A-Fa-f]{40}$/u),
  scheme: z.literal("exact"),
  items: z.tuple([z.object({
    id: z.string().min(1).max(256),
    title: z.string().min(1).max(256),
    quantity: z.literal(1),
  }).strict()]),
}).strict();

function fail(code: "invalid_credential" | "invalid_mandate" = "invalid_credential"): never {
  throw new Ap2ProtocolError(code);
}

function rejectRemoteKeyHeaders(header: Readonly<Record<string, unknown>>): void {
  for (const forbidden of ["jku", "x5u", "x5c", "jwk"]) {
    if (forbidden in header) fail();
  }
}

function snapshotFromBinding(binding: Ap2ExpectedBinding): Ap2CheckoutSnapshot {
  const result = checkoutSnapshotSchema.safeParse({
    profile: "ap2-v0.2-experimental",
    nonce: binding.nonce,
    agentId: binding.agentId,
    agentSlug: binding.agentSlug,
    flowId: binding.flowId,
    deploymentId: binding.deploymentId,
    flowVersionId: binding.flowVersionId,
    fullHash: binding.fullHash,
    resource: binding.resource,
    method: binding.method,
    requestDigest: binding.requestDigest,
    priceUsdc: binding.priceUsdc,
    amountAtomic: binding.amountAtomic,
    amountMinorUsd: binding.amountMinorUsd,
    payee: binding.payee,
    payTo: binding.payTo,
    network: binding.network,
    asset: binding.asset,
    scheme: binding.scheme,
    items: [{ id: binding.agentId, title: binding.agentSlug, quantity: 1 }],
  });
  if (!result.success) return fail("invalid_mandate");
  return result.data;
}

function findMerchantKey(publicJwks: Ap2Jwks, keyId: string): JWK {
  const matches = publicJwks.keys.filter((key) => key.kid === keyId);
  if (matches.length !== 1) fail();
  const key = matches[0];
  if (
    !key
    || key.kty !== "EC"
    || key.crv !== "P-256"
    || key.alg !== undefined && key.alg !== "ES256"
    || "d" in key
  ) fail();
  return key;
}

export async function deriveMerchantJwks(
  signing: Ap2MerchantSigningConfig,
): Promise<Ap2Jwks> {
  return {
    keys: [
      await merchantPublicJwk(signing),
      ...merchantRetiredPublicJwks(signing),
    ],
  };
}

export interface IssueMerchantCheckoutJwtInput {
  readonly signing: Ap2MerchantSigningConfig;
  readonly binding: Ap2ExpectedBinding;
  readonly issuedAt?: number;
  readonly expiresInSeconds?: number;
}

export interface IssuedMerchantCheckoutJwt {
  readonly checkoutJwt: string;
  readonly checkoutHash: string;
  readonly expiresAt: number;
}

export async function issueMerchantCheckoutJwt(
  input: IssueMerchantCheckoutJwtInput,
): Promise<IssuedMerchantCheckoutJwt> {
  const issuedAt = input.issuedAt ?? Math.floor(Date.now() / 1_000);
  const expiresInSeconds = input.expiresInSeconds ?? 300;
  if (
    !Number.isSafeInteger(issuedAt)
    || issuedAt <= 0
    || !Number.isSafeInteger(expiresInSeconds)
    || expiresInSeconds < 30
    || expiresInSeconds > 900
  ) fail("invalid_mandate");
  const snapshot = snapshotFromBinding(input.binding);
  const expiresAt = issuedAt + expiresInSeconds;
  const checkoutJwt = await new SignJWT({ ap2: snapshot })
    .setProtectedHeader({ alg: "ES256", kid: input.signing.keyId, typ: "JWT" })
    .setIssuer(input.signing.issuer)
    .setAudience(input.binding.audience)
    .setJti(randomUUID())
    .setIssuedAt(issuedAt)
    .setNotBefore(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(await merchantPrivateKey(input.signing));
  return {
    checkoutJwt,
    checkoutHash: sha256Base64Url(checkoutJwt),
    expiresAt,
  };
}

export async function verifyMerchantCheckoutJwt(input: {
  readonly checkoutJwt: string;
  readonly publicJwks: Ap2Jwks;
  readonly expected: Ap2ExpectedBinding;
  readonly issuer: string;
  readonly now?: number;
  readonly clockSkewSeconds?: number;
}): Promise<{ readonly binding: Ap2CheckoutSnapshot }> {
  if (
    !input.checkoutJwt
    || Buffer.byteLength(input.checkoutJwt, "utf8") > 32_768
    || input.checkoutJwt !== input.expected.checkoutJwt
    || sha256Base64Url(input.checkoutJwt) !== input.expected.checkoutHash
  ) fail("invalid_mandate");
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(input.checkoutJwt);
  } catch {
    return fail();
  }
  rejectRemoteKeyHeaders(header);
  if (header.alg !== "ES256" || typeof header.kid !== "string" || !header.kid) fail();
  const key = await importJWK(findMerchantKey(input.publicJwks, header.kid), "ES256");
  let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];
  try {
    ({ payload } = await jwtVerify(input.checkoutJwt, key, {
      algorithms: ["ES256"],
      issuer: input.issuer,
      audience: input.expected.audience,
      clockTolerance: input.clockSkewSeconds ?? 30,
      currentDate: input.now === undefined ? undefined : new Date(input.now * 1_000),
    }));
  } catch {
    return fail();
  }
  const parsed = checkoutSnapshotSchema.safeParse(payload.ap2);
  if (!parsed.success) fail("invalid_mandate");
  const expectedSnapshot = snapshotFromBinding(input.expected);
  if (canonicalizeJson(parsed.data) !== canonicalizeJson(expectedSnapshot)) {
    fail("invalid_mandate");
  }
  return { binding: parsed.data };
}

/**
 * Verify a merchant-issued checkout quote before using any of its fields to
 * construct the expected AP2 binding. This accepts no caller-selected key or
 * issuer and returns only after ES256 verification.
 */
export async function verifyMerchantCheckoutQuote(input: {
  readonly checkoutJwt: string;
  readonly publicJwks: Ap2Jwks;
  readonly issuer: string;
  readonly now?: number;
  readonly clockSkewSeconds?: number;
}): Promise<{
  readonly binding: Ap2CheckoutSnapshot;
  readonly audience: string;
  readonly checkoutHash: string;
  readonly expiresAt: number;
}> {
  if (!input.checkoutJwt || Buffer.byteLength(input.checkoutJwt, "utf8") > 32_768) fail();
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(input.checkoutJwt);
  } catch {
    return fail();
  }
  rejectRemoteKeyHeaders(header);
  if (header.alg !== "ES256" || typeof header.kid !== "string" || !header.kid) fail();
  const key = await importJWK(findMerchantKey(input.publicJwks, header.kid), "ES256");
  try {
    const { payload } = await jwtVerify(input.checkoutJwt, key, {
      algorithms: ["ES256"],
      issuer: input.issuer,
      clockTolerance: input.clockSkewSeconds ?? 30,
      currentDate: input.now === undefined ? undefined : new Date(input.now * 1_000),
    });
    const parsed = checkoutSnapshotSchema.safeParse(payload.ap2);
    if (
      !parsed.success
      || typeof payload.aud !== "string"
      || payload.aud !== parsed.data.resource
      || !Number.isSafeInteger(payload.exp)
    ) {
      fail("invalid_mandate");
    }
    return {
      binding: parsed.data,
      audience: payload.aud,
      checkoutHash: sha256Base64Url(input.checkoutJwt),
      expiresAt: payload.exp as number,
    };
  } catch (error) {
    if (error instanceof Ap2ProtocolError) throw error;
    return fail();
  }
}

const successReceiptSchema = z.object({
  status: z.literal("Success"),
  iss: z.string().min(1).max(512),
  iat: z.number().int().positive(),
  reference: z.string().min(1).max(512),
  order_id: z.string().min(1).max(256),
}).passthrough();

const errorReceiptSchema = z.object({
  status: z.literal("Error"),
  iss: z.string().min(1).max(512),
  iat: z.number().int().positive(),
  reference: z.string().min(1).max(512),
  error: z.string().min(1).max(128),
  error_description: z.string().min(1).max(512),
}).passthrough();

const receiptSchema = z.discriminatedUnion("status", [
  successReceiptSchema,
  errorReceiptSchema,
]);

type ReceiptInput = {
  readonly signing: Ap2MerchantSigningConfig;
  readonly reference: string;
  readonly issuedAt?: number;
} & (
  | { readonly status: "Success"; readonly orderId: string }
  | {
    readonly status: "Error";
    readonly error: string;
    readonly errorDescription: string;
  }
);

export async function issueCheckoutReceipt(input: ReceiptInput): Promise<string> {
  const issuedAt = input.issuedAt ?? Math.floor(Date.now() / 1_000);
  const body = input.status === "Success"
    ? {
      status: input.status,
      reference: input.reference,
      order_id: input.orderId,
    }
    : {
      status: input.status,
      reference: input.reference,
      error: input.error,
      error_description: input.errorDescription,
    };
  const candidate = { ...body, iss: input.signing.issuer, iat: issuedAt };
  if (!receiptSchema.safeParse(candidate).success) fail("invalid_mandate");
  return new SignJWT(body)
    .setProtectedHeader({ alg: "ES256", kid: input.signing.keyId, typ: "JWT" })
    .setIssuer(input.signing.issuer)
    .setIssuedAt(issuedAt)
    .sign(await merchantPrivateKey(input.signing));
}

export async function verifyCheckoutReceipt(input: {
  readonly receiptJwt: string;
  readonly publicJwks: Ap2Jwks;
  readonly issuer: string;
}): Promise<z.infer<typeof receiptSchema>> {
  if (!input.receiptJwt || Buffer.byteLength(input.receiptJwt, "utf8") > 16_384) fail();
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(input.receiptJwt);
  } catch {
    return fail();
  }
  rejectRemoteKeyHeaders(header);
  if (header.alg !== "ES256" || typeof header.kid !== "string" || !header.kid) fail();
  const key = await importJWK(findMerchantKey(input.publicJwks, header.kid), "ES256");
  try {
    const { payload } = await jwtVerify(input.receiptJwt, key, {
      algorithms: ["ES256"],
      issuer: input.issuer,
    });
    const parsed = receiptSchema.safeParse(payload);
    if (!parsed.success) fail();
    return parsed.data;
  } catch (error) {
    if (error instanceof Ap2ProtocolError) throw error;
    return fail();
  }
}
