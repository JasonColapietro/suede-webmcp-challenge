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
export interface SuedeConfig {
    workspaceKey: string;
    apiUrl: string;
}
export interface ParsedArgs {
    command: string | undefined;
    args: string[];
}
export interface InitFile {
    name: string;
    content: string;
}
export interface PushOutput {
    slug: string;
    url: string;
}
export interface VersionWriteOptions {
    readonly out?: string;
    readonly force?: boolean;
}
export declare function readConfig(cwd?: string): SuedeConfig | null;
export declare function writeConfig(cwd: string, config: SuedeConfig): void;
export declare function parseArgs(argv: string[]): ParsedArgs;
export declare function extractBearer(authHeader: string | null): string | null;
export declare function buildInitFiles(apiUrl: string): InitFile[];
export declare function runPush(config: SuedeConfig, cwd: string): Promise<PushOutput>;
export declare function runPull(slug: string, config: SuedeConfig, cwd: string): Promise<void>;
export declare function runVersionsList(flowId: string, config: SuedeConfig): Promise<string>;
export declare function runVersionInspect(flowId: string, versionId: string, config: SuedeConfig): Promise<string>;
export declare function runVersionPull(flowId: string, versionId: string, config: SuedeConfig, cwd: string, options?: VersionWriteOptions): Promise<string>;
export declare function runVersionExport(flowId: string, versionId: string, config: SuedeConfig, cwd: string, options?: VersionWriteOptions): Promise<string>;
export declare function runVersionsCommand(args: readonly string[], config: SuedeConfig, cwd: string): Promise<string>;
export interface LinkOutput {
    secret: string;
    url: string;
}
export declare function runLink(slug: string, url: string, config: SuedeConfig): Promise<LinkOutput>;
//# sourceMappingURL=cli.d.ts.map