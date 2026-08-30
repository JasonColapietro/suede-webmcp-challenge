import { z } from "zod";
export const SUPPORTED_FLOW_SCHEMA_VERSION = 1;
export const VERSION_DEPENDENCY_KINDS = [
    "agent",
    "connector",
    "flow",
    "skill",
    "template",
];
export class VersionClientError extends Error {
    kind;
    status;
    constructor(kind, status, message) {
        super(message);
        this.name = "VersionClientError";
        this.kind = kind;
        this.status = status;
    }
}
export class UnsupportedSchemaVersionError extends VersionClientError {
    received;
    supported = SUPPORTED_FLOW_SCHEMA_VERSION;
    constructor(received) {
        super("protocol", 0, `Unsupported flow schema version ${received}; supported version is ${SUPPORTED_FLOW_SCHEMA_VERSION}`);
        this.name = "UnsupportedSchemaVersionError";
        this.received = received;
    }
}
const LowercaseSha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const OpaqueIdSchema = z.string().min(1);
const VersionSummaryWireSchema = z
    .object({
    id: OpaqueIdSchema,
    flowId: OpaqueIdSchema,
    versionNumber: z.number().int().positive(),
    schemaVersion: z.number().int().positive(),
    label: z.string().optional(),
    description: z.string().optional(),
    semanticHash: LowercaseSha256Schema,
    fullHash: LowercaseSha256Schema,
    createdBy: z.string().optional(),
    createdAt: z.number().finite(),
    dependencyCount: z.number().int().nonnegative(),
})
    .strict();
const DependencyPinWireSchema = z
    .object({
    id: z.string().optional(),
    flowVersionId: z.string().optional(),
    kind: z.enum(VERSION_DEPENDENCY_KINDS),
    resourceId: OpaqueIdSchema,
    version: OpaqueIdSchema,
    contentHash: z.string().min(1).optional(),
    createdAt: z.number().finite().optional(),
})
    .strict();
function compareDependencyPins(left, right) {
    const leftKey = JSON.stringify([left.kind, left.resourceId, left.version, left.contentHash ?? null]);
    const rightKey = JSON.stringify([
        right.kind,
        right.resourceId,
        right.version,
        right.contentHash ?? null,
    ]);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}
const DependencyPinsWireSchema = z
    .array(DependencyPinWireSchema)
    .max(1_000)
    .superRefine((dependencies, context) => {
    const seen = new Set();
    for (const dependency of dependencies) {
        const key = JSON.stringify([dependency.kind, dependency.resourceId]);
        if (seen.has(key)) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                message: "Duplicate dependency pin",
            });
        }
        seen.add(key);
    }
})
    .transform((dependencies) => [...dependencies].sort(compareDependencyPins));
const VersionRecordWireSchema = z
    .object({
    id: OpaqueIdSchema,
    flowId: OpaqueIdSchema,
    versionNumber: z.number().int().positive(),
    schemaVersion: z.number().int().positive(),
    label: z.string().optional(),
    description: z.string().optional(),
    graph: z.record(z.unknown()),
    semanticHash: LowercaseSha256Schema,
    fullHash: LowercaseSha256Schema,
    createdBy: z.string().optional(),
    createdAt: z.number().finite(),
    dependencies: DependencyPinsWireSchema,
})
    .strict();
const VersionsWireEnvelopeSchema = z
    .object({ versions: z.array(VersionSummaryWireSchema).max(1_000) })
    .strict();
