import { createHash } from "node:crypto";

import {
  importJWK,
  jwtVerify,
  type JWK,
} from "jose";
import { z } from "zod";

import {
  canonicalizeJson,
  finalMandateReference,
  finalMandateReplayIdentity,
  parseSdJwtPresentation,
  rootSdJwtReference,
  sha256Base64Url,
  type ParsedSdJwtPresentation,
  type ParsedSdJwtSegment,
} from "./codec";
import {
  AP2_CHECKOUT_VCT,
  AP2_OPEN_CHECKOUT_VCT,
  AP2_OPEN_PAYMENT_VCT,
  AP2_PAYMENT_VCT,
  Ap2ProtocolError,
  type Ap2AsymmetricAlgorithm,
  type Ap2AuthorizationMode,
  type Ap2AuthorizationResult,
  type Ap2ExpectedBinding,
  type Ap2Merchant,
  type Ap2TrustedIssuer,
  type Ap2TrustedIssuerRegistry,
} from "./types";

const STANDARD_CLAIMS = new Set([
  "iss", "sub", "aud", "nonce", "iat", "nbf", "exp", "jti", "_sd_alg",
  "sd_hash", "issuer_jwt_hash",
]);
const REMOTE_KEY_HEADERS = ["jku", "x5u", "x5c", "jwk"] as const;
const TERMINAL_TYPES = new Set(["kb+sd-jwt", "kb-sd-jwt"]);

const merchantSchema = z.object({
  id: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
  website: z.string().url().max(2_048).optional(),
}).strict();

const publicJwkSchema = z.object({
  kty: z.enum(["EC", "OKP", "RSA"]),
  kid: z.string().min(1).max(128).optional(),
  alg: z.enum(["ES256", "EdDSA", "RS256", "PS256"]).optional(),
  use: z.literal("sig").optional(),
  key_ops: z.tuple([z.literal("verify")]).optional(),
  x5t: z.string().regex(/^[A-Za-z0-9_-]{20,128}$/u).optional(),
  "x5t#S256": z.string().regex(/^[A-Za-z0-9_-]{20,128}$/u).optional(),
  crv: z.string().optional(),
  x: z.string().optional(),
  y: z.string().optional(),
  n: z.string().optional(),
  e: z.string().optional(),
}).strict();

const checkoutMandateSchema = z.object({
  vct: z.literal(AP2_CHECKOUT_VCT),
  checkout_jwt: z.string().min(1).max(32_768),
  checkout_hash: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/u),
  iat: z.number().int().positive().optional(),
  exp: z.number().int().positive().optional(),
}).strict();

const paymentInstrumentSchema = z.object({
  id: z.string().min(1).max(256),
  type: z.string().min(1).max(128),
  description: z.string().max(512).optional(),
}).strict();

const pispSchema = z.object({
  legal_name: z.string().min(1).max(256),
  brand_name: z.string().min(1).max(256),
  domain_name: z.string().min(1).max(253),
}).strict();

const paymentMandateSchema = z.object({
  vct: z.literal(AP2_PAYMENT_VCT),
  transaction_id: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/u),
  payee: merchantSchema,
  pisp: pispSchema.optional(),
  payment_amount: z.object({
    amount: z.number().int().nonnegative().safe(),
    currency: z.string().regex(/^[A-Z]{3}$/u),
  }).strict(),
  payment_instrument: paymentInstrumentSchema,
  execution_date: z.string().max(64).optional(),
  risk_data: z.record(z.unknown()).optional(),
  iat: z.number().int().positive().optional(),
  exp: z.number().int().positive().optional(),
}).strict();

const openCheckoutSchema = z.object({
  vct: z.literal(AP2_OPEN_CHECKOUT_VCT),
  constraints: z.array(z.record(z.unknown())).min(1).max(16),
  cnf: z.object({ jwk: publicJwkSchema }).strict(),
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
}).strict();

