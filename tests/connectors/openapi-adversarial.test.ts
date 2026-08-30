import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { compileOpenApi310, type OpenApiCompileFailureCode } from "@/lib/connectors/openapi/compile";
import { CONNECTOR_IMPORT_V1_LIMITS } from "@/lib/connectors/limits";

function documentWith(operation: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: { title: "Adversarial", version: "1" },
    servers: [{ url: "https://api.example.com" }],
    paths: {
      "/things/{id}": {
        get: {
          operationId: "getThing",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "204": { description: "ok" } },
          ...operation,
        },
      },
    },
  };
}

function refuse(value: unknown, code: OpenApiCompileFailureCode): void {
  expect(compileOpenApi310(typeof value === "string" ? value : JSON.stringify(value))).toEqual({ ok: false, code });
}

describe("bounded duplicate-key JSON parsing", () => {
  it("rejects exact and NFC-normalized duplicate keys", () => {
    refuse('{"openapi":"3.1.0","openapi":"3.1.0"}', "DUPLICATE_JSON_KEY");
    refuse('{"openapi":"3.1.0","é":1,"é":2}', "DUPLICATE_JSON_KEY");
  });

  it("rejects invalid UTF-8, syntax, and non-JSON input without echo", () => {
    expect(compileOpenApi310(new Uint8Array([0xc3, 0x28]))).toEqual({ ok: false, code: "INVALID_JSON" });
    refuse('{"secret":"CANARY",}', "INVALID_JSON");
  });

  it("applies input byte, JSON depth, container entry, and inspected-value ceilings", () => {
    const base = JSON.stringify(documentWith());
    expect(compileOpenApi310(base, { limits: { maxInputBytes: Buffer.byteLength(base) } }).ok).toBe(true);
    expect(compileOpenApi310(base, { limits: { maxInputBytes: Buffer.byteLength(base) - 1 } })).toEqual({ ok: false, code: "INPUT_BYTES_LIMIT" });

    const nested = '{"a":{"b":0}}';
    expect(compileOpenApi310(nested, { limits: { maxJsonDepth: 2 } })).not.toEqual({ ok: false, code: "JSON_DEPTH_LIMIT" });
    expect(compileOpenApi310(nested, { limits: { maxJsonDepth: 1 } })).toEqual({ ok: false, code: "JSON_DEPTH_LIMIT" });

    const entries = '{"a":1,"b":2}';
    expect(compileOpenApi310(entries, { limits: { maxContainerEntries: 2 } })).not.toEqual({ ok: false, code: "JSON_ENTRY_LIMIT" });
    expect(compileOpenApi310(entries, { limits: { maxContainerEntries: 1 } })).toEqual({ ok: false, code: "JSON_ENTRY_LIMIT" });

    expect(compileOpenApi310(entries, { limits: { maxInspectedValues: 3 } })).not.toEqual({ ok: false, code: "INSPECTED_VALUE_LIMIT" });
    expect(compileOpenApi310(entries, { limits: { maxInspectedValues: 2 } })).toEqual({ ok: false, code: "INSPECTED_VALUE_LIMIT" });
  });

  it("counts each parsed JSON value once so the normative entry ceiling is attainable", () => {
    const atLimit = `{${Array.from({ length: 50_000 }, (_, index) => `"k${index}":0`).join(",")}}`;
    expect(compileOpenApi310(atLimit)).not.toEqual({ ok: false, code: "INSPECTED_VALUE_LIMIT" });
    const overLimit = `{${Array.from({ length: 50_001 }, (_, index) => `"k${index}":0`).join(",")}}`;
    expect(compileOpenApi310(overLimit)).toEqual({ ok: false, code: "JSON_ENTRY_LIMIT" });
  });

  it("charges real semantic revisits and reaches 99,999/100,000/100,001 exactly", () => {
    let deep: any = { Target: { type: "string" } };
    for (let index = 0; index < 52; index += 1) deep = { next: deep };
    const pointer = `#/info/deep/${"next/".repeat(52)}Target`;
    const aliases = Object.fromEntries(Array.from({ length: 999 }, (_, index) => [
      `Alias${index}`,
      { "$ref": pointer },
    ]));
    const base: any = {
      ...documentWith(),
      info: { title: "Semantic boundary", version: "1", deep },
      components: {
        schemas: { ...aliases, Switch: { type: "string" } },
        parameters: { Baseline: { name: "baseline", in: "query", schema: { type: "string" } } },
      },
    };
    const minimumBudget = (input: string): number => {
      let low = 0;
      let high = 100_000;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        const result = compileOpenApi310(input, { limits: { maxInspectedValues: middle } });
        if (!result.ok && result.code === "INSPECTED_VALUE_LIMIT") low = middle + 1;
        else high = middle;
      }
      return low;
    };
    const baseMinimum = minimumBudget(JSON.stringify(base));
    expect(baseMinimum).toBeGreaterThan(50_000);
    expect(baseMinimum).toBeLessThan(100_000);
    const padding = 100_000 - baseMinimum;
    expect(padding).toBeGreaterThan(3);
    base.info.padding = Array.from({ length: padding - 2 }, () => 0);
    expect(compileOpenApi310(JSON.stringify(base), { limits: { maxInspectedValues: 99_999 } }).ok).toBe(true);

    base.info.padding.push(0);
    const atLimit = JSON.stringify(base);
    expect(compileOpenApi310(atLimit, { limits: { maxInspectedValues: 99_999 } }))
      .toEqual({ ok: false, code: "INSPECTED_VALUE_LIMIT" });
    expect(compileOpenApi310(atLimit, { limits: { maxInspectedValues: 100_000 } }).ok).toBe(true);
    expect(compileOpenApi310(atLimit).ok).toBe(true);

    const overLimit = JSON.parse(atLimit);
    delete overLimit.components.schemas.Switch;
    overLimit.components.parameters.Switch = { name: "switch", in: "query", schema: { type: "string" } };
    overLimit.info.padding.splice(-3);
    expect(compileOpenApi310(JSON.stringify(overLimit), { limits: { maxInspectedValues: 100_000 } }))
      .toEqual({ ok: false, code: "INSPECTED_VALUE_LIMIT" });
  });

  it("preflights string UTF-8 bytes and refuses lone UTF-16 surrogates", () => {
    const exact = '"é"';
    expect(compileOpenApi310(exact, { limits: { maxInputBytes: 4 } })).not.toEqual({ ok: false, code: "INPUT_BYTES_LIMIT" });
    expect(compileOpenApi310(exact, { limits: { maxInputBytes: 3 } })).toEqual({ ok: false, code: "INPUT_BYTES_LIMIT" });
    expect(compileOpenApi310(`{"x":"${String.fromCharCode(0xd800)}"}`)).toEqual({ ok: false, code: "INVALID_JSON" });
  });
});

