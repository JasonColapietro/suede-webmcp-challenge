/**
 * Agent memory — v0 = local JSON file at <dir>/.suede/memory.json
 *
 * When self-hosting, the working directory (or the dir you pass) is the
 * storage root. Hosted agents (running on the Suede platform) use platform
 * memory tied to the agent's flow state — that unification is a later pass.
 * If you run `serve()` on your own machine, memory is local only: it won't
 * sync with the hosted version of the same agent. Document + revisit in Phase 9.
 */
import type { AgentMemory } from "./types.js";
/**
 * Create a local JSON-file-backed memory instance.
 *
 * @param workdir - directory containing the .suede/ folder (defaults to cwd)
 */
export declare function createLocalMemory(workdir?: string): AgentMemory;
//# sourceMappingURL=memory.d.ts.map