const openPaymentSchema = z.object({
  vct: z.literal(AP2_OPEN_PAYMENT_VCT),
  constraints: z.array(z.record(z.unknown())).min(1).max(16),
  cnf: z.object({ jwk: publicJwkSchema }).strict(),
  payee: merchantSchema.optional(),
  payment_amount: z.object({
    amount: z.number().int().nonnegative().safe(),
    currency: z.string().regex(/^[A-Z]{3}$/u),
  }).strict().optional(),
  payment_instrument: paymentInstrumentSchema.optional(),
  pisp: pispSchema.optional(),
  execution_date: z.string().max(64).optional(),
  risk_data: z.record(z.unknown()).optional(),
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
}).strict();

export type Ap2CheckoutMandate = z.infer<typeof checkoutMandateSchema>;
export type Ap2PaymentMandate = z.infer<typeof paymentMandateSchema>;
type Ap2OpenCheckoutMandate = z.infer<typeof openCheckoutSchema>;
type Ap2OpenPaymentMandate = z.infer<typeof openPaymentSchema>;

function fail(
  code: "invalid_credential" | "unresolved_constraint" | "invalid_mandate" =
    "invalid_credential",
): never {
  throw new Ap2ProtocolError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickMandateFields(
  payload: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): Record<string, unknown> {
  const allowed = new Set([...fields, ...STANDARD_CLAIMS]);
  if (Object.keys(payload).some((key) => !allowed.has(key))) fail("invalid_mandate");
  return Object.fromEntries(fields
    .filter((key) => payload[key] !== undefined)
    .map((key) => [key, payload[key]]));
}

export function validateCheckoutMandate(value: unknown): Ap2CheckoutMandate {
  if (!isRecord(value)) fail("invalid_mandate");
  const parsed = checkoutMandateSchema.safeParse(pickMandateFields(value, [
    "vct", "checkout_jwt", "checkout_hash", "iat", "exp",
  ]));
  if (!parsed.success) fail("invalid_mandate");
  return parsed.data;
}

export function validatePaymentMandate(value: unknown): Ap2PaymentMandate {
  if (!isRecord(value)) fail("invalid_mandate");
  const parsed = paymentMandateSchema.safeParse(pickMandateFields(value, [
    "vct", "transaction_id", "payee", "pisp", "payment_amount",
    "payment_instrument", "execution_date", "risk_data", "iat", "exp",
  ]));
  if (!parsed.success) fail("invalid_mandate");
  return parsed.data;
}

function validateOpenCheckout(value: unknown): Ap2OpenCheckoutMandate {
  if (!isRecord(value)) fail("invalid_mandate");
  const parsed = openCheckoutSchema.safeParse(pickMandateFields(value, [
    "vct", "constraints", "cnf", "iat", "exp",
  ]));
  if (!parsed.success) fail("invalid_mandate");
  return parsed.data;
}

function validateOpenPayment(value: unknown): Ap2OpenPaymentMandate {
  if (!isRecord(value)) fail("invalid_mandate");
  const parsed = openPaymentSchema.safeParse(pickMandateFields(value, [
    "vct", "constraints", "cnf", "payee", "payment_amount",
    "payment_instrument", "pisp", "execution_date", "risk_data", "iat", "exp",
  ]));
  if (!parsed.success) fail("invalid_mandate");
  return parsed.data;
}

function rejectRemoteHeaders(segment: ParsedSdJwtSegment): void {
  for (const header of REMOTE_KEY_HEADERS) {
    if (header in segment.protectedHeader) fail();
  }
}

function enforceSellerSdAlgorithm(presentation: ParsedSdJwtPresentation): void {
  for (const segment of presentation.segments) {
    const algorithm = segment.jwtPayload._sd_alg;
    if (algorithm !== undefined && algorithm !== "sha-256") fail();
  }
}

function findRootKey(
  segment: ParsedSdJwtSegment,
  registry: Ap2TrustedIssuerRegistry,
): { readonly issuer: Ap2TrustedIssuer; readonly key: JWK; readonly alg: Ap2AsymmetricAlgorithm } {
  rejectRemoteHeaders(segment);
  const issuerName = segment.jwtPayload.iss;
  const keyId = segment.protectedHeader.kid;
  const algorithm = segment.protectedHeader.alg;
  if (
    issuerName !== undefined && typeof issuerName !== "string"
    || keyId !== undefined && (typeof keyId !== "string" || !keyId)
    || typeof algorithm !== "string"
  ) fail();

  const matches: Array<{ readonly issuer: Ap2TrustedIssuer; readonly key: JWK }> = [];
  for (const issuer of registry.byIssuer.values()) {
    if (typeof issuerName === "string" && issuer.issuer !== issuerName) continue;
    if (!issuer.algorithms.includes(algorithm as Ap2AsymmetricAlgorithm)) continue;
    for (const key of issuer.keys) {
      if (key.alg !== algorithm) continue;
      if (typeof keyId === "string" && key.kid !== keyId) continue;
      matches.push({ issuer, key });
    }
  }
  const match = matches[0];
  if (matches.length !== 1 || !match) fail();
  return { ...match, alg: algorithm as Ap2AsymmetricAlgorithm };
}

function claim(
  segment: ParsedSdJwtSegment,
  name: string,
): unknown {
  return segment.effectivePayload[name]
    ?? segment.resolvedPayload[name]
    ?? segment.jwtPayload[name];
}

function exactAudience(segment: ParsedSdJwtSegment, expected: string): void {
  if (claim(segment, "aud") !== expected) fail();
}

function exactNonce(segment: ParsedSdJwtSegment, expected: string): void {
  if (claim(segment, "nonce") !== expected) fail();
}

function verifyTime(
  segment: ParsedSdJwtSegment,
  now: number,
  clockSkewSeconds: number,
): void {
  const issuedAt = claim(segment, "iat");
  const expiresAt = claim(segment, "exp");
  const notBefore = claim(segment, "nbf");
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)) fail();
  if ((issuedAt as number) > now + clockSkewSeconds) fail();
  if ((expiresAt as number) < now - clockSkewSeconds) fail();
  if (notBefore !== undefined) {
    if (!Number.isSafeInteger(notBefore) || (notBefore as number) > now + clockSkewSeconds) fail();
  }
}

