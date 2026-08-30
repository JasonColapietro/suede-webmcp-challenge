import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resourcePack } from "./resources/fixture";
import { resourcePackSemanticHash } from "@/lib/resources/pack-hash";

const state = vi.hoisted(() => ({
  activeRevision: 1,
  agent: {
    id: "agent-1",
    flowId: "flow-1",
    slug: "published-agent",
    status: "live" as const,
    priceUsdc: 0,
    createdAt: 1,
    settlementLive: true,
  },
  flow: {
    id: "flow-1",
    ownerId: "owner-1",
    name: "Published flow",
    graph: { id: "draft-graph", name: "Draft", nodes: [], edges: [], revision: 1 },
    updatedAt: 1,
  },
  getFlow: vi.fn(),
  getRelayEndpoint: vi.fn(),
  createRun: vi.fn(),
  getRun: vi.fn(),
  listRunSteps: vi.fn(),
  finishRun: vi.fn(),
  stampRunSettled: vi.fn(),
  recordSettlement: vi.fn(),
  resolveAgent: vi.fn(),
  getSettlementByRun: vi.fn(),
  reserveAp2Authorization: vi.fn(),
  getAp2AuthorizationByMandateReference: vi.fn(),
  transitionAp2Authorization: vi.fn(),
  checkAp2ReplayStoreReady: vi.fn(),
  runToCompletion: vi.fn(),
  runPublishedLiveToCompletion: vi.fn(),
  preparePublishedLiveExecution: vi.fn(),
  runPreparedPublishedLiveToCompletion: vi.fn(),
  runPreparedPublishedLiveDryRunToCompletion: vi.fn(),
  consumePreparedPublishedLiveRelay: vi.fn(),
  preparedPublishedLiveRelaySnapshot: vi.fn(),
  runIdFromExecutionError: vi.fn(),
  disposePreparedPublishedLiveExecution: vi.fn(),
  bindPreparedPublishedLiveResourceSnapshot: vi.fn(),
  preparedPublishedLiveExecutionReceipt: vi.fn(),
  verifyAndSettle: vi.fn(),
  decodePaymentHeader: vi.fn(),
  verifyX402AuthorizationSignature: vi.fn(),
  loadAp2RunConfig: vi.fn(),
  issueAp2Checkout: vi.fn(),
  verifyAp2RunAuthorization: vi.fn(),
  expectedAp2X402Nonce: vi.fn(),
  hashAp2PaymentNonce: vi.fn(),
  ap2X402PaymentInstrumentId: vi.fn(),
  reconcileX402AuthorizationState: vi.fn(),
  issueCheckoutReceipt: vi.fn(),
  finalMandateReference: vi.fn(),
  finalMandateReplayIdentity: vi.fn(),
  connectionProvider: vi.fn(),
  decrypt: vi.fn(),
  fetch: vi.fn(),
  executeRelayV2: vi.fn(),
  queryRelayV2Status: vi.fn(),
  relayV2EndpointBindingHash: vi.fn(),
  relayV2RequestWindow: vi.fn(),
  recordResourceRunReceipt: vi.fn(),
  getResourceRepository: vi.fn(),
  getOwnedResourcePack: vi.fn(),
  listOwnedResourceProducts: vi.fn(),
  publicService: null as null | Readonly<Record<string, unknown>>,
  relaySnapshot: null as null | undefined | {
    agentId?: string;
    url: string;
    secret: string;
    protocolVersion: number;
    createdAt: string;
  },
}));

vi.mock("@/lib/agents", () => ({ resolveAgent: (...args: unknown[]) => state.resolveAgent(...args) }));
vi.mock("@/lib/db/repo", () => ({
  isAp2TerminalEvidenceExpired: (value: unknown) =>
    typeof value === "object" && value !== null
    && Reflect.get(Reflect.get(value, "evidenceRetention") ?? {}, "status") === "expired",
  getRepo: vi.fn(async () => ({
    getFlow: (...args: unknown[]) => state.getFlow(...args),
    getRelayEndpoint: (...args: unknown[]) => state.getRelayEndpoint(...args),
    createRun: (...args: unknown[]) => state.createRun(...args),
    getRun: (...args: unknown[]) => state.getRun(...args),
    listRunSteps: (...args: unknown[]) => state.listRunSteps(...args),
    finishRun: (...args: unknown[]) => state.finishRun(...args),
    stampRunSettled: (...args: unknown[]) => state.stampRunSettled(...args),
    recordSettlement: (...args: unknown[]) => state.recordSettlement(...args),
    getSettlementByRun: (...args: unknown[]) => state.getSettlementByRun(...args),
    reserveAp2Authorization: (...args: unknown[]) => state.reserveAp2Authorization(...args),
    getAp2AuthorizationByMandateReference: (...args: unknown[]) =>
      state.getAp2AuthorizationByMandateReference(...args),
    transitionAp2Authorization: (...args: unknown[]) => state.transitionAp2Authorization(...args),
    checkAp2ReplayStoreReady: (...args: unknown[]) => state.checkAp2ReplayStoreReady(...args),
  })),
}));
vi.mock("@/lib/run-service", () => ({
  runToCompletion: (...args: unknown[]) => state.runToCompletion(...args),
  runPublishedLiveToCompletion: (...args: unknown[]) => state.runPublishedLiveToCompletion(...args),
  preparePublishedLiveExecution: (...args: unknown[]) => state.preparePublishedLiveExecution(...args),
  runPreparedPublishedLiveToCompletion: (...args: unknown[]) => state.runPreparedPublishedLiveToCompletion(...args),
  runPreparedPublishedLiveDryRunToCompletion: (...args: unknown[]) =>
    state.runPreparedPublishedLiveDryRunToCompletion(...args),
  consumePreparedPublishedLiveRelay: (...args: unknown[]) =>
    state.consumePreparedPublishedLiveRelay(...args),
  preparedPublishedLiveRelaySnapshot: (...args: unknown[]) =>
    state.preparedPublishedLiveRelaySnapshot(...args),
  disposePreparedPublishedLiveExecution: (...args: unknown[]) => state.disposePreparedPublishedLiveExecution(...args),
  bindPreparedPublishedLiveResourceSnapshot: (...args: unknown[]) =>
    state.bindPreparedPublishedLiveResourceSnapshot(...args),
  preparedPublishedLiveExecutionReceipt: (...args: unknown[]) =>
    state.preparedPublishedLiveExecutionReceipt(...args),
  // Pure helpers mirrored from the real module so the mock stays in sync with
  // the run route's imports; these tests exercise connection gating, not the
  // dry-run marker or input-contract validation.
  runModeResponseFields: (dryRun: boolean) => (dryRun ? { mode: "dry-run" } : {}),
  triggerInputContractViolations: () => [],
  runIdFromExecutionError: (...args: unknown[]) => state.runIdFromExecutionError(...args),
}));
vi.mock("@/lib/connections/provider", () => ({
  getConnectionRepository: (...args: unknown[]) => state.connectionProvider(...args),
}));
vi.mock("@/lib/payout", () => ({
  resolvePayout: vi.fn(async () => ({ source: "creator", payTo: "0x1111111111111111111111111111111111111111" })),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(() => ({ allowed: true })),
  ipFromRequest: vi.fn(() => "127.0.0.1"),
}));
vi.mock("@/lib/rails/x402-verify", () => ({
  USDC_TOKEN_ADDRESS: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  X402_FACILITATOR_NETWORK: "eip155:8453",
  X402_SCHEME: "exact",
  X402_AGENT_RUN_RESOURCE_DESCRIPTION:
    "Run a Suede Agent Studio workflow over x402.",
  X402_RUN_OUTPUT_SCHEMA: {},
  buildX402BazaarExtensions: vi.fn(() => ({ bazaar: {} })),
  buildX402Accept: vi.fn(() => ({})),
  buildX402PaymentRequired: vi.fn(() => ({ accepts: [{}] })),
  encodeX402Header: vi.fn(() => ""),
  usdcToAtomic: (amount: number) => String(Math.round(amount * 1_000_000)),
  decodePaymentHeader: (...args: unknown[]) => state.decodePaymentHeader(...args),
  x402AuthorizationIdentity: vi.fn(() => ({
    x402Version: 2,
    payer: "0x2222222222222222222222222222222222222222",
    payTo: "0x1111111111111111111111111111111111111111",
    amountAtomic: "1000000",
    nonce: "0xap2nonce",
    validAfter: "0",
    validBefore: "1787000300",
    network: "eip155:8453",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    scheme: "exact",
  })),
  verifyAndSettle: (...args: unknown[]) => state.verifyAndSettle(...args),
  verifyX402AuthorizationSignature: (...args: unknown[]) =>
    state.verifyX402AuthorizationSignature(...args),
}));
vi.mock("@/lib/rails/ap2-runtime", () => ({
  AP2_PROFILE: "ap2-v0.2-experimental",
  loadAp2RunConfig: (...args: unknown[]) => state.loadAp2RunConfig(...args),
  issueAp2Checkout: (...args: unknown[]) => state.issueAp2Checkout(...args),
  verifyAp2RunAuthorization: (...args: unknown[]) => state.verifyAp2RunAuthorization(...args),
  expectedAp2X402Nonce: (...args: unknown[]) => state.expectedAp2X402Nonce(...args),
  hashAp2PaymentNonce: (...args: unknown[]) => state.hashAp2PaymentNonce(...args),
  ap2X402PaymentInstrumentId: (...args: unknown[]) => state.ap2X402PaymentInstrumentId(...args),
}));
vi.mock("@/lib/rails/ap2", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/rails/ap2")>(),
  issueCheckoutReceipt: (...args: unknown[]) => state.issueCheckoutReceipt(...args),
  finalMandateReference: (...args: unknown[]) => state.finalMandateReference(...args),
  finalMandateReplayIdentity: (...args: unknown[]) => state.finalMandateReplayIdentity(...args),
}));
vi.mock("@/lib/rails/x402-reconcile", () => ({
  reconcileX402AuthorizationState: (...args: unknown[]) =>
    state.reconcileX402AuthorizationState(...args),
}));
vi.mock("@/lib/relay", () => ({
  RelayError: class RelayError extends Error {},
  forwardToRelay: (...args: unknown[]) => state.fetch(...args),
}));
vi.mock("@/lib/relay-v2", () => ({
  RELAY_V2_PROTOCOL: "suede-relay/2",
  executeRelayV2: (...args: unknown[]) => state.executeRelayV2(...args),
  queryRelayV2Status: (...args: unknown[]) => state.queryRelayV2Status(...args),
  relayV2EndpointBindingHash: (...args: unknown[]) => state.relayV2EndpointBindingHash(...args),
  relayV2RequestWindow: (...args: unknown[]) => state.relayV2RequestWindow(...args),
}));
vi.mock("@/lib/resources/provider", () => ({
  getResourceRepository: (...args: unknown[]) => state.getResourceRepository(...args),
}));

function resourceRepository() {
  return {
    getOwnedPack: (...args: unknown[]) => state.getOwnedResourcePack(...args),
    listOwnedProducts: (...args: unknown[]) => state.listOwnedResourceProducts(...args),
    recordRunReceipt: (...args: unknown[]) => state.recordResourceRunReceipt(...args),
  };
}
vi.mock("@/lib/public-service-contract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/public-service-contract")>();
  return {
    ...actual,
    resolvePublicServiceContractFromRelease: (...args: Parameters<typeof actual.resolvePublicServiceContractFromRelease>) =>
      state.publicService ?? actual.resolvePublicServiceContractFromRelease(...args),
  };
});

function context() {
  return { params: Promise.resolve({ agent: "published-agent" }) };
}

