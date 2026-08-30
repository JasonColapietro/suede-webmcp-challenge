/**
 * Triggers a workflow_dispatch event via the GitHub REST API. Same credential
 * rule as githubIssue.ts: the PAT must come from a bound connection secret.
 * Delivery goes through http.ts's SSRF-hardened executor.
 */
import { z } from "zod";
import { defineExecutableNode, type NodeExecutor } from "../../executor";
import { getNodeDefinition } from "../../node-definitions";
import { errMessage, interpolate, interpolateStructured } from "../_util";
import { createHttpExecutor, httpDryRunStub } from "../http";
import { GITHUB_API_BASE, githubHeaders, githubToken, parseRepo } from "./_github";

/** GitHub's own naming rule for a workflow filename: no path separators. */
const WORKFLOW_FILE_PATTERN = /^[A-Za-z0-9._-]+\.ya?ml$/;

export const githubWorkflowDispatchParamsSchema = z.object({
  repo: z.string().min(1, "repo is required"),
  workflowFile: z.string().min(1, "workflowFile is required"),
  ref: z.string().min(1, "ref is required"),
  inputs: z.record(z.string(), z.unknown()).optional(),
});

export type GithubWorkflowDispatchParams = z.infer<typeof githubWorkflowDispatchParamsSchema>;

export function createGithubWorkflowDispatchExecutor(
  httpExecutor: NodeExecutor = createHttpExecutor(),
): NodeExecutor {
  return async (ctx, rawParams, inputs, provenance) => {
    let params: GithubWorkflowDispatchParams;
    try {
      params = githubWorkflowDispatchParamsSchema.parse(rawParams ?? {});
    } catch (e) {
      return { ok: false, error: errMessage(e), costUsdc: 0 };
    }

    const repo = parseRepo(params.repo);
    if (!repo) {
      return { ok: false, error: 'repo must be in the form "owner/repo"', costUsdc: 0 };
    }
    if (!WORKFLOW_FILE_PATTERN.test(params.workflowFile)) {
      return { ok: false, error: 'workflowFile must be a plain filename, e.g. "deploy.yml"', costUsdc: 0 };
    }
    const token = githubToken(provenance);
    if (!token) {
      return {
        ok: false,
        error: "token must be bound to a stored connection secret (this node never accepts it as a plain param)",
        costUsdc: 0,
      };
    }

    const ref = interpolate(params.ref, inputs);
    const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/actions/workflows/${encodeURIComponent(params.workflowFile)}/dispatches`;
    const payload = {
      ref,
      ...(params.inputs ? { inputs: interpolateStructured(params.inputs, inputs) } : {}),
    };

    return httpExecutor(
      ctx,
      { method: "POST", url, headers: githubHeaders(token), body: JSON.stringify(payload) },
      {},
      undefined,
    );
  };
}

export const githubWorkflowDispatchDryRunStub: NodeExecutor = async (ctx, _rawParams, inputs) =>
  httpDryRunStub(
    ctx,
    { method: "POST", url: `${GITHUB_API_BASE}/repos/<redacted>/actions/workflows/<redacted>/dispatches` },
    inputs,
    undefined,
  );

export const githubWorkflowDispatchNode = defineExecutableNode(
  getNodeDefinition("devops.githubWorkflowDispatch"),
  {
    paramsSchema: githubWorkflowDispatchParamsSchema,
    executor: createGithubWorkflowDispatchExecutor(),
    dryRunStub: githubWorkflowDispatchDryRunStub,
  },
);