async function verifyTrustedRoot(
  segment: ParsedSdJwtSegment,
  registry: Ap2TrustedIssuerRegistry,
  now: number,
  clockSkewSeconds: number,
): Promise<{ readonly issuer: string; readonly subject?: string }> {
  const trusted = findRootKey(segment, registry);
  try {
    await jwtVerify(segment.issuerJwt, await importJWK(trusted.key, trusted.alg), {
      algorithms: [trusted.alg],
      ...(typeof segment.jwtPayload.iss === "string"
        ? { issuer: trusted.issuer.issuer }
        : {}),
      clockTolerance: clockSkewSeconds,
      currentDate: new Date(now * 1_000),
    });
  } catch {
    return fail();
  }
  verifyTime(segment, now, clockSkewSeconds);
  const subject = claim(segment, "sub");
  if (subject !== undefined && typeof subject !== "string") fail();
  return {
    issuer: trusted.issuer.issuer,
    ...(typeof subject === "string" ? { subject } : {}),
  };
}

function validateDelegatedKey(value: unknown, segment: ParsedSdJwtSegment): JWK {
  const result = publicJwkSchema.safeParse(value);
  if (!result.success) fail();
  const jwk = result.data;
  const headerAlgorithm = segment.protectedHeader.alg;
  const headerKeyId = segment.protectedHeader.kid;
  if (
    headerAlgorithm !== "ES256"
    || headerKeyId !== undefined && (typeof headerKeyId !== "string" || !headerKeyId)
    || jwk.alg !== undefined && jwk.alg !== headerAlgorithm
    || jwk.kid !== undefined && jwk.kid !== headerKeyId
  ) fail();
  const valid = jwk.kty === "EC"
    && jwk.crv === "P-256"
    && Boolean(jwk.x && jwk.y);
  if (!valid) fail();
  return jwk;
}

