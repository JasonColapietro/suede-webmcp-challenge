import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { runSqliteMigrations } from "@/lib/db/migrations/sqlite";
import type { FlowGraph } from "@/lib/flow/types";

const root = mkdtempSync(join(tmpdir(), "suede-v1-byte-proof-"));
const sqlitePath = join(root, "v1.db");
const ownerId = "00000000-0000-4000-8000-000000000001";

vi.stubEnv("NODE_ENV", "production");
vi.stubEnv("DB_DRIVER", "sqlite");
vi.stubEnv("SQLITE_PATH", sqlitePath);

vi.mock("next/headers", () => ({
  headers: async () => ({ get: (key: string) => (key === "x-owner-id" ? ownerId : null) }),
  cookies: async () => ({ get: () => undefined }),
}));

const graph: FlowGraph = {
  id: "graph-v1-byte-proof",
  name: "V1 byte proof",
  nodes: [{ id: "input", type: "input", params: {}, position: { x: 0, y: 0 } }],
  edges: [],
};
const db = new Database(sqlitePath);
runSqliteMigrations(db);
db.prepare(
  "INSERT INTO flows (id, owner_id, name, graph, updated_at) VALUES (?, ?, ?, ?, ?)",
).run("row-v1-byte-proof", ownerId, graph.name, JSON.stringify(graph), 1_710_000_000_000);
db.close();

const { GET: listFlows } = await import("@/app/api/flows/route");
const { GET: getFlow } = await import("@/app/api/flows/[id]/route");
const { GET: getContext } = await import("@/app/api/v2/context/route");
const { GET: listVersions, POST: createVersion } = await import(
  "@/app/api/v2/flows/[flowId]/versions/route"
);
const { POST: deployVersion } = await import(
  "@/app/api/v2/flows/[flowId]/deployments/route"
);

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("public v1 byte preservation", () => {
  it("keeps the reviewed v1 route source bytes pinned", () => {
    // Re-attested 2026-07-30 for the run and launch routes only. The sole
    // change in each is the catch-all 500: it returned raw `error.message`,
    // which leaks DB/provider internals, and now logs server-side and returns
    // the opaque `{ error: "internal error" }` already used by
    // /api/agents/[agent]/run. Every success response, status code, and the
    // SSE error frame are byte-identical — the two v1 shapes asserted below
    // are unchanged, and `src/app/api/flows/route.ts` plus
    // `src/app/api/flows/[id]/route.ts` still hash to their original digests.
    // See tests/api/opaque-500-contract.test.ts for the standing rule.
    //
    // Re-attested 2026-08-09 for the launch route only (deploy-on-launch).
    // Deliberate intent change: launch now promotes the flow's graph to an
    // active immutable Live deployment before any agent write (via
    // src/lib/launch/promote-live.ts), unlocks v2 paid-call-only graphs, and
    // adds ADDITIVE response fields (deployment, settlementLive,
    // settlementEndpoint, payoutSource, payoutWarning, floorUsdc,
    // suggestedUsdc). Every pre-existing response key, status code, and
    // error shape is unchanged; the envelope test in
    // tests/compat/public-api-v0.test.ts still passes over the same keys.
    const expected = new Map([
      ["src/app/api/flows/route.ts", "f0d6163caac0e06b32d4471b232169b51c45e46b379575de0eaf08385a31c4d8"],
      ["src/app/api/flows/[id]/route.ts", "5a1a692dfc29684e0e145495949ec139b7f01c4b83abbd3be13d276378df0352"],
      ["src/app/api/flows/[id]/run/route.ts", "84b6f84b5bae83384b5874b132dee61a5ec1a25cda67a3297a998b28e1004568"],
      ["src/app/api/flows/[id]/launch/route.ts", "70b1ade567e1e43ee2fa09bbe5981b438f5b8ebd8ffece6091aec13913cf267e"],
    ]);
    for (const [file, digest] of expected) {
      expect(createHash("sha256").update(readFileSync(join(process.cwd(), file))).digest("hex")).toBe(
        digest,
      );
    }
  });

  it("keeps raw v1 list and detail bytes identical through v2 version and deployment mutations", async () => {
    const detailBefore = await getFlow(
      new Request("https://agents.suedeai.ai/api/flows/row-v1-byte-proof"),
      { params: Promise.resolve({ id: "row-v1-byte-proof" }) },
    );
    const detailBytesBefore = await detailBefore.text();
    const listBytesBefore = await (await listFlows()).text();
    expect(detailBefore.status).toBe(200);
    expect(detailBytesBefore).toBe(
      JSON.stringify({
        flow: {
          id: "row-v1-byte-proof",
          ownerId,
          name: graph.name,
          graph,
          updatedAt: 1_710_000_000_000,
        },
      }),
    );

    const context = (await (await getContext()).json()) as {
      context: { environments: Array<{ id: string; kind: string }> };
    };
    const flowParams = { params: Promise.resolve({ flowId: "row-v1-byte-proof" }) };
    expect(
      (
        await listVersions(
          new Request("https://agents.suedeai.ai/api/v2/flows/row-v1-byte-proof/versions"),
          flowParams,
        )
      ).status,
    ).toBe(200);
    const versionResponse = await createVersion(
      new Request("https://agents.suedeai.ai/api/v2/flows/row-v1-byte-proof/versions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      flowParams,
    );
    expect(versionResponse.status).toBe(200);
    const version = (await versionResponse.json()) as {
      version: { id: string; semanticHash: string; fullHash: string };
    };
    const test = context.context.environments.find(({ kind }) => kind === "test");
    const live = context.context.environments.find(({ kind }) => kind === "live");
    expect(test).toBeDefined();
    expect(live).toBeDefined();
    if (!test || !live) return;
    const testPromotion = await deployVersion(
      new Request("https://agents.suedeai.ai/api/v2/flows/row-v1-byte-proof/deployments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          versionId: version.version.id,
          versionSemanticHash: version.version.semanticHash,
          versionFullHash: version.version.fullHash,
          environmentId: test.id,
          environmentKind: "test",
          expectedActiveDeploymentId: null,
          sourceTestDeploymentId: null,
          confirmation: "PROMOTE TEST",
        }),
      }),
      flowParams,
    );
    expect(testPromotion.status).toBe(200);
    const testDeployment = (await testPromotion.json()) as { deployment: { id: string } };
    expect(
      (
        await deployVersion(
          new Request("https://agents.suedeai.ai/api/v2/flows/row-v1-byte-proof/deployments", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              versionId: version.version.id,
              versionSemanticHash: version.version.semanticHash,
              versionFullHash: version.version.fullHash,
              environmentId: live.id,
              environmentKind: "live",
              expectedActiveDeploymentId: null,
              sourceTestDeploymentId: testDeployment.deployment.id,
              confirmation: "PROMOTE LIVE",
            }),
          }),
          flowParams,
        )
      ).status,
    ).toBe(200);

    const detailBytesAfter = await (
      await getFlow(new Request("https://agents.suedeai.ai/api/flows/row-v1-byte-proof"), {
        params: Promise.resolve({ id: "row-v1-byte-proof" }),
      })
    ).text();
    const listBytesAfter = await (await listFlows()).text();
    expect(detailBytesAfter).toBe(detailBytesBefore);
    expect(listBytesAfter).toBe(listBytesBefore);
  });
});
