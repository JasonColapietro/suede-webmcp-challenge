/**
 * Posts a message to a Slack incoming webhook. The webhook URL IS the
 * credential — it must come from a bound connection secret (see
 * value-bindings.ts's SecretReference), never a plain string param, so it
 * can never end up in flow params, run history, or node output. The actual
 * delivery is done by http.ts's SSRF-hardened executor, not a second fetch
 * implementation: this node only builds the JSON body and hands the
 * resolved URL to createHttpExecutor().
 */
import { z } from "zod";
import { defineExecutableNode, type NodeExecutor } from "../../executor";
import { getNodeDefinition } from "../../node-definitions";
import { errMessage, interpolate } from "../_util";
import { connectionHeader } from "../connection-material";
import { createHttpExecutor, httpDryRunStub } from "../http";

export const slackMessageParamsSchema = z.object({
  text: z.string().min(1, "text is required"),
  channel: z.string().optional(),
});

export type SlackMessageParams = z.infer<typeof slackMessageParamsSchema>;

export function createSlackMessageExecutor(
  httpExecutor: NodeExecutor = createHttpExecutor(),
): NodeExecutor {
  return async (ctx, rawParams, inputs, provenance) => {
    let params: SlackMessageParams;
    try {
      params = slackMessageParamsSchema.parse(rawParams ?? {});
    } catch (e) {
      return { ok: false, error: errMessage(e), costUsdc: 0 };
    }

    const webhookUrl = connectionHeader(provenance, "x-suede-webhook-url");
    if (!webhookUrl) {
      return {
        ok: false,
        error: "connection secret must contain a stored Slack webhook endpoint",
        costUsdc: 0,
      };
    }

    const text = interpolate(params.text, inputs);
    const body = JSON.stringify({
      text,
      ...(params.channel ? { channel: interpolate(params.channel, inputs) } : {}),
    });

    return httpExecutor(
      ctx,
      { method: "POST", url: webhookUrl, headers: { "content-type": "application/json" }, body },
      {},
      undefined,
    );
  };
}

export const slackMessageDryRunStub: NodeExecutor = async (ctx, rawParams, inputs) => {
  try {
    // Parsed for its rejection behaviour only. The stub has to refuse exactly
    // the params the real executor would, but it sends nothing, so the parsed
    // value itself is not needed.
    slackMessageParamsSchema.parse(rawParams ?? {});
  } catch (e) {
    return { ok: false, error: errMessage(e), costUsdc: 0 };
  }
  return httpDryRunStub(
    ctx,
    { method: "POST", url: "https://hooks.slack.com/services/<redacted>" },
    inputs,
    undefined,
  );
};

export const slackMessageNode = defineExecutableNode(getNodeDefinition("comms.slackMessage"), {
  paramsSchema: slackMessageParamsSchema,
  executor: createSlackMessageExecutor(),
  dryRunStub: slackMessageDryRunStub,
});