function hashForSdAlgorithm(value: string, algorithm: unknown): string {
  const nodeAlgorithm = algorithm === undefined || algorithm === "sha-256"
    ? "sha256"
    : algorithm === "sha-384"
      ? "sha384"
      : algorithm === "sha-512"
        ? "sha512"
        : null;
  if (!nodeAlgorithm) fail();
  return createHash(nodeAlgorithm).update(value, "ascii").digest("base64url");
}

async function verifyDelegatedClosed(
  root: ParsedSdJwtSegment,
  closed: ParsedSdJwtSegment,
  openCnfJwk: JWK,
  expected: Ap2ExpectedBinding,
  now: number,
  clockSkewSeconds: number,
): Promise<void> {
  rejectRemoteHeaders(closed);
  if (!TERMINAL_TYPES.has(String(closed.protectedHeader.typ))) fail();
  const key = validateDelegatedKey(openCnfJwk, closed);
  try {
    await jwtVerify(closed.issuerJwt, await importJWK(key, "ES256"), {
      algorithms: ["ES256"],
      clockTolerance: clockSkewSeconds,
      currentDate: new Date(now * 1_000),
    });
  } catch {
    return fail();
  }
  exactAudience(closed, expected.audience);
  exactNonce(closed, expected.nonce);
  verifyTime(closed, now, clockSkewSeconds);
  if (isRecord(closed.effectivePayload.cnf)) fail("invalid_mandate");

  const sdHash = claim(closed, "sd_hash");
  const issuerJwtHash = claim(closed, "issuer_jwt_hash");
  if ((typeof sdHash === "string") === (typeof issuerJwtHash === "string")) fail();
  const sdAlgorithm = root.jwtPayload._sd_alg;
  if (
    typeof sdHash === "string"
    && sdHash !== hashForSdAlgorithm(root.canonicalSdJwt, sdAlgorithm)
  ) fail();
  if (
    typeof issuerJwtHash === "string"
    && issuerJwtHash !== hashForSdAlgorithm(root.issuerJwt, sdAlgorithm)
  ) fail();
}

function validateExpectedBinding(expected: Ap2ExpectedBinding): void {
  if (
    expected.method !== "POST"
    || expected.scheme !== "exact"
    || expected.network !== "eip155:8453"
    || !expected.audience
    || !expected.nonce
    || expected.resource !== expected.audience
    || sha256Base64Url(expected.checkoutJwt) !== expected.checkoutHash
    || !/^(?:0|[1-9][0-9]*)$/u.test(expected.amountAtomic)
    || !Number.isSafeInteger(expected.amountMinorUsd)
    || expected.amountMinorUsd < 0
    || !Number.isFinite(expected.priceUsdc)
    || expected.priceUsdc < 0
    || BigInt(expected.amountAtomic) !== BigInt(Math.round(expected.priceUsdc * 1_000_000))
    || expected.amountMinorUsd !== Math.round(expected.priceUsdc * 100)
  ) fail("invalid_mandate");
}

function merchantEquals(left: Ap2Merchant, right: Ap2Merchant): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right);
}

function jsonEquals(left: unknown, right: unknown): boolean {
  try {
    return canonicalizeJson(left) === canonicalizeJson(right);
  } catch {
    return false;
  }
}

function verifyClosedBindings(
  checkout: Ap2CheckoutMandate,
  payment: Ap2PaymentMandate,
  expected: Ap2ExpectedBinding,
): void {
  if (
    checkout.checkout_jwt !== expected.checkoutJwt
    || checkout.checkout_hash !== expected.checkoutHash
    || payment.transaction_id !== expected.checkoutHash
    || !merchantEquals(payment.payee, expected.payee)
    || payment.payment_amount.amount !== expected.amountMinorUsd
    || payment.payment_amount.currency !== "USD"
    || payment.payment_instrument.type !== "x402"
  ) fail("invalid_mandate");
}

function constraintType(constraint: Record<string, unknown>): string {
  if (typeof constraint.type !== "string" || !constraint.type) fail("unresolved_constraint");
  return constraint.type;
}

