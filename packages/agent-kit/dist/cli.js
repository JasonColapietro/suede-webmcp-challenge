#!/usr/bin/env node
/**
 * suede CLI — code-native agent management for the Suede platform.
 *
 * Subcommands (plain process.argv dispatch, no external deps):
 *   init            scaffold .suede/config.json + agent.ts + package.json + .gitignore
 *   login <key>     save workspace key; POST /api/me/claim to verify
 *   push            read agent.ts, post manifest to /api/cli/agents
 *   pull <slug>     GET /api/cli/agents/<slug>, write manifest.json + agent.ts
 *   versions ...    read immutable versions and write local portable artifacts
 *   dev             run the agent locally on port 3001
 *   whoami          print apiUrl + key prefix
 *
 * Config: .suede/config.json in cwd  { workspaceKey: string, apiUrl: string }
 */
import fs from "node:fs";
import path from "node:path";
import { createVersionBundle, createVersionClient, } from "./version-client.js";
// ────────────────────────────────────────────────────────────────────────────
// Config helpers
// ────────────────────────────────────────────────────────────────────────────
const CONFIG_RELATIVE = path.join(".suede", "config.json");
export function readConfig(cwd = process.cwd()) {
    const filePath = path.join(cwd, CONFIG_RELATIVE);
    try {
        const raw = fs.readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(raw);
        if (typeof parsed === "object" &&
            parsed !== null &&
            "workspaceKey" in parsed &&
            "apiUrl" in parsed &&
            typeof parsed.workspaceKey === "string" &&
            typeof parsed.apiUrl === "string") {
            return parsed;
        }
        return null;
    }
    catch {
        return null;
    }
}
export function writeConfig(cwd, config) {
    const dir = path.join(cwd, ".suede");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config, null, 2), "utf-8");
}
// ────────────────────────────────────────────────────────────────────────────
// Argument parsing
// ────────────────────────────────────────────────────────────────────────────
export function parseArgs(argv) {
    // argv[0] = node, argv[1] = script path, argv[2] = subcommand, argv[3+] = args
    const [, , command, ...rest] = argv;
    return { command, args: rest };
}
// ────────────────────────────────────────────────────────────────────────────
// Bearer extraction (used by route handlers too — pure function)
// ────────────────────────────────────────────────────────────────────────────
export function extractBearer(authHeader) {
    if (!authHeader?.startsWith("Bearer "))
        return null;
    const key = authHeader.slice(7).trim();
    return key.length > 0 ? key : null;
}
// ────────────────────────────────────────────────────────────────────────────
// init — scaffold files
// ────────────────────────────────────────────────────────────────────────────
export function buildInitFiles(apiUrl) {
    const configContent = JSON.stringify({ workspaceKey: "", apiUrl }, null, 2);
    const agentContent = `import { defineAgent, paidCall, suede } from "@suedeai/agents";

export default defineAgent({
  name: "my-agent",
  description: "Describe what this agent does.",
  triggers: [paidCall(0.1)],
  async run({ input, memory }) {
    const result = await suede.llm({
      system: "You are a helpful assistant.",
      prompt: String(input ?? ""),
    });
    return { text: result.text };
  },
});
`;
    const packageContent = JSON.stringify({
        name: "my-suede-agent",
        version: "0.1.0",
        private: true,
        type: "module",
        scripts: {
            dev: "suede dev",
            push: "suede push",
        },
        dependencies: {
            "@suedeai/agents": "^0.1.0",
        },
    }, null, 2);
    const gitignoreContent = `.suede/
node_modules/
dist/
`;
    return [
        { name: ".suede/config.json", content: configContent },
        { name: "agent.ts", content: agentContent },
        { name: "package.json", content: packageContent },
        { name: ".gitignore", content: gitignoreContent },
    ];
}
function runInit(cwd) {
    const apiUrl = "https://agents.suedeai.ai";
    const files = buildInitFiles(apiUrl);
    for (const file of files) {
        const fullPath = path.join(cwd, file.name);
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
        if (fs.existsSync(fullPath)) {
            process.stdout.write(`  skip  ${file.name} (already exists)\n`);
        }
        else {
            fs.writeFileSync(fullPath, file.content, "utf-8");
            process.stdout.write(`  create ${file.name}\n`);
        }
    }
    process.stdout.write("\nInitialized. Edit agent.ts, then run:\n" +
        "  suede login <your-workspace-key>\n" +
        "  suede push\n");
}
// ────────────────────────────────────────────────────────────────────────────
// login — claim the workspace key
// ────────────────────────────────────────────────────────────────────────────
async function runLogin(key, cwd) {
    if (!key) {
        process.stderr.write("Usage: suede login <workspace-key>\n");
        process.exit(1);
    }
    const apiUrl = readConfig(cwd)?.apiUrl ?? "https://agents.suedeai.ai";
    let ok = false;
    try {
        const res = await fetch(`${apiUrl}/api/me/claim`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: key }),
        });
        ok = res.ok;
        if (!res.ok) {
            const body = (await res.json().catch(() => ({})));
            const msg = body.error ?? `HTTP ${res.status}`;
            process.stderr.write(`Login failed: ${msg}\n`);
            process.exit(1);
        }
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Login error: ${message}\n`);
        process.exit(1);
    }
    if (ok) {
        writeConfig(cwd, { workspaceKey: key, apiUrl });
        const prefix = key.slice(0, 8);
        process.stdout.write(`Logged in as ${prefix}...\n`);
    }
}
// ────────────────────────────────────────────────────────────────────────────
// push — read agent.ts, extract manifest, POST to platform
// ────────────────────────────────────────────────────────────────────────────
/**
 * Build a minimal AgentManifest from an agent.ts file by reading the
 * exported defineAgent properties. Uses dynamic import (ESM).
 *
 * This is a best-effort static approach: reads the file as text and
 * dynamically imports it via a data URL to avoid complex transpilation.
 */
async function loadManifestFromAgentFile(agentPath) {
    // Dynamic import the agent module
    // The agent.ts file must be pre-compiled to JS, OR we import the raw file
    // (works when Node supports TS natively via --experimental-strip-types, or
    // when the user has ts-node/tsx installed).
    // Fallback: read the file and extract name/triggers via a simple heuristic.
    try {
        const mod = await import(agentPath);
        const agent = mod.default;
        if (!agent || typeof agent.name !== "string") {
            throw new Error("agent.ts must export a default defineAgent({...}) result");
        }
        // Build a minimal manifest JSON
        const triggers = Array.isArray(agent.triggers) ? agent.triggers : [{ kind: "paidCall", priceUsdc: 0 }];
        return {
            manifestVersion: 1,
            name: agent.name,
            description: agent.description ?? "",
            triggers,
            steps: [
                { id: "n1", type: "input", config: {}, after: [] },
                { id: "n2", type: "output", config: {}, after: ["n1"] },
            ],
            meta: { createdBy: "code" },
        };
    }
    catch {
        // Fallback: parse the file text for name
        const src = fs.readFileSync(agentPath, "utf-8");
        const nameMatch = /name:\s*["']([^"']+)["']/.exec(src);
        const name = nameMatch?.[1] ?? "my-agent";
        return {
            manifestVersion: 1,
            name,
            description: "",
            triggers: [{ kind: "paidCall", priceUsdc: 0 }],
            steps: [
                { id: "n1", type: "input", config: {}, after: [] },
                { id: "n2", type: "output", config: {}, after: ["n1"] },
            ],
            meta: { createdBy: "code" },
        };
    }
}
export async function runPush(config, cwd) {
    const agentPath = path.resolve(cwd, "agent.ts");
    if (!fs.existsSync(agentPath)) {
        throw new Error(`No agent.ts found in ${cwd}. Run 'suede init' first.`);
    }
    const manifest = await loadManifestFromAgentFile(agentPath);
    const res = await fetch(`${config.apiUrl}/api/cli/agents`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${config.workspaceKey}`,
        },
        body: JSON.stringify(manifest),
    });
    if (!res.ok) {
        const body = (await res.json().catch(() => ({})));
        throw new Error(`Push failed (${res.status}): ${body.error ?? "unknown error"}`);
    }
    const result = (await res.json());
    if (!result.slug)
        throw new Error("Push failed: server did not return a slug");
    return { slug: result.slug, url: result.url ?? `/a/${result.slug}` };
}
// ────────────────────────────────────────────────────────────────────────────
// pull — GET manifest from platform, write manifest.json + agent.ts
// ────────────────────────────────────────────────────────────────────────────
export async function runPull(slug, config, cwd) {
    const res = await fetch(`${config.apiUrl}/api/cli/agents/${slug}`, {
        method: "GET",
        headers: { "Authorization": `Bearer ${config.workspaceKey}` },
    });
    if (!res.ok) {
        const body = (await res.json().catch(() => ({})));
        throw new Error(`Pull failed (${res.status}): ${body.error ?? "not found"}`);
    }
    const result = (await res.json());
    const manifest = result.manifest;
    if (!manifest)
        throw new Error("Pull failed: server did not return a manifest");
    // Write manifest.json
    fs.writeFileSync(path.join(cwd, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
    // Write agent.ts via codegen
    const agentSrc = generateAgentTs(manifest);
    fs.writeFileSync(path.join(cwd, "agent.ts"), agentSrc, "utf-8");
}
// versions-read-start
function versionClient(config) {
    return createVersionClient({
        apiUrl: config.apiUrl,
        workspaceKey: config.workspaceKey,
    });
}
function shortVersionHash(hash) {
    return hash.length > 12 ? hash.slice(0, 12) : hash;
}
function formatVersionSummary(version) {
    const label = version.label ?? "Untitled checkpoint";
    const pins = `${version.dependencyCount} ${version.dependencyCount === 1 ? "pin" : "pins"}`;
    return `v${version.versionNumber}  ${label}  ${shortVersionHash(version.semanticHash)}  ${pins}`;
}
export async function runVersionsList(flowId, config) {
    const { versions } = await versionClient(config).listVersions(flowId);
    return versions.length === 0
        ? "No immutable versions found.\n"
        : `${versions.map(formatVersionSummary).join("\n")}\n`;
}
function formatDependency(dependency) {
    const hash = dependency.contentHash === undefined ? "" : ` (${dependency.contentHash})`;
    return `- ${dependency.kind} ${dependency.resourceId}@${dependency.version}${hash}`;
}
export async function runVersionInspect(flowId, versionId, config) {
    const { version } = await versionClient(config).getVersion(flowId, versionId);
    const dependencies = [...version.dependencies].sort((left, right) => {
        const leftKey = JSON.stringify([left.kind, left.resourceId, left.version, left.contentHash ?? null]);
        const rightKey = JSON.stringify([right.kind, right.resourceId, right.version, right.contentHash ?? null]);
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
    return [
        `Version: v${version.versionNumber}`,
        `Schema: ${version.schemaVersion}`,
        `Semantic hash: ${version.semanticHash}`,
        `Full hash: ${version.fullHash}`,
        "Dependencies:",
        ...(dependencies.length === 0 ? ["- none"] : dependencies.map(formatDependency)),
        "",
    ].join("\n");
}
function safeOpaquePathSegment(value) {
    return Buffer.from(value, "utf8").toString("base64url") || "version";
}
let atomicWriteSequence = 0;
const VERSION_STAGING_DIRECTORY = ".suede-version-tmp";
function errorCode(error) {
    return error !== null && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
}
function assertSafeOutputTarget(cwd, target) {
    const root = path.resolve(cwd);
    const absolute = path.resolve(target);
    const relative = path.relative(root, absolute);
    if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`refusing to write outside the working directory: ${target}`);
    }
    const segments = relative.split(path.sep).filter(Boolean);
    let cursor = root;
    for (const segment of segments) {
        cursor = path.join(cursor, segment);
        try {
            if (fs.lstatSync(cursor).isSymbolicLink()) {
                throw new Error(`refusing to write through a symbolic link: ${cursor}`);
            }
        }
        catch (error) {
            const code = errorCode(error);
            if (code === "ENOENT")
                return;
            throw error;
        }
    }
}
function assertTrustedDirectory(directory) {
    const directoryStat = fs.lstatSync(directory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
        throw new Error(`refusing to use an output ancestor that is not a real directory: ${directory}`);
    }
    // Windows does not expose process ownership through process.getuid(). On
    // those platforms the structural non-symlink directory checks still apply.
    if (typeof process.getuid !== "function")
        return;
    if (directoryStat.uid !== process.getuid()) {
        throw new Error(`refusing to use an output ancestor not owned by the current user: ${directory}`);
    }
    if ((directoryStat.mode & 0o022) !== 0) {
        throw new Error(`refusing to use a group or other writable output ancestor: ${directory}`);
    }
}
function assertTrustedOutputDirectories(cwd, targetDirectory, allowMissing) {
    const root = path.resolve(cwd);
    const relative = path.relative(root, path.resolve(targetDirectory));
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`refusing to validate output directories outside the working directory: ${targetDirectory}`);
    }
    const directories = [
        root,
        ...relative.split(path.sep).filter(Boolean).map((_, index, segments) => path.join(root, ...segments.slice(0, index + 1))),
    ];
    for (const directory of directories) {
        try {
            assertTrustedDirectory(directory);
        }
        catch (error) {
            if (allowMissing && errorCode(error) === "ENOENT")
                return;
            throw error;
        }
    }
}
function assertExistingTargetIsSafe(target, force) {
    try {
        const targetStat = fs.lstatSync(target);
        if (targetStat.isSymbolicLink()) {
            throw new Error(`refusing to write through a symbolic link: ${target}`);
        }
        if (!force) {
            throw new Error(`refusing to overwrite existing file: ${target}`);
        }
        if (!targetStat.isFile()) {
            throw new Error(`refusing to replace a target that is not a regular file: ${target}`);
        }
    }
    catch (error) {
        if (errorCode(error) === "ENOENT")
            return;
        throw error;
    }
}
function ensureVersionStagingDirectory(cwd) {
    const root = path.resolve(cwd);
    assertTrustedOutputDirectories(root, root, false);
    const staging = path.join(root, VERSION_STAGING_DIRECTORY);
    try {
        fs.mkdirSync(staging, { mode: 0o700 });
    }
    catch (error) {
        if (errorCode(error) !== "EEXIST")
            throw error;
    }
    assertTrustedOutputDirectories(root, staging, false);
    return staging;
}
function assertSameFilesystem(staging, targetDirectory) {
    if (fs.statSync(staging).dev !== fs.statSync(targetDirectory).dev) {
        throw new Error("refusing non-atomic version publication across filesystems");
    }
}
function writeAtomic(cwd, target, content, force) {
    assertSafeOutputTarget(cwd, target);
    const directory = path.dirname(target);
    assertTrustedOutputDirectories(cwd, directory, true);
    assertExistingTargetIsSafe(target, force);
    fs.mkdirSync(directory, { recursive: true });
    assertSafeOutputTarget(cwd, target);
    assertTrustedOutputDirectories(cwd, directory, false);
    assertExistingTargetIsSafe(target, force);
    const staging = ensureVersionStagingDirectory(cwd);
    assertSameFilesystem(staging, directory);
    atomicWriteSequence += 1;
    const temporary = path.join(staging, `.version.${process.pid}.${atomicWriteSequence}.tmp`);
    try {
        fs.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
        assertSafeOutputTarget(cwd, target);
        assertTrustedOutputDirectories(cwd, directory, false);
        assertExistingTargetIsSafe(target, force);
        assertSameFilesystem(staging, directory);
        // Node does not expose openat-style dirfd publication. This closes the
        // observed pre-publication swap, while assuming another same-user process
        // is not replacing cwd ancestors between this check and link/rename.
        if (force) {
            fs.renameSync(temporary, target);
        }
        else {
            fs.linkSync(temporary, target);
            fs.unlinkSync(temporary);
        }
    }
    catch (error) {
        fs.rmSync(temporary, { force: true });
        const code = errorCode(error);
        if (!force && code === "EEXIST") {
            throw new Error(`refusing to overwrite existing file: ${target}`);
        }
        throw error;
    }
}
function stableJson(value) {
    return `${JSON.stringify(canonicalJsonValue(value), null, 2)}\n`;
}
function canonicalJsonValue(value) {
    if (Array.isArray(value))
        return value.map(canonicalJsonValue);
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value)
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
            .map(([key, item]) => [key, canonicalJsonValue(item)]));
    }
    return value;
}
export async function runVersionPull(flowId, versionId, config, cwd, options = {}) {
    const { version } = await versionClient(config).getVersion(flowId, versionId);
    const directory = options.out === undefined
        ? path.join(cwd, ".suede", "versions", safeOpaquePathSegment(versionId))
        : path.resolve(cwd, options.out);
    const target = path.join(directory, "version.json");
    writeAtomic(cwd, target, stableJson(version), options.force === true);
    return target;
}
export async function runVersionExport(flowId, versionId, config, cwd, options = {}) {
    const { version } = await versionClient(config).getVersion(flowId, versionId);
    const target = options.out === undefined
        ? path.join(cwd, ".suede", "versions", `${safeOpaquePathSegment(versionId)}.suede-version.json`)
        : path.resolve(cwd, options.out);
    writeAtomic(cwd, target, stableJson(createVersionBundle(version)), options.force === true);
    return target;
}
function parseVersionWriteOptions(args) {
    let out;
    let force = false;
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === "--force") {
            force = true;
            continue;
        }
        if (argument === "--out") {
            const value = args[index + 1];
            if (!value || value.startsWith("--") || out !== undefined) {
                throw new Error("Usage: suede versions pull|export <flowId> <versionId> [--out <path>] [--force]");
            }
            out = value;
            index += 1;
            continue;
        }
        throw new Error(`Unknown versions option: ${argument}`);
    }
    return { ...(out === undefined ? {} : { out }), ...(force ? { force: true } : {}) };
}
export async function runVersionsCommand(args, config, cwd) {
    const [subcommand, flowId, versionId, ...flags] = args;
    switch (subcommand) {
        case "list":
            if (!flowId || versionId !== undefined) {
                throw new Error("Usage: suede versions list <flowId>");
            }
            return runVersionsList(flowId, config);
        case "inspect":
            if (!flowId || !versionId || flags.length > 0) {
                throw new Error("Usage: suede versions inspect <flowId> <versionId>");
            }
            return runVersionInspect(flowId, versionId, config);
        case "pull": {
            if (!flowId || !versionId) {
                throw new Error("Usage: suede versions pull <flowId> <versionId> [--out <dir>] [--force]");
            }
            const target = await runVersionPull(flowId, versionId, config, cwd, parseVersionWriteOptions(flags));
            return `Pulled immutable version to ${target}\n`;
        }
        case "export": {
            if (!flowId || !versionId) {
                throw new Error("Usage: suede versions export <flowId> <versionId> [--out <file>] [--force]");
            }
            const target = await runVersionExport(flowId, versionId, config, cwd, parseVersionWriteOptions(flags));
            return `Exported self-hostable version bundle to ${target}\n`;
        }
        default:
            throw new Error("Usage: suede versions <list|pull|inspect|export> <flowId> [versionId]");
    }
}
// versions-read-end
/** Minimal codegen: produce a defineAgent source from a raw manifest object. */
function generateAgentTs(manifest) {
    const name = typeof manifest.name === "string" ? manifest.name : "agent";
    const description = typeof manifest.description === "string" ? manifest.description : "";
    const triggers = Array.isArray(manifest.triggers) ? manifest.triggers : [];
    const steps = Array.isArray(manifest.steps) ? manifest.steps : [];
    const triggerExprs = triggers.map((t) => {
        if (typeof t !== "object" || t === null)
            return `{ kind: "manual" }`;
        const trig = t;
        if (trig.kind === "schedule")
            return `schedule(${JSON.stringify(trig.cron)})`;
        if (trig.kind === "paidCall")
            return `paidCall(${Number(trig.priceUsdc ?? 0)})`;
        if (trig.kind === "webhook")
            return `{ kind: "webhook" }`;
        return `{ kind: "manual" }`;
    }).join(",\n    ");
    const imports = triggers.some((t) => t?.kind === "schedule")
        ? `import { defineAgent, schedule, paidCall, suede } from "@suedeai/agents";`
        : `import { defineAgent, paidCall, suede } from "@suedeai/agents";`;
    const stepLines = steps.map((s) => {
        if (typeof s !== "object" || s === null)
            return "";
        const step = s;
        const configJson = JSON.stringify(step.config ?? {}, null, 2);
        return `    // step: ${String(step.id)} (${String(step.type)})\n    await suede.run(${JSON.stringify(step.type)}, ${configJson});`;
    }).join("\n");
    return [
        imports,
        ``,
        `export default defineAgent({`,
        `  name: ${JSON.stringify(name)},`,
        `  description: ${JSON.stringify(description)},`,
        `  triggers: [`,
        `    ${triggerExprs},`,
        `  ],`,
        `  async run({ input, memory, trigger }) {`,
        stepLines,
        `  },`,
        `});`,
        ``,
    ].join("\n");
}
export async function runLink(slug, url, config) {
    if (!slug)
        throw new Error("Usage: suede link <slug> --url <url>");
    if (!url)
        throw new Error("Usage: suede link <slug> --url <url>");
    const res = await fetch(`${config.apiUrl}/api/cli/agents/${slug}/relay`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${config.workspaceKey}`,
        },
        body: JSON.stringify({ url }),
    });
    if (!res.ok) {
        const body = (await res.json().catch(() => ({})));
        throw new Error(`Link failed (${res.status}): ${body.error ?? "unknown error"}`);
    }
    const result = (await res.json());
    if (!result.secret)
        throw new Error("Link failed: server did not return a secret");
    return { secret: result.secret, url: result.url ?? url };
}
// ────────────────────────────────────────────────────────────────────────────
// dev — serve the local agent
// ────────────────────────────────────────────────────────────────────────────
async function runDev(cwd) {
    process.stdout.write("Starting agent locally on http://127.0.0.1:3001\n");
    const agentPath = path.resolve(cwd, "agent.ts");
    if (!fs.existsSync(agentPath)) {
        process.stderr.write(`No agent.ts found in ${cwd}. Run 'suede init' first.\n`);
        process.exit(1);
    }
    // Dynamic import the agent and serve it
    const { serve } = await import("./serve.js");
    try {
        const mod = await import(agentPath);
        const agent = mod.default;
        if (!agent) {
            process.stderr.write("agent.ts must export a default defineAgent({...}) result\n");
            process.exit(1);
        }
        serve(agent, { port: 3001 });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Failed to load agent: ${message}\n`);
        process.exit(1);
    }
}
// ────────────────────────────────────────────────────────────────────────────
// whoami
// ────────────────────────────────────────────────────────────────────────────
function runWhoami(cwd) {
    const config = readConfig(cwd);
    if (!config) {
        process.stdout.write("Not logged in. Run: suede login <workspace-key>\n");
        return;
    }
    const prefix = config.workspaceKey.slice(0, 8);
    process.stdout.write(`API: ${config.apiUrl}\nKey: ${prefix}...\n`);
}
// ────────────────────────────────────────────────────────────────────────────
// Main entrypoint
// ────────────────────────────────────────────────────────────────────────────
async function main() {
    const { command, args } = parseArgs(process.argv);
    const cwd = process.cwd();
    switch (command) {
        case "init":
            runInit(cwd);
            break;
        case "login": {
            const key = args[0];
            if (!key) {
                process.stderr.write("Usage: suede login <workspace-key>\n");
                process.exit(1);
            }
            await runLogin(key, cwd);
            break;
        }
        case "push": {
            const config = readConfig(cwd);
            if (!config?.workspaceKey) {
                process.stderr.write("Not logged in. Run: suede login <workspace-key>\n");
                process.exit(1);
            }
            const result = await runPush(config, cwd);
            process.stdout.write(`Published: ${result.slug}\n` +
                `Live at: ${config.apiUrl}${result.url}\n`);
            break;
        }
        case "pull": {
            const slug = args[0];
            if (!slug) {
                process.stderr.write("Usage: suede pull <slug>\n");
                process.exit(1);
            }
            const config = readConfig(cwd);
            if (!config?.workspaceKey) {
                process.stderr.write("Not logged in. Run: suede login <workspace-key>\n");
                process.exit(1);
            }
            await runPull(slug, config, cwd);
            process.stdout.write(`Pulled: manifest.json + agent.ts written\n`);
            break;
        }
        case "versions": {
            const config = readConfig(cwd);
            if (!config?.workspaceKey) {
                process.stderr.write("Not logged in. Run: suede login <workspace-key>\n");
                process.exit(1);
            }
            process.stdout.write(await runVersionsCommand(args, config, cwd));
            break;
        }
        case "link": {
            const slugArg = args[0];
            if (!slugArg) {
                process.stderr.write("Usage: suede link <slug> --url <url>\n");
                process.exit(1);
            }
            const urlFlagIdx = args.indexOf("--url");
            const urlArg = urlFlagIdx !== -1 ? args[urlFlagIdx + 1] : undefined;
            if (!urlArg) {
                process.stderr.write("Usage: suede link <slug> --url <url>\n");
                process.exit(1);
            }
            const linkConfig = readConfig(cwd);
            if (!linkConfig?.workspaceKey) {
                process.stderr.write("Not logged in. Run: suede login <workspace-key>\n");
                process.exit(1);
            }
            const linkResult = await runLink(slugArg, urlArg, linkConfig);
            process.stdout.write(`Linked. Suede hosts the paid endpoint; your machine does the work. Keep this secret safe — it's shown once.\n\n` +
                `  SUEDE_RELAY_SECRET=${linkResult.secret}\n`);
            break;
        }
        case "dev":
            await runDev(cwd);
            break;
        case "whoami":
            runWhoami(cwd);
            break;
        default:
            process.stdout.write("suede — Suede Agent Studio CLI\n\n" +
                "Commands:\n" +
                "  suede init                          Scaffold a new agent project\n" +
                "  suede login <key>                   Save your workspace key\n" +
                "  suede push                          Push agent.ts to the platform\n" +
                "  suede pull <slug>                   Pull an agent from the platform\n" +
                "  suede versions list <flowId>        List immutable versions\n" +
                "  suede versions pull <flowId> <id>   Pull one immutable version locally\n" +
                "  suede versions inspect <flowId> <id> Inspect version hashes and pins\n" +
                "  suede versions export <flowId> <id> Export a self-hostable version bundle\n" +
                "  suede link <slug> --url <url>       Register a relay URL for a published agent\n" +
                "  suede dev                           Run agent locally on port 3001\n" +
                "  suede whoami                        Show current workspace info\n");
            break;
    }
}
// Run when this file is the entrypoint (not when imported as a module in tests)
const isMain = process.argv[1]?.endsWith("cli.js") || process.argv[1]?.endsWith("cli.ts");
if (isMain) {
    main().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
    });
}
//# sourceMappingURL=cli.js.map