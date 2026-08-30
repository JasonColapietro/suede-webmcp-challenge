import { createHash, randomUUID } from "node:crypto";

import type { FlowRepo } from "@/lib/db/repo";
import type { PublishedLiveExecutionReceipt } from "@/lib/run-service";
import {
  Ap2ProtocolError,
  buildAp2RequestDigest,
  deriveMerchantJwks,
  issueMerchantCheckoutJwt,
  loadAp2RuntimeConfig,
  parseSdJwtPresentation,
  validateCheckoutMandate,
  verifyAp2Authorization,
  verifyMerchantCheckoutJwt,
  verifyMerchantCheckoutQuote,
  type Ap2AuthorizationMode,
  type Ap2AuthorizationResult,
  type Ap2ExpectedBinding,
  type Ap2RuntimeConfig,
} from "@/lib/rails/ap2";
import {
  USDC_TOKEN_ADDRESS,
  X402_FACILITATOR_NETWORK,
  X402_SCHEME,
  usdcToAtomic,
} from "@/lib/rails/x402-verify";

export const AP2_PROFILE = "ap2-v0.2-experimental" as const;

export interface Ap2PresentedAuthorization {
  readonly authorizationMode: Ap2AuthorizationMode;
  readonly checkoutMandateSdJwt: string;
  readonly paymentMandateSdJwt: string;
}

export interface Ap2RunTerms {
  readonly agentId: string;
  readonly agentSlug: string;
  readonly flowId: string;
  readonly live: PublishedLiveExecutionReceipt;
  readonly resource: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly runVariables?: Readonly<Record<string, unknown>>;
  readonly priceUsdc: number;
  readonly payTo: string;
  readonly siteOrigin: string;
}

export interface IssuedAp2Checkout {
  readonly checkoutJwt: string;
  readonly checkoutHash: string;
  readonly challengeNonce: string;
  readonly expiresAt: number;
  readonly binding: Ap2ExpectedBinding;
}

function replayStoreAvailable(repo: FlowRepo): boolean {
  return typeof repo.reserveAp2Authorization === "function"
    && typeof repo.getAp2AuthorizationByMandateReference === "function"
    && typeof repo.transitionAp2Authorization === "function"
    && typeof repo.checkAp2ReplayStoreReady === "function";
}

export async function loadAp2RunConfig(repo: FlowRepo): Promise<Ap2RuntimeConfig> {
  let replayStoreReady = false;
  if (replayStoreAvailable(repo) && process.env.AP2_REPLAY_STORE_READY === "1") {
    try {
      replayStoreReady = await repo.checkAp2ReplayStoreReady();
    } catch {
      replayStoreReady = false;
    }
  }
  return loadAp2RuntimeConfig({
    replayStoreReady,
  });
}

function amountMinorUsd(priceUsdc: number): number {
  const atomic = BigInt(usdcToAtomic(priceUsdc));
  // AP2 v0.2 expresses USD in ISO-4217 minor units. Refuse prices that cannot
  // be represented exactly in cents instead of silently rounding authorization.
  if (atomic % 10_000n !== 0n) throw new Ap2ProtocolError("invalid_mandate");
  const cents = atomic / 10_000n;
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Ap2ProtocolError("invalid_mandate");
  return Number(cents);
}

function expectedBinding(
  terms: Ap2RunTerms,
  input: {
    readonly nonce: string;
    readonly checkoutJwt: string;
    readonly checkoutHash: string;
  },
): Ap2ExpectedBinding {
  return {
    audience: terms.resource,
    nonce: input.nonce,
    checkoutJwt: input.checkoutJwt,
    checkoutHash: input.checkoutHash,
    agentId: terms.agentId,
    agentSlug: terms.agentSlug,
    flowId: terms.flowId,
    deploymentId: terms.live.deploymentId,
    flowVersionId: terms.live.flowVersionId,
    fullHash: terms.live.fullHash,
    resource: terms.resource,
    method: "POST",
    requestDigest: buildAp2RequestDigest({
      method: "POST",
      resource: terms.resource,
      body: {
        input: terms.input,
        ...(terms.runVariables ? { runVariables: terms.runVariables } : {}),
      },
    }),
    priceUsdc: terms.priceUsdc,
    amountAtomic: usdcToAtomic(terms.priceUsdc),
    amountMinorUsd: amountMinorUsd(terms.priceUsdc),
    payee: {
      id: "suede-agent-studio",
      name: "Suede Agent Studio",
      website: terms.siteOrigin,
    },
    payTo: terms.payTo,
    network: X402_FACILITATOR_NETWORK,
    asset: USDC_TOKEN_ADDRESS,
    scheme: X402_SCHEME,
  };
}