const VersionWireEnvelopeSchema = z.object({ version: VersionRecordWireSchema }).strict();
function assertSupportedSchemaVersion(schemaVersion) {
    if (schemaVersion !== SUPPORTED_FLOW_SCHEMA_VERSION) {
        throw new UnsupportedSchemaVersionError(schemaVersion);
    }
}
function portableSummary(wire) {
    assertSupportedSchemaVersion(wire.schemaVersion);
    return {
        id: wire.id,
        flowId: wire.flowId,
        versionNumber: wire.versionNumber,
        schemaVersion: wire.schemaVersion,
        ...(wire.label === undefined ? {} : { label: wire.label }),
        ...(wire.description === undefined ? {} : { description: wire.description }),
        semanticHash: wire.semanticHash,
        fullHash: wire.fullHash,
        createdAt: wire.createdAt,
        dependencyCount: wire.dependencyCount,
    };
}
function portableVersion(wire) {
    assertSupportedSchemaVersion(wire.schemaVersion);
    return {
        id: wire.id,
        flowId: wire.flowId,
        versionNumber: wire.versionNumber,
        schemaVersion: wire.schemaVersion,
        ...(wire.label === undefined ? {} : { label: wire.label }),
        ...(wire.description === undefined ? {} : { description: wire.description }),
        graph: wire.graph,
        semanticHash: wire.semanticHash,
        fullHash: wire.fullHash,
        createdAt: wire.createdAt,
        dependencies: wire.dependencies.map(({ kind, resourceId, version, contentHash }) => ({
            kind,
            resourceId,
            version,
            ...(contentHash === undefined ? {} : { contentHash }),
        })),
    };
}
function requireOpaqueId(value, field) {
    if (value.trim().length === 0) {
        throw new VersionClientError("protocol", 0, `${field} is required`);
    }
    return value;
}
function responseError(response) {
    return new VersionClientError("http", response.status, `Version request failed with HTTP ${response.status}`);
}
async function readJson(response) {
    try {
        return await response.json();
    }
    catch {
        throw new VersionClientError("protocol", 0, "Version response was not valid JSON");
    }
}
function protocolError() {
    return new VersionClientError("protocol", 0, "Version response did not match its envelope");
}
function validatedApiOrigin(value) {
    if (value.trim() !== value || value.length === 0) {
        throw new VersionClientError("protocol", 0, "apiUrl must be an HTTP(S) origin");
    }
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new VersionClientError("protocol", 0, "apiUrl must be an HTTP(S) origin");
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") ||
        url.username !== "" ||
        url.password !== "" ||
        url.search !== "" ||
        url.hash !== "" ||
        url.pathname !== "/") {
        throw new VersionClientError("protocol", 0, "apiUrl must be an HTTP(S) origin without credentials, query, fragment, or base path");
    }
    return url.origin;
}
export function createVersionClient(options) {
    const apiUrl = validatedApiOrigin(options.apiUrl);
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
        throw new VersionClientError("protocol", 0, "Fetch is unavailable in this runtime");
    }
    const headers = { Accept: "application/json" };
    if (options.workspaceKey !== undefined &&
        (options.workspaceKey.length === 0 || /\s/.test(options.workspaceKey))) {
        throw new VersionClientError("protocol", 0, "workspaceKey must be nonempty and contain no whitespace");
    }
    if (options.workspaceKey !== undefined) {
        headers.Authorization = `Bearer ${options.workspaceKey}`;
    }
    async function get(path) {
        let response;
        try {
            response = await fetchImpl(`${apiUrl}${path}`, {
                method: "GET",
                redirect: "error",
                headers,
            });
        }
        catch {
            throw new VersionClientError("network", 0, "Version request could not reach the server");
        }
        if (!response.ok)
            throw responseError(response);
        return readJson(response);
    }
    return {
        async listVersions(flowId) {
            const normalizedFlowId = requireOpaqueId(flowId, "flowId");
            const body = await get(`/api/v2/flows/${encodeURIComponent(normalizedFlowId)}/versions`);
            const parsed = VersionsWireEnvelopeSchema.safeParse(body);
            if (!parsed.success)
                throw protocolError();
            return { versions: parsed.data.versions.map(portableSummary) };
        },
        async getVersion(flowId, versionId) {
            const normalizedFlowId = requireOpaqueId(flowId, "flowId");
            const normalizedVersionId = requireOpaqueId(versionId, "versionId");
            const body = await get(`/api/v2/flows/${encodeURIComponent(normalizedFlowId)}/versions/${encodeURIComponent(normalizedVersionId)}`);
            const parsed = VersionWireEnvelopeSchema.safeParse(body);
            if (!parsed.success)
                throw protocolError();
            return { version: portableVersion(parsed.data.version) };
        },
    };
}
export function createVersionBundle(version) {
    assertSupportedSchemaVersion(version.schemaVersion);
    return { bundleVersion: 1, version };
}
//# sourceMappingURL=version-client.js.map