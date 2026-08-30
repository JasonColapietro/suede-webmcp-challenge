import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function validateLocalBaseUrl(value) {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
    throw new Error("--base-url must be an HTTP(S) origin without credentials");
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error("--base-url must use localhost, 127.0.0.1, or [::1]");
  }
  return url;
}

function resolveThroughExistingParent(value) {
  let cursor = resolve(value);
  const suffix = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(basename(cursor));
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...suffix);
}

export function validateCaptureOutput(output, repositoryRoot = process.cwd()) {
  if (!isAbsolute(output)) throw new Error("--output must be an absolute directory");
  const physicalRepository = resolveThroughExistingParent(repositoryRoot);
  const physicalOutput = resolveThroughExistingParent(output);
  const repoRelative = relative(physicalRepository, physicalOutput);
  const insideRepository =
    repoRelative === "" || (!repoRelative.startsWith("..") && !isAbsolute(repoRelative));
  const insideIgnoredArtifacts =
    repoRelative === ".artifacts" || repoRelative.startsWith(`.artifacts/`);
  if (insideRepository && !insideIgnoredArtifacts) {
    throw new Error("--output inside the repository must be under .artifacts/");
  }
  const manifestPath = join(output, "phase-0-capture-manifest.json");
  if (existsSync(manifestPath)) {
    throw new Error(`refusing to overwrite existing manifest: ${manifestPath}`);
  }
  return manifestPath;
}

export function writeNewCaptureManifest(manifestPath, manifest) {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

export async function verifyIsolatedCaptureServer(
  baseUrl,
  sessionToken,
  fetchImpl = fetch,
  options = {},
) {
  if (typeof sessionToken !== "string" || sessionToken.length < 16) {
    throw new Error("--session-token must be the token from capture:phase0:server");
  }
  const attempts = options.attempts ?? 20;
  const delayMs = options.delayMs ?? 500;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImpl(`${baseUrl.origin}/api/verification/capture-session`, {
        headers: { "x-suede-capture-session": sessionToken },
        cache: "no-store",
      });
      if (response.ok) {
        const body = await response.json();
        if (body?.safe === true) return;
      }
    } catch {
      // A cold local server can refuse the first connection while it starts.
    }
    if (attempt + 1 < attempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error("capture server is not using the required disposable SQLite runtime");
}
