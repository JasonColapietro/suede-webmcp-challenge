export declare const SUPPORTED_FLOW_SCHEMA_VERSION: 1;
export declare const VERSION_DEPENDENCY_KINDS: readonly ["agent", "connector", "flow", "skill", "template"];
export type VersionDependencyKind = (typeof VERSION_DEPENDENCY_KINDS)[number];
export interface PortableDependencyPin {
    readonly kind: VersionDependencyKind;
    readonly resourceId: string;
    readonly version: string;
    readonly contentHash?: string;
}
export interface FlowVersionSummary {
    readonly id: string;
    readonly flowId: string;
    readonly versionNumber: number;
    readonly schemaVersion: number;
    readonly label?: string;
    readonly description?: string;
    readonly semanticHash: string;
    readonly fullHash: string;
    readonly createdAt: number;
    readonly dependencyCount: number;
}
export interface FlowVersionRecord {
    readonly id: string;
    readonly flowId: string;
    readonly versionNumber: number;
    readonly schemaVersion: number;
    readonly label?: string;
    readonly description?: string;
    readonly graph: Readonly<Record<string, unknown>>;
    readonly semanticHash: string;
    readonly fullHash: string;
    readonly createdAt: number;
    readonly dependencies: readonly PortableDependencyPin[];
}
export interface VersionsEnvelope {
    readonly versions: readonly FlowVersionSummary[];
}
export interface VersionEnvelope {
    readonly version: FlowVersionRecord;
}
export interface VersionBundle {
    readonly bundleVersion: 1;
    readonly version: FlowVersionRecord;
}
export type VersionClientErrorKind = "http" | "network" | "protocol";
export declare class VersionClientError extends Error {
    readonly kind: VersionClientErrorKind;
    readonly status: number;
    constructor(kind: VersionClientErrorKind, status: number, message: string);
}
export declare class UnsupportedSchemaVersionError extends VersionClientError {
    readonly received: number;
    readonly supported: 1;
    constructor(received: number);
}
export interface VersionClientOptions {
    readonly apiUrl: string;
    readonly workspaceKey?: string;
    readonly fetch?: typeof fetch;
}
export interface VersionClient {
    listVersions(flowId: string): Promise<VersionsEnvelope>;
    getVersion(flowId: string, versionId: string): Promise<VersionEnvelope>;
}
export declare function createVersionClient(options: VersionClientOptions): VersionClient;
export declare function createVersionBundle(version: FlowVersionRecord): VersionBundle;
//# sourceMappingURL=version-client.d.ts.map