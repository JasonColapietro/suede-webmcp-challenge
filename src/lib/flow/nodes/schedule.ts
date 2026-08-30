import { z } from "zod";
import { defineExecutableNode } from "../executor";
import { getNodeDefinition } from "../node-definitions";

/**
 * A trigger node. Engine feeds it the run's trigger input; it just forwards.
 *
 * `fields` mirrors the input node: its keys are this agent's published input
 * contract (see deriveInputSchema), and its values are the defaults a run
 * falls back to. A scheduled agent is not only reached by its cron — it is
 * also a callable MCP tool, and its downstream prompts interpolate {{in}} the
 * same way an input-triggered one does. Without authored keys the tool
 * advertises a bare `{ type: "object" }` that names nothing.
 */
export const scheduleParamsSchema = z.object({
  cron: z.string().min(1, "cron expression required"),
  fields: z.record(z.string(), z.unknown()).optional(),
});

export const scheduleNode = defineExecutableNode(getNodeDefinition("schedule"), {
  paramsSchema: scheduleParamsSchema,
  executor: async (_ctx, rawParams, inputs) => {
    const params = scheduleParamsSchema.parse(rawParams);
    // Configured default fields, overridden by live trigger inputs — the cron
    // fires with no payload, so the defaults are what that run actually reads.
    return { ok: true, outputs: { result: { ...(params.fields ?? {}), ...inputs } }, costUsdc: 0 };
  },
});
