/**
 * Sends a flexible JSON record to any CRM/automation webhook — a generic
 * "push this record somewhere" node, not a real Salesforce/HubSpot OAuth
 * integration. The endpoint URL and the optional bearer token are both
 * credentials and must come from bound connection secrets, never a plain
 * param, same rule as slackMessage.ts. Delivery goes through http.ts's
 * SSRF-hardened executor, not a second fetch implementation.
 */
import { z } from "zod";
import { defineExecutableNode, type NodeExecutor } from "../../executor";
import { getNodeDefinition } from "../../node-definitions";
import { errMessage, interpolateStructured } from "../_util";
import { connectionHeader } from "../connection-material";
import { createHttpExecutor, httpDryRunStub } from "../http";

export const crmWebhookParamsSchema = z.object({
  record: z.record(z.string(), z.unknown()),
});

export type CrmWebhookParams = z.infer<typeof crmWebhookParamsSchema>;

export function createCrmWebhookExecutor(
  httpExecutor: NodeExecutor = createHttpExecutor(),
): NodeExecutor {
  return async (ctx, rawParams, inputs, provenance) => {
    let params: CrmWebhookParams;
    try {
      params = crmWebhookParamsSchema.parse(rawParams ?? {});
    } catch (e) {
      return { ok: false, error: errMessage(e), costUsdc: 0 };
    }

    const url = connectionHeader(provenance, "x-suede-webhook-url");
    if (!url) {
      return {
        ok: false,
        error: "connection secret must contain a stored CRM webhook endpoint",
        costUsdc: 0,
      };
    }
    const authorization = connectionHeader(provenance, "authorization");

    return httpExecutor(
      ctx,
      {
        method: "POST",
        url,
        headers: {
          "content-type": "application/json",
          ...(authorization ? { authorization } : {}),
        },
        body: JSON.stringify(interpolateStructured(params.record, inputs)),
      },
      {},
      undefined,
    );
  };
}

export const crmWebhookDryRunStub: NodeExecutor = async (ctx, _rawParams, inputs) =>
  httpDryRunStub(ctx, { method: "POST", url: "https://<redacted-crm-webhook>" }, inputs, undefined);

export const crmWebhookNode = defineExecutableNode(getNodeDefinition("comms.crmWebhook"), {
  paramsSchema: crmWebhookParamsSchema,
  executor: createCrmWebhookExecutor(),
  dryRunStub: crmWebhookDryRunStub,
});