function evaluateCheckoutConstraints(
  open: Ap2OpenCheckoutMandate,
  expected: Ap2ExpectedBinding,
): void {
  let sawLineItems = false;
  for (const constraint of open.constraints) {
    switch (constraintType(constraint)) {
      case "checkout.allowed_merchants": {
        const parsed = z.object({
          type: z.literal("checkout.allowed_merchants"),
          allowed: z.array(merchantSchema).min(1).max(32),
        }).strict().safeParse(constraint);
        if (!parsed.success || !parsed.data.allowed.some((merchant) =>
          merchantEquals(merchant, expected.payee))) fail("invalid_mandate");
        break;
      }
      case "checkout.line_items": {
        const parsed = z.object({
          type: z.literal("checkout.line_items"),
          items: z.array(z.object({
            id: z.string().min(1).max(256),
            acceptable_items: z.array(z.object({
              id: z.string().min(1).max(256),
              title: z.string().min(1).max(256),
            }).strict()).min(1).max(32),
            quantity: z.number().int().positive().max(100),
          }).strict()).min(1).max(32),
        }).strict().safeParse(constraint);
        if (!parsed.success) fail("invalid_mandate");
        const matching = parsed.data.items.filter((requirement) =>
          requirement.quantity === 1
          && requirement.acceptable_items.some((item) =>
            item.id === expected.agentId && item.title === expected.agentSlug));
        if (matching.length !== 1 || parsed.data.items.length !== 1) fail("invalid_mandate");
        sawLineItems = true;
        break;
      }
      default:
        fail("unresolved_constraint");
    }
  }
  if (!sawLineItems) fail("invalid_mandate");
}

function evaluatePaymentConstraints(
  open: Ap2OpenPaymentMandate,
  closed: Ap2PaymentMandate,
  expected: Ap2ExpectedBinding,
  openCheckoutReference: string,
): void {
  for (const field of [
    "payee",
    "payment_amount",
    "payment_instrument",
    "pisp",
    "execution_date",
    "risk_data",
  ] as const) {
    if (open[field] !== undefined && !jsonEquals(open[field], closed[field])) {
      fail("invalid_mandate");
    }
  }

  let sawReference = false;
  for (const constraint of open.constraints) {
    const type = constraintType(constraint);
    if (type === "payment.budget" || type === "payment.agent_recurrence") {
      fail("unresolved_constraint");
    }
    switch (type) {
      case "payment.allowed_payees": {
        const parsed = z.object({
          type: z.literal("payment.allowed_payees"),
          allowed: z.array(merchantSchema).min(1).max(32),
        }).strict().safeParse(constraint);
        if (!parsed.success || !parsed.data.allowed.some((merchant) =>
          merchantEquals(merchant, expected.payee))) fail("invalid_mandate");
        break;
      }
      case "payment.allowed_payment_instruments": {
        const parsed = z.object({
          type: z.literal("payment.allowed_payment_instruments"),
          allowed: z.array(paymentInstrumentSchema).min(1).max(32),
        }).strict().safeParse(constraint);
        if (!parsed.success || !parsed.data.allowed.some((instrument) =>
          instrument.id === closed.payment_instrument.id
          && instrument.type === closed.payment_instrument.type)) fail("invalid_mandate");
        break;
      }
      case "payment.allowed_pisps": {
        const parsed = z.object({
          type: z.literal("payment.allowed_pisps"),
          allowed: z.array(pispSchema).min(1).max(32),
        }).strict().safeParse(constraint);
        if (
          !parsed.success
          || !closed.pisp
          || !parsed.data.allowed.some((pisp) => canonicalizeJson(pisp) === canonicalizeJson(closed.pisp))
        ) fail("invalid_mandate");
        break;
      }
      case "payment.amount_range": {
        const parsed = z.object({
          type: z.literal("payment.amount_range"),
          currency: z.string().regex(/^[A-Z]{3}$/u),
          min: z.number().int().nonnegative().optional(),
          max: z.number().int().nonnegative(),
        }).strict().safeParse(constraint);
        if (
          !parsed.success
          || parsed.data.currency !== closed.payment_amount.currency
          || closed.payment_amount.amount > parsed.data.max
          || parsed.data.min !== undefined && closed.payment_amount.amount < parsed.data.min
        ) fail("invalid_mandate");
        break;
      }
      case "payment.reference": {
        const parsed = z.object({
          type: z.literal("payment.reference"),
          conditional_transaction_id: z.string().min(1).max(512),
        }).strict().safeParse(constraint);
        if (!parsed.success || parsed.data.conditional_transaction_id !== openCheckoutReference) {
          fail("invalid_mandate");
        }
        sawReference = true;
        break;
      }
      case "payment.execution_date": {
        const parsed = z.object({
          type: z.literal("payment.execution_date"),
          not_before: z.string().max(64).optional(),
          not_after: z.string().max(64).optional(),
        }).strict().safeParse(constraint);
        const execution = closed.execution_date ? Date.parse(closed.execution_date) : Number.NaN;
        const notBefore = parsed.success && parsed.data.not_before
          ? Date.parse(parsed.data.not_before)
          : Number.NEGATIVE_INFINITY;
        const notAfter = parsed.success && parsed.data.not_after
          ? Date.parse(parsed.data.not_after)
          : Number.POSITIVE_INFINITY;
        if (
          !parsed.success
          || !Number.isFinite(execution)
          || parsed.data.not_before !== undefined && !Number.isFinite(notBefore)
          || parsed.data.not_after !== undefined && !Number.isFinite(notAfter)
          || notBefore > notAfter
          || execution < notBefore
          || execution > notAfter
        ) {
          fail("invalid_mandate");
        }
        break;
      }
      default:
        fail("unresolved_constraint");
    }
  }
  if (!sawReference) fail("invalid_mandate");
}

