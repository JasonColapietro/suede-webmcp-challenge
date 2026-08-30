/**
 * Cover for devops.githubRead. The security-relevant behaviour is the same as
 * its write siblings — the token must come from a bound connection, never a
 * param — plus URL construction, which is where a read node can leak a path.
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildGithubReadUrl,
  createGithubReadExecutor,
  githubReadNode,
} from "@/lib/flow/nodes/devops/githubRead";
import { createNodeExecutionProvenance } from "@/lib/flow/executor";
import type { NodeContext, NodeExecutor } from "@/lib/flow/executor";

const ctx = {} as NodeContext;
const REPO = { owner: "acme", name: "widgets" };

/** Captures the request the node hands to the hardened http executor. */
function spyHttp(): { executor: NodeExecutor; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const executor: NodeExecutor = async (_c, params) => {
    calls.push(params as Record<string, unknown>);
    return { ok: true, outputs: { result: { status: 200, body: {} } }, costUsdc: 0 };
  };
  return { executor, calls };
}

const boundToken = createNodeExecutionProvenance({
  connection: { Authorization: "Bearer ghp_test" },
});

describe("githubRead URL construction", () => {
  it("reads one issue", () => {
    const built = buildGithubReadUrl({ repo: "acme/widgets", resource: "issue", number: 7 }, REPO, {});
    expect(built).toEqual({ ok: true, url: "https://api.github.com/repos/acme/widgets/issues/7" });
  });

  it("uses the pulls endpoint for a pull request, not issues", () => {
    // A PR is an issue in GitHub's API, but only /pulls carries diff and merge state.
    const built = buildGithubReadUrl({ repo: "acme/widgets", resource: "pullRequest", number: 7 }, REPO, {});
    expect(built).toEqual({ ok: true, url: "https://api.github.com/repos/acme/widgets/pulls/7" });
  });

  it("defaults a list to open issues with a bounded page size", () => {
    const built = buildGithubReadUrl({ repo: "acme/widgets", resource: "issues" }, REPO, {});
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.url).toContain("/issues?");
    expect(built.url).toContain("state=open");
    expect(built.url).toContain("per_page=30");
  });

  it("applies state, label and limit filters", () => {
    const built = buildGithubReadUrl(
      { repo: "acme/widgets", resource: "issues", state: "all", labels: "bug,needs-triage", limit: 5 },
      REPO,
      {},
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.url).toContain("state=all");
    expect(built.url).toContain("per_page=5");
    expect(built.url).toContain("labels=bug%2Cneeds-triage");
  });

  it("interpolates a label filter from upstream and encodes it", () => {
    const built = buildGithubReadUrl(
      { repo: "acme/widgets", resource: "issues", labels: "{{in.label}}" },
      REPO,
      { in: { label: "needs triage" } },
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.url).toContain("labels=needs+triage");
  });

  it("omits the label filter when interpolation resolves to nothing", () => {
    const built = buildGithubReadUrl(
      { repo: "acme/widgets", resource: "issues", labels: "{{in.missing}}" },
      REPO,
      { in: {} },
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.url).not.toContain("labels=");
  });

  it("requires a number for a single resource", () => {
    const built = buildGithubReadUrl({ repo: "acme/widgets", resource: "issue" }, REPO, {});
    expect(built).toEqual({ ok: false, error: "number is required unless you are reading an issue list" });
  });
});

describe("githubRead executor", () => {
  it("sends a GET with the bound token and never a body", async () => {
    const http = spyHttp();
    const result = await createGithubReadExecutor(http.executor)(
      ctx,
      { repo: "acme/widgets", resource: "issue", number: 3 },
      {},
      boundToken,
    );
    expect(result.ok).toBe(true);
    expect(http.calls[0]?.method).toBe("GET");
    expect(http.calls[0]?.body).toBeUndefined();
    expect((http.calls[0]?.headers as Record<string, string>).authorization).toBe("Bearer ghp_test");
  });

  it("refuses to run without a bound connection secret", async () => {
    const http = spyHttp();
    const result = await createGithubReadExecutor(http.executor)(
      ctx,
      { repo: "acme/widgets", resource: "issue", number: 3 },
      {},
      undefined,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected missing-connection failure");
    expect(result.error).toContain("bound to a stored connection secret");
    // The credential check must happen before any request is attempted.
    expect(http.calls).toHaveLength(0);
  });

  it("rejects a repo that could break out of its path segment", async () => {
    const http = spyHttp();
    for (const repo of ["acme/widgets/../../admin", "acme", "../etc", "acme/wid gets"]) {
      const result = await createGithubReadExecutor(http.executor)(
        ctx,
        { repo, resource: "issue", number: 1 },
        {},
        boundToken,
      );
      expect(result.ok, repo).toBe(false);
    }
    expect(http.calls).toHaveLength(0);
  });

  it("bounds the page size through the schema", () => {
    expect(() => githubReadNode.paramsSchema.parse({ repo: "a/b", resource: "issues", limit: 500 })).toThrow();
    expect(() => githubReadNode.paramsSchema.parse({ repo: "a/b", resource: "issues", limit: 0 })).toThrow();
  });

  it("makes no request in dry-run", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await githubReadNode.dryRunStub?.(ctx, { repo: "a/b", resource: "issues" }, {}, undefined);
    expect(result?.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
