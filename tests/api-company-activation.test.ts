import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { activateCompany } from "@/lib/company/activation";
import { materializeCompanyDraft, templateToDraft } from "@/lib/company/founding";
import { SqliteRepo } from "@/lib/db/sqlite-repo";
import type { DeployVersionRepositoryInput, ProjectRepo } from "@/lib/projects/repo";
import { SqliteProjectRepo } from "@/lib/projects/sqlite-project-repo";

const OWNER = "company-activation-owner";

async function fixture(templateSlug = "audit-shop"): Promise<{
  readonly companyId: string;
  readonly companyRepo: SqliteRepo;
  readonly projectRepo: SqliteProjectRepo;
}> {
  const db = new Database(":memory:");
  const projectRepo = new SqliteProjectRepo(db);
  const companyRepo = new SqliteRepo(db);
  const draft = templateToDraft(templateSlug);
  if (!draft) throw new Error(`Expected ${templateSlug} template`);
  const { companyId } = await materializeCompanyDraft(OWNER, draft, companyRepo);
  return { companyId, companyRepo, projectRepo };
}

function failingTestDeployment(repo: ProjectRepo): ProjectRepo {
  return new Proxy(repo, {
    get(target, property, receiver): unknown {
      if (property === "deployVersion") {
        return async (input: DeployVersionRepositoryInput) => input.environmentKind === "test"
          ? { status: "conflict" as const }
          : target.deployVersion(input);
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function failingSecondTestDeployment(repo: ProjectRepo): ProjectRepo {
  let testDeployments = 0;
  return new Proxy(repo, {
    get(target, property, receiver): unknown {
      if (property === "deployVersion") {
        return async (input: DeployVersionRepositoryInput) => {
          if (input.environmentKind === "test") {
            testDeployments += 1;
            if (testDeployments === 2) return { status: "conflict" as const };
          }
          return target.deployVersion(input);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("company activation service", () => {
  it("promotes every employee through exact Test to immutable Live before activating", async () => {
    const setup = await fixture();
    const result = await activateCompany({
      companyId: setup.companyId,
      ownerId: OWNER,
      companyRepo: setup.companyRepo,
      projectRepo: setup.projectRepo,
    });

    expect(result.status).toBe("activated");
    expect((await setup.companyRepo.getCompany(setup.companyId))?.status).toBe("active");

    const employees = await setup.companyRepo.listEmployees(setup.companyId);
    expect(employees.length).toBeGreaterThan(0);
    for (const employee of employees) {
      const agent = await setup.companyRepo.getAgent(employee.agentId);
      expect(agent).toMatchObject({ status: "live", settlementLive: false });
      if (!agent) throw new Error("Expected employee agent");

      const [versions, testDeployment, liveDeployment] = await Promise.all([
        setup.projectRepo.listFlowVersions({ flowId: agent.flowId, ownerId: OWNER }),
        setup.projectRepo.getActiveDeployment({
          flowId: agent.flowId,
          environmentKind: "test",
          ownerId: OWNER,
        }),
        setup.projectRepo.getActiveDeployment({
          flowId: agent.flowId,
          environmentKind: "live",
          ownerId: OWNER,
        }),
      ]);
      expect(versions).toHaveLength(1);
      expect(testDeployment).toMatchObject({
        flowVersionId: versions[0]?.id,
        status: "test",
      });
      expect(liveDeployment).toMatchObject({
        flowVersionId: versions[0]?.id,
        status: "live",
      });
    }
  });

  it("leaves the company draft when an employee Test deployment fails", async () => {
    const setup = await fixture();
    const result = await activateCompany({
      companyId: setup.companyId,
      ownerId: OWNER,
      companyRepo: setup.companyRepo,
      projectRepo: failingTestDeployment(setup.projectRepo),
    });

    expect(result).toMatchObject({ status: "activation-failed", stage: "test-deployment" });
    expect((await setup.companyRepo.getCompany(setup.companyId))?.status).toBe("draft");
  });

  it("leaves every agent draft when a later employee deployment fails", async () => {
    const setup = await fixture("content-studio");
    const employees = await setup.companyRepo.listEmployees(setup.companyId);
    expect(employees.length).toBeGreaterThan(1);

    const result = await activateCompany({
      companyId: setup.companyId,
      ownerId: OWNER,
      companyRepo: setup.companyRepo,
      projectRepo: failingSecondTestDeployment(setup.projectRepo),
    });

    expect(result).toMatchObject({ status: "activation-failed", stage: "test-deployment" });
    expect((await setup.companyRepo.getCompany(setup.companyId))?.status).toBe("draft");
    for (const employee of employees) {
      expect(await setup.companyRepo.getAgent(employee.agentId)).toMatchObject({
        status: "draft",
        settlementLive: false,
      });
    }
  });

  it("compensates earlier agent changes when a later status update fails", async () => {
    const setup = await fixture("content-studio");
    const employees = await setup.companyRepo.listEmployees(setup.companyId);
    expect(employees.length).toBeGreaterThan(1);
    const originalUpdate = setup.companyRepo.updateAgent.bind(setup.companyRepo);
    let liveUpdates = 0;
    vi.spyOn(setup.companyRepo, "updateAgent").mockImplementation(async (agentId, input) => {
      if (input.status === "live") {
        liveUpdates += 1;
        if (liveUpdates === 2) return null;
      }
      return originalUpdate(agentId, input);
    });

    const result = await activateCompany({
      companyId: setup.companyId,
      ownerId: OWNER,
      companyRepo: setup.companyRepo,
      projectRepo: setup.projectRepo,
    });

    expect(result).toMatchObject({ status: "activation-failed", stage: "agent" });
    expect((await setup.companyRepo.getCompany(setup.companyId))?.status).toBe("draft");
    for (const employee of employees) {
      expect(await setup.companyRepo.getAgent(employee.agentId)).toMatchObject({
        status: "draft",
        settlementLive: false,
      });
    }
  });

  it("keeps settlement disabled after successful activation", async () => {
    const setup = await fixture();
    const employees = await setup.companyRepo.listEmployees(setup.companyId);
    for (const employee of employees) {
      expect((await setup.companyRepo.getAgent(employee.agentId))?.settlementLive).toBe(false);
    }

    await activateCompany({
      companyId: setup.companyId,
      ownerId: OWNER,
      companyRepo: setup.companyRepo,
      projectRepo: setup.projectRepo,
    });

    for (const employee of employees) {
      expect((await setup.companyRepo.getAgent(employee.agentId))?.settlementLive).toBe(false);
    }
  });
});
