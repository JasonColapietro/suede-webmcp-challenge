/**
 * defineAgent — validate and freeze an agent definition.
 *
 * The return is Object.freeze'd so that the definition cannot be mutated
 * after creation. The `run` function is preserved as-is.
 */
import { z } from "zod";
const TriggerSchema = z.union([
    z.object({ kind: z.literal("manual") }),
    z.object({ kind: z.literal("schedule"), cron: z.string().min(1) }),
    z.object({ kind: z.literal("paidCall"), priceUsdc: z.number().nonnegative() }),
    z.object({ kind: z.literal("webhook") }),
]);
const AgentDefinitionInputSchema = z.object({
    name: z.string().min(1, "name must be a non-empty string"),
    description: z.string().optional(),
    triggers: z.array(TriggerSchema).min(1, "at least one trigger is required"),
    run: z.function(),
});
/** Validate and freeze an agent definition. Throws on invalid input. */
export function defineAgent(def) {
    const result = AgentDefinitionInputSchema.safeParse(def);
    if (!result.success) {
        throw new Error(`defineAgent(): invalid definition — ${result.error.issues[0].message}`);
    }
    return Object.freeze({
        name: def.name,
        description: def.description,
        triggers: def.triggers,
        run: def.run,
    });
}
//# sourceMappingURL=define.js.map