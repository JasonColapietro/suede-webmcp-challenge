import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SCHEMA = path.join(ROOT, "src/lib/manifest/schema.ts");
const FORBIDDEN = /(?:connector-bundle\.ts|connectors\/(?:schema|operation-closure|repository)|^node:|\bBuffer\b)/;

function runtimeImports(source: string): string[] {
  return [...source.matchAll(/import\s+(?!type\b)(?:[^"'\n]+?\s+from\s+)?["']([^"']+)["']/g)]
    .map((match) => match[1]!);
}

function resolve(from: string, specifier: string): string | null {
  const base = specifier.startsWith("@/")
    ? path.join(ROOT, "src", specifier.slice(2))
    : specifier.startsWith(".")
      ? path.resolve(path.dirname(from), specifier)
      : null;
  if (base === null) return null;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Cannot resolve ${specifier} from ${from}`);
}

describe("portable manifest client boundary", () => {
  it("keeps the browser schema runtime graph free of connector server and node builtins", () => {
    const pending = [SCHEMA];
    const seen = new Set<string>();
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const source = fs.readFileSync(file, "utf8");
      expect(source, path.relative(ROOT, file)).not.toMatch(/\bBuffer\b/);
      for (const specifier of runtimeImports(source)) {
        expect(specifier, path.relative(ROOT, file)).not.toMatch(FORBIDDEN);
        const target = resolve(file, specifier);
        if (target !== null) pending.push(target);
      }
    }
  });
});
