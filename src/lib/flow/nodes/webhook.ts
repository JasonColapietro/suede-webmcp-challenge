import { z } from "zod";
import { defineExecutableNode } from "../executor";
import { getNodeDefinition } from "../node-definitions";

/**
 * A trigger node, same shape as schedule.ts: no inputs, engine feeds it the
 * run's trigger input (the inbound webhook's parsed JSON body) and it just
 * forwards it downstream.
 *
 * Authentication for who is allowed to fire this trigger does NOT live in
 * node params — it is not something a flow author configures per node. The
 * secret is generated server-side at launch time (one per agent, not per
 * node) and verified in src/app/api/agents/[agent]/webhook/route.ts /
 * src/lib/webhook-handler.ts, well before the graph ever runs. See
 * src/lib/webhook-auth.ts for the full auth scheme. `note` is purely a
 * documentation field for the flow author (e.g. "GitHub push events") and
 * has no effect on verification.
 */
export const webhookParamsSchema = z.object({
  note: z.string().optional(),
  // Same contract role as the input and schedule nodes: these keys name the
  // body shape this trigger expects, and deriveInputSchema publishes them as
  // the agent's MCP input schema. Unlike `note`, this is not documentation —
  // the defaults are merged under the live payload at run time.
  fields: z.record(z.string(), z.unknown()).optional(),
});

export const webhookNode = defineExecutableNode(getNodeDefinition("webhook"), {
  paramsSchema: webhookParamsSchema,
  executor: async (_ctx, rawParams, inputs) => {
    const params = webhookParamsSchema.parse(rawParams);
    return { ok: true, outputs: { result: { ...(params.fields ?? {}), ...inputs } }, costUsdc: 0 };
  },
});
