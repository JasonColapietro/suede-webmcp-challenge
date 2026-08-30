import { describe, expect, it, vi } from "vitest";
import {
  SubflowBreadcrumbService,
  SubflowBreadcrumbStoreUnavailableError,
} from "@/lib/flow/subflow-breadcrumbs";

describe("SubflowBreadcrumbService", () => {
  it("delegates the entire trail to exactly one repository boundary", async () => {
    const readSubflowBreadcrumbs = vi.fn(async () => ({
      crumbs: [],
    }));
    const service = new SubflowBreadcrumbService({ readSubflowBreadcrumbs });
    await expect(service.read({
      ownerId: "owner", currentFlowId: "current", trail: [],
    })).resolves.toEqual({ crumbs: [] });
    expect(readSubflowBreadcrumbs).toHaveBeenCalledTimes(1);
    expect(readSubflowBreadcrumbs).toHaveBeenCalledWith({
      ownerId: "owner", currentFlowId: "current", trail: [],
    });
  });

  it("fails closed when an adapter lacks the transactional breadcrumb read", async () => {
    await expect(new SubflowBreadcrumbService({}).read({
      ownerId: "owner", currentFlowId: "current", trail: [],
    })).rejects.toBeInstanceOf(SubflowBreadcrumbStoreUnavailableError);
  });

  it("rejects an unbounded or partial repository projection", async () => {
    const service = new SubflowBreadcrumbService({
      readSubflowBreadcrumbs: async () => ({
        crumbs: [{ flowId: "current", name: "Current", versionId: "partial" }],
      }),
    });
    await expect(service.read({ ownerId: "owner", currentFlowId: "current", trail: [] }))
      .resolves.toBeNull();
  });
});
