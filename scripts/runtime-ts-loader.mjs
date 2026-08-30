import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve as resolvePath } from "node:path";
import ts from "typescript";

const root = resolvePath(fileURLToPath(new URL("..", import.meta.url)));

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const base = resolvePath(root, "src", specifier.slice(2));
    for (const candidate of [`${base}.ts`, resolvePath(base, "index.ts")]) {
      try { await readFile(candidate); return { url: pathToFileURL(candidate).href, shortCircuit: true }; } catch { /* try next */ }
    }
  }
  if (specifier.startsWith(".") && context.parentURL?.endsWith(".ts")) {
    for (const suffix of [".ts", "/index.ts"]) {
      const candidate = new URL(`${specifier}${suffix}`, context.parentURL);
      try { await readFile(candidate); return { url: candidate.href, shortCircuit: true }; } catch { /* try next */ }
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (!url.endsWith(".ts")) return nextLoad(url, context);
  const source = await readFile(new URL(url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, moduleResolution: ts.ModuleResolutionKind.Bundler },
    fileName: fileURLToPath(url),
  });
  return { format: "module", source: output.outputText, shortCircuit: true };
}