interface VerifiedPresentationPair {
  readonly checkout: Ap2CheckoutMandate;
  readonly payment: Ap2PaymentMandate;
  readonly issuer: string;
  readonly subject?: string;
}

async function verifyDirect(input: {
  readonly checkout: ParsedSdJwtPresentation;
  readonly payment: ParsedSdJwtPresentation;
  readonly expected: Ap2ExpectedBinding;
  readonly trustedIssuers: Ap2TrustedIssuerRegistry;
  readonly now: number;
  readonly clockSkewSeconds: number;
}): Promise<VerifiedPresentationPair> {
  if (input.checkout.segments.length !== 1 || input.payment.segments.length !== 1) fail();
  const checkoutRoot = input.checkout.segments[0];
  const paymentRoot = input.payment.segments[0];
  if (!checkoutRoot || !paymentRoot) fail();
  const checkoutIdentity = await verifyTrustedRoot(
    checkoutRoot, input.trustedIssuers, input.now, input.clockSkewSeconds,
  );
  const paymentIdentity = await verifyTrustedRoot(
    paymentRoot, input.trustedIssuers, input.now, input.clockSkewSeconds,
  );
  exactAudience(checkoutRoot, input.expected.audience);
  exactAudience(paymentRoot, input.expected.audience);
  exactNonce(checkoutRoot, input.expected.nonce);
  exactNonce(paymentRoot, input.expected.nonce);
  if (
    checkoutIdentity.issuer !== paymentIdentity.issuer
    || checkoutIdentity.subject !== paymentIdentity.subject
  ) fail("invalid_mandate");
  return {
    checkout: validateCheckoutMandate(checkoutRoot.effectivePayload),
    payment: validatePaymentMandate(paymentRoot.effectivePayload),
    issuer: checkoutIdentity.issuer,
    ...(checkoutIdentity.subject ? { subject: checkoutIdentity.subject } : {}),
  };
}