function requireReadyRuntime(runtime: Ap2RuntimeConfig) {
  if (!runtime.readiness.ready || !runtime.signing || !runtime.trustedIssuers) {
    throw new Ap2ProtocolError("ap2_not_ready");
  }
  return { signing: runtime.signing, trustedIssuers: runtime.trustedIssuers };
}

export async function issueAp2Checkout(input: {
  readonly runtime: Ap2RuntimeConfig;
  readonly terms: Ap2RunTerms;
  readonly issuedAt?: number;
}): Promise<IssuedAp2Checkout> {
  const { signing } = requireReadyRuntime(input.runtime);
  const challengeNonce = `${randomUUID()}.${randomUUID()}`;
  const unsigned = expectedBinding(input.terms, {
    nonce: challengeNonce,
    checkoutJwt: "pending",
    checkoutHash: "pending",
  });
  const issued = await issueMerchantCheckoutJwt({
    signing,
    binding: unsigned,
    ...(input.issuedAt === undefined ? {} : { issuedAt: input.issuedAt }),
  });
  return {
    ...issued,
    challengeNonce,
    binding: expectedBinding(input.terms, {
      nonce: challengeNonce,
      checkoutJwt: issued.checkoutJwt,
      checkoutHash: issued.checkoutHash,
    }),
  };
}

function closedCheckoutFromPresentation(presentation: string) {
  const parsed = parseSdJwtPresentation(presentation);
  const closed = parsed.segments.at(-1);
  if (!closed) throw new Ap2ProtocolError("invalid_mandate");
  return validateCheckoutMandate(closed.effectivePayload);
}

export interface VerifiedAp2RunAuthorization {
  readonly authorization: Ap2AuthorizationResult;
  readonly expected: Ap2ExpectedBinding;
  readonly expiresAt: number;
}

export async function verifyAp2RunAuthorization(input: {
  readonly runtime: Ap2RuntimeConfig;
  readonly terms: Ap2RunTerms;
  readonly presentation: Ap2PresentedAuthorization;
  readonly now?: number;
}): Promise<VerifiedAp2RunAuthorization> {
  const { signing, trustedIssuers } = requireReadyRuntime(input.runtime);
  const closedCheckout = closedCheckoutFromPresentation(
    input.presentation.checkoutMandateSdJwt,
  );
  const publicJwks = await deriveMerchantJwks(signing);
  const quote = await verifyMerchantCheckoutQuote({
    checkoutJwt: closedCheckout.checkout_jwt,
    publicJwks,
    issuer: signing.issuer,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  if (closedCheckout.checkout_hash !== quote.checkoutHash) {
    throw new Ap2ProtocolError("invalid_mandate");
  }
  const expected = expectedBinding(input.terms, {
    nonce: quote.binding.nonce,
    checkoutJwt: closedCheckout.checkout_jwt,
    checkoutHash: closedCheckout.checkout_hash,
  });
  await verifyMerchantCheckoutJwt({
    checkoutJwt: closedCheckout.checkout_jwt,
    publicJwks,
    expected,
    issuer: signing.issuer,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  const authorization = await verifyAp2Authorization({
    authorizationMode: input.presentation.authorizationMode,
    checkoutPresentation: input.presentation.checkoutMandateSdJwt,
    paymentPresentation: input.presentation.paymentMandateSdJwt,
    expected,
    trustedIssuers,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  return { authorization, expected, expiresAt: quote.expiresAt };
}

/** EIP-3009 nonce required by Suede's experimental AP2-to-x402 v2 profile. */
export function expectedAp2X402Nonce(
  paymentReference: string,
  checkoutHash: string,
): string {
  return `0x${createHash("sha256")
    .update("suede-ap2-x402-v1\0", "utf8")
    .update(paymentReference, "ascii")
    .update("\0", "utf8")
    .update(checkoutHash, "ascii")
    .digest("hex")}`;
}

export function hashAp2PaymentNonce(input: {
  readonly network: string;
  readonly asset: string;
  readonly payer: string;
  readonly nonce: string;
}): string {
  return createHash("sha256")
    .update("suede-ap2-eip3009-v1\0", "utf8")
    .update(input.network.toLowerCase(), "utf8")
    .update("\0", "utf8")
    .update(input.asset.toLowerCase(), "utf8")
    .update("\0", "utf8")
    .update(input.payer.toLowerCase(), "utf8")
    .update("\0", "utf8")
    .update(input.nonce, "utf8")
    .digest("base64url");
}

/** Canonical AP2 identifier for the x402 EIP-3009 authorizer (CAIP-10). */
export function ap2X402PaymentInstrumentId(network: string, payer: string): string {
  if (network !== X402_FACILITATOR_NETWORK || !/^0x[0-9a-fA-F]{40}$/u.test(payer)) {
    throw new Ap2ProtocolError("invalid_mandate");
  }
  return `${network}:${payer.toLowerCase()}`;
}
