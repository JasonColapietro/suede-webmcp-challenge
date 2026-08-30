import type { NodeExecutor } from "./executor";

const llmStub: NodeExecutor = async (_ctx, _params, _inputs) => ({
  ok: true,
  outputs: { result: "[Scoped test stub]" },
  costUsdc: 0,
});

const httpStub: NodeExecutor = async (_ctx, _params, _inputs) => ({
  ok: true,
  outputs: { result: { status: 200, body: null } },
  costUsdc: 0,
});

const suedeResultStub: NodeExecutor = async (_ctx, _params, _inputs) => ({
  ok: true,
  outputs: { result: { testMode: "stub" } },
  costUsdc: 0,
});

const suedeCampaignStub: NodeExecutor = async (_ctx, _params, _inputs) => ({
  ok: true,
  outputs: { campaign: { testMode: "stub" } },
  costUsdc: 0,
});

const suedeClaimsStub: NodeExecutor = async (_ctx, _params, _inputs) => ({
  ok: true,
  outputs: { claims: { claims: [], total: 0, testMode: "stub" } },
  costUsdc: 0,
});

const apiOperationStub: NodeExecutor = async () => ({
  ok: true,
  outputs: { result: { status: 0, body: null } },
  costUsdc: 0,
});

const SCOPED_TEST_STUBS: Readonly<Record<string, NodeExecutor>> = Object.freeze({
  llm: llmStub,
  // Provider-backed AI nodes: a scoped test must never reach the model.
  "ai.classify": suedeResultStub,
  "ai.extract": suedeResultStub,
  http: httpStub,
  "api.operation": apiOperationStub,
  "suede.styleCoach": suedeResultStub,
  "suede.generateSong": suedeResultStub,
  "suede.lyrics": suedeResultStub,
  "suede.analyze": suedeResultStub,
  "suede.stems": suedeResultStub,
  "suede.midi": suedeResultStub,
  "suede.mastering": suedeResultStub,
  "suede.rightsLookup": suedeResultStub,
  "suede.registerIp": suedeResultStub,
  "suede.chainChat": suedeResultStub,
  "suede.promo": suedeCampaignStub,
  "suede.promoClaims": suedeClaimsStub,
  "web.fetchUrl": suedeResultStub,
  "comms.slackMessage": httpStub,
  "comms.crmWebhook": httpStub,
  "devops.githubIssue": httpStub,
  "devops.githubRead": httpStub,
  "devops.githubWorkflowDispatch": httpStub,
});

/** Returns the non-echoing executor approved for an ephemeral scoped test. */
export function scopedTestStubFor(type: string): NodeExecutor | undefined {
  return Object.hasOwn(SCOPED_TEST_STUBS, type)
    ? SCOPED_TEST_STUBS[type]
    : undefined;
}
