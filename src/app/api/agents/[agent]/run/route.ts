/**
 * x402-gated machine run for a published agent.
 * POST /api/agents/[agent]/run — [agent] is an id or slug. Verifies payment
 * (or dry-runs), executes the underlying flow, returns the run summary.
 */
import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  getRepo,
  isAp2TerminalEvidenceExpired,
  type Ap2AuthorizationRecord,
  type Ap2SanitizedJson,
} from "@/lib/db/repo";
import { resolveAgent } from "@/lib/agents";
import {
  bindPreparedPublishedLiveResourceSnapshot,
  disposePreparedPublishedLiveExecution,
  consumePreparedPublishedLiveRelay,
  preparePublishedLiveExecution,
  preparedPublishedLiveExecutionReceipt,
  preparedPublishedLiveRelaySnapshot,
  runModeResponseFields,
  runPreparedPublishedLiveToCompletion,
  runPreparedPublishedLiveDryRunToCompletion,
  runIdFromExecutionError,
  triggerInputContractViolations,
  type PreparedPublishedLiveExecution,
} from "@/lib/run-service";
import { deriveInputSchema } from "@/lib/flow/input-contract";
import {
  curatedBusinessService,
  extractCuratedServiceResult,
  publishedServiceInputSchema,
} from "@/lib/curated-business-services";
import { resolvePayout } from "@/lib/payout";
import { checkRateLimit, ipFromRequest } from "@/lib/rate-limit";
import {
  decodePaymentHeader,
  verifyAndSettle,
  buildX402BazaarExtensions,
  buildX402PaymentRequired,
  encodeX402Header,
  USDC_TOKEN_ADDRESS,
  X402_FACILITATOR_NETWORK,
  X402_SCHEME,
  usdcToAtomic,
  verifyX402AuthorizationSignature,
  x402AuthorizationIdentity,
} from "@/lib/rails/x402-verify";
import {
  Ap2ProtocolError,
  AP2_SELLER_SUBPROFILE,
  buildAp2RequestDigest,
  finalMandateReference,
  finalMandateReplayIdentity,
  issueCheckoutReceipt,
} from "@/lib/rails/ap2";
import {
  AP2_PROFILE,
  ap2X402PaymentInstrumentId,
  expectedAp2X402Nonce,
  hashAp2PaymentNonce,
  issueAp2Checkout,
  loadAp2RunConfig,
  verifyAp2RunAuthorization,
  type Ap2RunTerms,
} from "@/lib/rails/ap2-runtime";
import { reconcileX402AuthorizationState } from "@/lib/rails/x402-reconcile";
import { sanitizeAp2Json } from "@/lib/rails/ap2-sanitize";
import { isAp2ServiceEligible } from "@/lib/rails/ap2-eligibility";
import { forwardToRelay, RelayError } from "@/lib/relay";
import {
  executeRelayV2,
  queryRelayV2Status,
  relayV2EndpointBindingHash,
  relayV2RequestWindow,
  RELAY_V2_PROTOCOL,
  type RelayV2Delivery,
} from "@/lib/relay-v2";
import { isDryRunRequested, resolveRunMode } from "@/lib/run-mode";
import {
  API_OPERATION_LIVE_UNAVAILABLE,
  ApiOperationLiveUnavailableError,
} from "@/lib/connectors/operation-closure";
import { flowToManifest } from "@/lib/manifest/from-flow";
import { publicCallBudgetBlock } from "@/lib/company/guardrails";
import { isFlowGraphV2 } from "@/lib/flow/graph-schema";
import type { SupportedFlowGraph } from "@/lib/flow/types";
import { publishedResourceAccess } from "@/lib/resources/public-access";
import {
  RESOURCE_CONTRACT_EXTENSION_URI,
  publicResourceDependencyContractMatches,
  resolvePublicResourcePreviewContract,
  resolvePublicServiceContractFromRelease,
  type PublicServiceContract,
} from "@/lib/public-service-contract";
import { getResourceRepository } from "@/lib/resources/provider";
import {
  buildAndPersistResourceRunEnvelope,
  buildResourcePublicPreviewEnvelope,
} from "@/lib/resources/run-receipt";
import { parseResourcePackBundle } from "@/lib/resources/query";
import { resourcePackSemanticHash } from "@/lib/resources/pack-hash";
import { RESOURCE_FOUNDRY_ENABLED } from "@/lib/resources/flags";
import { loadExactFreshResourcePackSnapshot } from "@/lib/projects/resource-dependencies";

export const runtime = "nodejs";

const runBodySchema = z.object({
  input: z.record(z.string(), z.unknown()).optional(),
  runVariables: z.record(z.string(), z.unknown()).optional(),
  dryRun: z.boolean().optional(),
  ap2: z.object({
    authorizationMode: z.enum(["direct", "autonomous"]),
    checkoutMandateSdJwt: z.string().min(1).max(96 * 1024),
    paymentMandateSdJwt: z.string().min(1).max(96 * 1024),
  }).strict().optional(),
});

const MAX_RUN_BODY_BYTES = 256 * 1024;
const RELAY_V2_RECONCILIATION_SKEW_MS = 30_000;

interface RouteContext {
  params: Promise<{ agent: string }>;
}

function isApiOperationLiveUnavailable(error: unknown): boolean {
  return error instanceof ApiOperationLiveUnavailableError ||
    (typeof error === "object" && error !== null &&
      Reflect.get(error, "code") === API_OPERATION_LIVE_UNAVAILABLE);
}

async function readRunBody(req: Request): Promise<unknown | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_RUN_BODY_BYTES) return null;
  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RUN_BODY_BYTES) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

function ap2ErrorStatus(error: Ap2ProtocolError): number {
  return error.code === "ap2_not_ready" ? 503
    : error.code === "mandates_not_supported" ? 400
      : 403;
}

function safeCheckoutReference(presentation: string): string | null {
  try {
    return finalMandateReference(presentation);
  } catch {
    return null;
  }
}

function safePaymentReplayIdentity(presentation: string): string | null {
  try {
    return finalMandateReplayIdentity(presentation);
  } catch {
    return null;
  }
}

