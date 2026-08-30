/**
 * Agent memory — v0 = local JSON file at <dir>/.suede/memory.json
 *
 * When self-hosting, the working directory (or the dir you pass) is the
 * storage root. Hosted agents (running on the Suede platform) use platform
 * memory tied to the agent's flow state — that unification is a later pass.
 * If you run `serve()` on your own machine, memory is local only: it won't
 * sync with the hosted version of the same agent. Document + revisit in Phase 9.
 */
import fs from "node:fs";
import path from "node:path";
const MEMORY_FILENAME = "memory.json";
function resolveMemoryPath(workdir) {
    return path.join(workdir, ".suede", MEMORY_FILENAME);
}
function readStore(filePath) {
    try {
        const raw = fs.readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(raw);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            return parsed;
        }
        return {};
    }
    catch {
        return {};
    }
}
function writeStore(filePath, store) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(store, null, 2), "utf-8");
}
/**
 * Create a local JSON-file-backed memory instance.
 *
 * @param workdir - directory containing the .suede/ folder (defaults to cwd)
 */
export function createLocalMemory(workdir = process.cwd()) {
    const filePath = resolveMemoryPath(workdir);
    return {
        async get(key) {
            const store = readStore(filePath);
            const value = store[key];
            return value === undefined ? undefined : value;
        },
        async set(key, value) {
            const store = readStore(filePath);
            store[key] = value;
            writeStore(filePath, store);
        },
    };
}
//# sourceMappingURL=memory.js.map