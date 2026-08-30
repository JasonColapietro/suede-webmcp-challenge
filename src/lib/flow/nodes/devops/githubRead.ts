/**
 * Reads from the GitHub REST API. The existing GitHub nodes only write —
 * githubIssue creates and comments, githubWorkflowDispatch triggers — so an
 * agent could act on a repository but never look at one first. Triage needs
 * to read before it decides.
 *
 * Same credential rule as its siblings: the token is a bound connection
 * secret, never a plain param, and delivery goes through http.ts's
 * SSRF-hardened executor rather than a second fetch implementation.
 */
import { z } from "zod";
import { defineExecutableNode, type NodeExecutor } from "../../executor";
import { getNodeDefinition } from "../../node-definitions";
import { errMessage, interpolate } from "../_util";
import { createHttpExecutor, httpDryRunStub } from "../http";
import { GITHUB_API_BASE, githubHeaders, githubToken, parseRepo } from "./_github";

export const githubReadParamsSchema = z.object({
  repo: z.string().min(1, "repo is required"),
  resource: z.enum(["issue", "pullRequest", "issues"]),
  number: z.number().int().positive().optional(),
  state: z.enum(["open", "closed", "all"]).optional(),
  labels: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export type GithubReadParams = z.infer<typeof githubReadParamsSchema>;

/** GitHub caps per_page at 100; anything above is silently clamped by them. */
const DEFAULT_LIMIT = 30;

export function buildGithubReadUrl(
  params: GithubReadParams,
  repo: { owner: string; name: string },
  inputs: Record<string, unknown>,
): { ok: true; url: string } | { ok: false; error: string } {
  const base = `${GITHUB_API_BASE}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;

  if (params.resource === "issues") {
    const query = new URLSearchParams({
      state: params.state ?? "open",
      per_page: String(params.limit ?? DEFAULT_LIMIT),
    });
    const labels = params.labels !== undefined ? interpolate(params.labels, inputs).trim() : "";
    if (labels !== "") query.set("labels", labels);
    return { ok: true, url: `${base}/issues?${query.toString()}` };
  }

  if (params.number === undefined) {
    return { ok: false, error: "number is required unless you are reading an issue list" };
  }
  // A PR is also an issue in GitHub's API, but only the pulls endpoint carries
  // the diff/merge fields a review agent needs.
  const path = params.resource === "pullRequest" ? "pulls" : "issues";
  return { ok: true, url: `${base}/${path}/${params.number}` };
}

export function createGithubReadExecutor(
  httpExecutor: NodeExecutor = createHttpExecutor(),
): NodeExecutor {
  return async (ctx, rawParams, inputs, provenance) => {
    let params: GithubReadParams;
    try {
      params = githubReadParamsSchema.parse(rawParams ?? {});
    } catch (e) {
      return { ok: false, error: errMessage(e), costUsdc: 0 };
    }

    const repo = parseRepo(params.repo);
    if (!repo) {
      return { ok: false, error: 'repo must be in the form "owner/repo"', costUsdc: 0 };
    }
    const token = githubToken(provenance);
    if (!token) {
      return {
        ok: false,
        error: "token must be bound to a stored connection secret (this node never accepts it as a plain param)",
        costUsdc: 0,
      };
    }

    const built = buildGithubReadUrl(params, repo, inputs);
    if (!built.ok) return { ok: false, error: built.error, costUsdc: 0 };

    return httpExecutor(
      ctx,
      { method: "GET", url: built.url, headers: githubHeaders(token) },
      {},
      undefined,
    );
  };
}

export const githubReadDryRunStub: NodeExecutor = async (ctx, _rawParams, inputs) =>
  httpDryRunStub(ctx, { method: "GET", url: `${GITHUB_API_BASE}/repos/<redacted>/issues` }, inputs, undefined);

export const githubReadNode = defineExecutableNode(getNodeDefinition("devops.githubRead"), {
  paramsSchema: githubReadParamsSchema,
  executor: createGithubReadExecutor(),
  dryRunStub: githubReadDryRunStub,
});
