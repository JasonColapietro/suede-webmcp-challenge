/**
 * Creates or comments on a GitHub issue via the REST API. The PAT is a
 * credential and must come from a bound connection secret, never a plain
 * param, same rule as the comms/ nodes. Delivery goes through http.ts's
 * SSRF-hardened executor, not a second fetch implementation.
 */
import { z } from "zod";
import { defineExecutableNode, type NodeExecutor } from "../../executor";
import { getNodeDefinition } from "../../node-definitions";
import { errMessage, interpolate } from "../_util";
import { createHttpExecutor, httpDryRunStub } from "../http";
import { GITHUB_API_BASE, githubHeaders, githubToken, parseRepo } from "./_github";

export const githubIssueParamsSchema = z.object({
  repo: z.string().min(1, "repo is required"),
  action: z.enum(["create", "comment"]),
  issueNumber: z.number().int().positive().optional(),
  title: z.string().optional(),
  body: z.string().optional(),
});

export type GithubIssueParams = z.infer<typeof githubIssueParamsSchema>;

export function createGithubIssueExecutor(
  httpExecutor: NodeExecutor = createHttpExecutor(),
): NodeExecutor {
  return async (ctx, rawParams, inputs, provenance) => {
    let params: GithubIssueParams;
    try {
      params = githubIssueParamsSchema.parse(rawParams ?? {});
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

    const body = params.body !== undefined ? interpolate(params.body, inputs) : undefined;
    let url: string;
    let payload: Record<string, unknown>;

    if (params.action === "create") {
      const title = params.title !== undefined ? interpolate(params.title, inputs) : undefined;
      if (!title) {
        return { ok: false, error: "title is required to create an issue", costUsdc: 0 };
      }
      url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/issues`;
      payload = { title, ...(body ? { body } : {}) };
    } else {
      if (!params.issueNumber) {
        return { ok: false, error: "issueNumber is required to comment on an issue", costUsdc: 0 };
      }
      if (!body) {
        return { ok: false, error: "body is required to comment on an issue", costUsdc: 0 };
      }
      url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/issues/${params.issueNumber}/comments`;
      payload = { body };
    }

    return httpExecutor(
      ctx,
      { method: "POST", url, headers: githubHeaders(token), body: JSON.stringify(payload) },
      {},
      undefined,
    );
  };
}

export const githubIssueDryRunStub: NodeExecutor = async (ctx, _rawParams, inputs) =>
  httpDryRunStub(ctx, { method: "POST", url: `${GITHUB_API_BASE}/repos/<redacted>/issues` }, inputs, undefined);

export const githubIssueNode = defineExecutableNode(getNodeDefinition("devops.githubIssue"), {
  paramsSchema: githubIssueParamsSchema,
  executor: createGithubIssueExecutor(),
  dryRunStub: githubIssueDryRunStub,
});