function ordinaryPaymentRunId(agentId: string, paymentHeader: string): string {
  const digest = createHash("sha256")
    .update("suede-agent-studio:ordinary-x402-run:v1\0")
    .update(agentId)
    .update("\0")
    .update(paymentHeader)
    .digest("hex")
    .slice(0, 32)
    .split("");
  digest[12] = "5";
  digest[16] = ((Number.parseInt(digest[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  const value = digest.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function isAmbiguousSettlementFailure(reason: string): boolean {
  return reason.startsWith("facilitator_settle_") || reason === "settle_failed";
}

function ordinaryPaymentReconciliationResponse(input: {
  readonly runId: string;
  readonly transaction: string | null;
}): NextResponse {
  return NextResponse.json({
    error: "payment_pending_manual_reconciliation",
    message: "Settlement outcome is ambiguous; reconcile this durable run before retrying.",
    runId: input.runId,
    transaction: input.transaction,
  }, {
    status: 503,
    headers: {
      "cache-control": "private, no-store",
      "retry-after": "30",
    },
  });
}

function ap2ResponseEnvelope(status: number, body: Ap2SanitizedJson): Ap2SanitizedJson {
  return { httpStatus: status, body };
}

function storedAp2Response(value: Ap2SanitizedJson | null): {
  readonly status: number;
  readonly body: Ap2SanitizedJson;
} | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const status = value.httpStatus;
  if (!Number.isSafeInteger(status) || (status as number) < 100 || (status as number) > 599
    || !Object.prototype.hasOwnProperty.call(value, "body")) return null;
  return { status: status as number, body: value.body ?? null };
}

interface StoredRelayReconciliation {
  readonly protocol: typeof RELAY_V2_PROTOCOL;
  readonly endpointBinding: string;
  readonly notAfter: string;
  readonly deliveryId: string;
}

interface StoredAp2AuthorizationMetadata {
  readonly mode: "direct" | "autonomous";
  readonly checkoutReference: string;
  readonly paymentReference: string;
}

function storedAp2AuthorizationMetadata(
  value: Ap2SanitizedJson | null,
): StoredAp2AuthorizationMetadata | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const authorization = value.authorization;
  if (typeof authorization !== "object" || authorization === null || Array.isArray(authorization)) {
    return null;
  }
  if (
    authorization.mode !== "direct" && authorization.mode !== "autonomous"
    || typeof authorization.checkoutReference !== "string"
    || authorization.checkoutReference.length < 1
    || typeof authorization.paymentReference !== "string"
    || authorization.paymentReference.length < 1
  ) return null;
  return {
    mode: authorization.mode,
    checkoutReference: authorization.checkoutReference,
    paymentReference: authorization.paymentReference,
  };
}

interface Ap2RouteAuthorization {
  readonly mode: "direct" | "autonomous";
  readonly checkoutReference: string;
  readonly paymentReference: string;
  readonly paymentReplayIdentity: string;
  readonly paymentInstrumentId?: string;
  readonly issuer: string;
  readonly subject?: string;
  readonly requestDigest: string;
  readonly checkoutHash: string;
  readonly amountMinorUsd: number;
  readonly payeeId: string;
  readonly expiresAt: number;
}

function storedRelayReconciliation(value: Ap2SanitizedJson | null): StoredRelayReconciliation | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const relay = value.relay;
  if (typeof relay !== "object" || relay === null || Array.isArray(relay)) return null;
  if (
    relay.protocol !== RELAY_V2_PROTOCOL
    || typeof relay.endpointBinding !== "string"
    || typeof relay.notAfter !== "string"
    || !Number.isFinite(Date.parse(relay.notAfter))
    || typeof relay.deliveryId !== "string"
    || relay.deliveryId.length === 0
  ) return null;
  return {
    protocol: RELAY_V2_PROTOCOL,
    endpointBinding: relay.endpointBinding,
    notAfter: relay.notAfter,
    deliveryId: relay.deliveryId,
  };
}

function relayResponsePayload(params: {
  readonly runId: string;
  readonly output: unknown;
  readonly didSettle: boolean;
  readonly transaction: string | null;
  readonly payer: string | null;
  readonly checkoutReceipt: string | null;
  readonly authorizationMode: "direct" | "autonomous" | null;
}): Ap2SanitizedJson {
  return {
    runId: params.runId,
    status: "done",
    totalCostUsdc: 0,
    outputs: { relay: params.output as Ap2SanitizedJson },
    relayed: true,
    settled: params.didSettle,
    ...(params.transaction !== null ? { transaction: params.transaction } : {}),
    ...(params.payer !== null ? { payer: params.payer } : {}),
    ...(params.checkoutReceipt ? {
      ap2: {
        profile: AP2_PROFILE,
        authorizationMode: params.authorizationMode,
        checkoutReceipt: params.checkoutReceipt,
      },
    } : {}),
  };
}

function relayPendingResponse(unavailable = false): NextResponse {
  return NextResponse.json({
    error: "relay_fulfillment_pending",
    message: "The paid relay delivery is being reconciled and will not be executed again.",
  }, {
    status: unavailable ? 503 : 202,
    headers: { "retry-after": unavailable ? "10" : "3" },
  });
}

function relayTerminalFailure(message: string): { readonly error: string; readonly message: string } {
  return { error: "relay_error", message };
}

async function replayTerminalAp2Response(input: {
  readonly req: Request;
  readonly repo: Awaited<ReturnType<typeof getRepo>>;
  readonly agent: Readonly<{ id: string; slug: string }>;
  readonly flowId: string;
}): Promise<NextResponse | null> {
  const raw = await readRunBody(input.req);
  if (raw === null) return null;
  const parsed = runBodySchema.safeParse(raw);
  if (!parsed.success || !parsed.data.ap2) return null;
  const requestUrl = new URL(input.req.url);
  if (isDryRunRequested(requestUrl, input.req.headers, parsed.data)
    || requestUrl.searchParams.get("ap2Checkout") === "1") return null;
  const paymentHeader = input.req.headers.get("payment-signature")
    ?? input.req.headers.get("x-payment");
  if (!paymentHeader) return null;

  const paymentReference = safeCheckoutReference(parsed.data.ap2.paymentMandateSdJwt);
  const paymentReplayIdentity = safePaymentReplayIdentity(parsed.data.ap2.paymentMandateSdJwt);
  const checkoutReference = safeCheckoutReference(parsed.data.ap2.checkoutMandateSdJwt);
  if (!paymentReference || !paymentReplayIdentity || !checkoutReference) return null;
  const persisted = await input.repo.getAp2AuthorizationByMandateReference(paymentReplayIdentity);
  const metadata = persisted ? storedAp2AuthorizationMetadata(persisted.receiptJson) : null;
  if (!persisted || !metadata || (persisted.state !== "completed"
    && persisted.state !== "failed" && persisted.state !== "rejected")) return null;

  const siteOrigin = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://agents.suedeai.ai")
    .replace(/\/+$/, "");
  const resourceUrl = `${siteOrigin}/api/agents/${input.agent.slug}/run`;
  const identity = x402AuthorizationIdentity(paymentHeader);
  const payment = decodePaymentHeader(paymentHeader);
  const accepted = payment?.x402Version === 2 ? payment.accepted : null;
  const requestDigest = buildAp2RequestDigest({
    method: "POST",
    resource: resourceUrl,
    body: {
      input: parsed.data.input ?? {},
      ...(parsed.data.runVariables ? { runVariables: parsed.data.runVariables } : {}),
    },
  });
  const expectedNonce = expectedAp2X402Nonce(paymentReplayIdentity, persisted.checkoutHash);
  const validBefore = identity ? Number(identity.validBefore) : Number.NaN;
  const paymentValidBefore = Number.isSafeInteger(validBefore)
    && validBefore >= 0 && validBefore <= 8_640_000_000_000
    ? new Date(validBefore * 1_000).toISOString()
    : null;
  const authenticated = await verifyX402AuthorizationSignature(paymentHeader);
  if (
    metadata.mode !== parsed.data.ap2.authorizationMode
    || metadata.paymentReference !== paymentReference
    || metadata.checkoutReference !== checkoutReference
    || persisted.mandateReference !== paymentReplayIdentity
    || persisted.requestDigest !== requestDigest
    || persisted.agentId !== input.agent.id
    || persisted.flowId !== input.flowId
    || identity === null
    || payment?.x402Version !== 2
    || accepted === null
    || payment.resource?.url !== resourceUrl
    || identity.network !== persisted.network
    || identity.asset?.toLowerCase() !== persisted.asset.toLowerCase()
    || identity.scheme !== X402_SCHEME
    || identity.payer.toLowerCase() !== persisted.payer.toLowerCase()
    || identity.payTo.toLowerCase() !== persisted.payTo.toLowerCase()
    || identity.amountAtomic !== persisted.amountAtomic
    || identity.nonce.toLowerCase() !== expectedNonce.toLowerCase()
    || accepted.network !== persisted.network
    || accepted.asset.toLowerCase() !== persisted.asset.toLowerCase()
    || accepted.scheme !== X402_SCHEME
    || accepted.payTo.toLowerCase() !== persisted.payTo.toLowerCase()
    || accepted.amount !== persisted.amountAtomic
    || paymentValidBefore !== persisted.paymentValidBefore
    || hashAp2PaymentNonce({
      network: identity.network,
      asset: identity.asset!,
      payer: identity.payer,
      nonce: identity.nonce,
    }) !== persisted.paymentNonceHash
    || !authenticated
  ) return null;

  const stored = storedAp2Response(persisted.resultJson);
  if (stored) {
    return NextResponse.json(stored.body, {
      status: stored.status,
      headers: { "cache-control": "no-store" },
    });
  }
  if (!isAp2TerminalEvidenceExpired(persisted.receiptJson)) return null;
  return NextResponse.json({
    error: "ap2_terminal_evidence_expired",
    state: persisted.state,
    ...(persisted.runId ? { runId: persisted.runId } : {}),
  }, { status: 410, headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request, { params }: RouteContext): Promise<NextResponse> {
  // Rate-limit before any DB work. Default bucket: 10 burst, 0.5 req/s refill.
  const ip = ipFromRequest(req);
  const rl = checkRateLimit(`run:${ip}`);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "rate_limited", message: `Too many requests. Retry after ${rl.retryAfterSec}s.` },
      {
        status: 429,
        headers: { "Retry-After": String(rl.retryAfterSec) },
      },
    );
  }

  try {
    const { agent: agentParam } = await params;
    const agent = await resolveAgent(agentParam);
    if (!agent) {
      return NextResponse.json({ error: "agent not found" }, { status: 404 });
    }
    // Draft includes explicitly unpublished agents and former company
    // employees. Immutable Live deployments remain preserved, but this public
    // route must never execute an agent after its publication status is removed.
    if (agent.status !== "live") {
      return NextResponse.json({ error: "agent not found" }, { status: 404 });
    }

    const repo = await getRepo();
    const flow = await repo.getFlow(agent.flowId);
    if (!flow) {
      return NextResponse.json({ error: "flow not found" }, { status: 404 });
    }
    // The emergency switch must win before AP2 terminal replay, immutable
    // execution preparation, Resource persistence reads, or payment work.
    if (!RESOURCE_FOUNDRY_ENABLED && flow.graph.meta?.resourceProduct !== undefined) {
      return NextResponse.json({ error: "agent not found" }, { status: 404 });
    }
    const globalLive = process.env.X402_SKIP_SETTLEMENT === "false";
    let preparedLive: PreparedPublishedLiveExecution | null = null;
    try {
      try {
        preparedLive = await preparePublishedLiveExecution({
          flowId: flow.id,
          ownerId: flow.ownerId,
          agent: { id: agent.id, priceUsdc: agent.priceUsdc },
        });
      } catch (error) {
        if (isApiOperationLiveUnavailable(error)) {
          return NextResponse.json({ error: API_OPERATION_LIVE_UNAVAILABLE }, { status: 409 });
        }
        throw error;
      }
      if (!preparedLive || !preparedLive.agent ||
          preparedLive.agent.id !== agent.id ||
          preparedLive.agent.flowId !== flow.id ||
          preparedLive.agent.priceUsdc !== agent.priceUsdc) {
        return NextResponse.json({ error: "published run unavailable" }, { status: 503 });
      }
      const preparedGraph = preparedLive.graph as SupportedFlowGraph;
      const hasResourceMarker = preparedGraph.meta?.resourceProduct !== undefined;
      const hasResourceDependencies = preparedLive.resourceDependencies.length > 0;
      if (!publicResourceDependencyContractMatches({
            graph: preparedLive.graph,
            resourceDependencies: preparedLive.resourceDependencies,
            release: preparedLive.release,
          }) ||
          hasResourceMarker !== hasResourceDependencies ||
          (hasResourceDependencies && !RESOURCE_FOUNDRY_ENABLED)) {
        disposePreparedPublishedLiveExecution(preparedLive);
        return NextResponse.json({ error: "agent not found" }, { status: 404 });
      }
      const publicRelease = Object.freeze({
        graph: preparedLive.graph,
        resourceDependencies: preparedLive.resourceDependencies,
        release: preparedLive.release,
      });
      const previewService = hasResourceDependencies
        ? resolvePublicResourcePreviewContract({ agent, flow, publicRelease })
        : null;
      const immutableResourceAccess = publishedResourceAccess(preparedGraph);
      if (hasResourceDependencies && (!previewService ||
          previewService.resource?.access.execution === "private" ||
          immutableResourceAccess?.executionAccess === "private")) {
        return NextResponse.json({ error: "agent not found" }, { status: 404 });
      }
      if (previewService?.kind === "resource") {
        const previewResource = previewService.resource;
        if (!previewResource) {
          return NextResponse.json({ error: "agent not found" }, { status: 404 });
        }
        const previewBody = await readRunBody(req.clone());
        if (previewBody === null) {
          return NextResponse.json({ error: "request_too_large" }, { status: 413 });
        }
        const previewRequest = runBodySchema.safeParse(previewBody);
        if (!previewRequest.success) {
          return NextResponse.json({ error: "invalid request body" }, { status: 400 });
        }
        const requestedPreview = isDryRunRequested(new URL(req.url), req.headers, previewRequest.data);
        if (requestedPreview) {
          const inputViolations = triggerInputContractViolations(
            previewService.inputSchema as ReturnType<typeof deriveInputSchema>,
            previewRequest.data.input ?? {},
          );
          if (inputViolations.length > 0) {
            return NextResponse.json({ error: "invalid_input", violations: inputViolations }, { status: 400 });
          }
          if (previewRequest.data.ap2) {
            return NextResponse.json(
              { error: "mandates_not_supported", message: "AP2 authorization is only used for priced Live calls." },
              { status: 400 },
            );
          }
          if (previewResource.access.execution === "paid") {
            return NextResponse.json({
              error: "resource_public_preview_forbidden",
              message: "Paid Resources do not expose public previews.",
            }, { status: 403 });
          }
          if (new URL(req.url).searchParams.get("ap2Checkout") === "1") {
            return NextResponse.json({
              error: "ap2_checkout_unavailable",
              message: "AP2 checkout is available only for priced services with Live settlement enabled.",
            }, { status: 503 });
          }
          const relay = preparedPublishedLiveRelaySnapshot(preparedLive);
          if (relay !== null) {
            return NextResponse.json({ error: "published run unavailable" }, { status: 503 });
          }
          const previewRepository = await getResourceRepository().catch(() => null);
          const previewPortfolio = previewRepository
            ? await previewRepository.getOwnedPortfolioItem(
                preparedLive.release.ownerId,
                previewResource.resourceProductId,
              ).catch(() => null)
            : null;
          const currentRelease = previewPortfolio?.currentRelease;
          if (!currentRelease ||
              currentRelease.resourceProductId !== previewResource.resourceProductId ||
              currentRelease.packVersionId !== previewResource.resourceVersion ||
              currentRelease.semanticHash !== previewResource.semanticHash ||
              currentRelease.executionAccess !== previewResource.access.execution ||
              currentRelease.discoveryAccess !== previewResource.access.discovery ||
              currentRelease.priceUsdc !== agent.priceUsdc ||
              currentRelease.agentId !== agent.id ||
              currentRelease.agentStatus !== "live" ||
              currentRelease.flowVersionId !== preparedLive.release.flowVersionId ||
              currentRelease.deploymentId !== preparedLive.release.deploymentId ||
              currentRelease.deploymentStatus !== "live" ||
              currentRelease.deploymentRetiredAt !== null ||
              currentRelease.freshness !== "fresh") {
            return NextResponse.json({ error: "published run unavailable" }, { status: 503 });
          }
          return NextResponse.json(buildResourcePublicPreviewEnvelope(previewService));
        }
      }
      const resourceRepository = !hasResourceDependencies
        ? null
        : await getResourceRepository().catch(() => null);
      const service: PublicServiceContract | null = await resolvePublicServiceContractFromRelease({
        agent,
        flow,
        publicRelease,
        resourceRepository,
      });
      if (!service || service.resource?.access.execution === "private" ||
          publishedResourceAccess(preparedGraph)?.executionAccess === "private") {
        disposePreparedPublishedLiveExecution(preparedLive);
        return NextResponse.json({ error: "agent not found" }, { status: 404 });
      }
      if (service.kind === "resource") {
        let exactPack = null;
        try {
          exactPack = parseResourcePackBundle(await resourceRepository?.getOwnedPack({
            ownerId: preparedLive.release.ownerId,
            resourceProductId: service.resource!.resourceProductId,
            packVersionId: service.resource!.resourceVersion,
            semanticHash: service.resource!.semanticHash,
          }));
        } catch {
          exactPack = null;
        }
        if (!exactPack ||
            exactPack.resourceProductId !== service.resource!.resourceProductId ||
            exactPack.packVersionId !== service.resource!.resourceVersion ||
            exactPack.semanticHash !== service.resource!.semanticHash ||
            resourcePackSemanticHash(exactPack.content).semanticHash !== service.resource!.semanticHash ||
            exactPack.freshness !== "fresh") {
          disposePreparedPublishedLiveExecution(preparedLive);
          return NextResponse.json({ error: "published run unavailable" }, { status: 503 });
        }
      }
      if (service.kind === "resource" && preparedLive.relay) {
        disposePreparedPublishedLiveExecution(preparedLive);
        return NextResponse.json({ error: "published run unavailable" }, { status: 503 });
      }
      if (hasResourceDependencies) {
        const freshSnapshot = resourceRepository
          ? await loadExactFreshResourcePackSnapshot(
              preparedLive.release.ownerId,
              resourceRepository,
              preparedLive.resourceDependencies,
            )
          : null;
        if (!freshSnapshot ||
            !bindPreparedPublishedLiveResourceSnapshot(preparedLive, freshSnapshot)) {
          disposePreparedPublishedLiveExecution(preparedLive);
          return NextResponse.json({ error: "published run unavailable" }, { status: 503 });
        }
      }
      const terminalReplay = await replayTerminalAp2Response({
        req: req.clone(),
        repo,
        agent,
        flowId: flow.id,
      });
      if (terminalReplay) return terminalReplay;
      // Resolve immutable private access before parsing caller-controlled body
      // fields. Existing private and unknown agents therefore share one fixed
      // 404 for valid and malformed requests, without settlement or execution.
      const raw = await readRunBody(req);
      if (raw === null) {
        return NextResponse.json({ error: "request_too_large" }, { status: 413 });
      }
      const parsed = runBodySchema.safeParse(raw);
      if (!parsed.success) {
        return NextResponse.json({ error: "invalid request body" }, { status: 400 });
      }
      const requestedDryRun = isDryRunRequested(new URL(req.url), req.headers, parsed.data);
      const curated = service.curated ?? curatedBusinessService(agent.slug, preparedGraph);

    // Company external-call gate — before any payment or execution work.
    // Draft companies are evaluation-only and paused companies are explicitly
    // unavailable, so only active company employees may use this public path.
    // repo.getEmployeeByAgent is a required
    // FlowRepo member, but some test mocks (and, in principle, older
    // deploys) construct a partial repo object without it; tolerate that by
    // treating a missing implementation as "not a company employee" rather
    // than throwing. Non-employee agents take the existing path untouched.
    const requestUrl = new URL(req.url);
    const requestedAp2Checkout = requestUrl.searchParams.get("ap2Checkout") === "1";
    const SITE_ORIGIN = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://agents.suedeai.ai")
      .replace(/\/+$/, "");
    const resourceUrl = `${SITE_ORIGIN}/api/agents/${agent.slug}/run`;
    const paymentHeader = req.headers.get("payment-signature") ?? req.headers.get("x-payment");

    const employee = typeof repo.getEmployeeByAgent === "function"
      ? await repo.getEmployeeByAgent(agent.id)
      : null;
    if (employee) {
      const company = await repo.getCompany(employee.companyId);
      if (!company || company.status !== "active") {
        const paused = company?.status === "paused";
        return NextResponse.json(
          paused
            ? {
                error: "company_paused",
                message: "This service's company is paused by its founder.",
              }
            : {
                error: "company_not_active",
                message: "This service is not available until its company is active.",
              },
          { status: 503 },
        );
      }
      if (!globalLive || !agent.settlementLive) {
        return NextResponse.json(
          {
            error: "company_service_not_live",
            message: "This service is not enabled for public calls.",
          },
          { status: 503 },
        );
      }
      if (requestedDryRun) {
        return NextResponse.json(
          {
            error: "company_public_dry_run_forbidden",
            message: "Company services do not expose public previews.",
          },
          { status: 403 },
        );
      }
      if (employee.publishGated) {
        return NextResponse.json(
          {
            error: "company_service_approval_required",
            message: "This employee can only be run by its founder with approval.",
          },
          { status: 403 },
        );
      }
      const manifest = isFlowGraphV2(preparedGraph)
        ? flowToManifest(preparedGraph)
        : flowToManifest(preparedGraph);
      if (!manifest.triggers.some((trigger) => trigger.kind === "paidCall")) {
        return NextResponse.json(
          {
            error: "company_service_not_callable",
            message: "This employee is not configured for public paid calls.",
          },
          { status: 503 },
        );
      }
      const [departments, employeeHistory] = await Promise.all([
        repo.listDepartments(company.id),
        repo.listCompanyEmployeeHistory(company.id),
      ]);
      const department = departments.find((candidate) => candidate.id === employee.departmentId);
      if (!department) {
        return NextResponse.json({ error: "company_service_unavailable" }, { status: 503 });
      }
      const budgetBlock = await publicCallBudgetBlock({
        repo,
        department,
        employee,
        departmentAgentIds: employeeHistory
          .filter((candidate) => candidate.departmentId === employee.departmentId)
          .map((candidate) => candidate.agentId),
        now: new Date(),
      });
      if (budgetBlock) {
        return NextResponse.json(
          { error: budgetBlock.code, message: "This company service has reached its monthly budget." },
          { status: 429 },
        );
      }
    }

    // Enforce the published input contract BEFORE any payment work. The
    // contract is derived from the same graph the catalog/MCP surface
    // publishes (deriveInputSchema), so a malformed paid call 400s here —
    // ahead of verifyAndSettle — instead of charging the caller and then
    // running a flow against input it never advertised accepting.
    const inputViolations = triggerInputContractViolations(
      service.kind === "resource"
        ? service.inputSchema as ReturnType<typeof deriveInputSchema>
        : publishedServiceInputSchema(agent.slug, preparedGraph, deriveInputSchema(preparedGraph)),
      parsed.data.input ?? {},
    );
    if (inputViolations.length > 0) {
      return NextResponse.json(
        { error: "invalid_input", violations: inputViolations },
        { status: 400 },
      );
    }
    if (requestedDryRun && parsed.data.ap2) {
      return NextResponse.json(
        { error: "mandates_not_supported", message: "AP2 authorization is only used for priced Live calls." },
        { status: 400 },
      );
    }
    if (requestedAp2Checkout && parsed.data.ap2) {
      return NextResponse.json(
        { error: "invalid_request", message: "Request a checkout before presenting AP2 mandates." },
        { status: 400 },
      );
    }

    const relayRow = preparedPublishedLiveRelaySnapshot(preparedLive);
    if (relayRow === undefined) {
      return NextResponse.json({ error: "published run unavailable" }, { status: 503 });
    }
    const ap2ServiceEligible = isAp2ServiceEligible({
      priceUsdc: agent.priceUsdc,
      acceptsPayment: globalLive && agent.settlementLive,
      publishedLive: agent.status === "live" && !requestedDryRun,
      fulfillmentSupportsAp2: relayRow === null || relayRow.protocolVersion === 2,
    });
    if (relayRow && (requestedAp2Checkout || parsed.data.ap2)
      && relayRow.protocolVersion !== 2) {
      return NextResponse.json({
        error: "ap2_relay_v2_required",
        message: "AP2 relay calls require the idempotent Suede relay v2 execute/status protocol.",
      }, { status: 409 });
    }
    // Settlement fires only when the run is NOT a dry-run. A run is a dry-run
    // when the caller explicitly asks for one (the in-app "Try it" preview:
    // ?dryRun=1 / { dryRun: true } / x-suede-dry-run header), OR settlement
    // isn't globally live, OR this agent opted out. The explicit request always
    // wins, so the free human preview never hits the x402 paywall — the cause
    // of the App Store 2.1 rejection.
    const { dryRun } = resolveRunMode({
      requestedDryRun,
      globalLive,
      agentSettlementLive: agent.settlementLive,
    });
    if (service.resource?.access.execution === "paid" && dryRun) {
      return NextResponse.json(
        {
          error: "resource_public_preview_forbidden",
          message: "Paid Resources do not expose public previews.",
        },
        { status: 403 },
      );
    }

    if (requestedAp2Checkout && (!ap2ServiceEligible || dryRun)) {
      return NextResponse.json(
        {
          error: "ap2_checkout_unavailable",
          message: "AP2 checkout is available only for priced services with Live settlement enabled.",
        },
        { status: 503 },
      );
    }
    if (parsed.data.ap2 && (!ap2ServiceEligible || dryRun)) {
      return NextResponse.json(
        { error: "mandates_not_supported", message: "This request does not have a priced Live checkout." },
        { status: 400 },
      );
    }

    let ap2AuthorizationRecord: Ap2AuthorizationRecord | null = null;
    let settledTransaction: string | null = null;
    let settledPayer: string | null = null;
    // True only when a real x402 payment verified+settled. Free agents
    // (priceUsdc === 0) and dry-runs never settle, so the response must not
    // claim `settled: true` for them — that would be a lie about payment state.
    let didSettlePayment = false;
    let paymentAlreadySettled = false;
    // Ledger facts captured at settle time; written once the run id exists.
    let settlementFacts: Omit<
      Parameters<typeof repo.recordSettlement>[0],
      "runId"
    > | null = null;
    let settlementAccountingPersisted = false;
    let precreatedRunId: string | null = null;
    let ap2CheckoutReceipt: string | null = null;
    let ap2AuthorizationMode: "direct" | "autonomous" | null = null;
    let ap2RouteAuthorization: Ap2RouteAuthorization | null = null;
    let issueAp2TerminalReceipt: ((input: {
      readonly status: "Success" | "Error";
      readonly orderId?: string;
      readonly error?: string;
      readonly errorDescription?: string;
    }) => Promise<string>) | null = null;
    const terminalCheckoutReceipt = async (input: {
      readonly status: "Success" | "Error";
      readonly orderId?: string;
      readonly error?: string;
      readonly errorDescription?: string;
    }): Promise<string | null> => {
      if (!issueAp2TerminalReceipt) return null;
      const receipt = await issueAp2TerminalReceipt(input);
      ap2CheckoutReceipt = receipt;
      return receipt;
    };
    const ap2EvidenceProjection = (input: {
      readonly checkoutReceipt?: string | null;
      readonly relay?: StoredRelayReconciliation;
    } = {}): Ap2SanitizedJson | null => {
      if (!ap2RouteAuthorization) return null;
      const projection: { [key: string]: Ap2SanitizedJson } = {
        authorization: {
          mode: ap2RouteAuthorization.mode,
          checkoutReference: ap2RouteAuthorization.checkoutReference,
          paymentReference: ap2RouteAuthorization.paymentReference,
        },
      };
      if (input.checkoutReceipt) projection.checkoutReceipt = input.checkoutReceipt;
      if (input.relay) {
        projection.relay = {
          protocol: input.relay.protocol,
          endpointBinding: input.relay.endpointBinding,
          notAfter: input.relay.notAfter,
          deliveryId: input.relay.deliveryId,
        };
      }
      return projection;
    };
    const persistSettlementAccounting = async (runId: string): Promise<void> => {
      if (!didSettlePayment || !settlementFacts) return;
      await repo.stampRunSettled(runId, new Date().toISOString());
      await repo.recordSettlement({ runId, ...settlementFacts });
      if (ap2AuthorizationRecord) {
        const [run, recorded] = await Promise.all([
          repo.getRun(runId),
          repo.getSettlementByRun(runId),
        ]);
        if (
          !run?.settledAt
          || !recorded
          || recorded.agentId !== settlementFacts.agentId
          || recorded.ownerId !== settlementFacts.ownerId
          || recorded.grossUsdc !== settlementFacts.grossUsdc
          || recorded.creatorUsdc !== settlementFacts.creatorUsdc
          || recorded.platformUsdc !== settlementFacts.platformUsdc
          || recorded.payTo.toLowerCase() !== settlementFacts.payTo.toLowerCase()
          || recorded.payoutSource !== settlementFacts.payoutSource
          || (recorded.payer ?? "").toLowerCase() !== (settlementFacts.payer ?? "").toLowerCase()
          || (recorded.tx ?? "").toLowerCase() !== (settlementFacts.tx ?? "").toLowerCase()
        ) {
          throw new Error("Settlement accounting attestation failed");
        }
      }
      settlementAccountingPersisted = true;
    };
    const finalizeRelayDelivery = async (
      authorization: Ap2AuthorizationRecord,
      delivery: RelayV2Delivery,
    ): Promise<NextResponse> => {
      if (!authorization.runId) return relayPendingResponse(true);
      let completed = delivery.state === "completed";
      let relayOutput: unknown = delivery.output ?? null;
      if (completed) {
        try {
          relayOutput = sanitizeAp2Json(relayOutput);
        } catch {
          completed = false;
        }
      }
      const checkoutReceipt = await terminalCheckoutReceipt(completed
        ? {
            status: "Success",
            orderId: authorization.runId,
          }
        : {
            status: "Error",
            error: "relay_reported_failure",
            errorDescription: "The relay reported that fulfillment failed.",
          });
      const failure: Ap2SanitizedJson = {
        ...relayTerminalFailure("The relay reported that fulfillment failed."),
        ...(checkoutReceipt ? {
            ap2: {
              profile: AP2_PROFILE,
              authorizationMode: ap2AuthorizationMode,
              checkoutReceipt,
            },
          } : {}),
      };
      const responseBody = completed
        ? relayResponsePayload({
            runId: authorization.runId,
            output: relayOutput,
            didSettle: true,
            transaction: authorization.tx,
            payer: authorization.payer,
            checkoutReceipt,
            authorizationMode: ap2AuthorizationMode,
          })
        : failure;
      const responseStatus = completed ? 200 : 502;
      try {
        await repo.finishRun(authorization.runId, completed ? "done" : "error", 0);
        const terminal = await repo.transitionAp2Authorization({
          id: authorization.id,
          fromState: "executing",
          toState: completed ? "completed" : "failed",
          decisionCode: completed ? "fulfilled" : "relay_reported_failure",
          runId: authorization.runId,
          receiptJson: ap2EvidenceProjection({ checkoutReceipt }),
          resultJson: ap2ResponseEnvelope(responseStatus, responseBody),
        });
        if (terminal) {
          ap2AuthorizationRecord = terminal;
          return NextResponse.json(responseBody, { status: responseStatus });
        }
        const current = await repo.getAp2AuthorizationByMandateReference(
          authorization.mandateReference,
        );
        const stored = current ? storedAp2Response(current.resultJson) : null;
        if (stored && current && (current.state === "completed" || current.state === "failed")) {
          return NextResponse.json(stored.body, { status: stored.status });
        }
      } catch {
        // The relay's signed terminal status can be queried again. Never turn a
        // projection write failure into a second execute delivery.
      }
      return relayPendingResponse(true);
    };
    try {
    if (!dryRun && agent.priceUsdc > 0) {
      const payout = await resolvePayout(agent);
      // Never settle into the zero address — a live rail with no payout
      // destination is a misconfiguration, not a sale.
      if (payout.source === "unset") {
        return NextResponse.json(
          { error: "payouts not configured for this agent" },
          { status: 503 },
        );
      }
      const payoutSource: "creator" | "platform" = payout.source;

      const resourceDescription = service.kind === "resource" ? service.description : curated?.description ??
        `Run ${preparedGraph.name} through Suede Agent Studio.`;
      const serviceTags = service.kind === "resource" ? [...service.tags] : curated ? [...curated.tags] : ["suede", "agent", "x402"];
      const outputSchema = service.kind === "resource" ? service.responseSchema ?? service.outputSchema : curated?.outputSchema ?? {
        type: "object",
        additionalProperties: true,
      };
      const extensions = buildX402BazaarExtensions({
        ...(service.kind === "resource" ? { mode: "resource" as const } : {}),
        inputSchema: service.kind === "resource" ? service.inputSchema : curated?.inputSchema ?? deriveInputSchema(preparedGraph),
        outputSchema,
        exampleInput: service.kind === "resource" ? service.exampleInput : curated?.exampleInput ?? {},
        exampleOutput: service.kind === "resource" ? service.responseExample ?? {} : curated?.exampleOutput ?? { ok: true },
      });
      const advertisedExtensions = service.resource
        ? { ...extensions, [RESOURCE_CONTRACT_EXTENSION_URI]: service.resource }
        : extensions;
      const challenge = (
        reason?: string,
        ap2?: {
          readonly checkoutReceipt?: string;
          readonly checkoutReference: string;
          readonly paymentReference: string;
          readonly x402Nonce: string;
        },
      ): NextResponse => {
        const paymentRequired = buildX402PaymentRequired(
          {
            priceUsdc: agent.priceUsdc,
            payTo: payout.payTo,
            resource: resourceUrl,
            description: resourceDescription,
            serviceName: "Suede Agent Studio",
            tags: serviceTags,
            outputSchema,
            extensions: advertisedExtensions,
          },
          reason,
        );
        return NextResponse.json({
          ...paymentRequired,
          ...(ap2 ? { ap2: { profile: AP2_PROFILE, ...ap2 } } : {}),
        }, {
          status: 402,
          headers: {
            "PAYMENT-REQUIRED": encodeX402Header(paymentRequired),
            "Access-Control-Expose-Headers": "PAYMENT-REQUIRED,PAYMENT-RESPONSE,Link",
            Link: `<${SITE_ORIGIN}/.well-known/x402>; rel="x402-discovery"; type="application/json"`,
          },
        });
      };

      const restoreSettledAccountingContext = (authorization: Ap2AuthorizationRecord): void => {
        settledTransaction = authorization.tx;
        settledPayer = authorization.payer;
        didSettlePayment = true;
        paymentAlreadySettled = true;
        settlementFacts = {
          agentId: agent.id,
          ownerId: flow.ownerId,
          grossUsdc: agent.priceUsdc,
          creatorUsdc: payoutSource === "creator" ? agent.priceUsdc : 0,
          platformUsdc: payoutSource === "platform" ? agent.priceUsdc : 0,
          payTo: payout.payTo,
          payoutSource,
          payer: authorization.payer,
          tx: authorization.tx,
        };
      };

      const recoverDirectEngineRun = async (
        authorization: Ap2AuthorizationRecord,
        fromState: "executing" | "pending_reconciliation",
      ): Promise<NextResponse | null> => {
        if (!authorization.runId) return null;
        const run = await repo.getRun(authorization.runId);
        if (!run || run.status === "running" || run.finishedAt === null
          || run.flowId !== flow.id || run.agentId !== agent.id || run.trigger !== "agent") {
          return null;
        }
        restoreSettledAccountingContext(authorization);
        try {
          await persistSettlementAccounting(run.id);
        } catch {
          return null;
        }
        const steps = await repo.listRunSteps(run.id);
        const outputs: Record<string, Record<string, unknown>> = {};
        for (const step of steps) {
          if (step.status !== "done" || typeof step.output !== "object"
            || step.output === null || Array.isArray(step.output)) continue;
          outputs[step.nodeId] = step.output as Record<string, unknown>;
        }
        const completed = run.status === "done";
        const checkoutReceipt = await terminalCheckoutReceipt(completed
          ? { status: "Success", orderId: run.id }
          : {
              status: "Error",
              error: "fulfillment_failed",
              errorDescription: "The fulfillment run finished with an error.",
            });
        let responseBody: Ap2SanitizedJson;
        try {
          if (service.kind === "resource") {
            if (!resourceRepository) return null;
            const envelope = await buildAndPersistResourceRunEnvelope({
              service,
              summary: {
                runId: run.id,
                status: run.status,
                totalCostUsdc: run.totalCostUsdc,
                outputs,
              },
              payment: {
                priceUsdc: service.priceUsdc,
                state: "settled",
                paymentId: authorization.tx,
              },
              repository: resourceRepository,
            });
            responseBody = sanitizeAp2Json({
              ...envelope,
              ...(checkoutReceipt ? {
                  ap2: {
                    profile: AP2_PROFILE,
                    authorizationMode: ap2AuthorizationMode,
                    checkoutReceipt,
                  },
                } : {}),
            });
          } else {
            const safeOutputs = sanitizeAp2Json(outputs);
            const recoveredResult = extractCuratedServiceResult(curated, preparedGraph, outputs);
            const safeResult = recoveredResult ? sanitizeAp2Json(recoveredResult) : null;
            responseBody = {
              runId: run.id,
              status: run.status,
              totalCostUsdc: run.totalCostUsdc,
              outputs: safeOutputs,
              ...(safeResult ? { result: safeResult } : {}),
              settled: true,
              ...(authorization.tx ? { transaction: authorization.tx } : {}),
              payer: authorization.payer,
              ...(checkoutReceipt ? {
                  ap2: {
                    profile: AP2_PROFILE,
                    authorizationMode: ap2AuthorizationMode,
                    checkoutReceipt,
                  },
                } : {}),
            };
          }
        } catch {
          return null;
        }
        const terminal = await repo.transitionAp2Authorization({
          id: authorization.id,
          fromState,
          toState: completed ? "completed" : "failed",
          decisionCode: completed ? "fulfilled_reconciled" : "fulfillment_failed_reconciled",
          runId: run.id,
          receiptJson: ap2EvidenceProjection({ checkoutReceipt }),
          resultJson: ap2ResponseEnvelope(200, responseBody),
        });
        if (terminal) {
          ap2AuthorizationRecord = terminal;
          return NextResponse.json(responseBody);
        }
        const current = await repo.getAp2AuthorizationByMandateReference(
          authorization.mandateReference,
        );
        const stored = current ? storedAp2Response(current.resultJson) : null;
        return stored ? NextResponse.json(stored.body, { status: stored.status }) : null;
      };

      const needsAp2 = requestedAp2Checkout || parsed.data.ap2 !== undefined;
      const ap2Runtime = await loadAp2RunConfig(repo);
      const liveReceipt = needsAp2 && preparedLive
        ? preparedPublishedLiveExecutionReceipt(preparedLive)
        : null;
      const ap2Terms: Ap2RunTerms | null = liveReceipt
        ? {
            agentId: agent.id,
            agentSlug: agent.slug,
            flowId: flow.id,
            live: liveReceipt,
            resource: resourceUrl,
            input: parsed.data.input ?? {},
            ...(parsed.data.runVariables ? { runVariables: parsed.data.runVariables } : {}),
            priceUsdc: agent.priceUsdc,
            payTo: payout.payTo,
            siteOrigin: SITE_ORIGIN,
          }
        : null;

      if (ap2ServiceEligible
        && ap2Runtime.readiness.mode === "required" && !ap2Runtime.readiness.ready) {
        return NextResponse.json(
          { error: "ap2_not_ready", message: "Required AP2 verification is temporarily unavailable." },
          { status: 503, headers: { "cache-control": "no-store" } },
        );
      }

      if (requestedAp2Checkout) {
        if (ap2Runtime.readiness.mode === "off") {
          return NextResponse.json(
            { error: "mandates_not_supported", message: "AP2 is not enabled on this deployment." },
            { status: 400 },
          );
        }
        if (!ap2Runtime.readiness.ready || !ap2Terms) {
          return NextResponse.json(
            { error: "ap2_not_ready", message: "AP2 checkout is temporarily unavailable." },
            { status: 503 },
          );
        }
        const checkout = await issueAp2Checkout({ runtime: ap2Runtime, terms: ap2Terms });
        return NextResponse.json({
          protocol: "AP2",
          version: "0.2",
          profile: AP2_PROFILE,
          status: "experimental",
          extensionUri: "https://github.com/google-agentic-commerce/ap2/v1",
          authorizationModes: ["direct", "autonomous"],
          sellerSubprofile: AP2_SELLER_SUBPROFILE,
          checkoutJwt: checkout.checkoutJwt,
          checkoutHash: checkout.checkoutHash,
          challengeNonce: checkout.challengeNonce,
          expiresAt: new Date(checkout.expiresAt * 1_000).toISOString(),
          resource: resourceUrl,
          payment: {
            rail: "x402-v2",
            scheme: X402_SCHEME,
            network: X402_FACILITATOR_NETWORK,
            asset: USDC_TOKEN_ADDRESS,
            amountAtomic: checkout.binding.amountAtomic,
            amountMinorUsd: checkout.binding.amountMinorUsd,
            currency: "USD",
            payTo: payout.payTo,
            instrumentIdFormat: "CAIP-10 eip155:8453:<payer-address>",
          },
        }, { headers: { "cache-control": "no-store" } });
      }

      let durableExactRetry = false;
      if (parsed.data.ap2) {
        if (ap2Runtime.readiness.mode === "off") {
          return NextResponse.json(
            { error: "mandates_not_supported", message: "AP2 is not enabled on this deployment." },
            { status: 400 },
          );
        }
        if (!ap2Runtime.readiness.ready || !ap2Terms || !ap2Runtime.signing) {
          return NextResponse.json(
            { error: "ap2_not_ready", message: "AP2 verification is temporarily unavailable." },
            { status: 503 },
          );
        }
        const presentedPaymentReference = paymentHeader
          ? safeCheckoutReference(parsed.data.ap2.paymentMandateSdJwt)
          : null;
        const presentedPaymentReplayIdentity = paymentHeader
          ? safePaymentReplayIdentity(parsed.data.ap2.paymentMandateSdJwt)
          : null;
        if (presentedPaymentReference && presentedPaymentReplayIdentity) {
          const persisted = await repo.getAp2AuthorizationByMandateReference(
            presentedPaymentReplayIdentity,
          );
          const metadata = persisted
            ? storedAp2AuthorizationMetadata(persisted.receiptJson)
            : null;
          if (persisted && metadata) {
            const checkoutReference = safeCheckoutReference(
              parsed.data.ap2.checkoutMandateSdJwt,
            );
            const currentDigest = buildAp2RequestDigest({
              method: "POST",
              resource: resourceUrl,
              body: {
                input: parsed.data.input ?? {},
                ...(parsed.data.runVariables
                  ? { runVariables: parsed.data.runVariables }
                  : {}),
              },
            });
            const expiresAt = Math.floor(Date.parse(persisted.expiresAt) / 1_000);
            if (
              metadata.mode !== parsed.data.ap2.authorizationMode
              || metadata.paymentReference !== presentedPaymentReference
              || metadata.checkoutReference !== checkoutReference
              || persisted.mandateReference !== presentedPaymentReplayIdentity
              || persisted.requestDigest !== currentDigest
              || persisted.agentId !== agent.id
              || persisted.flowId !== flow.id
              || persisted.deploymentId !== liveReceipt!.deploymentId
              || persisted.network !== X402_FACILITATOR_NETWORK
              || persisted.asset.toLowerCase() !== USDC_TOKEN_ADDRESS.toLowerCase()
              || persisted.amountAtomic !== usdcToAtomic(agent.priceUsdc)
              || persisted.amountMinorUsd !== Math.round(agent.priceUsdc * 100)
              || persisted.payeeId !== "suede-agent-studio"
              || persisted.payTo.toLowerCase() !== payout.payTo.toLowerCase()
              || !Number.isSafeInteger(expiresAt)
              || expiresAt <= 0
            ) {
              return NextResponse.json(
                { error: "ap2_replay_conflict", message: "This authorization does not match the durable request." },
                { status: 409, headers: { "cache-control": "no-store" } },
              );
            }
            ap2AuthorizationRecord = persisted;
            durableExactRetry = true;
            ap2AuthorizationMode = metadata.mode;
            ap2RouteAuthorization = {
              mode: metadata.mode,
              checkoutReference: metadata.checkoutReference,
              paymentReference: metadata.paymentReference,
              paymentReplayIdentity: presentedPaymentReplayIdentity,
              paymentInstrumentId: ap2X402PaymentInstrumentId(
                persisted.network,
                persisted.payer,
              ),
              issuer: persisted.issuer,
              ...(persisted.subjectId ? { subject: persisted.subjectId } : {}),
              requestDigest: persisted.requestDigest,
              checkoutHash: persisted.checkoutHash,
              amountMinorUsd: persisted.amountMinorUsd,
              payeeId: persisted.payeeId,
              expiresAt,
            };
          }
        }
        try {
          if (!ap2RouteAuthorization) {
            const verifiedAp2 = await verifyAp2RunAuthorization({
              runtime: ap2Runtime,
              terms: ap2Terms,
              presentation: parsed.data.ap2,
            });
            ap2AuthorizationMode = verifiedAp2.authorization.mode;
            ap2RouteAuthorization = {
              mode: verifiedAp2.authorization.mode,
              checkoutReference: verifiedAp2.authorization.checkoutReference,
              paymentReference: verifiedAp2.authorization.paymentReference,
              paymentReplayIdentity: verifiedAp2.authorization.paymentReplayIdentity,
              ...(verifiedAp2.authorization.paymentInstrumentId
                ? { paymentInstrumentId: verifiedAp2.authorization.paymentInstrumentId }
                : {}),
              issuer: verifiedAp2.authorization.issuer,
              ...(verifiedAp2.authorization.subject
                ? { subject: verifiedAp2.authorization.subject }
                : {}),
              requestDigest: verifiedAp2.expected.requestDigest,
              checkoutHash: verifiedAp2.expected.checkoutHash,
              amountMinorUsd: verifiedAp2.expected.amountMinorUsd,
              payeeId: verifiedAp2.expected.payee.id,
              expiresAt: verifiedAp2.expiresAt,
            };
          }
          issueAp2TerminalReceipt = async (input) => input.status === "Success"
            ? issueCheckoutReceipt({
                signing: ap2Runtime.signing!,
                reference: ap2RouteAuthorization!.checkoutReference,
                status: "Success",
                orderId: input.orderId ?? "fulfilled",
              })
            : issueCheckoutReceipt({
                signing: ap2Runtime.signing!,
                reference: ap2RouteAuthorization!.checkoutReference,
                status: "Error",
                error: input.error ?? "checkout_error",
                errorDescription: input.errorDescription ?? "The checkout could not be completed.",
              });
        } catch (error) {
          if (!(error instanceof Ap2ProtocolError)) throw error;
          const reference = safeCheckoutReference(parsed.data.ap2.checkoutMandateSdJwt);
          const receipt = reference
            ? await issueCheckoutReceipt({
                signing: ap2Runtime.signing,
                reference,
                status: "Error",
                error: error.code,
                errorDescription: error.message,
              })
            : null;
          return NextResponse.json({
            error: error.code,
            message: error.message,
            ...(receipt ? { ap2: { profile: AP2_PROFILE, checkoutReceipt: receipt } } : {}),
          }, { status: ap2ErrorStatus(error), headers: { "cache-control": "no-store" } });
        }
      } else if (ap2ServiceEligible && ap2Runtime.readiness.requireAuthorization) {
        return NextResponse.json({
          error: "ap2_mandate_required",
          message: "Request a merchant checkout and present AP2 Checkout and Payment Mandates.",
          checkoutUrl: `${SITE_ORIGIN}/api/agents/${agent.slug}/ap2/checkout`,
        }, { status: 428, headers: { "cache-control": "no-store" } });
      }

      if (!paymentHeader) {
        return ap2RouteAuthorization
          ? challenge(undefined, {
              checkoutReference: ap2RouteAuthorization.checkoutReference,
              paymentReference: ap2RouteAuthorization.paymentReference,
              x402Nonce: expectedAp2X402Nonce(
                ap2RouteAuthorization.paymentReplayIdentity,
                ap2RouteAuthorization.checkoutHash,
              ),
            })
          : challenge();
      }

      if (ap2RouteAuthorization) {
        const payment = decodePaymentHeader(paymentHeader);
        const identity = x402AuthorizationIdentity(paymentHeader);
        const requiredNonce = expectedAp2X402Nonce(
          ap2RouteAuthorization.paymentReplayIdentity,
          ap2RouteAuthorization.checkoutHash,
        );
        const accepted = payment?.x402Version === 2 ? payment.accepted : null;
        const resourceMatches = payment?.x402Version === 2
          && payment.resource?.url === resourceUrl;
        const validBefore = identity ? Number(identity.validBefore) : Number.NaN;
        const validAfter = identity ? Number(identity.validAfter) : Number.NaN;
        const now = Math.floor(Date.now() / 1_000);
        const locallyAuthenticated = await verifyX402AuthorizationSignature(paymentHeader);
        if (
          !payment
          || payment.x402Version !== 2
          || !identity
          || !accepted
          || !resourceMatches
          || identity.network !== X402_FACILITATOR_NETWORK
          || identity.asset?.toLowerCase() !== USDC_TOKEN_ADDRESS.toLowerCase()
          || identity.scheme !== X402_SCHEME
          || identity.payTo.toLowerCase() !== payout.payTo.toLowerCase()
          || identity.amountAtomic !== usdcToAtomic(agent.priceUsdc)
          || accepted.network !== X402_FACILITATOR_NETWORK
          || accepted.asset.toLowerCase() !== USDC_TOKEN_ADDRESS.toLowerCase()
          || accepted.scheme !== X402_SCHEME
          || accepted.payTo.toLowerCase() !== payout.payTo.toLowerCase()
          || accepted.amount !== usdcToAtomic(agent.priceUsdc)
          || identity.nonce.toLowerCase() !== requiredNonce.toLowerCase()
          || !/^0x[0-9a-fA-F]{40}$/u.test(identity.payer)
          || ap2RouteAuthorization.paymentInstrumentId
            !== ap2X402PaymentInstrumentId(identity.network, identity.payer)
          || !locallyAuthenticated
          || !Number.isSafeInteger(validAfter)
          || !Number.isSafeInteger(validBefore)
          || !durableExactRetry && validAfter > now
          || !durableExactRetry && validBefore <= now
          || !durableExactRetry && validBefore > ap2RouteAuthorization.expiresAt
          || durableExactRetry && ap2AuthorizationRecord !== null
            && new Date(validBefore * 1_000).toISOString()
              !== ap2AuthorizationRecord.paymentValidBefore
          || durableExactRetry && ap2AuthorizationRecord !== null
            && hashAp2PaymentNonce({
              network: identity.network,
              asset: identity.asset!,
              payer: identity.payer,
              nonce: identity.nonce,
            }) !== ap2AuthorizationRecord.paymentNonceHash
        ) {
          if (durableExactRetry) {
            return NextResponse.json(
              { error: "ap2_replay_conflict", message: "This payment proof does not match the durable authorization." },
              { status: 409, headers: { "cache-control": "no-store" } },
            );
          }
          const receipt = await terminalCheckoutReceipt({
            status: "Error",
            error: "ap2_x402_binding_mismatch",
            errorDescription: "The x402 authorization does not match the accepted AP2 checkout.",
          });
          return challenge("ap2_x402_binding_mismatch", {
            ...(receipt ? { checkoutReceipt: receipt } : {}),
            checkoutReference: ap2RouteAuthorization.checkoutReference,
            paymentReference: ap2RouteAuthorization.paymentReference,
            x402Nonce: requiredNonce,
          });
        }

        const reservation = durableExactRetry && ap2AuthorizationRecord
          ? { status: "exact-retry" as const, authorization: ap2AuthorizationRecord }
          : await repo.reserveAp2Authorization({
          mandateReference: ap2RouteAuthorization.paymentReplayIdentity,
          paymentNonceHash: hashAp2PaymentNonce({
            network: identity.network,
            asset: identity.asset!,
            payer: identity.payer,
            nonce: identity.nonce,
          }),
          requestDigest: ap2RouteAuthorization.requestDigest,
          issuer: ap2RouteAuthorization.issuer,
          subjectId: ap2RouteAuthorization.subject ?? null,
          checkoutHash: ap2RouteAuthorization.checkoutHash,
          agentId: agent.id,
          flowId: flow.id,
          deploymentId: liveReceipt!.deploymentId,
          network: identity.network,
          asset: identity.asset!,
          amountAtomic: identity.amountAtomic,
          amountMinorUsd: ap2RouteAuthorization.amountMinorUsd,
          payeeId: ap2RouteAuthorization.payeeId,
          payTo: identity.payTo,
          payer: identity.payer,
          expiresAt: new Date(ap2RouteAuthorization.expiresAt * 1_000).toISOString(),
          paymentValidBefore: new Date(validBefore * 1_000).toISOString(),
        });
        if (reservation.status === "conflict") {
          return NextResponse.json(
            { error: "ap2_replay_conflict", message: "This authorization was already used for a different request." },
            { status: 409 },
          );
        }
        ap2AuthorizationRecord = reservation.authorization;
        if (reservation.status === "exact-retry") {
          const stored = storedAp2Response(ap2AuthorizationRecord.resultJson);
          if (stored && (ap2AuthorizationRecord.state === "completed"
            || ap2AuthorizationRecord.state === "failed"
            || ap2AuthorizationRecord.state === "rejected")) {
            return NextResponse.json(stored.body, { status: stored.status });
          }
          if (
            (ap2AuthorizationRecord.state === "completed"
              || ap2AuthorizationRecord.state === "failed"
              || ap2AuthorizationRecord.state === "rejected")
            && isAp2TerminalEvidenceExpired(ap2AuthorizationRecord.receiptJson)
          ) {
            return NextResponse.json({
              error: "ap2_terminal_evidence_expired",
              message: "The retained response payload has expired; this authorization remains consumed.",
              state: ap2AuthorizationRecord.state,
              ...(ap2AuthorizationRecord.runId ? { runId: ap2AuthorizationRecord.runId } : {}),
              ...(ap2AuthorizationRecord.tx ? { transaction: ap2AuthorizationRecord.tx } : {}),
            }, { status: 410, headers: { "cache-control": "no-store" } });
          }
          if (ap2AuthorizationRecord.state === "completed" && ap2AuthorizationRecord.resultJson) {
            return NextResponse.json(ap2AuthorizationRecord.resultJson);
          }
          if (
            ap2AuthorizationRecord.state === "executing"
            && ap2AuthorizationRecord.decisionCode === "relay_delivery_started"
          ) {
            const relayMetadata = storedRelayReconciliation(ap2AuthorizationRecord.receiptJson);
            const endpointBinding = relayRow?.protocolVersion === 2
              ? relayV2EndpointBindingHash({
                  url: relayRow.url,
                  createdAt: relayRow.createdAt,
                  protocolVersion: String(relayRow.protocolVersion),
                })
              : null;
            if (
              !relayMetadata
              || !relayRow
              || relayRow.protocolVersion !== 2
              || !ap2AuthorizationRecord.runId
              || relayMetadata.deliveryId !== ap2AuthorizationRecord.runId
              || endpointBinding !== relayMetadata.endpointBinding
            ) {
              return NextResponse.json({
                error: "relay_reconciliation_unavailable",
                message: "The paid relay delivery is paused for manual reconciliation.",
              }, { status: 503, headers: { "retry-after": "30" } });
            }
            restoreSettledAccountingContext(ap2AuthorizationRecord);
            try {
              await persistSettlementAccounting(ap2AuthorizationRecord.runId);
            } catch {
              return relayPendingResponse(true);
            }
            const relayStatus = await queryRelayV2Status({
              relay: { url: relayRow.url, secret: relayRow.secret },
              deliveryId: relayMetadata.deliveryId,
              agent: agent.slug,
            });
            if (relayStatus.kind === "unavailable") return relayPendingResponse(true);
            if (relayStatus.state === "completed" || relayStatus.state === "failed") {
              return finalizeRelayDelivery(ap2AuthorizationRecord, relayStatus);
            }
            if (
              relayStatus.state === "unknown"
              && Date.now() > Date.parse(relayMetadata.notAfter) + RELAY_V2_RECONCILIATION_SKEW_MS
            ) {
              return finalizeRelayDelivery(ap2AuthorizationRecord, {
                ...relayStatus,
                state: "failed",
                error: "delivery_not_found_after_deadline",
              });
            }
            return relayPendingResponse();
          }
          if (ap2AuthorizationRecord.state === "executing") {
            const recovered = await recoverDirectEngineRun(ap2AuthorizationRecord, "executing");
            if (recovered) return recovered;
            return NextResponse.json({
              error: "fulfillment_pending_reconciliation",
              message: "The paid run outcome is being reconciled and will not be executed again.",
              ...(ap2AuthorizationRecord.runId ? { runId: ap2AuthorizationRecord.runId } : {}),
            }, { status: 503, headers: { "retry-after": "30" } });
          }
          if (ap2AuthorizationRecord.state === "settling") {
            const pending = await repo.transitionAp2Authorization({
              id: ap2AuthorizationRecord.id,
              fromState: "settling",
              toState: "pending_reconciliation",
              decisionCode: "settlement_result_unavailable",
            });
            if (pending) ap2AuthorizationRecord = pending;
            return NextResponse.json({
              error: "payment_pending_reconciliation",
              message: "Settlement outcome is being reconciled.",
            }, { status: 503, headers: { "retry-after": "10" } });
          }
          if (ap2AuthorizationRecord.state === "pending_reconciliation") {
            if (ap2AuthorizationRecord.decisionCode === "fulfillment_exception_ambiguous") {
              const recovered = await recoverDirectEngineRun(
                ap2AuthorizationRecord,
                "pending_reconciliation",
              );
              if (recovered) return recovered;
              return NextResponse.json({
                error: "fulfillment_pending_reconciliation",
                message: "The paid run outcome is being reconciled and will not be executed again.",
                ...(ap2AuthorizationRecord.runId ? { runId: ap2AuthorizationRecord.runId } : {}),
              }, { status: 503, headers: { "retry-after": "30" } });
            }
            const reconciliation = await reconcileX402AuthorizationState({
              rpcUrl: process.env.BASE_RPC_URL ?? "",
              asset: ap2AuthorizationRecord.asset,
              payer: ap2AuthorizationRecord.payer,
              payTo: ap2AuthorizationRecord.payTo,
              nonce: requiredNonce,
              amountAtomic: ap2AuthorizationRecord.amountAtomic,
              ...(ap2AuthorizationRecord.tx
                ? { transactionHash: ap2AuthorizationRecord.tx }
                : {}),
              expiresAt: Math.floor(Date.parse(ap2AuthorizationRecord.paymentValidBefore) / 1_000),
            });
            if (reconciliation.status === "used") {
              const reconciled = await repo.transitionAp2Authorization({
                id: ap2AuthorizationRecord.id,
                fromState: "pending_reconciliation",
                toState: "settled",
                decisionCode: "x402_finalized_transfer_reconciled",
                tx: reconciliation.transactionHash,
              });
              if (!reconciled) {
                return NextResponse.json(
                  { error: "ap2_authorization_pending", state: "pending_reconciliation" },
                  { status: 202, headers: { "retry-after": "3" } },
                );
              }
              ap2AuthorizationRecord = reconciled;
            } else if (reconciliation.status === "unused" && reconciliation.definitive) {
              const receipt = await terminalCheckoutReceipt({
                status: "Error",
                error: "payment_not_settled",
                errorDescription: "The expected transaction did not contain the authorized payment.",
              });
              const failure: Ap2SanitizedJson = {
                error: "payment_not_settled",
                message: "The expected transaction did not settle this checkout.",
                ...(receipt ? {
                    ap2: {
                      profile: AP2_PROFILE,
                      authorizationMode: ap2AuthorizationMode,
                      checkoutReceipt: receipt,
                    },
                  } : {}),
              };
              const failed = await repo.transitionAp2Authorization({
                id: ap2AuthorizationRecord.id,
                fromState: "pending_reconciliation",
                toState: "failed",
                decisionCode: "x402_transaction_missing_exact_transfer",
                receiptJson: ap2EvidenceProjection({ checkoutReceipt: receipt }),
                resultJson: ap2ResponseEnvelope(409, failure),
              });
              if (failed) ap2AuthorizationRecord = failed;
              return NextResponse.json(failure, { status: 409 });
            } else {
              const unavailable = reconciliation.status === "unavailable";
              return NextResponse.json({
                error: "payment_pending_reconciliation",
                message: "Settlement outcome is being reconciled.",
              }, {
                status: unavailable ? 503 : 202,
                headers: { "retry-after": unavailable ? "10" : "3" },
              });
            }
          }
          if (ap2AuthorizationRecord.state === "settled") {
            paymentAlreadySettled = true;
            didSettlePayment = true;
            settledTransaction = ap2AuthorizationRecord.tx;
            settledPayer = ap2AuthorizationRecord.payer;
            settlementFacts = {
              agentId: agent.id,
              ownerId: flow.ownerId,
              grossUsdc: agent.priceUsdc,
              creatorUsdc: payoutSource === "creator" ? agent.priceUsdc : 0,
              platformUsdc: payoutSource === "platform" ? agent.priceUsdc : 0,
              payTo: payout.payTo,
              payoutSource,
              payer: ap2AuthorizationRecord.payer,
              tx: ap2AuthorizationRecord.tx,
            };
          } else if (ap2AuthorizationRecord.state !== "authorized") {
            const pending = ap2AuthorizationRecord.state === "settling"
              || ap2AuthorizationRecord.state === "executing"
              || ap2AuthorizationRecord.state === "pending_reconciliation";
            return NextResponse.json({
              error: pending ? "ap2_authorization_pending" : "ap2_authorization_terminal",
              state: ap2AuthorizationRecord.state,
            }, { status: pending ? 202 : 409, headers: { "retry-after": pending ? "3" : "0" } });
          }
        }
        if (!paymentAlreadySettled) {
          const settling = await repo.transitionAp2Authorization({
            id: ap2AuthorizationRecord.id,
            fromState: "authorized",
            toState: "settling",
            decisionCode: "checkout_authorized",
            receiptJson: ap2EvidenceProjection(),
          });
          if (!settling) {
            return NextResponse.json(
              { error: "ap2_authorization_pending", state: "settling" },
              { status: 202, headers: { "retry-after": "3" } },
            );
          }
          ap2AuthorizationRecord = settling;
        }
      }

      // Ordinary x402 has no AP2 authorization row to anchor recovery. Create
      // its durable run identity before the facilitator can move money so a
      // transient runs-table failure can never become a settled payment with
      // no run to reconcile. Challenges without a payment header remain
      // side-effect free.
      if (!paymentAlreadySettled && !ap2AuthorizationRecord && paymentHeader && !precreatedRunId) {
        const durableRunId = ordinaryPaymentRunId(agent.id, paymentHeader);
        const existing = await repo.getRun(durableRunId);
        if (existing?.id === durableRunId) {
          if (decodePaymentHeader(paymentHeader) === null) {
            if (existing.status === "running") await repo.finishRun(durableRunId, "error", 0);
            return challenge("x_payment_header_invalid_base64_json");
          }
          const recorded = await repo.getSettlementByRun(durableRunId);
          return ordinaryPaymentReconciliationResponse({
            runId: durableRunId,
            transaction: recorded?.tx ?? null,
          });
        }
        const runRecord = await repo.createRun({
          id: durableRunId,
          flowId: flow.id,
          agentId: agent.id,
          trigger: "agent",
          triggerInput: parsed.data.input ?? null,
          runVariables: parsed.data.runVariables ?? null,
        });
        precreatedRunId = runRecord.id;
      }

      const settlement = paymentAlreadySettled ? null : await verifyAndSettle({
        paymentHeader,
        payTo: payout.payTo,
        amountUsdc: agent.priceUsdc,
        resource: resourceUrl,
        description: resourceDescription,
        serviceName: "Suede Agent Studio",
        tags: serviceTags,
        outputSchema,
        extensions: advertisedExtensions,
        requireExactAmount: ap2RouteAuthorization !== null,
      });
      if (settlement && !settlement.ok) {
        if (ap2AuthorizationRecord) {
          const ambiguous = isAmbiguousSettlementFailure(settlement.reason);
          const receipt = ambiguous ? null : await terminalCheckoutReceipt({
            status: "Error",
            error: "x402_rejected",
            errorDescription: "The payment authorization was rejected.",
          });
          const failureBody: Ap2SanitizedJson = {
            error: settlement.reason,
            ...(receipt ? {
                ap2: {
                  profile: AP2_PROFILE,
                  authorizationMode: ap2AuthorizationMode,
                  checkoutReceipt: receipt,
                },
              } : {}),
          };
          await repo.transitionAp2Authorization({
            id: ap2AuthorizationRecord.id,
            fromState: "settling",
            toState: ambiguous ? "pending_reconciliation" : "failed",
            decisionCode: ambiguous ? "settlement_ambiguous" : "x402_rejected",
            receiptJson: ap2EvidenceProjection({ checkoutReceipt: receipt }),
            ...(ambiguous ? {} : { resultJson: ap2ResponseEnvelope(402, failureBody) }),
          });
          if (ambiguous) {
            return NextResponse.json(
              { error: "payment_pending_reconciliation", message: "Settlement outcome is being reconciled." },
              { status: 503, headers: { "retry-after": "10" } },
            );
          }
        } else if (precreatedRunId) {
          await repo.finishRun(precreatedRunId, "error", 0);
          if (isAmbiguousSettlementFailure(settlement.reason)) {
            return ordinaryPaymentReconciliationResponse({
              runId: precreatedRunId,
              transaction: null,
            });
          }
        }
        return challenge(settlement.reason);
      }
      if (settlement) {
        settledTransaction = settlement.transaction;
        settledPayer = settlement.payer;
        didSettlePayment = true;
      }
      if (ap2AuthorizationRecord && settlement) {
        let settled = await repo.transitionAp2Authorization({
          id: ap2AuthorizationRecord.id,
          fromState: "settling",
          toState: "settled",
          decisionCode: "x402_settled",
          tx: settlement.transaction,
        });
        if (!settled) {
          const current = await repo.getAp2AuthorizationByMandateReference(
            ap2AuthorizationRecord.mandateReference,
          );
          if (current?.state === "pending_reconciliation") {
            settled = await repo.transitionAp2Authorization({
              id: current.id,
              fromState: "pending_reconciliation",
              toState: "settled",
              decisionCode: "x402_settled_after_retry_race",
              tx: settlement.transaction,
            });
          }
        }
        if (!settled) {
          return NextResponse.json(
            { error: "payment_pending_reconciliation", message: "Payment settled; fulfillment is paused for reconciliation." },
            { status: 503, headers: { "retry-after": "10" } },
          );
        }
        ap2AuthorizationRecord = settled;
      }
      // resolvePayout routes 100% of the call to a single payTo, so the
      // actual amounts follow the payout source verbatim. When split
      // collection lands at settlement, this is the one place that changes
      // to record the real creator/platform split.
      if (settlement) settlementFacts = {
        agentId: agent.id,
        ownerId: flow.ownerId,
        grossUsdc: agent.priceUsdc,
        creatorUsdc: payoutSource === "creator" ? agent.priceUsdc : 0,
        platformUsdc: payoutSource === "platform" ? agent.priceUsdc : 0,
        payTo: payout.payTo,
        payoutSource,
        payer: settlement.payer,
        tx: settlement.transaction,
      };
    }

    // Track whether we settled so we can stamp the run after it finishes.
    // Keyed off the settlement flag — not the transaction hash, which the
    // facilitator may legitimately return as null on an otherwise-good settle.
    const didSettle = didSettlePayment;
    // Check for a relay endpoint — self-hosted agents forward here instead
    // of running through the engine. Run still gets recorded the same way.
    if (relayRow && !dryRun) {
      const relay = await consumePreparedPublishedLiveRelay(preparedLive, {
        flowId: flow.id,
        ownerId: flow.ownerId,
        agentId: agent.id,
      });
      if (!relay) {
        return NextResponse.json({ error: "published run unavailable" }, { status: 503 });
      }
      // Create the run record before forwarding so the run id is stable.
      const runRecord = precreatedRunId
        ? { id: precreatedRunId }
        : await repo.createRun({
            flowId: flow.id,
            agentId: agent.id,
            trigger: "agent",
            triggerInput: parsed.data.input ?? null,
            runVariables: parsed.data.runVariables ?? null,
          });
      if (ap2AuthorizationRecord?.state === "settled") {
        const requestWindow = relayV2RequestWindow();
        const endpointBinding = relayV2EndpointBindingHash({
          url: relayRow.url,
          createdAt: relayRow.createdAt,
          protocolVersion: String(relayRow.protocolVersion),
        });
        const executing = await repo.transitionAp2Authorization({
          id: ap2AuthorizationRecord.id,
          fromState: "settled",
          toState: "executing",
          decisionCode: "relay_delivery_started",
          runId: runRecord.id,
          receiptJson: ap2EvidenceProjection({
            relay: {
              protocol: RELAY_V2_PROTOCOL,
              endpointBinding,
              notAfter: requestWindow.notAfter,
              deliveryId: runRecord.id,
            },
          }),
        });
        if (!executing) {
          return NextResponse.json(
            { error: "payment_record_unavailable", message: "Payment settled; relay fulfillment did not start." },
            { status: 503 },
          );
        }
        ap2AuthorizationRecord = executing;
        try {
          if (didSettle) await persistSettlementAccounting(runRecord.id);
        } catch {
          const receipt = await terminalCheckoutReceipt({
            status: "Error",
            error: "settlement_accounting_failed",
            errorDescription: "Payment accounting could not be finalized before relay delivery.",
          });
          const failure: Ap2SanitizedJson = {
            ...relayTerminalFailure("Payment accounting could not be finalized before relay delivery."),
            ...(receipt ? {
                ap2: {
                  profile: AP2_PROFILE,
                  authorizationMode: ap2AuthorizationMode,
                  checkoutReceipt: receipt,
                },
              } : {}),
          };
          await repo.finishRun(runRecord.id, "error", 0).catch(() => undefined);
          await repo.transitionAp2Authorization({
            id: ap2AuthorizationRecord.id,
            fromState: "executing",
            toState: "failed",
            decisionCode: "settlement_accounting_failed",
            runId: runRecord.id,
            receiptJson: ap2EvidenceProjection({ checkoutReceipt: receipt }),
            resultJson: ap2ResponseEnvelope(503, failure),
          }).catch(() => null);
          return NextResponse.json(failure, { status: 503 });
        }
        const relayDelivery = await executeRelayV2({
          relay: { url: relayRow.url, secret: relayRow.secret },
          runId: runRecord.id,
          agent: agent.slug,
          input: parsed.data.input ?? {},
          requestWindow,
        });
        if (relayDelivery.kind === "ambiguous") return relayPendingResponse();
        if (relayDelivery.state === "completed" || relayDelivery.state === "failed") {
          return finalizeRelayDelivery(ap2AuthorizationRecord, relayDelivery);
        }
        return relayPendingResponse();
      }
      let relayOutput: unknown;
      try {
        if (didSettle) await persistSettlementAccounting(runRecord.id);
        relayOutput = await forwardToRelay(
          parsed.data.input ?? {},
          relay,
          runRecord.id,
          agent.slug,
        );
      } catch (err: unknown) {
        await repo.finishRun(runRecord.id, "error", 0);
        const status = err instanceof RelayError ? 502 : 500;
        const failure: Ap2SanitizedJson = err instanceof RelayError
          ? { error: "relay_error", message: err.message }
          : { error: "internal error" };
        if (ap2AuthorizationRecord?.state === "executing") {
          await repo.transitionAp2Authorization({
            id: ap2AuthorizationRecord.id,
            fromState: "executing",
            toState: "failed",
            decisionCode: "relay_failed",
            runId: runRecord.id,
            resultJson: ap2ResponseEnvelope(status, failure),
          });
        }
        return NextResponse.json(failure, { status });
      }
      await repo.finishRun(runRecord.id, "done", 0);
      const relayResponse = {
        runId: runRecord.id,
        status: "done",
        totalCostUsdc: 0,
        outputs: { relay: relayOutput as Record<string, unknown> },
        relayed: true,
        settled: didSettlePayment,
        ...(settledTransaction !== null && { transaction: settledTransaction }),
        ...(settledPayer !== null && { payer: settledPayer }),
        ...(ap2CheckoutReceipt ? {
          ap2: {
            profile: AP2_PROFILE,
            authorizationMode: ap2AuthorizationMode,
            checkoutReceipt: ap2CheckoutReceipt,
          },
        } : {}),
      };
      if (ap2AuthorizationRecord?.state === "executing") {
        const completed = await repo.transitionAp2Authorization({
          id: ap2AuthorizationRecord.id,
          fromState: "executing",
          toState: "completed",
          decisionCode: "fulfilled",
          runId: runRecord.id,
          resultJson: ap2ResponseEnvelope(200, relayResponse as Ap2SanitizedJson),
        });
        if (!completed) {
          return NextResponse.json(
            { error: "payment_record_unavailable", message: "The run completed but its AP2 receipt could not be finalized." },
            { status: 503 },
          );
        }
      }
      return NextResponse.json(relayResponse);
    }

    if (ap2AuthorizationRecord?.state === "settled" && !relayRow) {
      const runRecord = await repo.createRun({
        flowId: flow.id,
        agentId: agent.id,
        trigger: "agent",
        triggerInput: parsed.data.input ?? null,
        runVariables: parsed.data.runVariables ?? null,
      });
      try {
        const executing = await repo.transitionAp2Authorization({
          id: ap2AuthorizationRecord.id,
          fromState: "settled",
          toState: "executing",
          decisionCode: "fulfillment_started",
          runId: runRecord.id,
        });
        if (!executing) throw new Error("AP2 fulfillment state unavailable");
        ap2AuthorizationRecord = executing;
        await persistSettlementAccounting(runRecord.id);
        precreatedRunId = runRecord.id;
      } catch {
        const receipt = await terminalCheckoutReceipt({
          status: "Error",
          error: "settlement_accounting_failed",
          errorDescription: "Payment accounting could not be finalized before fulfillment.",
        });
        const failure: Ap2SanitizedJson = {
          error: "payment_record_unavailable",
          message: "Payment settled; fulfillment did not start.",
          ...(receipt ? {
              ap2: {
                profile: AP2_PROFILE,
                authorizationMode: ap2AuthorizationMode,
                checkoutReceipt: receipt,
              },
            } : {}),
        };
        await repo.finishRun(runRecord.id, "error", 0).catch(() => undefined);
        if (ap2AuthorizationRecord.state === "executing") {
          await repo.transitionAp2Authorization({
            id: ap2AuthorizationRecord.id,
            fromState: "executing",
            toState: "failed",
            decisionCode: "settlement_accounting_failed",
            runId: runRecord.id,
            receiptJson: ap2EvidenceProjection({ checkoutReceipt: receipt }),
            resultJson: ap2ResponseEnvelope(503, failure),
          }).catch(() => null);
        }
        return NextResponse.json(failure, { status: 503 });
      }
    }

    if (didSettlePayment && !ap2AuthorizationRecord && !relayRow && !precreatedRunId) {
      const runRecord = await repo.createRun({
        flowId: flow.id,
        agentId: agent.id,
        trigger: "agent",
        triggerInput: parsed.data.input ?? null,
        runVariables: parsed.data.runVariables ?? null,
      });
      precreatedRunId = runRecord.id;
      await persistSettlementAccounting(runRecord.id);
    }

    const summary = dryRun
      ? await runPreparedPublishedLiveDryRunToCompletion(preparedLive!, {
          trigger: "agent",
          agentId: agent.id,
          flowId: flow.id,
          ownerId: flow.ownerId,
          triggerInput: parsed.data.input,
          runVariables: parsed.data.runVariables,
          dryRun: true,
        })
      : await runPreparedPublishedLiveToCompletion(preparedLive!, {
          flowId: flow.id,
          ownerId: flow.ownerId,
          trigger: "agent",
          agentId: agent.id,
          triggerInput: parsed.data.input,
          runVariables: parsed.data.runVariables,
          ...(precreatedRunId ? { precreatedRunId } : {}),
        });
    if (!summary) {
      let failure: Ap2SanitizedJson = { error: "published run unavailable" };
      if (ap2AuthorizationRecord?.state === "executing") {
        const receipt = await terminalCheckoutReceipt({
          status: "Error",
          error: "published_run_unavailable",
          errorDescription: "The published fulfillment run was unavailable.",
        });
        failure = {
          error: "published run unavailable",
          ...(receipt ? {
              ap2: {
                profile: AP2_PROFILE,
                authorizationMode: ap2AuthorizationMode,
                checkoutReceipt: receipt,
              },
            } : {}),
        };
        await repo.transitionAp2Authorization({
          id: ap2AuthorizationRecord.id,
          fromState: "executing",
          toState: "failed",
          decisionCode: "published_run_unavailable",
          receiptJson: ap2EvidenceProjection({ checkoutReceipt: receipt }),
          resultJson: ap2ResponseEnvelope(503, failure),
        });
      }
      return NextResponse.json(failure, { status: 503 });
    }

    if (didSettle && !settlementAccountingPersisted) {
      await persistSettlementAccounting(summary.runId);
    }

    if (ap2AuthorizationRecord) {
      await terminalCheckoutReceipt(summary.status === "done"
        ? { status: "Success", orderId: summary.runId }
        : {
            status: "Error",
            error: "fulfillment_failed",
            errorDescription: "The fulfillment run finished with an error.",
          });
    }
    let responsePayload: unknown;
    if (service.kind === "resource") {
      if (!resourceRepository) return NextResponse.json({ error: "published run unavailable" }, { status: 503 });
      const envelope = await buildAndPersistResourceRunEnvelope({
        service,
        summary,
        payment: {
          priceUsdc: service.priceUsdc,
          state: didSettlePayment ? "settled" : "free",
          paymentId: settledTransaction,
        },
        repository: resourceRepository,
      });
      responsePayload = sanitizeAp2Json({
        ...envelope,
        ...(ap2CheckoutReceipt ? {
          ap2: {
            profile: AP2_PROFILE,
            authorizationMode: ap2AuthorizationMode,
            checkoutReceipt: ap2CheckoutReceipt,
          },
        } : {}),
      });
    } else {
      const result = extractCuratedServiceResult(curated, preparedGraph, summary.outputs);
      const responseOutputs = ap2AuthorizationRecord
        ? sanitizeAp2Json(summary.outputs)
        : summary.outputs;
      const responseResult = result && ap2AuthorizationRecord
        ? sanitizeAp2Json(result)
        : result;
      responsePayload = {
        runId: summary.runId,
        status: summary.status,
        totalCostUsdc: summary.totalCostUsdc,
        outputs: responseOutputs,
        ...(responseResult ? { result: responseResult } : {}),
        settled: didSettlePayment,
        // Additive: dry-run responses carry mode: "dry-run" so machine callers
        // can tell a simulation from a settled run; real runs add nothing.
        ...runModeResponseFields(dryRun),
        ...(settledTransaction !== null && { transaction: settledTransaction }),
        ...(settledPayer !== null && { payer: settledPayer }),
        ...(ap2CheckoutReceipt ? {
          ap2: {
            profile: AP2_PROFILE,
            authorizationMode: ap2AuthorizationMode,
            checkoutReceipt: ap2CheckoutReceipt,
          },
        } : {}),
      };
    }
    if (ap2AuthorizationRecord?.state === "executing") {
      const terminalState = summary.status === "done" ? "completed" : "failed";
      const terminal = await repo.transitionAp2Authorization({
        id: ap2AuthorizationRecord.id,
        fromState: "executing",
        toState: terminalState,
        decisionCode: summary.status === "done" ? "fulfilled" : "fulfillment_failed",
        runId: summary.runId,
        receiptJson: ap2EvidenceProjection({ checkoutReceipt: ap2CheckoutReceipt }),
        resultJson: ap2ResponseEnvelope(200, responsePayload as Ap2SanitizedJson),
      });
      if (!terminal) {
        return NextResponse.json(
          { error: "payment_record_unavailable", message: "The run finished but its AP2 state could not be finalized." },
          { status: 503 },
        );
      }
    }
    return NextResponse.json(responsePayload);
    } catch (error) {
      const failedRunId = precreatedRunId ?? runIdFromExecutionError(error);
      if (didSettlePayment && failedRunId) {
        try {
          if (!settlementAccountingPersisted) await persistSettlementAccounting(failedRunId);
        } catch {
          // The AP2 row remains the durable paid fact if the secondary
          // accounting projection is temporarily unavailable.
        }
      }
      if (ap2AuthorizationRecord?.state === "executing") {
        try {
          const failureBody: Ap2SanitizedJson = {
            error: "fulfillment_pending_reconciliation",
            message: "The paid run outcome is being reconciled and will not be executed again.",
            ...(failedRunId ? { runId: failedRunId } : {}),
          };
          await repo.transitionAp2Authorization({
            id: ap2AuthorizationRecord.id,
            fromState: "executing",
            toState: "pending_reconciliation",
            decisionCode: "fulfillment_exception_ambiguous",
            ...(failedRunId ? { runId: failedRunId } : {}),
            receiptJson: ap2EvidenceProjection(),
          });
          return NextResponse.json(failureBody, {
            status: 503,
            headers: { "retry-after": "30" },
          });
        } catch {
          // The outer opaque error response remains authoritative. Recovery
          // inspects the durable settling/settled/executing row out of band.
        }
      }
      if (didSettlePayment && !ap2AuthorizationRecord) {
        return NextResponse.json({
          error: "payment_pending_manual_reconciliation",
          message: "Payment settled; fulfillment requires manual reconciliation and will not be retried automatically.",
          ...(failedRunId ? { runId: failedRunId } : {}),
          ...(settledTransaction ? { transaction: settledTransaction } : {}),
        }, { status: 503, headers: { "cache-control": "no-store" } });
      }
      throw error;
    }
    } finally {
      if (preparedLive) disposePreparedPublishedLiveExecution(preparedLive);
    }
  } catch (error: unknown) {
    // Never surface raw error.message to the caller on the money path — it can
    // leak facilitator internals, DB errors, relay hosts, or stack context.
    // Log server-side; return an opaque error to the client.
    const classified = error instanceof Ap2ProtocolError
      ? error.code
      : error instanceof Error
        ? error.name
        : typeof error;
    console.error("agent run failed", { code: classified });
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
