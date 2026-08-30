/**
 * Source contract: API routes never surface raw error.message on a plain 500.
 *
 * The catch-all `const message = error instanceof Error ? error.message : ...`
 * → `NextResponse.json({ error: message }, { status: 500 })` idiom leaks DB,
 * provider, relay, and stack context to callers. The reviewed pattern (see
 * /api/agents/[agent]/run) logs server-side and returns an opaque body.
 *
 * SSE run streams are exempt by construction: they enqueue error frames into
 * an owner-only diagnostic stream instead of returning a 500 body, and this
 * scan only matches the return form.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const API_ROOT = join(process.cwd(), "src", "app", "api");

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...routeFiles(path));
    else if (entry.isFile() && entry.name === "route.ts") out.push(path);
  }
  return out;
}

const LEAK_IDIOM =
  /const message = error instanceof Error \? error\.message[^;]*;\s*return (?:NextResponse\.json|privateJson)\(\{ error: message \}, \{ status: 500 \}\)/;

describe("opaque 500 contract", () => {
  it("no API route returns raw error.message with a 500", () => {
    const files = routeFiles(API_ROOT);
    expect(files.length).toBeGreaterThan(40);
    const offenders = files.filter((file) => LEAK_IDIOM.test(readFileSync(file, "utf8")));
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
