import type { JWK } from "jose";

export const AP2_EXTENSION_URI =
  "https://github.com/google-agentic-commerce/ap2/v1";
export const AP2_CHECKOUT_MANDATE_DATA_KEY =
  "ap2.mandates.CheckoutMandateSdJwt";
export const AP2_PAYMENT_MANDATE_DATA_KEY =
  "ap2.mandates.PaymentMandateSdJwt";
export const AP2_CHECKOUT_RECEIPT_DATA_KEY = "ap2.CheckoutReceipt";

/** Machine-readable limits of Suede's experimental merchant-only profile. */
export const AP2_SELLER_SUBPROFILE = Object.freeze({
  trustedIssuerAlgorithms: "configured allowlist",
  rootTrustResolution: "pinned-exact-or-unique-compatible-key",
  acceptedSdAlgorithms: Object.freeze(["sha-256"]),
  delegatedKey: Object.freeze({
    kty: "EC",
    crv: "P-256",
    alg: "ES256",
    kidMember: "optional",
    algMember: "optional",
  }),
  requiredClaims: Object.freeze(["iat", "exp", "aud", "nonce"]),
  autonomousRootRequiredClaims: Object.freeze(["iat", "exp"]),
  maximumDelegationHops: 1,
  supportedCheckoutConstraints: Object.freeze([
    "checkout.allowed_merchants",
    "checkout.line_items",
  ]),
  supportedPaymentConstraints: Object.freeze([
    "payment.allowed_payees",
    "payment.allowed_payment_instruments",
    "payment.allowed_pisps",
    "payment.amount_range",
    "payment.reference",
    "payment.execution_date",
  ]),
  unknownConstraints: "rejected",
  statefulOpenPaymentConstraints: false,
  openPaymentPresetClaims: Object.freeze([
    "payee",
    "payment_amount",
    "payment_instrument",
    "pisp",
    "execution_date",
    "risk_data",
  ]),
  openPaymentPresetRule: "exact-match-closed",
  paymentInstrumentId: "CAIP-10 eip155:8453:<payer-address>",
  receiptReferenceRule: "sd-hash-final-sd-jwt",
} as const);

export const AP2_CHECKOUT_VCT = "mandate.checkout.1";
export const AP2_OPEN_CHECKOUT_VCT = "mandate.checkout.open.1";
export const AP2_PAYMENT_VCT = "mandate.payment.1";
export const AP2_OPEN_PAYMENT_VCT = "mandate.payment.open.1";

export type Ap2Mode = "off" | "optional" | "required";
export type Ap2AuthorizationMode = "direct" | "autonomous";
export type Ap2ErrorCode =
  | "invalid_credential"
  | "unresolved_constraint"
  | "invalid_mandate"
  | "mandates_not_supported"
  | "ap2_not_ready";

const ERROR_MESSAGES: Readonly<Record<Ap2ErrorCode, string>> = {
  invalid_credential: "AP2 credential verification failed.",
  unresolved_constraint: "AP2 mandate contains an unsupported constraint.",
  invalid_mandate: "AP2 mandate does not authorize this request.",
  mandates_not_supported: "AP2 mandates are not supported for this request.",
  ap2_not_ready: "AP2 verification is not ready.",
};

/** A fixed-message protocol failure that never includes raw token material. */
export class Ap2ProtocolError extends Error {
  readonly code: Ap2ErrorCode;

  constructor(code: Ap2ErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "Ap2ProtocolError";
    this.code = code;
  }
}

export interface Ap2Merchant {
  readonly id: string;
  readonly name: string;
  readonly website?: string;
}

export interface Ap2ExpectedBinding {
  readonly audience: string;
  readonly nonce: string;
  readonly checkoutJwt: string;
  readonly checkoutHash: string;
  readonly agentId: string;
  readonly agentSlug: string;
  readonly flowId: string;
  readonly deploymentId: string;
  readonly flowVersionId: string;
  readonly fullHash: string;
  readonly resource: string;
  readonly method: "POST";
  readonly requestDigest: string;
  readonly priceUsdc: number;
  readonly amountAtomic: string;
  readonly amountMinorUsd: number;
  readonly payee: Ap2Merchant;
  readonly payTo: string;
  readonly network: "eip155:8453";
  readonly asset: string;
  readonly scheme: "exact";
}

export interface Ap2CheckoutSnapshot {
  readonly profile: "ap2-v0.2-experimental";
  /** Merchant-issued, one-time verifier challenge bound into the signed quote. */
  readonly nonce: string;
  readonly agentId: string;
  readonly agentSlug: string;
  readonly flowId: string;
  readonly deploymentId: string;
  readonly flowVersionId: string;
  readonly fullHash: string;
  readonly resource: string;
  readonly method: "POST";
  readonly requestDigest: string;
  readonly priceUsdc: number;
  readonly amountAtomic: string;
  readonly amountMinorUsd: number;
  readonly payee: Ap2Merchant;
  readonly payTo: string;
  readonly network: "eip155:8453";
  readonly asset: string;
  readonly scheme: "exact";
  readonly items: readonly [{
    readonly id: string;
    readonly title: string;
    readonly quantity: 1;
  }];
}

export interface Ap2MerchantSigningConfig {
  readonly issuer: string;
  readonly keyId: string;
  readonly privateKeyPem?: string;
  readonly privateJwk?: JWK;
}

export interface Ap2TrustedIssuer {
  readonly issuer: string;
  readonly algorithms: readonly Ap2AsymmetricAlgorithm[];
  readonly keys: readonly JWK[];
}

export interface Ap2TrustedIssuerRegistry {
  readonly byIssuer: ReadonlyMap<string, Ap2TrustedIssuer>;
}

export type Ap2AsymmetricAlgorithm = "ES256" | "EdDSA" | "RS256" | "PS256";

export interface Ap2AuthorizationResult {
  readonly mode: Ap2AuthorizationMode;
  readonly checkoutReference: string;
  readonly paymentReference: string;
  /** Stable final issuer-JWT hash for durable replay reservation and lookup. */
  readonly paymentReplayIdentity: string;
  readonly issuer: string;
  readonly subject?: string;
  readonly paymentInstrumentId?: string;
}

export interface Ap2Jwks {
  readonly keys: readonly JWK[];
}
