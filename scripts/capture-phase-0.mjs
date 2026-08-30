import { mkdirSync } from "node:fs";
import {
  validateCaptureOutput,
  validateLocalBaseUrl,
  verifyIsolatedCaptureServer,
  writeNewCaptureManifest,
} from "./capture-phase-0-lib.mjs";
import { assertGitEvidenceUnchanged, requireCleanGitEvidence } from "./git-evidence.mjs";

const routes = [
  "/",
  "/start",
  "/flows",
  "/build/new",
  "/build/new?template=lead-qualifier",
  "/templates",
  "/agents",
];

const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
  { name: "studio-wide", width: 1920, height: 1080, studioOnly: true },
];

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key !== "--base-url" && key !== "--output" && key !== "--session-token") {
      throw new Error(`Unknown argument: ${key}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    values.set(key, value);
    index += 1;
  }
  return values;
}

function routeName(route) {
  if (route === "/") return "home";
  return route
    .slice(1)
    .replaceAll("?", "-")
    .replaceAll("=", "-")
    .replaceAll("/", "-")
    .replaceAll(/[^a-zA-Z0-9-]/g, "-");
}

try {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = validateLocalBaseUrl(args.get("--base-url") ?? "");
  const output = args.get("--output") ?? "";
  const manifestPath = validateCaptureOutput(output);
  const evidence = requireCleanGitEvidence();
  await verifyIsolatedCaptureServer(baseUrl, args.get("--session-token"));

  mkdirSync(output, { recursive: true });
  const captures = routes.flatMap((route) =>
    viewports
      .filter((viewport) => !viewport.studioOnly || route.startsWith("/build/"))
      .map((viewport) => ({
        route,
        viewport: viewport.name,
        width: viewport.width,
        height: viewport.height,
        filename: `${routeName(route)}--${viewport.name}.png`,
        sha256: null,
      })),
  );
  const manifest = {
    schemaVersion: 1,
    commit: evidence.commit,
    tree: evidence.tree,
    dirty: evidence.dirty,
    baseUrl: baseUrl.origin,
    createdAt: new Date().toISOString(),
    routes,
    viewports,
    captures,
    privacy: "Local pages only. No cookies, credentials, environment values, or storage state are captured.",
  };
  writeNewCaptureManifest(manifestPath, manifest);
  assertGitEvidenceUnchanged(evidence);
  process.stdout.write(`Wrote ${manifestPath}\n`);
  process.stdout.write(`Capture ${captures.length} local screenshots listed in the manifest, then populate each sha256 field.\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Phase 0 capture manifest failed: ${message}\n`);
  process.stderr.write("Usage: npm run capture:phase0 -- --base-url http://127.0.0.1:3210 --output /absolute/path --session-token <token>\n");
  process.exit(1);
}