async function verifyAutonomous(input: {
  readonly checkout: ParsedSdJwtPresentation;
  readonly payment: ParsedSdJwtPresentation;
  readonly expected: Ap2ExpectedBinding;
  readonly trustedIssuers: Ap2TrustedIssuerRegistry;
  readonly now: number;
  readonly clockSkewSeconds: number;
  readonly checkoutPresentation: string;
}): Promise<VerifiedPresentationPair> {
  if (input.checkout.segments.length !== 2 || input.payment.segments.length !== 2) fail();
  const [checkoutRoot, checkoutClosed] = input.checkout.segments;
  const [paymentRoot, paymentClosed] = input.payment.segments;
  if (!checkoutRoot || !checkoutClosed || !paymentRoot || !paymentClosed) fail();
  const checkoutIdentity = await verifyTrustedRoot(
    checkoutRoot, input.trustedIssuers, input.now, input.clockSkewSeconds,
  );
  const paymentIdentity = await verifyTrustedRoot(
    paymentRoot, input.trustedIssuers, input.now, input.clockSkewSeconds,
  );
  if (
    checkoutIdentity.issuer !== paymentIdentity.issuer
    || checkoutIdentity.subject !== paymentIdentity.subject
  ) fail("invalid_mandate");
  const openCheckout = validateOpenCheckout(checkoutRoot.effectivePayload);
  const openPayment = validateOpenPayment(paymentRoot.effectivePayload);
  await verifyDelegatedClosed(
    checkoutRoot,
    checkoutClosed,
    openCheckout.cnf.jwk,
    input.expected,
    input.now,
    input.clockSkewSeconds,
  );
  await verifyDelegatedClosed(
    paymentRoot,
    paymentClosed,
    openPayment.cnf.jwk,
    input.expected,
    input.now,
    input.clockSkewSeconds,
  );
  const checkout = validateCheckoutMandate(checkoutClosed.effectivePayload);
  const payment = validatePaymentMandate(paymentClosed.effectivePayload);
  evaluateCheckoutConstraints(openCheckout, input.expected);
  evaluatePaymentConstraints(
    openPayment,
    payment,
    input.expected,
    rootSdJwtReference(input.checkoutPresentation, paymentRoot.jwtPayload._sd_alg),
  );
  return {
    checkout,
    payment,
    issuer: checkoutIdentity.issuer,
    ...(checkoutIdentity.subject ? { subject: checkoutIdentity.subject } : {}),
  };
}

export interface VerifyAp2AuthorizationInput {
  readonly authorizationMode: Ap2AuthorizationMode;
  readonly checkoutPresentation: string;
  readonly paymentPresentation: string;
  readonly expected: Ap2ExpectedBinding;
  readonly trustedIssuers: Ap2TrustedIssuerRegistry;
  readonly now?: number;
  readonly clockSkewSeconds?: number;
}

export async function verifyAp2Authorization(
  input: VerifyAp2AuthorizationInput,
): Promise<Ap2AuthorizationResult> {
  validateExpectedBinding(input.expected);
  const now = input.now ?? Math.floor(Date.now() / 1_000);
  const clockSkewSeconds = input.clockSkewSeconds ?? 30;
  if (!Number.isSafeInteger(now) || now <= 0 || !Number.isSafeInteger(clockSkewSeconds)
    || clockSkewSeconds < 0 || clockSkewSeconds > 300) fail();
  const checkout = parseSdJwtPresentation(input.checkoutPresentation);
  const payment = parseSdJwtPresentation(input.paymentPresentation);
  enforceSellerSdAlgorithm(checkout);
  enforceSellerSdAlgorithm(payment);
  const verified = input.authorizationMode === "direct"
    ? await verifyDirect({
      checkout,
      payment,
      expected: input.expected,
      trustedIssuers: input.trustedIssuers,
      now,
      clockSkewSeconds,
    })
    : await verifyAutonomous({
      checkout,
      payment,
      expected: input.expected,
      trustedIssuers: input.trustedIssuers,
      now,
      clockSkewSeconds,
      checkoutPresentation: input.checkoutPresentation,
    });
  verifyClosedBindings(verified.checkout, verified.payment, input.expected);
  return {
    mode: input.authorizationMode,
    checkoutReference: finalMandateReference(input.checkoutPresentation),
    paymentReference: finalMandateReference(input.paymentPresentation),
    paymentReplayIdentity: finalMandateReplayIdentity(input.paymentPresentation),
    issuer: verified.issuer,
    ...(verified.subject ? { subject: verified.subject } : {}),
    ...(verified.payment.payment_instrument.id
      ? { paymentInstrumentId: verified.payment.payment_instrument.id }
      : {}),
  };
}