function request(body: Readonly<Record<string, unknown>>, query = "", payment?: string): Request {
  return new Request(`https://agents.suedeai.ai/api/agents/published-agent/run${query}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(payment ? { "x-payment": payment } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function route() {
  return import("@/app/api/agents/[agent]/run/route");
}

function immutableResourceMarker(
  revision: number,
  resourceAccess: Readonly<{
    executionAccess: "free" | "paid" | "private";
    discoveryAccess: "public" | "unlisted";
  }>,
  semanticHash = "c".repeat(64),
) {
  return Object.freeze({
    id: "flow-1",
    slug: state.agent.slug,
    name: `Live v${revision}`,
    packVersionId: "pack-1",
    semanticHash,
    freshness: "fresh" as const,
    ...resourceAccess,
    sourceDisclosure: Object.freeze({
      corpus: "private" as const,
      sourceCount: 1,
      sourceKinds: Object.freeze(["manual"]),
    }),
    jobContract: resourcePack().jobContract,
  });
}

function preparedLiveHandle(
  revision = state.activeRevision,
  relay = false,
  resourceAccess?: Readonly<{ executionAccess: "free" | "paid" | "private"; discoveryAccess: "public" | "unlisted" }>,
) {
  const graph = Object.freeze({
    id: `live-graph-v${revision}`,
    name: `Live v${revision}`,
    nodes: Object.freeze([]),
    edges: Object.freeze([]),
    revision,
    ...(resourceAccess === undefined ? {} : {
      meta: { resourceProduct: immutableResourceMarker(revision, resourceAccess) },
    }),
  });
  return Object.freeze({
    graph,
    resourceDependencies: Object.freeze(resourceAccess === undefined ? [] : [{
      resourceProductId: "flow-1",
      packVersionId: "pack-1",
      contentHash: "c".repeat(64),
    }]),
    release: Object.freeze({
      ownerId: "owner-1",
      flowId: "flow-1",
      deploymentId: `deployment-v${revision}`,
      environmentId: "environment-live",
      flowVersionId: `version-v${revision}`,
      semanticHash: "a".repeat(64),
      fullHash: "b".repeat(64),
    }),
    agent: Object.freeze({
      id: state.agent.id,
      flowId: state.agent.flowId,
      priceUsdc: state.agent.priceUsdc,
    }),
    relay,
  });
}

function readyAp2(mode: "optional" | "required" = "optional") {
  return {
    readiness: {
      mode,
      ready: true,
      advertise: true,
      requireAuthorization: mode === "required",
      reason: null,
      reasons: [],
    },
    signing: { issuer: "https://agents.suedeai.ai", keyId: "merchant-key" },
    trustedIssuers: { byIssuer: new Map() },
  };
}

function verifiedAp2(paymentInstrumentId =
  "eip155:8453:0x2222222222222222222222222222222222222222") {
  return {
    authorization: {
      mode: "direct",
      checkoutReference: "checkout-reference",
      paymentReference: "payment-reference",
      paymentReplayIdentity: "payment-replay-identity",
      paymentInstrumentId,
      issuer: "https://wallet.example",
    },
    expected: {
      requestDigest: "request-digest",
      checkoutHash: "checkout-hash",
      amountMinorUsd: 100,
      payee: { id: "suede-agent-studio" },
    },
    expiresAt: 1_787_000_300,
  };
}

function ap2Record(stateName: string, overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: "ap2-authorization-1",
    mandateReference: "payment-replay-identity",
    paymentNonceHash: "payment-nonce-hash",
    requestDigest: "request-digest",
    issuer: "https://wallet.example",
    subjectId: null,
    checkoutHash: "checkout-hash",
    agentId: "agent-1",
    flowId: "flow-1",
    deploymentId: "deployment-1",
    network: "eip155:8453",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    amountAtomic: "1000000",
    amountMinorUsd: 100,
    payeeId: "suede-agent-studio",
    payTo: "0x1111111111111111111111111111111111111111",
    payer: "0x2222222222222222222222222222222222222222",
    state: stateName,
    decisionCode: null,
    receiptJson: null,
    resultJson: null,
    expiresAt: "2026-08-13T22:00:00.000Z",
    paymentValidBefore: "2026-08-13T21:59:00.000Z",
    runId: null,
    tx: null,
    createdAt: "2026-08-13T21:55:00.000Z",
    updatedAt: "2026-08-13T21:55:00.000Z",
    ...overrides,
  };
}

type MutableAp2TestRecord = Omit<
  ReturnType<typeof ap2Record>,
  "state" | "decisionCode" | "receiptJson" | "resultJson"
> & {
  state: string;
  decisionCode: unknown;
  receiptJson: unknown;
  resultJson: unknown;
};

/*
 * Every payment fixture below authorizes until epoch second 1_787_000_300 --
 * 2026-08-17T20:58:20Z -- an absolute instant baked in when these tests were
 * written. Wall-clock passed it on 2026-08-17 and the suite went red on a
 * clock tick with no code change: expired authorizations make the gate answer
 * 402, so every assertion expecting a real status (200/202/409/502/503) failed.
 * Pin the suite clock an hour inside the window instead. Derived from the
 * fixture value rather than restated, so the two cannot drift apart again.
 */
const AUTHORIZATION_EXPIRES_AT = 1_787_000_300;
const SUITE_CLOCK = new Date((AUTHORIZATION_EXPIRES_AT - 3_600) * 1_000);

afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(SUITE_CLOCK);
  vi.stubEnv("X402_SKIP_SETTLEMENT", "false");
  state.agent.priceUsdc = 0;
  state.activeRevision = 1;
  state.publicService = null;
  state.flow = {
    id: "flow-1",
    ownerId: "owner-1",
    name: "Published flow",
    graph: { id: "draft-graph", name: "Draft", nodes: [], edges: [], revision: 1 },
    updatedAt: 1,
  };
  state.getFlow.mockImplementation(async () => state.flow);
  state.resolveAgent.mockImplementation(async () => state.agent);
  state.getRelayEndpoint.mockResolvedValue(null);
  state.createRun.mockResolvedValue({ id: "relay-run" });
  state.getRun.mockResolvedValue({ id: "relay-run", settledAt: "2026-08-14T00:00:00.000Z" });
  state.listRunSteps.mockResolvedValue([]);
  state.finishRun.mockResolvedValue(undefined);
  state.stampRunSettled.mockResolvedValue(undefined);
  state.recordSettlement.mockResolvedValue(undefined);
  state.getSettlementByRun.mockImplementation(async (runId: string) => {
    const call = state.recordSettlement.mock.calls.find(([input]) => input.runId === runId);
    return call ? { ...call[0], createdAt: "2026-08-14T00:00:00.000Z" } : null;
  });
  state.reserveAp2Authorization.mockReset();
  state.getAp2AuthorizationByMandateReference.mockResolvedValue(null);
  state.transitionAp2Authorization.mockReset();
  state.checkAp2ReplayStoreReady.mockResolvedValue(true);
  state.runToCompletion.mockImplementation(async (graph: { readonly revision: number }) => ({
    runId: "dry-run",
    status: "done",
    totalCostUsdc: 0,
    outputs: { preview: { revision: graph.revision } },
  }));
  state.runPublishedLiveToCompletion.mockImplementation(async () => ({
    runId: `live-v${state.activeRevision}`,
    status: "done",
    totalCostUsdc: 0,
    outputs: { published: { revision: state.activeRevision } },
  }));
  state.preparePublishedLiveExecution.mockImplementation(async () => preparedLiveHandle());
  state.runPreparedPublishedLiveToCompletion.mockImplementation(async () => ({
    runId: `live-v${state.activeRevision}`,
    status: "done",
    totalCostUsdc: 0,
    outputs: { published: { revision: state.activeRevision } },
  }));
  state.runPreparedPublishedLiveDryRunToCompletion.mockImplementation(async (prepared: {
    readonly graph: { readonly revision: number };
  }) => ({
    runId: "dry-run",
    status: "done",
    totalCostUsdc: 0,
    outputs: { preview: { revision: prepared.graph.revision } },
  }));
  state.consumePreparedPublishedLiveRelay.mockImplementation(async () => state.relaySnapshot
    ? { url: state.relaySnapshot.url, secret: state.relaySnapshot.secret }
    : null);
  state.relaySnapshot = null;
  state.preparedPublishedLiveRelaySnapshot.mockImplementation(() => state.relaySnapshot);
  state.runIdFromExecutionError.mockReturnValue(null);
  state.disposePreparedPublishedLiveExecution.mockReturnValue(undefined);
  state.bindPreparedPublishedLiveResourceSnapshot.mockReturnValue(true);
  state.preparedPublishedLiveExecutionReceipt.mockReturnValue({
    ownerId: "owner-1",
    flowId: "flow-1",
    deploymentId: "deployment-1",
    environmentId: "environment-live",
    flowVersionId: "version-1",
    semanticHash: "a".repeat(64),
    fullHash: "b".repeat(64),
  });
  state.verifyAndSettle.mockResolvedValue({ ok: true, transaction: null, payer: null });
  state.decodePaymentHeader.mockReturnValue({
    x402Version: 2,
    resource: { url: "https://agents.suedeai.ai/api/agents/published-agent/run" },
    accepted: {
      scheme: "exact",
      network: "eip155:8453",
      amount: "1000000",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: "0x1111111111111111111111111111111111111111",
    },
  });
  state.verifyX402AuthorizationSignature.mockResolvedValue(true);
  state.loadAp2RunConfig.mockResolvedValue({
    readiness: {
      mode: "off",
      ready: false,
      advertise: false,
      requireAuthorization: false,
      reason: "mode_off",
      reasons: ["mode_off"],
    },
  });
  state.expectedAp2X402Nonce.mockReturnValue("0xap2nonce");
  state.hashAp2PaymentNonce.mockReturnValue("payment-nonce-hash");
  state.ap2X402PaymentInstrumentId.mockReturnValue(
    "eip155:8453:0x2222222222222222222222222222222222222222",
  );
  state.issueCheckoutReceipt.mockResolvedValue("signed-checkout-receipt");
  state.finalMandateReference.mockImplementation((presentation: string) =>
    presentation.includes("payment") ? "payment-reference" : "checkout-reference");
  state.finalMandateReplayIdentity.mockReturnValue("payment-replay-identity");
  state.reconcileX402AuthorizationState.mockResolvedValue({
    status: "unavailable",
    definitive: false,
    reason: "rpc_unavailable",
  });
  state.executeRelayV2.mockResolvedValue({
    kind: "delivery",
    protocol: "suede-relay/2",
    deliveryId: "relay-run",
    state: "completed",
    httpStatus: 200,
    output: { ok: true },
  });
  state.queryRelayV2Status.mockResolvedValue({
    kind: "delivery",
    protocol: "suede-relay/2",
    deliveryId: "relay-run",
    state: "running",
    httpStatus: 202,
  });
  state.relayV2EndpointBindingHash.mockImplementation(({ url, createdAt, protocolVersion }) =>
    `binding:${url}:${createdAt}:${protocolVersion}`);
  state.relayV2RequestWindow.mockReturnValue({
    issuedAt: "2026-08-14T00:00:00.000Z",
    notAfter: "2026-08-14T00:00:15.000Z",
  });
  state.recordResourceRunReceipt.mockResolvedValue({ id: "resource-receipt-1" });
  state.getResourceRepository.mockImplementation(async () => resourceRepository());
  state.listOwnedResourceProducts.mockResolvedValue([{
    id: "flow-1",
    approvedPackVersionId: "pack-1",
    livePackVersionId: "pack-1",
  }]);
  state.getOwnedResourcePack.mockResolvedValue({
    resourceProductId: "flow-1",
    packVersionId: "pack-1",
    semanticHash: "c".repeat(64),
    freshness: "fresh",
    content: resourcePack(),
  });
});

describe("published agent Live connection boundary", () => {
  it("pins v1 across Draft edits, switches on v2 promotion, and ignores caller authority fields", async () => {
    const { POST } = await route();
    const attackerFields = {
      graph: { id: "attacker-graph" },
      versionId: "attacker-version",
      deploymentId: "attacker-deployment",
      environment: "test",
      semanticHash: "attacker-semantic",
      fullHash: "attacker-full",
      connection: { token: "attacker-token" },
    };

    state.flow.graph.revision = 99;
    const v1 = await POST(request({ input: { topic: "launch" }, runVariables: { audience: "fans" }, ...attackerFields }), context());
    expect(v1.status).toBe(200);
    expect(await v1.json()).toMatchObject({ runId: "live-v1", outputs: { published: { revision: 1 } } });
    expect(state.preparePublishedLiveExecution).toHaveBeenLastCalledWith({
      flowId: "flow-1",
      ownerId: "owner-1",
      agent: { id: "agent-1", priceUsdc: 0 },
    });
    expect(state.runPreparedPublishedLiveToCompletion).toHaveBeenLastCalledWith(
      expect.any(Object),
      {
      flowId: "flow-1",
      ownerId: "owner-1",
      trigger: "agent",
      agentId: "agent-1",
      triggerInput: { topic: "launch" },
      runVariables: { audience: "fans" },
      },
    );
    expect(JSON.stringify(state.runPreparedPublishedLiveToCompletion.mock.calls.at(-1)?.[1])).not.toMatch(
      /attacker|graph|version|deployment|environment|hash|connection|token/u,
    );
    expect(state.runToCompletion).not.toHaveBeenCalled();

    state.activeRevision = 2;
    const v2 = await POST(request({ input: { topic: "promoted" } }), context());
    expect(await v2.json()).toMatchObject({ runId: "live-v2", outputs: { published: { revision: 2 } } });
    expect(state.runToCompletion).not.toHaveBeenCalled();
  });

  it("runs explicit dry previews from the prepared immutable Live graph", async () => {
    const { POST } = await route();
    state.flow.graph.revision = 77;

    const response = await POST(request({ input: { preview: true }, dryRun: true }), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      runId: "dry-run",
      settled: false,
      outputs: { preview: { revision: 1 } },
    });
    expect(state.runPreparedPublishedLiveDryRunToCompletion).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        trigger: "agent",
        agentId: "agent-1",
        flowId: "flow-1",
        triggerInput: { preview: true },
        dryRun: true,
      }),
    );
    expect(state.preparePublishedLiveExecution).toHaveBeenCalledWith({
      flowId: "flow-1",
      ownerId: "owner-1",
      agent: { id: "agent-1", priceUsdc: 0 },
    });
    expect(state.runPreparedPublishedLiveToCompletion).not.toHaveBeenCalled();
    expect(state.connectionProvider).not.toHaveBeenCalled();
    expect(state.decrypt).not.toHaveBeenCalled();
    expect(state.fetch).not.toHaveBeenCalled();
  });

  it.each(["direct", "nested"] as const)(
    "refuses a markerless %s resource.query closure before replay, Resource provider, settlement, or output work",
    async (placement) => {
      const { POST } = await route();
      const prepared = preparedLiveHandle();
      const graph = Object.freeze({
        ...prepared.graph,
        nodes: Object.freeze(placement === "direct"
          ? [{ id: "resource-query", type: "resource.query", params: {}, position: { x: 0, y: 0 } }]
          : [{ id: "nested-resource", type: "subflow", params: {}, position: { x: 0, y: 0 } }]),
      });
      state.preparePublishedLiveExecution.mockResolvedValue(Object.freeze({
        ...prepared,
        graph,
        resourceDependencies: Object.freeze([{
          resourceProductId: "flow-1",
          packVersionId: "pack-1",
          contentHash: "c".repeat(64),
        }]),
      }));

      const response = await POST(request({ input: { query: "private corpus" } }), context());

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "agent not found" });
      expect(state.getResourceRepository).not.toHaveBeenCalled();
      expect(state.getOwnedResourcePack).not.toHaveBeenCalled();
      expect(state.verifyAndSettle).not.toHaveBeenCalled();
      expect(state.createRun).not.toHaveBeenCalled();
      expect(state.recordSettlement).not.toHaveBeenCalled();
      expect(state.runPreparedPublishedLiveToCompletion).not.toHaveBeenCalled();
      expect(state.runPreparedPublishedLiveDryRunToCompletion).not.toHaveBeenCalled();
      expect(state.recordResourceRunReceipt).not.toHaveBeenCalled();
    },
  );

  it("denies public execution of an immutable private Resource Product before settlement or execution", async () => {
    const { POST } = await route();
    state.preparePublishedLiveExecution.mockResolvedValue(preparedLiveHandle(1, false, {
      executionAccess: "private", discoveryAccess: "public",
    }));

    const response = await POST(request({ input: { private: true } }), context());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "agent not found" });
    expect(state.verifyAndSettle).not.toHaveBeenCalled();
    expect(state.runPreparedPublishedLiveToCompletion).not.toHaveBeenCalled();
    expect(state.runPreparedPublishedLiveDryRunToCompletion).not.toHaveBeenCalled();
  });

  it("refuses a legacy valid-first invalid-second Resource pack before payment or ledger mutation", async () => {
    const { POST } = await route();
    state.agent.priceUsdc = 1;
    state.preparePublishedLiveExecution.mockResolvedValue(preparedLiveHandle(1, false, {
      executionAccess: "paid", discoveryAccess: "public",
    }));
    state.publicService = {
      kind: "resource",
      resource: {
        resourceProductId: "flow-1",
        resourceVersion: "pack-1",
        semanticHash: "c".repeat(64),
        access: { execution: "paid", discovery: "public" },
      },
    };
    state.getOwnedResourcePack.mockResolvedValue({
      resourceProductId: "flow-1",
      packVersionId: "pack-1",
      semanticHash: "c".repeat(64),
      freshness: "fresh",
      content: {
        recordSchema: {
          type: "object",
          properties: { name: { type: "string" }, score: { type: "number" } },
          required: ["name"],
          additionalProperties: false,
        },
        filterFields: [],
        returnFields: ["name", "score"],
        taxonomy: [],
        records: [
          { id: "valid-first", fields: { name: "Alpha", score: 1 }, tags: [], evidenceIds: [] },
          { id: "invalid-second", fields: { name: "Beta", score: "not-a-number" }, tags: [], evidenceIds: [] },
        ],
        evidence: [],
        sourceSnapshotIds: [],
        jobContract: {
          jobStatement: "Return reviewed records.",
          buyerIntent: "Find one reviewed record.",
          inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
          outputSchema: {
            type: "array",
            items: {
              type: "object",
              properties: { name: { type: "string" }, score: { type: "number" } },
              required: ["name"],
              additionalProperties: false,
            },
          },
          unsupportedRequest: "Return no records.",
          evidenceRequirement: "Evidence is optional.",
          safeExample: [],
          reviewBoundary: "Reviewed records only.",
          dataHandlingDisclosure: "Private inputs remain private.",
        },
      },
    });

    const response = await POST(
      request({ input: { invoiceId: "inv-1" } }, "", "valid-payment"),
      context(),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "published run unavailable" });
    expect(state.verifyAndSettle).not.toHaveBeenCalled();
    expect(state.reserveAp2Authorization).not.toHaveBeenCalled();
    expect(state.createRun).not.toHaveBeenCalled();
    expect(state.stampRunSettled).not.toHaveBeenCalled();
    expect(state.recordSettlement).not.toHaveBeenCalled();
    expect(state.runPreparedPublishedLiveToCompletion).not.toHaveBeenCalled();
  });

  it("refuses freshness advancing immediately after read two before settlement persistence, execution, or receipt writes", async () => {
    const { POST } = await route();
    const content = resourcePack();
    const semanticHash = resourcePackSemanticHash(content).semanticHash;
    state.agent.priceUsdc = 1;
    const prepared = preparedLiveHandle(1, false, {
      executionAccess: "paid", discoveryAccess: "public",
    });
    state.preparePublishedLiveExecution.mockResolvedValue(Object.freeze({
      ...prepared,
      graph: Object.freeze({
        ...prepared.graph,
        meta: { resourceProduct: immutableResourceMarker(1, {
          executionAccess: "paid",
          discoveryAccess: "public",
        }, semanticHash) },
      }),
      resourceDependencies: Object.freeze([{
        resourceProductId: "flow-1",
        packVersionId: "pack-1",
        contentHash: semanticHash,
      }]),
    }));
    state.publicService = {
      kind: "resource",
      inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
      resource: {
        resourceProductId: "flow-1",
        resourceVersion: "pack-1",
        semanticHash,
        access: { execution: "paid", discovery: "public" },
      },
    };
    state.getOwnedResourcePack
      .mockResolvedValueOnce({
        resourceProductId: "flow-1",
        packVersionId: "pack-1",
        semanticHash,
        freshness: "fresh",
        content,
      })
      .mockResolvedValueOnce({
        resourceProductId: "flow-1",
        packVersionId: "pack-1",
        semanticHash,
        freshness: "stale",
        content,
      });

    const response = await POST(request({ input: {} }, "", "valid-payment"), context());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "published run unavailable" });
    expect(state.getOwnedResourcePack).toHaveBeenCalledTimes(2);
    expect(state.bindPreparedPublishedLiveResourceSnapshot).not.toHaveBeenCalled();
    expect(state.verifyAndSettle).not.toHaveBeenCalled();
    expect(state.reserveAp2Authorization).not.toHaveBeenCalled();
    expect(state.createRun).not.toHaveBeenCalled();
    expect(state.stampRunSettled).not.toHaveBeenCalled();
    expect(state.recordSettlement).not.toHaveBeenCalled();
    expect(state.runPreparedPublishedLiveToCompletion).not.toHaveBeenCalled();
    expect(state.runPreparedPublishedLiveDryRunToCompletion).not.toHaveBeenCalled();
    expect(state.recordResourceRunReceipt).not.toHaveBeenCalled();
  });

  it("refuses an array-enum Resource contract whose two-row projection can fail after payment", async () => {
    const { POST } = await route();
    state.agent.priceUsdc = 1;
    state.preparePublishedLiveExecution.mockResolvedValue(preparedLiveHandle(1, false, {
      executionAccess: "paid", discoveryAccess: "public",
    }));
    const projected = [
      { name: "Alpha", category: "keep" },
      { name: "Beta", category: "keep" },
      { name: "Gamma", category: "other" },
    ];
    const outputSchema = {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, category: { type: "string" } },
        required: ["name", "category"],
        additionalProperties: false,
      },
      enum: [[], ...projected.map((row) => [row]), projected],
    };
    const jobContract = {
      jobStatement: "Return deterministic reviewed records.",
      buyerIntent: "Find reviewed records by category.",
      inputSchema: {
        type: "object",
        properties: { category: { type: "string" } },
        required: ["category"],
        additionalProperties: false,
      },
      outputSchema,
      unsupportedRequest: "Return no records.",
      evidenceRequirement: "Evidence is optional.",
      safeExample: [],
      reviewBoundary: "Reviewed records only.",
      dataHandlingDisclosure: "Private inputs remain private.",
    };
    state.publicService = {
      kind: "resource",
      priceUsdc: 1,
      description: jobContract.jobStatement,
      tags: ["resource"],
      inputSchema: jobContract.inputSchema,
      outputSchema,
      exampleInput: { category: "keep" },
      resource: {
        resourceProductId: "flow-1",
        resourceVersion: "pack-1",
        semanticHash: "c".repeat(64),
        access: { execution: "paid", discovery: "public" },
        jobContract,
      },
    };
    state.getOwnedResourcePack.mockResolvedValue({
      resourceProductId: "flow-1",
      packVersionId: "pack-1",
      semanticHash: "c".repeat(64),
      freshness: "fresh",
      content: {
        recordSchema: {
          type: "object",
          properties: { name: { type: "string" }, category: { type: "string" } },
          required: ["name", "category"],
          additionalProperties: false,
        },
        filterFields: ["category"],
        returnFields: ["name", "category"],
        taxonomy: [],
        records: projected.map((fields, index) => ({
          id: `record-${index + 1}`, fields, tags: [], evidenceIds: [],
        })),
        evidence: [],
        sourceSnapshotIds: [],
        jobContract,
      },
    });

    const response = await POST(
      request({ input: { category: "keep" } }, "", "valid-payment"),
      context(),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "published run unavailable" });
    expect(state.verifyAndSettle).not.toHaveBeenCalled();
    expect(state.createRun).not.toHaveBeenCalled();
    expect(state.recordSettlement).not.toHaveBeenCalled();
    expect(state.runPreparedPublishedLiveToCompletion).not.toHaveBeenCalled();
  });

  it("makes private and unknown agents identically opaque before malformed body validation", async () => {
    const { POST } = await route();
    state.preparePublishedLiveExecution.mockResolvedValue(preparedLiveHandle(1, false, {
      executionAccess: "private", discoveryAccess: "public",
    }));
    const malformedBody = { input: {}, dryRun: "not-a-boolean" };
    const privateMalformed = await POST(request(malformedBody), context());
    const privateValid = await POST(request({ input: {} }), context());

    state.resolveAgent.mockResolvedValue(null);
    const unknownMalformed = await POST(request(malformedBody), context());
    const unknownValid = await POST(request({ input: {} }), context());

    const responses = [privateMalformed, privateValid, unknownMalformed, unknownValid];
    expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404]);
    await expect(Promise.all(responses.map((response) => response.json())))
      .resolves.toEqual(Array.from({ length: 4 }, () => ({ error: "agent not found" })));
    expect(state.preparePublishedLiveExecution).toHaveBeenCalledTimes(2);
    expect(state.verifyAndSettle).not.toHaveBeenCalled();
    expect(state.runPreparedPublishedLiveToCompletion).not.toHaveBeenCalled();
    expect(state.runPreparedPublishedLiveDryRunToCompletion).not.toHaveBeenCalled();
  });

  it("returns one private unavailable response for every Live mismatch before decrypt or fetch", async () => {
    const { POST } = await route();
    state.preparePublishedLiveExecution.mockResolvedValue(null);

    const response = await POST(request({ input: { topic: "launch" } }), context());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "published run unavailable" });
    expect(state.runToCompletion).not.toHaveBeenCalled();
    expect(state.runPreparedPublishedLiveToCompletion).not.toHaveBeenCalled();
    expect(state.decrypt).not.toHaveBeenCalled();
    expect(state.fetch).not.toHaveBeenCalled();
  });

  it("refuses api.operation on the relay Live path before settlement, run writes, or forwarding", async () => {
    const { POST } = await route();
    state.agent.priceUsdc = 1;
    state.getRelayEndpoint.mockResolvedValue({ url: "https://relay.example.test", secret: "private" });
    state.preparePublishedLiveExecution.mockRejectedValue(Object.assign(new Error("private"), {
      code: "API_OPERATION_LIVE_UNAVAILABLE",
    }));

    const response = await POST(request({ input: { topic: "relay" } }, "", "valid-payment"), context());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "API_OPERATION_LIVE_UNAVAILABLE" });
    expect(state.preparePublishedLiveExecution).toHaveBeenCalledWith({
      flowId: "flow-1",
      ownerId: "owner-1",
      agent: { id: "agent-1", priceUsdc: 1 },
    });
    expect(state.verifyAndSettle).not.toHaveBeenCalled();
    expect(state.createRun).not.toHaveBeenCalled();
    expect(state.finishRun).not.toHaveBeenCalled();
    expect(state.fetch).not.toHaveBeenCalled();
    expect(state.runToCompletion).not.toHaveBeenCalled();
    expect(state.runPreparedPublishedLiveToCompletion).not.toHaveBeenCalled();
  });

  it("ignores an api.operation Draft during a relay preview and uses the prepared Live graph", async () => {
    const { POST } = await route();
    const prepared = preparedLiveHandle(1, true);
    state.preparePublishedLiveExecution.mockResolvedValue(prepared);
    state.relaySnapshot = {
      agentId: "agent-1",
      url: "https://live.example.test/run",
      secret: "live",
      protocolVersion: 2,
      createdAt: "2026-08-13T20:00:00.000Z",
    };
    state.getRelayEndpoint.mockResolvedValue({ url: "https://relay.example.test", secret: "private" });
    state.flow.graph = {
      schemaVersion: 2,
      id: "draft-api-operation",
      name: "Draft API operation",
      nodes: [{
        id: "api", type: "api.operation",
        params: {
          connectorDefinitionVersionId: "00000000-0000-4000-8000-000000000601",
          operationVersionId: "00000000-0000-4000-8000-000000000602",
          operationId: "createThing",
          connectorProjectionHash: "1".repeat(64),
          operationProjectionHash: "2".repeat(64),
          schemaHash: "3".repeat(64),
        },
        bindings: {}, position: { x: 0, y: 0 },
      }],
      edges: [], variables: [], groups: [], annotations: [], revision: 2,
    } as unknown as typeof state.flow.graph;

    const response = await POST(request({ input: { topic: "preview" }, dryRun: true }), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      runId: "dry-run",
      settled: false,
      totalCostUsdc: 0,
    });
    expect(state.preparePublishedLiveExecution).toHaveBeenCalledWith({
      flowId: "flow-1",
      ownerId: "owner-1",
      agent: { id: "agent-1", priceUsdc: 0 },
    });
    expect(state.verifyAndSettle).not.toHaveBeenCalled();
    expect(state.createRun).not.toHaveBeenCalled();
    expect(state.finishRun).not.toHaveBeenCalled();
    expect(state.fetch).not.toHaveBeenCalled();
    expect(state.getRelayEndpoint).not.toHaveBeenCalled();
    expect(state.runPreparedPublishedLiveDryRunToCompletion).toHaveBeenCalledWith(
      prepared,
      expect.objectContaining({ dryRun: true, flowId: "flow-1", agentId: "agent-1" }),
    );
    expect(state.runPreparedPublishedLiveToCompletion).not.toHaveBeenCalled();
  });

  it("prepares before paid settlement and does not charge when Live is unavailable", async () => {
    const { POST } = await route();
    state.agent.priceUsdc = 1;
    state.preparePublishedLiveExecution.mockResolvedValue(null);

    const response = await POST(request({ input: { topic: "launch" } }, "", "valid-payment"), context());

    expect(response.status).toBe(503);
    expect(state.preparePublishedLiveExecution).toHaveBeenCalledTimes(1);
    expect(state.verifyAndSettle).not.toHaveBeenCalled();
    expect(state.runPreparedPublishedLiveToCompletion).not.toHaveBeenCalled();
  });

  it("settles only after preparation and consumes that same prepared authority", async () => {
    const { POST } = await route();
    state.agent.priceUsdc = 1;
    const prepared = preparedLiveHandle();
    state.preparePublishedLiveExecution.mockResolvedValue(prepared);
    state.runPreparedPublishedLiveToCompletion.mockResolvedValue({
      runId: "relay-run",
      status: "done",
      totalCostUsdc: 0,
      outputs: { published: { revision: state.activeRevision } },
    });

    const response = await POST(request({ input: { topic: "paid" } }, "", "valid-payment"), context());

    expect(response.status).toBe(200);
    expect(state.preparePublishedLiveExecution.mock.invocationCallOrder[0])
      .toBeLessThan(state.verifyAndSettle.mock.invocationCallOrder[0]!);
    expect(state.createRun.mock.invocationCallOrder[0])
      .toBeLessThan(state.verifyAndSettle.mock.invocationCallOrder[0]!);
    expect(state.verifyAndSettle.mock.invocationCallOrder[0])
      .toBeLessThan(state.runPreparedPublishedLiveToCompletion.mock.invocationCallOrder[0]!);
    expect(state.runPreparedPublishedLiveToCompletion).toHaveBeenCalledWith(
      prepared,
      expect.objectContaining({
        flowId: "flow-1",
        ownerId: "owner-1",
        triggerInput: { topic: "paid" },
        precreatedRunId: "relay-run",
      }),
    );
    // The settlement ledger row records what actually routed: single payTo,
    // creator source → full gross to the creator, nothing to the platform.
    expect(state.recordSettlement).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "relay-run",
        agentId: "agent-1",
        ownerId: "owner-1",
        grossUsdc: 1,
        creatorUsdc: 1,
        platformUsdc: 0,
        payTo: "0x1111111111111111111111111111111111111111",
        payoutSource: "creator",
      }),
    );
  });

  it("forwards only through the relay endpoint captured by the prepared authority", async () => {
    const { POST } = await route();
    state.agent.priceUsdc = 1;
    const prepared = preparedLiveHandle(1, true);
    state.preparePublishedLiveExecution.mockResolvedValue(prepared);
    state.relaySnapshot = {
      agentId: "agent-1",
      url: "https://live.example.test/run",
      secret: "live",
      protocolVersion: 2,
      createdAt: "2026-08-13T20:00:00.000Z",
    };
    state.getRelayEndpoint.mockResolvedValue({ url: "https://draft.example.test/run", secret: "draft" });
    state.consumePreparedPublishedLiveRelay.mockResolvedValue({
      url: "https://live.example.test/run",
      secret: "live",
    });
    state.fetch.mockResolvedValue({ accepted: true });

    const response = await POST(request({ input: { topic: "paid" } }, "", "valid-payment"), context());

    expect(response.status).toBe(200);
    expect(state.getRelayEndpoint).not.toHaveBeenCalled();
    expect(state.consumePreparedPublishedLiveRelay).toHaveBeenCalledWith(
      prepared,
      expect.objectContaining({ flowId: "flow-1", ownerId: "owner-1", agentId: "agent-1" }),
    );
    expect(state.fetch).toHaveBeenCalledWith(
      { topic: "paid" },
      { url: "https://live.example.test/run", secret: "live" },
      "relay-run",
      "published-agent",
    );
  });

  it("keeps prepared-Live payment challenges byte-stable", async () => {
    const { POST } = await route();
    state.agent.priceUsdc = 1;

    const response = await POST(request({ input: { topic: "challenge" } }), context());

    expect(response.status).toBe(402);
    expect(await response.text()).toBe('{"accepts":[{}]}');
    expect({
      paymentRequired: response.headers.get("PAYMENT-REQUIRED"),
      expose: response.headers.get("Access-Control-Expose-Headers"),
      link: response.headers.get("Link"),
      contentType: response.headers.get("content-type"),
    }).toEqual({
      paymentRequired: "",
      expose: "PAYMENT-REQUIRED,PAYMENT-RESPONSE,Link",
      link: "<https://agents.suedeai.ai/.well-known/x402>; rel=\"x402-discovery\"; type=\"application/json\"",
      contentType: "application/json",
    });
  });

  it("disposes prepared Live authority when returning a payment challenge or failed settlement", async () => {
    const { POST } = await route();
    state.agent.priceUsdc = 1;
    const prepared = preparedLiveHandle();
    state.preparePublishedLiveExecution.mockResolvedValue(prepared);

    const challenge = await POST(request({ input: {} }), context());
    expect(challenge.status).toBe(402);
    expect(state.disposePreparedPublishedLiveExecution).toHaveBeenCalledWith(prepared);

    vi.clearAllMocks();
    state.getFlow.mockResolvedValue(state.flow);
    state.getRelayEndpoint.mockResolvedValue(null);
    state.preparePublishedLiveExecution.mockResolvedValue(prepared);
    state.verifyAndSettle.mockResolvedValue({ ok: false, reason: "invalid" });
    const failed = await POST(request({ input: {} }, "", "invalid-payment"), context());
    expect(failed.status).toBe(402);
    expect(state.disposePreparedPublishedLiveExecution).toHaveBeenCalledWith(prepared);
    expect(state.runPreparedPublishedLiveToCompletion).not.toHaveBeenCalled();
  });

  it("issues an AP2 checkout only after the common Live/input/payout preflight", async () => {
    const { POST } = await route();
    state.agent.priceUsdc = 1;
    state.loadAp2RunConfig.mockResolvedValue(readyAp2());
    state.issueAp2Checkout.mockResolvedValue({
      checkoutJwt: "merchant.checkout.jwt",
      checkoutHash: "checkout-hash",
      challengeNonce: "merchant-challenge-nonce",
      expiresAt: 1_787_000_300,
      binding: { amountAtomic: "1000000", amountMinorUsd: 100 },
    });

    const response = await POST(request({ input: { invoiceId: "inv-1" } }, "?ap2Checkout=1"), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      protocol: "AP2",
      version: "0.2",
      profile: "ap2-v0.2-experimental",
      checkoutJwt: "merchant.checkout.jwt",
      challengeNonce: "merchant-challenge-nonce",
      payment: { rail: "x402-v2", amountAtomic: "1000000" },
    });
    expect(state.preparePublishedLiveExecution.mock.invocationCallOrder[0])
      .toBeLessThan(state.issueAp2Checkout.mock.invocationCallOrder[0]!);
    expect(state.issueAp2Checkout).toHaveBeenCalledWith(expect.objectContaining({
      terms: expect.objectContaining({
        agentId: "agent-1",
        live: expect.objectContaining({ deploymentId: "deployment-1" }),
        input: { invoiceId: "inv-1" },
        payTo: "0x1111111111111111111111111111111111111111",
      }),
    }));
    expect(state.verifyAndSettle).not.toHaveBeenCalled();
    expect(state.runPreparedPublishedLiveToCompletion).not.toHaveBeenCalled();
  });

  it("refuses AP2 on the legacy relay captured by preparation before settlement", async () => {
    const { POST } = await route();
    state.agent.priceUsdc = 1;
    const prepared = preparedLiveHandle(1, true);
    state.preparePublishedLiveExecution.mockResolvedValue(prepared);
    state.relaySnapshot = {
      agentId: "agent-1",
      url: "https://relay.example.test",
      secret: "private",
      protocolVersion: 1,
      createdAt: "2026-08-13T00:00:00.000Z",
    };

    const response = await POST(
      request({ input: { invoiceId: "inv-1" } }, "?ap2Checkout=1"),
      context(),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "ap2_relay_v2_required" });
    expect(state.preparePublishedLiveExecution).toHaveBeenCalledOnce();
    expect(state.verifyAndSettle).not.toHaveBeenCalled();
  });

  it("requires AP2 before payment in required mode", async () => {
    const { POST } = await route();
    state.agent.priceUsdc = 1;
    state.loadAp2RunConfig.mockResolvedValue(readyAp2("required"));

    const response = await POST(request({ input: { invoiceId: "inv-1" } }, "", "valid-payment"), context());

    expect(response.status).toBe(428);
    expect(await response.json()).toMatchObject({ error: "ap2_mandate_required" });
    expect(state.verifyAndSettle).not.toHaveBeenCalled();
    expect(state.runPreparedPublishedLiveToCompletion).not.toHaveBeenCalled();
  });

  it("fails closed before payment when required-mode AP2 readiness is unavailable", async () => {
    const { POST } = await route();
    state.agent.priceUsdc = 1;
    state.loadAp2RunConfig.mockResolvedValue({
      readiness: {
        mode: "required",
        ready: false,
        advertise: false,
        requireAuthorization: false,
        reason: "replay_store_unavailable",
        reasons: ["replay_store_unavailable"],
      },
    });

    const response = await POST(request({ input: { invoiceId: "inv-1" } }, "", "valid-payment"), context());

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "ap2_not_ready" });
    expect(state.verifyAndSettle).not.toHaveBeenCalled();
    expect(state.runPreparedPublishedLiveToCompletion).not.toHaveBeenCalled();
  });

  it("reserves a verified AP2 authorization before exactly-once settlement and fulfillment", async () => {
    const { POST } = await route();
    state.agent.priceUsdc = 1;
    state.loadAp2RunConfig.mockResolvedValue(readyAp2());
    state.verifyAp2RunAuthorization.mockResolvedValue({
      authorization: {
        mode: "direct",
        checkoutReference: "checkout-reference",
        paymentReference: "payment-reference",
        paymentReplayIdentity: "payment-replay-identity",
        paymentInstrumentId: "eip155:8453:0x2222222222222222222222222222222222222222",
        issuer: "https://wallet.example",
      },
      expected: {
        requestDigest: "request-digest",
        checkoutHash: "checkout-hash",
        amountMinorUsd: 100,
        payee: { id: "suede-agent-studio" },
      },
      expiresAt: 1_787_000_300,
    });
    state.reserveAp2Authorization.mockResolvedValue({
      status: "reserved",
      authorization: ap2Record("authorized"),
    });
    state.transitionAp2Authorization.mockImplementation(async (input: { toState: string }) =>
      ap2Record(input.toState));

    const response = await POST(request({
      input: { invoiceId: "inv-1" },
      ap2: {
        authorizationMode: "direct",
        checkoutMandateSdJwt: "checkout-mandate~",
        paymentMandateSdJwt: "payment-mandate~",
      },
    }, "", "valid-payment"), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      runId: "live-v1",
      settled: true,
      ap2: {
        profile: "ap2-v0.2-experimental",
        authorizationMode: "direct",
        checkoutReceipt: "signed-checkout-receipt",
      },
    });
    expect(state.verifyAp2RunAuthorization.mock.invocationCallOrder[0])
      .toBeLessThan(state.reserveAp2Authorization.mock.invocationCallOrder[0]!);
    expect(state.verifyX402AuthorizationSignature.mock.invocationCallOrder[0])
      .toBeLessThan(state.reserveAp2Authorization.mock.invocationCallOrder[0]!);
    expect(state.reserveAp2Authorization.mock.invocationCallOrder[0])
      .toBeLessThan(state.verifyAndSettle.mock.invocationCallOrder[0]!);
    expect(state.verifyAndSettle.mock.invocationCallOrder[0])
      .toBeLessThan(state.runPreparedPublishedLiveToCompletion.mock.invocationCallOrder[0]!);
    expect(state.transitionAp2Authorization.mock.calls.map(([input]) => input.toState))
      .toEqual(["settling", "settled", "executing", "completed"]);
    expect(state.verifyAndSettle).toHaveBeenCalledWith(expect.objectContaining({
      requireExactAmount: true,
    }));
    expect(state.reserveAp2Authorization).toHaveBeenCalledWith(expect.objectContaining({
      mandateReference: "payment-replay-identity",
    }));
    expect(state.expectedAp2X402Nonce).toHaveBeenCalledWith(
      "payment-replay-identity",
      "checkout-hash",
    );
  });

  it("returns the same signed Error receipt persisted when paid fulfillment is unavailable", async () => {
    const { POST } = await route();
    state.agent.priceUsdc = 1;
    state.loadAp2RunConfig.mockResolvedValue(readyAp2());
    state.verifyAp2RunAuthorization.mockResolvedValue(verifiedAp2());
    state.reserveAp2Authorization.mockResolvedValue({
      status: "reserved",
      authorization: ap2Record("authorized"),
    });
    state.transitionAp2Authorization.mockImplementation(async (input: { toState: string }) =>
      ap2Record(input.toState));
    state.runPreparedPublishedLiveToCompletion.mockResolvedValue(null);

    const response = await POST(request({
      input: { invoiceId: "inv-1" },
      ap2: {
        authorizationMode: "direct",
        checkoutMandateSdJwt: "checkout-mandate~",
        paymentMandateSdJwt: "payment-mandate~",
      },
    }, "", "valid-payment"), context());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "published run unavailable",
      ap2: {
        profile: "ap2-v0.2-experimental",
        authorizationMode: "direct",
        checkoutReceipt: "signed-checkout-receipt",
      },
    });
    expect(state.transitionAp2Authorization).toHaveBeenLastCalledWith(expect.objectContaining({
      fromState: "executing",
      toState: "failed",
      decisionCode: "published_run_unavailable",
      receiptJson: expect.objectContaining({
        checkoutReceipt: "signed-checkout-receipt",
      }),
      resultJson: expect.objectContaining({
        httpStatus: 503,
        body: expect.objectContaining({
          ap2: expect.objectContaining({ checkoutReceipt: "signed-checkout-receipt" }),
        }),
      }),
    }));
  });

  it("does not sign a Success checkout receipt in the pre-payment challenge", async () => {
    const { POST } = await route();
    state.agent.priceUsdc = 1;
    state.loadAp2RunConfig.mockResolvedValue(readyAp2());
    state.verifyAp2RunAuthorization.mockResolvedValue(verifiedAp2());

    const response = await POST(request({
      input: { invoiceId: "inv-1" },
      ap2: {
        authorizationMode: "direct",
        checkoutMandateSdJwt: "checkout-mandate~",
        paymentMandateSdJwt: "payment-mandate~",
      },
    }), context());

    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({
      ap2: {
        checkoutReference: "checkout-reference",
        paymentReference: "payment-reference",
      },
    });
    expect(state.issueCheckoutReceipt).not.toHaveBeenCalled();
    expect(state.reserveAp2Authorization).not.toHaveBeenCalled();
    expect(state.verifyAndSettle).not.toHaveBeenCalled();
  });

  it("persists an ambiguous AP2 settlement and never executes or issues a fresh challenge", async () => {
    const { POST } = await route();
    state.agent.priceUsdc = 1;
    state.loadAp2RunConfig.mockResolvedValue(readyAp2());
    state.verifyAp2RunAuthorization.mockResolvedValue({
      authorization: {
        mode: "direct",
        checkoutReference: "checkout-reference",
        paymentReference: "payment-reference",
        paymentReplayIdentity: "payment-replay-identity",
        paymentInstrumentId: "eip155:8453:0x2222222222222222222222222222222222222222",
        issuer: "https://wallet.example",
      },
      expected: {
        requestDigest: "request-digest",
        checkoutHash: "checkout-hash",
        amountMinorUsd: 100,
        payee: { id: "suede-agent-studio" },
      },
      expiresAt: 1_787_000_300,
    });
    state.reserveAp2Authorization.mockResolvedValue({
      status: "reserved",
      authorization: ap2Record("authorized"),
    });
    state.transitionAp2Authorization.mockImplementation(async (input: { toState: string }) =>
      ap2Record(input.toState));
    state.verifyAndSettle.mockResolvedValue({
      ok: false,
      reason: "facilitator_settle_network_error_timeout",
    });

    const response = await POST(request({
      input: { invoiceId: "inv-1" },
      ap2: {
        authorizationMode: "direct",
        checkoutMandateSdJwt: "checkout-mandate~",
        paymentMandateSdJwt: "payment-mandate~",
      },
    }, "", "valid-payment"), context());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "payment_pending_reconciliation",
      message: "Settlement outcome is being reconciled.",
    });
    expect(state.transitionAp2Authorization.mock.calls.map(([input]) => input.toState))
      .toEqual(["settling", "pending_reconciliation"]);
    expect(state.issueCheckoutReceipt).not.toHaveBeenCalled();
    expect(state.runPreparedPublishedLiveToCompletion).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated or wrong-payer instrument before reservation", async () => {
    const { POST } = await route();
    state.agent.priceUsdc = 1;
    state.loadAp2RunConfig.mockResolvedValue(readyAp2());
    state.verifyAp2RunAuthorization.mockResolvedValue(verifiedAp2(
      "eip155:8453:0x3333333333333333333333333333333333333333",
    ));

    const wrongInstrument = await POST(request({
      input: { invoiceId: "inv-1" },
      ap2: {
        authorizationMode: "direct",
        checkoutMandateSdJwt: "checkout-mandate~",
        paymentMandateSdJwt: "payment-mandate~",
      },
    }, "", "valid-payment"), context());

    expect(wrongInstrument.status).toBe(402);
    expect(state.reserveAp2Authorization).not.toHaveBeenCalled();
    expect(state.verifyAndSettle).not.toHaveBeenCalled();

    state.verifyAp2RunAuthorization.mockResolvedValue(verifiedAp2());
    state.verifyX402AuthorizationSignature.mockResolvedValue(false);
    const badSignature = await POST(request({
      input: { invoiceId: "inv-1" },
      ap2: {
        authorizationMode: "direct",
        checkoutMandateSdJwt: "checkout-mandate~",
        paymentMandateSdJwt: "payment-mandate~",
      },
    }, "", "invalid-payment"), context());

    expect(badSignature.status).toBe(402);
    expect(state.reserveAp2Authorization).not.toHaveBeenCalled();
    expect(state.verifyAndSettle).not.toHaveBeenCalled();
  });

  it("discovers a finalized exact EIP-3009 transfer and resumes without settling twice", async () => {
    const { POST } = await route();
    state.agent.priceUsdc = 1;
    state.loadAp2RunConfig.mockResolvedValue(readyAp2());
    state.verifyAp2RunAuthorization.mockResolvedValue({
      authorization: {
        mode: "direct",
        checkoutReference: "checkout-reference",
        paymentReference: "payment-reference",
        paymentReplayIdentity: "payment-replay-identity",
        paymentInstrumentId: "eip155:8453:0x2222222222222222222222222222222222222222",
        issuer: "https://wallet.example",
      },
      expected: {
        requestDigest: "request-digest",
        checkoutHash: "checkout-hash",
        amountMinorUsd: 100,
        payee: { id: "suede-agent-studio" },
      },
      expiresAt: 1_787_000_300,
    });
    state.reserveAp2Authorization.mockResolvedValue({
      status: "exact-retry",
      authorization: ap2Record("pending_reconciliation"),
    });
    state.reconcileX402AuthorizationState.mockResolvedValue({
      status: "used",
      definitive: true,
      transactionHash: `0x${"a".repeat(64)}`,
    });
    state.transitionAp2Authorization.mockImplementation(async (input: { toState: string }) =>
      ap2Record(input.toState));

    const response = await POST(request({
      input: { invoiceId: "inv-1" },
      ap2: {
        authorizationMode: "direct",
        checkoutMandateSdJwt: "checkout-mandate~",
        paymentMandateSdJwt: "payment-mandate~",
      },
    }, "", "valid-payment"), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ runId: "live-v1", settled: true });
    const reconciliationInput = state.reconcileX402AuthorizationState.mock.calls[0]?.[0];
    expect(reconciliationInput).toMatchObject({
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payer: "0x2222222222222222222222222222222222222222",
      payTo: "0x1111111111111111111111111111111111111111",
      nonce: "0xap2nonce",
      amountAtomic: "1000000",
    });
    expect(reconciliationInput).not.toHaveProperty("transactionHash");
    expect(state.verifyAndSettle).not.toHaveBeenCalled();
    expect(state.transitionAp2Authorization.mock.calls.map(([input]) => input.toState))
      .toEqual(["settled", "executing", "completed"]);
    expect(state.transitionAp2Authorization).toHaveBeenCalledWith(expect.objectContaining({
      fromState: "pending_reconciliation",
      toState: "settled",
      tx: `0x${"a".repeat(64)}`,
    }));
    expect(state.runPreparedPublishedLiveToCompletion).toHaveBeenCalledOnce();
  });

  it("terminally rejects an expired unused EIP-3009 authorization", async () => {
    const { POST } = await route();
    state.agent.priceUsdc = 1;
    state.loadAp2RunConfig.mockResolvedValue(readyAp2());
    state.verifyAp2RunAuthorization.mockResolvedValue({
      authorization: {
        mode: "direct",
        checkoutReference: "checkout-reference",
        paymentReference: "payment-reference",
        paymentReplayIdentity: "payment-replay-identity",
        paymentInstrumentId: "eip155:8453:0x2222222222222222222222222222222222222222",
        issuer: "https://wallet.example",
      },
      expected: {
        requestDigest: "request-digest",
        checkoutHash: "checkout-hash",
        amountMinorUsd: 100,
        payee: { id: "suede-agent-studio" },
      },
      expiresAt: 1_787_000_300,
    });
    state.reserveAp2Authorization.mockResolvedValue({
      status: "exact-retry",
      authorization: ap2Record("pending_reconciliation", { tx: `0x${"b".repeat(64)}` }),
    });
    state.reconcileX402AuthorizationState.mockResolvedValue({
      status: "unused",
      definitive: true,
      reason: "expired",
    });
    state.transitionAp2Authorization.mockImplementation(async (input: { toState: string }) =>
      ap2Record(input.toState));

    const response = await POST(request({
      input: { invoiceId: "inv-1" },
      ap2: {
        authorizationMode: "direct",
        checkoutMandateSdJwt: "checkout-mandate~",
        paymentMandateSdJwt: "payment-mandate~",
      },
    }, "", "valid-payment"), context());

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "payment_not_settled",
      message: "The expected transaction did not settle this checkout.",
      ap2: { checkoutReceipt: "signed-checkout-receipt" },
    });
    expect(state.verifyAndSettle).not.toHaveBeenCalled();
    expect(state.runPreparedPublishedLiveToCompletion).not.toHaveBeenCalled();
    expect(state.transitionAp2Authorization).toHaveBeenCalledWith(expect.objectContaining({
      fromState: "pending_reconciliation",
      toState: "failed",
      resultJson: expect.objectContaining({ httpStatus: 409 }),
    }));
  });

  it("replays the stored terminal failure response for an exact retry", async () => {
    const { POST } = await route();
    state.agent.priceUsdc = 1;
    state.loadAp2RunConfig.mockResolvedValue(readyAp2());
    state.verifyAp2RunAuthorization.mockResolvedValue({
      authorization: {
        mode: "direct",
        checkoutReference: "checkout-reference",
        paymentReference: "payment-reference",
        paymentReplayIdentity: "payment-replay-identity",
        paymentInstrumentId: "eip155:8453:0x2222222222222222222222222222222222222222",
        issuer: "https://wallet.example",
      },
      expected: {
        requestDigest: "request-digest",
        checkoutHash: "checkout-hash",
        amountMinorUsd: 100,
        payee: { id: "suede-agent-studio" },
      },
      expiresAt: 1_787_000_300,
    });
    state.reserveAp2Authorization.mockResolvedValue({
      status: "exact-retry",
      authorization: ap2Record("failed", {
        resultJson: {
          httpStatus: 502,
          body: { error: "relay_error", message: "Relay execution failed." },
        },
      }),
    });

    const response = await POST(request({
      input: { invoiceId: "inv-1" },
      ap2: {
        authorizationMode: "direct",
        checkoutMandateSdJwt: "checkout-mandate~",
        paymentMandateSdJwt: "payment-mandate~",
      },
    }, "", "valid-payment"), context());

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "relay_error",
      message: "Relay execution failed.",
    });
    expect(state.reconcileX402AuthorizationState).not.toHaveBeenCalled();
    expect(state.verifyAndSettle).not.toHaveBeenCalled();
    expect(state.transitionAp2Authorization).not.toHaveBeenCalled();
    expect(state.runPreparedPublishedLiveToCompletion).not.toHaveBeenCalled();
  });

  it("replays a durable terminal result after expiry and mutable price drift only after current contract preparation", async () => {
    const { POST } = await route();
    const { buildAp2RequestDigest } = await import("@/lib/rails/ap2");
    state.agent.priceUsdc = 9;
    const requestDigest = buildAp2RequestDigest({
      method: "POST",
      resource: "https://agents.suedeai.ai/api/agents/published-agent/run",
      body: { input: { invoiceId: "inv-1" } },
    });
    state.getAp2AuthorizationByMandateReference.mockResolvedValue(ap2Record("completed", {
      requestDigest,
      expiresAt: "2026-01-01T00:00:00.000Z",
      paymentValidBefore: new Date(1_787_000_300 * 1_000).toISOString(),
      receiptJson: {
        authorization: {
          mode: "direct",
          checkoutReference: "checkout-reference",
          paymentReference: "payment-reference",
        },
        checkoutReceipt: "previous-success-receipt",
      },
      resultJson: {
        httpStatus: 200,
        body: {
          runId: "original-run",
          status: "done",
          settled: true,
          outputs: { result: { approved: true } },
          ap2: { checkoutReceipt: "previous-success-receipt" },
        },
      },
    }));
    state.verifyAp2RunAuthorization.mockRejectedValue(new Error("expired credential must not reverify"));

    const response = await POST(request({
      input: { invoiceId: "inv-1" },
      ap2: {
        authorizationMode: "direct",
        checkoutMandateSdJwt: "checkout-mandate~",
        paymentMandateSdJwt: "payment-mandate~",
      },
    }, "", "valid-payment"), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      runId: "original-run",
      settled: true,
      ap2: { checkoutReceipt: "previous-success-receipt" },
    });
    expect(state.verifyAp2RunAuthorization).not.toHaveBeenCalled();
    expect(state.loadAp2RunConfig).not.toHaveBeenCalled();
    expect(state.preparePublishedLiveExecution).toHaveBeenCalledOnce();
    expect(state.reserveAp2Authorization).not.toHaveBeenCalled();
    expect(state.verifyAndSettle).not.toHaveBeenCalled();
    expect(state.runPreparedPublishedLiveToCompletion).not.toHaveBeenCalled();
  });

  it("returns 410 without re-execution after terminal response evidence is scrubbed", async () => {
    const { POST } = await route();
    const { buildAp2RequestDigest } = await import("@/lib/rails/ap2");
    state.agent.priceUsdc = 1;
    const requestDigest = buildAp2RequestDigest({
      method: "POST",
      resource: "https://agents.suedeai.ai/api/agents/published-agent/run",
      body: { input: { invoiceId: "inv-1" } },
    });
    state.getAp2AuthorizationByMandateReference.mockResolvedValue(ap2Record("completed", {
      requestDigest,
      resultJson: null,
      runId: "expired-run",
      tx: `0x${"a".repeat(64)}`,
      paymentValidBefore: new Date(1_787_000_300 * 1_000).toISOString(),
      receiptJson: {
        authorization: {
          mode: "direct",
          checkoutReference: "checkout-reference",
          paymentReference: "payment-reference",
        },
        evidenceRetention: {
          status: "expired",
          scrubbedAt: "2026-08-14T00:00:00.000Z",
        },
      },
    }));

    const response = await POST(request({
      input: { invoiceId: "inv-1" },
      ap2: {
        authorizationMode: "direct",
        checkoutMandateSdJwt: "checkout-mandate~",
        paymentMandateSdJwt: "payment-mandate~",
      },
    }, "", "valid-payment"), context());

    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({
      error: "ap2_terminal_evidence_expired",
      state: "completed",
      runId: "expired-run",
    });
    expect(state.verifyAp2RunAuthorization).not.toHaveBeenCalled();
    expect(state.verifyAndSettle).not.toHaveBeenCalled();
    expect(state.runPreparedPublishedLiveToCompletion).not.toHaveBeenCalled();
  });

  it("precreates a durable run and returns explicit manual reconciliation after ordinary x402 fulfillment fails", async () => {
    const { POST } = await route();
    state.agent.priceUsdc = 1;
    state.verifyAndSettle.mockResolvedValue({
      ok: true,
      transaction: `0x${"d".repeat(64)}`,
      payer: "0x2222222222222222222222222222222222222222",
    });
    state.runPreparedPublishedLiveToCompletion.mockRejectedValue(new Error("private provider failure"));

    const response = await POST(request({ input: { invoiceId: "inv-ordinary" } }, "", "valid-payment"), context());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "payment_pending_manual_reconciliation",
      message: "Payment settled; fulfillment requires manual reconciliation and will not be retried automatically.",
      runId: "relay-run",
      transaction: `0x${"d".repeat(64)}`,
    });
    expect(state.createRun).toHaveBeenCalledOnce();
    expect(state.recordSettlement).toHaveBeenCalledWith(expect.objectContaining({
      runId: "relay-run",
      tx: `0x${"d".repeat(64)}`,
    }));
    expect(state.runPreparedPublishedLiveToCompletion).toHaveBeenCalledOnce();
  });

  it("never settles ordinary x402 before its durable run exists and retries only once", async () => {
    const { POST } = await route();
    state.agent.priceUsdc = 1;
    state.createRun
      .mockRejectedValueOnce(new Error("runs unavailable"))
      .mockResolvedValueOnce({ id: "ordinary-paid-run" });
    state.verifyAndSettle.mockResolvedValue({
      ok: true,
      transaction: `0x${"e".repeat(64)}`,
      payer: "0x2222222222222222222222222222222222222222",
    });

    const first = await POST(
      request({ input: { invoiceId: "inv-durable-first" } }, "", "valid-payment"),
      context(),
    );

    expect(first.status).toBe(500);
    expect(state.verifyAndSettle).not.toHaveBeenCalled();
    expect(state.runPreparedPublishedLiveToCompletion).not.toHaveBeenCalled();

    const retry = await POST(
      request({ input: { invoiceId: "inv-durable-first" } }, "", "valid-payment"),
      context(),
    );

    expect(retry.status).toBe(200);
    expect(state.createRun).toHaveBeenCalledTimes(2);
    expect(state.verifyAndSettle).toHaveBeenCalledOnce();
    expect(state.runPreparedPublishedLiveToCompletion).toHaveBeenCalledOnce();
    expect(state.runPreparedPublishedLiveToCompletion).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ precreatedRunId: "ordinary-paid-run" }),
    );
  });

  it("closes the durable ordinary run when a malformed payment is definitively rejected", async () => {
    const { POST } = await route();
    state.agent.priceUsdc = 1;
    state.decodePaymentHeader.mockReturnValue(null);
    state.createRun.mockResolvedValue({ id: "ordinary-invalid-run" });
    state.verifyAndSettle.mockResolvedValue({
      ok: false,
      reason: "x_payment_header_invalid_base64_json",
    });

    const response = await POST(
      request({ input: { invoiceId: "inv-invalid" } }, "", "malformed-payment"),
      context(),
    );

    expect(response.status).toBe(402);
    expect(state.finishRun).toHaveBeenCalledWith("ordinary-invalid-run", "error", 0);
    expect(state.runPreparedPublishedLiveToCompletion).not.toHaveBeenCalled();
    expect(state.recordSettlement).not.toHaveBeenCalled();
  });

  it("replays one private reconciliation response after ambiguous ordinary settlement without settling twice", async () => {
    const { POST } = await route();
    state.agent.priceUsdc = 1;
    let durableRunId: string | null = null;
    state.createRun.mockImplementation(async (input: { id?: string }) => {
      durableRunId = input.id ?? null;
      return { id: durableRunId };
    });
    state.getRun.mockImplementation(async (id: string) => id === durableRunId && durableRunId
      ? {
          id: durableRunId,
          flowId: "flow-1",
          agentId: "agent-1",
          trigger: "agent",
          status: "error",
          totalCostUsdc: 0,
          startedAt: 1,
          finishedAt: 2,
          settledAt: null,
          triggerInput: { invoiceId: "inv-ambiguous" },
          runVariables: null,
        }
      : null);
    state.verifyAndSettle.mockResolvedValue({
      ok: false,
      reason: "facilitator_settle_network_error_timeout",
    });

    const first = await POST(
      request({ input: { invoiceId: "inv-ambiguous" } }, "", "valid-payment"),
      context(),
    );
    const retry = await POST(
      request({ input: { invoiceId: "inv-ambiguous" } }, "", "valid-payment"),
      context(),
    );

    expect(first.status).toBe(503);
    expect(retry.status).toBe(503);
    const expected = {
      error: "payment_pending_manual_reconciliation",
      message: "Settlement outcome is ambiguous; reconcile this durable run before retrying.",
      runId: durableRunId,
      transaction: null,
    };
    await expect(first.json()).resolves.toEqual(expected);
    await expect(retry.json()).resolves.toEqual(expected);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    expect(retry.headers.get("cache-control")).toBe("private, no-store");
    expect(state.createRun).toHaveBeenCalledOnce();
    expect(state.verifyAndSettle).toHaveBeenCalledOnce();
    expect(state.finishRun).toHaveBeenCalledWith(durableRunId, "error", 0);
    expect(state.runPreparedPublishedLiveToCompletion).not.toHaveBeenCalled();
    expect(state.recordSettlement).not.toHaveBeenCalled();
  });

  it("preserves payment accounting and leaves an ambiguous engine exception reconcilable", async () => {
    const { POST } = await route();
    state.agent.priceUsdc = 1;
    state.loadAp2RunConfig.mockResolvedValue(readyAp2());
    state.verifyAp2RunAuthorization.mockResolvedValue({
      authorization: {
        mode: "direct",
        checkoutReference: "checkout-reference",
        paymentReference: "payment-reference",
        paymentReplayIdentity: "payment-replay-identity",
        paymentInstrumentId: "eip155:8453:0x2222222222222222222222222222222222222222",
        issuer: "https://wallet.example",
      },
      expected: {
        requestDigest: "request-digest",
        checkoutHash: "checkout-hash",
        amountMinorUsd: 100,
        payee: { id: "suede-agent-studio" },
      },
      expiresAt: 1_787_000_300,
    });
    state.reserveAp2Authorization.mockResolvedValue({
      status: "reserved",
      authorization: ap2Record("authorized"),
    });
    state.transitionAp2Authorization.mockImplementation(async (input: { toState: string }) =>
      ap2Record(input.toState));
    const engineFailure = new Error("private provider failure");
    state.runPreparedPublishedLiveToCompletion.mockRejectedValue(engineFailure);
    state.runIdFromExecutionError.mockReturnValue("engine-run-1");

    const response = await POST(request({
      input: { invoiceId: "inv-1" },
      ap2: {
        authorizationMode: "direct",
        checkoutMandateSdJwt: "checkout-mandate~",
        paymentMandateSdJwt: "payment-mandate~",
      },
    }, "", "valid-payment"), context());

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: "fulfillment_pending_reconciliation",
      runId: "relay-run",
    });
    expect(state.stampRunSettled).toHaveBeenCalledWith("relay-run", expect.any(String));
    expect(state.recordSettlement).toHaveBeenCalledWith(expect.objectContaining({
      runId: "relay-run",
      grossUsdc: 1,
    }));
    expect(state.transitionAp2Authorization).toHaveBeenLastCalledWith(expect.objectContaining({
      fromState: "executing",
      toState: "pending_reconciliation",
      runId: "relay-run",
      decisionCode: "fulfillment_exception_ambiguous",
      receiptJson: expect.objectContaining({ authorization: expect.any(Object) }),
    }));
    expect(state.issueCheckoutReceipt).not.toHaveBeenCalled();
  });

  it("never re-executes an exact retry after an ambiguous engine exception", async () => {
    const { POST } = await route();
    const { buildAp2RequestDigest } = await import("@/lib/rails/ap2");
    state.agent.priceUsdc = 1;
    state.loadAp2RunConfig.mockResolvedValue(readyAp2());
    const requestDigest = buildAp2RequestDigest({
      method: "POST",
      resource: "https://agents.suedeai.ai/api/agents/published-agent/run",
      body: { input: { invoiceId: "inv-1" } },
    });
    const currentAuthorization = ap2Record("pending_reconciliation", {
        requestDigest,
        decisionCode: "fulfillment_exception_ambiguous",
        expiresAt: "2026-01-01T00:00:00.000Z",
        paymentValidBefore: new Date(1_787_000_300 * 1_000).toISOString(),
        runId: "engine-run-1",
        receiptJson: {
          authorization: {
            mode: "direct",
            checkoutReference: "checkout-reference",
            paymentReference: "payment-reference",
          },
        },
      });
    state.getAp2AuthorizationByMandateReference.mockImplementation(async () => currentAuthorization);

    const response = await POST(request({
      input: { invoiceId: "inv-1" },
      ap2: {
        authorizationMode: "direct",
        checkoutMandateSdJwt: "checkout-mandate~",
        paymentMandateSdJwt: "payment-mandate~",
      },
    }, "", "valid-payment"), context());

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: "fulfillment_pending_reconciliation",
      runId: "engine-run-1",
    });
    expect(state.verifyAp2RunAuthorization).not.toHaveBeenCalled();
    expect(state.reserveAp2Authorization).not.toHaveBeenCalled();
    expect(state.verifyAndSettle).not.toHaveBeenCalled();
    expect(state.runPreparedPublishedLiveToCompletion).not.toHaveBeenCalled();
  });

  it("finalizes an ambiguous direct run from durable terminal run steps without re-execution", async () => {
    const { POST } = await route();
    const { buildAp2RequestDigest } = await import("@/lib/rails/ap2");
    state.agent.priceUsdc = 1;
    state.loadAp2RunConfig.mockResolvedValue(readyAp2());
    const requestDigest = buildAp2RequestDigest({
      method: "POST",
      resource: "https://agents.suedeai.ai/api/agents/published-agent/run",
      body: { input: { invoiceId: "inv-1" } },
    });
    const currentAuthorization = ap2Record("pending_reconciliation", {
        requestDigest,
        decisionCode: "fulfillment_exception_ambiguous",
        paymentValidBefore: new Date(1_787_000_300 * 1_000).toISOString(),
        runId: "engine-run-1",
        tx: `0x${"a".repeat(64)}`,
        receiptJson: {
          authorization: {
            mode: "direct",
            checkoutReference: "checkout-reference",
            paymentReference: "payment-reference",
          },
        },
      });
    state.getAp2AuthorizationByMandateReference.mockImplementation(async () => currentAuthorization);
    state.getRun.mockResolvedValue({
      id: "engine-run-1",
      flowId: "flow-1",
      agentId: "agent-1",
      trigger: "agent",
      status: "done",
      totalCostUsdc: 0.02,
      finishedAt: 1_787_000_200_000,
      settledAt: "2026-08-14T00:00:00.000Z",
    });
    state.listRunSteps.mockResolvedValue([{
      nodeId: "output-1",
      status: "done",
      output: { approved: true },
    }]);
    state.transitionAp2Authorization.mockImplementation(async (input: { toState: string }) =>
      ap2Record(input.toState, { runId: "engine-run-1", tx: `0x${"a".repeat(64)}` }));

    const response = await POST(request({
      input: { invoiceId: "inv-1" },
      ap2: {
        authorizationMode: "direct",
        checkoutMandateSdJwt: "checkout-mandate~",
        paymentMandateSdJwt: "payment-mandate~",
      },
    }, "", "valid-payment"), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      runId: "engine-run-1",
      status: "done",
      settled: true,
      outputs: { "output-1": { approved: true } },
      ap2: { checkoutReceipt: "signed-checkout-receipt" },
    });
    expect(state.transitionAp2Authorization).toHaveBeenCalledWith(expect.objectContaining({
      fromState: "pending_reconciliation",
      toState: "completed",
      decisionCode: "fulfilled_reconciled",
    }));
    expect(state.runPreparedPublishedLiveToCompletion).not.toHaveBeenCalled();
  });

  it("rebuilds the exact Resource envelope from a durable paid run without re-execution", async () => {
    const { POST } = await route();
    const { buildAp2RequestDigest } = await import("@/lib/rails/ap2");
    state.agent.priceUsdc = 1;
    state.loadAp2RunConfig.mockResolvedValue(readyAp2());
    const requestDigest = buildAp2RequestDigest({
      method: "POST",
      resource: "https://agents.suedeai.ai/api/agents/published-agent/run",
      body: { input: { invoiceId: "inv-1" } },
    });
    let currentAuthorization = ap2Record("pending_reconciliation", {
      requestDigest,
      decisionCode: "fulfillment_exception_ambiguous",
      paymentValidBefore: new Date(1_787_000_300 * 1_000).toISOString(),
      runId: "resource-run-1",
      tx: `0x${"a".repeat(64)}`,
      receiptJson: {
        authorization: {
          mode: "direct",
          checkoutReference: "checkout-reference",
          paymentReference: "payment-reference",
        },
      },
    }) as MutableAp2TestRecord;
    state.getAp2AuthorizationByMandateReference.mockImplementation(async () => currentAuthorization);
    const currentPackContent = resourcePack();
    const currentPackHash = resourcePackSemanticHash(currentPackContent).semanticHash;
    const graph = {
      ...preparedLiveHandle(1).graph,
      nodes: [{ id: "resource-query", type: "resource.query", params: {}, position: { x: 0, y: 0 } }],
      meta: { resourceProduct: immutableResourceMarker(1, {
        executionAccess: "paid",
        discoveryAccess: "public",
      }, currentPackHash) },
    };
    state.getOwnedResourcePack.mockResolvedValue({
      resourceProductId: "flow-1",
      packVersionId: "pack-1",
      semanticHash: currentPackHash,
      freshness: "fresh",
      content: currentPackContent,
    });
    state.preparePublishedLiveExecution.mockResolvedValue({
      ...preparedLiveHandle(1),
      graph,
      resourceDependencies: [{
        resourceProductId: "flow-1",
        packVersionId: "pack-1",
        contentHash: currentPackHash,
      }],
    });
    state.publicService = {
      kind: "resource",
      id: "agent-1",
      slug: "published-agent",
      name: "Reviewed records",
      description: "Return reviewed records.",
      priceUsdc: 1,
      graph,
      release: preparedLiveHandle(1).release,
      inputSchema: {
        type: "object", properties: { invoiceId: { type: "string" } },
        required: ["invoiceId"], additionalProperties: false,
      },
      resultSchema: {
        type: "array", items: {
          type: "object", properties: { name: { type: "string" } },
          required: ["name"], additionalProperties: false,
        },
      },
      outputSchema: {
        type: "array", items: {
          type: "object", properties: { name: { type: "string" } },
          required: ["name"], additionalProperties: false,
        },
      },
      exampleInput: { invoiceId: "inv-1" },
      tags: ["resource"],
      urls: {},
      resource: {
        extensionUri: "https://agents.suedeai.ai/extensions/resource/v1",
        resourceProductId: "flow-1",
        resourceVersion: "pack-1",
        semanticHash: currentPackHash,
        freshness: "fresh",
        evidencePolicy: "Evidence is optional.",
        reviewBoundary: "Reviewed records only.",
        access: { execution: "paid", discovery: "public" },
        sourceDisclosure: { sourceCount: 1, sourceKinds: ["manual"] },
        jobContract: {
          jobStatement: "Return reviewed records.",
          buyerIntent: "Find a record.",
          inputSchema: {
            type: "object", properties: { invoiceId: { type: "string" } },
            required: ["invoiceId"], additionalProperties: false,
          },
          outputSchema: {
            type: "array", items: {
              type: "object", properties: { name: { type: "string" } },
              required: ["name"], additionalProperties: false,
            },
          },
          unsupportedRequest: "No match.",
          evidenceRequirement: "Evidence is optional.",
          safeExample: [],
          reviewBoundary: "Reviewed records only.",
          dataHandlingDisclosure: "Private inputs remain private.",
        },
      },
    };
    state.getRun.mockResolvedValue({
      id: "resource-run-1", flowId: "flow-1", agentId: "agent-1", trigger: "agent",
      status: "done", totalCostUsdc: 0.02, finishedAt: 1_787_000_200_000,
      settledAt: "2026-08-14T00:00:00.000Z",
    });
    state.listRunSteps.mockResolvedValue([{
      nodeId: "resource-query",
      status: "done",
      output: {
        result: [{ name: "Alpha" }],
        resourceReceipt: {
          resourceProductId: "flow-1",
          resourceVersion: "pack-1",
          semanticHash: currentPackHash,
          freshness: "fresh",
          evidence: [], unknowns: [], conflicts: [], outputSchemaValid: true,
        },
      },
    }]);
    state.recordResourceRunReceipt
      .mockRejectedValueOnce(new Error("receipt persistence unavailable"))
      .mockResolvedValue({ id: "resource-receipt-1" });
    let terminalTransitionAttempts = 0;
    state.transitionAp2Authorization.mockImplementation(async (input: {
      toState: string;
      decisionCode?: string;
      receiptJson?: unknown;
      resultJson?: unknown;
    }) => {
      if (input.toState === "completed" && terminalTransitionAttempts++ === 0) return null;
      currentAuthorization = {
        ...currentAuthorization,
        state: input.toState,
        decisionCode: input.decisionCode ?? currentAuthorization.decisionCode,
        receiptJson: input.receiptJson ?? currentAuthorization.receiptJson,
        resultJson: input.resultJson ?? currentAuthorization.resultJson,
      };
      return currentAuthorization;
    });

    const paidRequest = () => request({
      input: { invoiceId: "inv-1" },
      ap2: {
        authorizationMode: "direct",
        checkoutMandateSdJwt: "checkout-mandate~",
        paymentMandateSdJwt: "payment-mandate~",
      },
    }, "", "valid-payment");
    const receiptWriteFault = await POST(paidRequest(), context());
    expect(receiptWriteFault.status).toBe(503);
    expect(await receiptWriteFault.json()).toMatchObject({
      error: "fulfillment_pending_reconciliation",
      runId: "resource-run-1",
    });
    const terminalTransitionFault = await POST(paidRequest(), context());
    expect(terminalTransitionFault.status).toBe(503);
    expect(await terminalTransitionFault.json()).toMatchObject({
      error: "fulfillment_pending_reconciliation",
      runId: "resource-run-1",
    });

    const response = await POST(paidRequest(), context());

    expect(response.status).toBe(200);
    const exactEnvelope = await response.json();
    expect(exactEnvelope).toEqual({
      result: [{ name: "Alpha" }],
      resourceReceipt: {
        resourceProductId: "flow-1", resourceVersion: "pack-1",
        semanticHash: currentPackHash, freshness: "fresh", evidence: [],
        unknowns: [], conflicts: [], outputSchemaValid: true,
      },
      payment: { priceUsdc: 1, state: "settled", receiptId: "resource-receipt-1" },
      ap2: {
        profile: "ap2-v0.2-experimental", authorizationMode: "direct",
        checkoutReceipt: "signed-checkout-receipt",
      },
    });
    const terminalReplay = await POST(paidRequest(), context());
    expect(terminalReplay.status).toBe(200);
    expect(await terminalReplay.json()).toEqual(exactEnvelope);
    expect(state.recordResourceRunReceipt).toHaveBeenCalledTimes(3);
    expect(state.recordResourceRunReceipt.mock.calls[1]).toEqual(state.recordResourceRunReceipt.mock.calls[2]);
    expect(state.runPreparedPublishedLiveToCompletion).not.toHaveBeenCalled();
    expect(state.verifyAndSettle).not.toHaveBeenCalled();
  });

  it("dispatches an AP2 relay-v2 delivery once and leaves ambiguity reconcilable", async () => {
    const { POST } = await route();
    state.agent.priceUsdc = 1;
    state.preparePublishedLiveExecution.mockResolvedValue(preparedLiveHandle(1, true));
    state.relaySnapshot = {
      agentId: "agent-1",
      url: "https://relay.example.test/execute",
      secret: "private",
      protocolVersion: 2,
      createdAt: "2026-08-13T20:00:00.000Z",
    };
    state.loadAp2RunConfig.mockResolvedValue(readyAp2());
    state.verifyAp2RunAuthorization.mockResolvedValue(verifiedAp2());
    state.reserveAp2Authorization.mockResolvedValue({
      status: "reserved",
      authorization: ap2Record("authorized"),
    });
    state.transitionAp2Authorization.mockImplementation(async (input: {
      toState: string;
      decisionCode?: string;
      receiptJson?: unknown;
      runId?: string;
      tx?: string | null;
    }) => ap2Record(input.toState, {
      decisionCode: input.decisionCode ?? null,
      receiptJson: input.receiptJson ?? null,
      runId: input.runId ?? null,
      tx: input.tx ?? null,
    }));
    state.executeRelayV2.mockResolvedValue({
      kind: "ambiguous",
      deliveryId: "relay-run",
      reason: "timeout",
    });

    const response = await POST(request({
      input: { invoiceId: "inv-1" },
      ap2: {
        authorizationMode: "direct",
        checkoutMandateSdJwt: "checkout-mandate~",
        paymentMandateSdJwt: "payment-mandate~",
      },
    }, "", "valid-payment"), context());

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ error: "relay_fulfillment_pending" });
    expect(state.executeRelayV2).toHaveBeenCalledOnce();
    expect(state.executeRelayV2).toHaveBeenCalledWith(expect.objectContaining({
      runId: "relay-run",
      requestWindow: {
        issuedAt: "2026-08-14T00:00:00.000Z",
        notAfter: "2026-08-14T00:00:15.000Z",
      },
    }));
    expect(state.fetch).not.toHaveBeenCalled();
    expect(state.finishRun).not.toHaveBeenCalled();
    expect(state.transitionAp2Authorization).toHaveBeenCalledWith(expect.objectContaining({
      fromState: "settled",
      toState: "executing",
      decisionCode: "relay_delivery_started",
      runId: "relay-run",
      receiptJson: expect.objectContaining({
        relay: expect.objectContaining({
          protocol: "suede-relay/2",
          deliveryId: "relay-run",
        }),
      }),
    }));
    expect(state.recordSettlement.mock.invocationCallOrder[0])
      .toBeLessThan(state.executeRelayV2.mock.invocationCallOrder[0]!);
  });

  it("reconciles an executing relay exact retry by status without resending execute", async () => {
    const { POST } = await route();
    state.agent.priceUsdc = 1;
    state.preparePublishedLiveExecution.mockResolvedValue(preparedLiveHandle(1, true));
    state.relaySnapshot = {
      agentId: "agent-1",
      url: "https://relay.example.test/execute",
      secret: "private",
      protocolVersion: 2,
      createdAt: "2026-08-13T20:00:00.000Z",
    };
    state.loadAp2RunConfig.mockResolvedValue(readyAp2());
    state.verifyAp2RunAuthorization.mockResolvedValue(verifiedAp2());
    state.reserveAp2Authorization.mockResolvedValue({
      status: "exact-retry",
      authorization: ap2Record("executing", {
        decisionCode: "relay_delivery_started",
        runId: "relay-run",
        tx: "0xsettled",
        receiptJson: {
          checkoutReceipt: "original-receipt",
          relay: {
            protocol: "suede-relay/2",
            endpointBinding:
              "binding:https://relay.example.test/execute:2026-08-13T20:00:00.000Z:2",
            notAfter: "2099-08-14T00:00:15.000Z",
            deliveryId: "relay-run",
          },
        },
      }),
    });
    state.queryRelayV2Status.mockResolvedValue({
      kind: "delivery",
      protocol: "suede-relay/2",
      deliveryId: "relay-run",
      state: "completed",
      httpStatus: 200,
      output: { reconciled: true },
    });
    state.transitionAp2Authorization.mockImplementation(async (input: { toState: string }) =>
      ap2Record(input.toState, { runId: "relay-run", tx: "0xsettled" }));

    const response = await POST(request({
      input: { invoiceId: "inv-1" },
      ap2: {
        authorizationMode: "direct",
        checkoutMandateSdJwt: "checkout-mandate~",
        paymentMandateSdJwt: "payment-mandate~",
      },
    }, "", "valid-payment"), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      runId: "relay-run",
      outputs: { relay: { reconciled: true } },
      settled: true,
    });
    expect(state.queryRelayV2Status).toHaveBeenCalledOnce();
    expect(state.executeRelayV2).not.toHaveBeenCalled();
    expect(state.fetch).not.toHaveBeenCalled();
    expect(state.verifyAndSettle).not.toHaveBeenCalled();
    expect(state.createRun).not.toHaveBeenCalled();
    expect(state.finishRun).toHaveBeenCalledWith("relay-run", "done", 0);
    expect(state.transitionAp2Authorization).toHaveBeenCalledWith(expect.objectContaining({
      fromState: "executing",
      toState: "completed",
      runId: "relay-run",
    }));
  });

  it("does not probe or resend when relay endpoint identity changed", async () => {
    const { POST } = await route();
    state.agent.priceUsdc = 1;
    state.preparePublishedLiveExecution.mockResolvedValue(preparedLiveHandle(1, true));
    state.relaySnapshot = {
      agentId: "agent-1",
      url: "https://replacement.example.test/execute",
      secret: "replacement-secret",
      protocolVersion: 2,
      createdAt: "2026-08-14T01:00:00.000Z",
    };
    state.loadAp2RunConfig.mockResolvedValue(readyAp2());
    state.verifyAp2RunAuthorization.mockResolvedValue(verifiedAp2());
    state.reserveAp2Authorization.mockResolvedValue({
      status: "exact-retry",
      authorization: ap2Record("executing", {
        decisionCode: "relay_delivery_started",
        runId: "relay-run",
        receiptJson: {
          checkoutReceipt: "original-receipt",
          relay: {
            protocol: "suede-relay/2",
            endpointBinding: "binding:old-endpoint",
            notAfter: "2099-08-14T00:00:15.000Z",
            deliveryId: "relay-run",
          },
        },
      }),
    });

    const response = await POST(request({
      input: { invoiceId: "inv-1" },
      ap2: {
        authorizationMode: "direct",
        checkoutMandateSdJwt: "checkout-mandate~",
        paymentMandateSdJwt: "payment-mandate~",
      },
    }, "", "valid-payment"), context());

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "relay_reconciliation_unavailable" });
    expect(state.queryRelayV2Status).not.toHaveBeenCalled();
    expect(state.executeRelayV2).not.toHaveBeenCalled();
    expect(state.fetch).not.toHaveBeenCalled();
    expect(state.verifyAndSettle).not.toHaveBeenCalled();
  });
});
