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
import type { AgentMemory } from "./types.js";

const MEMORY_FILENAME = "memory.json";

function resolveMemoryPath(workdir: string): string {
  return path.join(workdir, ".suede", MEMORY_FILENAME);
}

function readStore(filePath: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function writeStore(filePath: string, store: Record<string, unknown>): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2), "utf-8");
}

/**
 * Create a local JSON-file-backed memory instance.
 *
 * @param workdir - directory containing the .suede/ folder (defaults to cwd)
 */
export function createLocalMemory(workdir: string = process.cwd()): AgentMemory {
  const filePath = resolveMemoryPath(workdir);

  return {
    async get<T>(key: string): Promise<T | undefined> {
      const store = readStore(filePath);
      const value = store[key];
      return value === undefined ? undefined : (value as T);
    },

    async set<T>(key: string, value: T): Promise<void> {
      const store = readStore(filePath);
      store[key] = value;
      writeStore(filePath, store);
    },
  };
}