describe("projection limits and fail-closed OpenAPI behavior", () => {
  it("refuses a root jsonSchemaDialect declaration", () => {
    refuse({ ...documentWith(), jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema" }, "UNSUPPORTED_OPENAPI_KEYWORD");
  });
  it("enforces operation and parameter ceilings at limit and limit+1", () => {
    const operations = Object.fromEntries(Array.from({ length: 3 }, (_, index) => [`/p${index}`, {
      get: { operationId: `op${index}`, responses: { "204": { description: "ok" } } },
    }]));
    expect(compileOpenApi310(JSON.stringify({ ...documentWith(), paths: operations }), { limits: { maxOperations: 3 } }).ok).toBe(true);
    expect(compileOpenApi310(JSON.stringify({ ...documentWith(), paths: operations }), { limits: { maxOperations: 2 } }))
      .toEqual({ ok: false, code: "OPERATION_LIMIT" });

    const parameters = [
      { name: "id", in: "path", required: true, schema: { type: "string" } },
      ...Array.from({ length: 2 }, (_, index) => ({ name: `q${index}`, in: "query", schema: { type: "string" } })),
    ];
    const doc = documentWith({ parameters });
    expect(compileOpenApi310(JSON.stringify(doc), { limits: { maxParametersPerOperation: 3 } }).ok).toBe(true);
    expect(compileOpenApi310(JSON.stringify(doc), { limits: { maxParametersPerOperation: 2 } }))
      .toEqual({ ok: false, code: "PARAMETER_LIMIT" });

    const inherited = documentWith() as any;
    inherited.paths["/things/{id}"].parameters = [
      { name: "id", in: "path", required: true, schema: { type: "string" } },
    ];
    inherited.paths["/things/{id}"].get.parameters = [
      { name: "id", in: "path", required: true, schema: { type: "string" } },
    ];
    expect(compileOpenApi310(JSON.stringify(inherited), { limits: { maxParametersPerOperation: 1 } }))
      .toEqual({ ok: false, code: "PARAMETER_LIMIT" });
  });

  it("enforces schema depth and local-reference expansion ceilings", () => {
    const schema = { type: "array", items: { type: "array", items: { type: "string" } } };
    const doc = documentWith({ requestBody: { content: { "application/json": { schema } } } });
    expect(compileOpenApi310(JSON.stringify(doc), { limits: { maxSchemaDepth: 2 } }).ok).toBe(true);
    expect(compileOpenApi310(JSON.stringify(doc), { limits: { maxSchemaDepth: 1 } }))
      .toEqual({ ok: false, code: "SCHEMA_DEPTH_LIMIT" });

    const refs = documentWith({ requestBody: { content: { "application/json": { schema: { "$ref": "#/components/schemas/A" } } } } }) as any;
    refs.components = { schemas: { A: { "$ref": "#/components/schemas/B" }, B: { type: "string" } } };
    expect(compileOpenApi310(JSON.stringify(refs), { limits: { maxLocalReferenceExpansions: 3 } }).ok).toBe(true);
    expect(compileOpenApi310(JSON.stringify(refs), { limits: { maxLocalReferenceExpansions: 2 } }))
      .toEqual({ ok: false, code: "LOCAL_REFERENCE_LIMIT" });
  });

  it("enforces deadline, cancellation, and canonical projection byte ceilings", () => {
    expect(compileOpenApi310(JSON.stringify(documentWith()), { limits: { compilerDeadlineMs: 0 } }))
      .toEqual({ ok: false, code: "COMPILER_DEADLINE" });
    const controller = new AbortController();
    controller.abort();
    expect(compileOpenApi310(JSON.stringify(documentWith()), { signal: controller.signal }))
      .toEqual({ ok: false, code: "IMPORT_CANCELLED" });
    expect(compileOpenApi310(JSON.stringify(documentWith()), { limits: { maxCanonicalProjectionBytes: 128 } }))
      .toEqual({ ok: false, code: "CANONICAL_PROJECTION_LIMIT" });
  });

  it.each([
    "http://api.example.com",
    "https://user:pass@api.example.com",
    "https://api.example.com?secret=x",
    "https://api.example.com/#fragment",
    "https://api.example.com:8443",
    "https://api.example.com:0443",
    "https://%61pi.example.com",
    "https://localhost",
    "https://127.0.0.1",
    "https://0177.0.0.1",
    "https://[::1]",
    "https://münich.example",
    "https://xn--mnich-kva.example",
    "https://service.local",
    "https://service.internal",
    "https://service.corp",
    "https://service.localdomain",
  ])("rejects unsafe or ambiguous origin %s", (url) => {
    refuse({ ...documentWith(), servers: [{ url }] }, "SERVER_ORIGIN_REFUSED");
  });

  it("rejects remote and cyclic refs", () => {
    const remote = documentWith({ requestBody: { content: { "application/json": { schema: { "$ref": "https://example.com/schema" } } } } });
    refuse(remote, "REMOTE_REFERENCE_REFUSED");
    const cycle = documentWith({ requestBody: { content: { "application/json": { schema: { "$ref": "#/components/schemas/A" } } } } }) as any;
    cycle.components = { schemas: { A: { "$ref": "#/components/schemas/B" }, B: { "$ref": "#/components/schemas/A" } } };
    refuse(cycle, "REFERENCE_CYCLE_REFUSED");
  });

  it("implements JSON Pointer escaping and rejects missing or malformed local pointers", () => {
    const valid = documentWith({ requestBody: { content: { "application/json": { schema: { "$ref": "#/components/schemas/a~1b" } } } } }) as any;
    valid.components = { schemas: { "a/b": { type: "string" } } };
    expect(compileOpenApi310(JSON.stringify(valid)).ok).toBe(true);
    const missing = structuredClone(valid);
    missing.paths["/things/{id}"].get.requestBody.content["application/json"].schema.$ref = "#/components/schemas/missing";
    refuse(missing, "REFERENCE_POINTER_REFUSED");
    const malformed = structuredClone(valid);
    malformed.paths["/things/{id}"].get.requestBody.content["application/json"].schema.$ref = "#/components/schemas/a~2b";
    refuse(malformed, "REFERENCE_POINTER_REFUSED");

    const encodedSeparator = documentWith({ requestBody: { content: { "application/json": { schema: { "$ref": "#/components/schemas/Group%2Fproperties%2Fitem" } } } } }) as any;
    encodedSeparator.components = { schemas: { Group: {
      type: "object", properties: { item: { type: "string" } }, required: ["item"], additionalProperties: false,
    } } };
    expect(compileOpenApi310(JSON.stringify(encodedSeparator)).ok).toBe(true);
  });

  it.each([
    [{ security: [{ A: [], B: [] }], components: { securitySchemes: { A: { type: "http", scheme: "bearer" }, B: { type: "http", scheme: "basic" } } } }, "SECURITY_REFUSED"],
    [{ security: [{ A: [] }, {}], components: { securitySchemes: { A: { type: "http", scheme: "bearer" } } } }, "SECURITY_REFUSED"],
    [{ security: [{ A: [] }], components: { securitySchemes: { A: { type: "oauth2", flows: {} } } } }, "SECURITY_REFUSED"],
  ] as const)("rejects unsupported security semantics", (patch, code) => {
    refuse({ ...documentWith(), ...patch }, code);
  });

  it("treats only absent or empty security arrays as no-auth", () => {
    expect(compileOpenApi310(JSON.stringify(documentWith())).ok).toBe(true);
    expect(compileOpenApi310(JSON.stringify(documentWith({ security: [] }))).ok).toBe(true);
    refuse(documentWith({ security: [{}] }), "SECURITY_REFUSED");
  });

  it("rejects 2XX wildcard response selection alone or beside a literal", () => {
    refuse(documentWith({ responses: { "2XX": { description: "wildcard" } } }), "RESPONSE_SELECTION_REFUSED");
    refuse(documentWith({ responses: {
      "200": { description: "ok", content: { "application/json": { schema: { type: "string" } } } },
      "2XX": { description: "wildcard" },
    } }), "RESPONSE_SELECTION_REFUSED");
  });

  it.each(["Authorization", "Content-Length", "Content-MD5", "Accept-Patch", "X-Forwarded-Port", "Host", "X-Api-Key"])("rejects reserved/auth header collision %s", (name) => {
    const doc = documentWith({
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        { name, in: "header", schema: { type: "string" } },
      ],
      security: name === "X-Api-Key" ? [{ Key: [] }] : undefined,
    }) as any;
    if (name === "X-Api-Key") doc.components = { securitySchemes: { Key: { type: "apiKey", in: "header", name } } };
    refuse(doc, "HEADER_OWNERSHIP_REFUSED");
  });

  it("rejects bad parameter serialization and unknown fixture ingress", () => {
    refuse(documentWith({ parameters: [{ name: "q", in: "query", style: "deepObject", schema: { type: "string" } }] }), "PARAMETER_SERIALIZATION_REFUSED");
    refuse(documentWith({ parameters: [{ name: "other", in: "path", required: true, schema: { type: "string" } }] }), "PARAMETER_REFUSED");
    refuse({ ...documentWith(), fixture: { output: "CANARY" } }, "UNSUPPORTED_FIXTURE_INPUT");
    refuse(documentWith({ fixture: { output: "CANARY" } }), "UNSUPPORTED_FIXTURE_INPUT");
  });

  it.each(["/bad?query", "/bad#fragment", "/bad\\path"])("rejects unsafe OpenAPI path syntax %s", (path) => {
    const doc = documentWith() as any;
    doc.paths = { [path]: { get: { operationId: "badPath", responses: { "204": { description: "ok" } } } } };
    refuse(doc, "OPENAPI_STRUCTURE_REFUSED");
  });

  it.each(["enum", "const", "oneOf", "pattern"])("rejects unsupported schema keyword %s", (keyword) => {
    refuse(documentWith({ requestBody: { content: { "application/json": { schema: { type: "string", [keyword]: keyword === "oneOf" ? [] : "x" } } } } }), "SCHEMA_KEYWORD_REFUSED");
  });

  it("rejects unsupported formats and unsatisfiable schema bounds", () => {
    refuse(documentWith({ requestBody: { content: { "application/json": { schema: { type: "string", format: "password" } } } } }), "SCHEMA_FORMAT_REFUSED");
    refuse(documentWith({ requestBody: { content: { "application/json": { schema: { type: "integer", minimum: 1.2, maximum: 1.8 } } } } }), "SCHEMA_UNSATISFIABLE");
  });

  it("refuses when complete request and result sentinels exceed the aggregate bound", () => {
    const doc = documentWith({
      requestBody: {
        required: true,
        content: { "application/json": { schema: { type: "string", minLength: 140_000 } } },
      },
      responses: {
        "200": {
          description: "ok",
          content: { "application/json": { schema: { type: "string", minLength: 140_000 } } },
        },
      },
    });
    refuse(doc, "SCHEMA_UNSATISFIABLE");
  });

  it("rejects callbacks, response links, and unsupported request media", () => {
    refuse(documentWith({ callbacks: {} }), "CALLBACK_REFUSED");
    refuse(documentWith({ responses: { "200": { description: "ok", links: {}, content: { "application/json": { schema: { type: "string" } } } } } }), "LINK_REFUSED");
    refuse(documentWith({ requestBody: { content: { "application/octet-stream": { schema: { type: "string" } } } } }), "REQUEST_BODY_REFUSED");
  });

  it("does not call fetch or browser network seams", () => {
    const fetchSpy = vi.fn(() => { throw new Error("network called"); });
    vi.stubGlobal("fetch", fetchSpy);
    expect(compileOpenApi310(JSON.stringify(documentWith())).ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("has a statically capability-minimized import graph", () => {
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const pending = [resolve(repo, "src/lib/connectors/openapi/compile.ts")];
    const visited = new Set<string>();
    const specifiers: string[] = [];
    const literalDependency = /(?:\bimport\s+(?:[^"']*?\s+from\s+)?|\bexport\s+[^"']*?\s+from\s+|\bimport\s*\(|\brequire\s*\()\s*["']([^"']+)["']/gu;
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      const moduleSource = readFileSync(file, "utf8");
      for (const match of moduleSource.matchAll(literalDependency)) {
        const specifier = match[1]!;
        specifiers.push(specifier);
        if (!specifier.startsWith(".") && !specifier.startsWith("@/")) continue;
        const base = specifier.startsWith("@/") ? resolve(repo, "src", specifier.slice(2)) : resolve(dirname(file), specifier);
        const target = [base, `${base}.ts`, `${base}.tsx`, resolve(base, "index.ts")].find(existsSync);
        expect(target, `unresolved dependency ${specifier} from ${file}`).toBeTruthy();
        pending.push(target!);
      }
      const calls = [...moduleSource.matchAll(/\b(?:import|require)\s*\(/gu)].length;
      const literalCalls = [...moduleSource.matchAll(/\b(?:import|require)\s*\(\s*["']/gu)].length;
      expect(calls, `computed dependency in ${file}`).toBe(literalCalls);
    }
    expect(visited.size).toBeGreaterThan(4);
    expect(specifiers.join("\n")).not.toMatch(/^(?:node:)?(?:dns(?:\/promises)?|http|https|net|tls|child_process)$|(?:^|\/)(?:safe-url|provider|model|payment)(?:\.|\/|$)/imu);
  });

  it("completes with hostile runtime transport and provider sentinels untouched", async () => {
    const sentinels = Object.fromEntries(["dns", "http", "https", "net", "tls", "child", "provider", "model", "payment"]
      .map((name) => [name, vi.fn(() => { throw new Error(`${name} called`); })]));
    vi.stubGlobal("fetch", sentinels.http);
    vi.stubGlobal("WebSocket", sentinels.net);
    vi.resetModules();
    vi.doMock("node:dns", () => ({ lookup: sentinels.dns, resolve: sentinels.dns }));
    vi.doMock("node:http", () => ({ request: sentinels.http, get: sentinels.http }));
    vi.doMock("node:https", () => ({ request: sentinels.https, get: sentinels.https }));
    vi.doMock("node:net", () => ({ connect: sentinels.net, createConnection: sentinels.net }));
    vi.doMock("node:tls", () => ({ connect: sentinels.tls }));
    vi.doMock("node:child_process", () => ({ exec: sentinels.child, execFile: sentinels.child, spawn: sentinels.child }));
    vi.doMock("@/lib/runtime/provider", () => ({ createProvider: sentinels.provider }));
    vi.doMock("@/lib/flow/nodes/llm", () => ({ run: sentinels.model }));
    vi.doMock("@/lib/rails/x402-client", () => ({ settle: sentinels.payment }));
    const module = await import("@/lib/connectors/openapi/compile");
    expect(module.compileOpenApi310(JSON.stringify(documentWith())).ok).toBe(true);
    expect(Object.values(sentinels).every((sentinel) => sentinel.mock.calls.length === 0)).toBe(true);
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("validates unsupported component categories and malformed shapes globally", () => {
    refuse({ ...documentWith(), components: { callbacks: {} } }, "UNSUPPORTED_OPENAPI_KEYWORD");
    refuse({ ...documentWith(), components: { schemas: [] } }, "OPENAPI_STRUCTURE_REFUSED");
    refuse({ ...documentWith(), components: { securitySchemes: { Unused: { type: "oauth2", flows: {} } } } }, "SECURITY_REFUSED");
    refuse({ ...documentWith(), components: { schemas: { Unused: { type: "string", oneOf: [] } } } }, "SCHEMA_KEYWORD_REFUSED");
    refuse({ ...documentWith(), components: { parameters: { Unused: { name: "q", in: "query" } } } }, "PARAMETER_REFUSED");
    refuse({ ...documentWith(), components: { requestBodies: { Unused: { content: {} } } } }, "REQUEST_BODY_REFUSED");
    refuse({ ...documentWith(), components: { responses: { Unused: { links: {} } } } }, "LINK_REFUSED");
  });

  it("does not permit limit overrides above the normative profile", () => {
    expect(() => compileOpenApi310(JSON.stringify(documentWith()), {
      limits: { maxOperations: CONNECTOR_IMPORT_V1_LIMITS.maxOperations + 1 },
    })).not.toThrow();
    expect(compileOpenApi310(JSON.stringify(documentWith()), {
      limits: { maxOperations: CONNECTOR_IMPORT_V1_LIMITS.maxOperations + 1 },
    })).toEqual({ ok: false, code: "INVALID_LIMIT_PROFILE" });
  });
});
