/**
 * defineAgent — validate and freeze an agent definition.
 *
 * The return is Object.freeze'd so that the definition cannot be mutated
 * after creation. The `run` function is preserved as-is.
 */
import type { AgentDefinition } from "./types.js";
/** Validate and freeze an agent definition. Throws on invalid input. */
export declare function defineAgent(def: AgentDefinition): Readonly<AgentDefinition>;
//# sourceMappingURL=define.d.ts.map