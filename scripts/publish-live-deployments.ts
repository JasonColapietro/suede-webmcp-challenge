/**
 * Promote every flow in a workspace to a Live deployment so its public run
 * endpoint can serve real (402-gated) calls. The plain launch route publishes
 * the agent row, but paid execution requires an immutable version promoted
 * Test → Live (src/lib/run-service.ts preparePublishedLiveExecution); this
 * script walks that promotion for each flow via the same v2 API the studio
 * uses. Flows that already hold an active Live deployment are skipped.
 *
 *   SEED_OWNER_ID=<uuid> BASE_URL=https://agents.suedeai.ai \
 *     npx tsx scripts/publish-live-deployments.ts
 *
 * FLOW_IDS scopes the run to specific flows instead of the whole workspace.
 * Promoting a flow to Live is what lets its agent serve PAID x402 calls, so
 * an unscoped run against a workspace holding unrelated flows turns all of
 * them into live endpoints at once. Pass an explicit allowlist whenever the
 * intent is "these agents", not "this entire workspace":
 *
 *   SEED_OWNER_ID=<uuid> FLOW_IDS=<uuid>,<uuid> BASE_URL=https://agents.suedeai.ai \
 *     npx tsx scripts/publish-live-deployments.ts
 */
export {};

const BASE = (process.env.BASE_URL ?? "http://localhost:3210").replace(/\/$/, "");
const OWNER = process.env.SEED_OWNER_ID;
if (!OWNER) throw new Error("SEED_OWNER_ID is required (the workspace owner id).");
const ONLY_FLOW_IDS = (process.env.FLOW_IDS ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter((id) => id.length > 0);

const headers = { "content-type": "application/json", "x-owner-id": OWNER };

interface Env { id: string; kind: "test" | "live" }
// The deployments list has no environmentKind field — only environmentId,
// so "is this the live one" must be resolved against context.environments.
interface Deployment { id: string; environmentId: string; status: string; retiredAt?: number }

async function json<T>(res: Response, label: string): Promise<T> {
  if (!res.ok) throw new Error(`${label} failed (${res.status}): ${await res.text()}`);
  return (await res.json()) as T;
}

async function publishFlow(flow: { id: string; name: string }): Promise<void> {
  // The workbook route runs ensureOwnedFlowContext, creating the project
  // binding on first touch — it must come before the deployments read, which
  // 404s on unbound flows.
  const { context } = await json<{ context: { environments: Env[] } }>(
    await fetch(`${BASE}/api/v2/flows/${flow.id}/workbook`, { headers }),
    "flow context",
  );
  const test = context.environments.find((e) => e.kind === "test");
  const live = context.environments.find((e) => e.kind === "live");
  if (!test || !live) throw new Error(`missing environments for ${flow.name}`);

  const { deployments } = await json<{ deployments: Deployment[] }>(
    await fetch(`${BASE}/api/v2/flows/${flow.id}/deployments`, { headers }),
    "list deployments",
  );
  const activeIn = (environmentId: string): Deployment | undefined =>
    deployments.find(
      (d) => d.environmentId === environmentId && d.status !== "retired" && d.retiredAt === undefined,
    );

  if (activeIn(live.id)) {
    console.log(`• already live-deployed: ${flow.name}`);
    return;
  }

  const promote = async (
    kind: "test" | "live",
    environmentId: string,
    versionId: string,
    versionSemanticHash: string,
    versionFullHash: string,
    sourceTestDeploymentId: string | null,
  ): Promise<{ id: string }> => {
    const { deployment } = await json<{ deployment: { id: string } }>(
      await fetch(`${BASE}/api/v2/flows/${flow.id}/deployments`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          versionId,
          versionSemanticHash,
          versionFullHash,
          environmentId,
          environmentKind: kind,
          expectedActiveDeploymentId: null,
          sourceTestDeploymentId,
          confirmation: kind === "test" ? "PROMOTE TEST" : "PROMOTE LIVE",
        }),
      }),
      `promote ${kind}`,
    );
    return deployment;
  };

  // Reuse a stray active Test deployment left over from an interrupted run
  // instead of minting a second one, which would 409 against it. The
  // deployments list omits version hashes, so read the pinned version back.
  const existingTest = activeIn(test.id) as (Deployment & { flowVersionId: string }) | undefined;
  if (existingTest) {
    const { version } = await json<{ version: { id: string; semanticHash: string; fullHash: string } }>(
      await fetch(`${BASE}/api/v2/flows/${flow.id}/versions/${existingTest.flowVersionId}`, { headers }),
      "read version",
    );
    await promote("live", live.id, version.id, version.semanticHash, version.fullHash, existingTest.id);
    console.log(`✓ live-deployed (reused test): ${flow.name}`);
    return;
  }

  const { version } = await json<{ version: { id: string; semanticHash: string; fullHash: string } }>(
    await fetch(`${BASE}/api/v2/flows/${flow.id}/versions`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    }),
    "create version",
  );
  const testDeployment = await promote("test", test.id, version.id, version.semanticHash, version.fullHash, null);
  await promote("live", live.id, version.id, version.semanticHash, version.fullHash, testDeployment.id);
  console.log(`✓ live-deployed: ${flow.name} (version ${version.id.slice(0, 8)}…)`);
}

async function main(): Promise<void> {
  const { flows } = await json<{ flows: { id: string; name: string }[] }>(
    await fetch(`${BASE}/api/flows`, { headers }),
    "list flows",
  );
  console.log(`${BASE}: ${flows.length} flows in workspace`);

  // An unmatched id is a typo, a wrong workspace, or a stale id — never a
  // reason to fall back to "promote everything". Fail before any mutation.
  const targets = ONLY_FLOW_IDS.length === 0 ? flows : flows.filter((flow) => ONLY_FLOW_IDS.includes(flow.id));
  if (ONLY_FLOW_IDS.length > 0) {
    const missing = ONLY_FLOW_IDS.filter((id) => !flows.some((flow) => flow.id === id));
    if (missing.length > 0) {
      throw new Error(`FLOW_IDS not found in this workspace: ${missing.join(", ")}`);
    }
    console.log(
      `FLOW_IDS set — promoting ${targets.length} of ${flows.length}; ` +
        `skipping ${flows.length - targets.length} untargeted flow(s)`,
    );
  }

  let failures = 0;
  for (const flow of targets) {
    try {
      await publishFlow(flow);
    } catch (error) {
      failures += 1;
      console.error(`✗ ${flow.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(failures === 0 ? "Done." : `Done with ${failures} failures.`);
}

await main();
