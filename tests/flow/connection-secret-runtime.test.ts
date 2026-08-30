import { describe, expect, it, vi } from "vitest";
import type { ConnectionRepository } from "@/lib/connections/repository";
import {
  CONNECTION_SECRET_RESOLUTION_ERROR,
  createConnectionSecretResolver,
} from "@/lib/connections/runtime-resolver";
import {
  createNodeExecutionProvenance,
  executeSelectedNode,
  listProvenanceSecretKeys,
  readProvenanceSecret,
  selectNodeDispatch,
  type NodeDef,
  type NodeExecutionProvenance,
} from "@/lib/flow/executor";
import type { FlowGraphV2 } from "@/lib/flow/types";
import { resolveNodeBindings } from "@/lib/flow/value-bindings";
import { makeCtx } from "../_helpers";

function repositoryWith(
  resolveHeaders: ConnectionRepository["resolveHeaders"],
): ConnectionRepository {
  return { resolveHeaders } as ConnectionRepository;
}

function fixedFailure(error: unknown, canaries: readonly string[] = []): void {
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(CONNECTION_SECRET_RESOLUTION_ERROR);
  for (const canary of canaries) expect((error as Error).message).not.toContain(canary);
}

describe("semantic connection runtime resolver", () => {
  it.each([
    ["api_key", { "X-Api-Key": "key{{literal}}" }],
    ["bearer", { Authorization: "Bearer token{{literal}}" }],
    ["basic", { Authorization: "Basic YWxhZGRpbjpvcGVuIHNlc2FtZQ==" }],
    ["custom_headers", { "X-Signature": "sig{{literal}}", "X-Tenant": "tenant" }],
  ] as const)("returns exact frozen %s headers without merging or interpolation", async (_kind, headers) => {
    const mutable = { ...headers } as Record<string, string>;
    const resolveHeaders = vi.fn(async () => mutable);
    const resolver = createConnectionSecretResolver({
      ownerId: "owner-a",
      environment: "live",
      repository: repositoryWith(resolveHeaders),
    });

    const resolved = await resolver({ connectionId: "connection-a", field: "headers" });

    expect(resolveHeaders).toHaveBeenCalledWith("owner-a", "connection-a", "live", "headers");
    expect(resolved).toEqual(headers);
    expect(resolved).not.toBe(mutable);
    expect(Object.getPrototypeOf(resolved)).toBeNull();
    expect(Object.isFrozen(resolved)).toBe(true);
    mutable[Object.keys(mutable)[0]!] = "changed";
    expect(resolved).toEqual(headers);
  });

  it("projects custom-header storage into bounded webhook material only for the webhook field", async () => {
    const resolveHeaders = vi.fn(async () => ({
      Authorization: "Bearer crm-token",
      "X-Suede-Webhook-Url": "https://hooks.example.com/incoming",
      "X-Ignored": "not-forwarded",
    }));
    const resolver = createConnectionSecretResolver({
      ownerId: "owner-a",
      environment: "live",
      repository: repositoryWith(resolveHeaders),
    });

    await expect(resolver({ connectionId: "connection-a", field: "webhook" })).resolves.toEqual({
      Authorization: "Bearer crm-token",
      "X-Suede-Webhook-Url": "https://hooks.example.com/incoming",
    });
    expect(resolveHeaders).toHaveBeenCalledWith("owner-a", "connection-a", "live", "headers");

    const unsafe = createConnectionSecretResolver({
      ownerId: "owner-a",
      environment: "live",
      repository: repositoryWith(async () => ({
        "X-Suede-Webhook-Url": "http://localhost/private",
      })),
    });
    await expect(unsafe({ connectionId: "connection-a", field: "webhook" }))
      .rejects.toThrow(CONNECTION_SECRET_RESOLUTION_ERROR);
  });

  it("refuses unsupported fields and untrusted constructor environments before repository access", async () => {
    const resolveHeaders = vi.fn(async () => ({ Authorization: "Bearer private" }));
    const repository = repositoryWith(resolveHeaders);
    const wrongField = createConnectionSecretResolver({
      ownerId: "owner-a",
      environment: "live",
      repository,
    });
    await expect(wrongField({ connectionId: "connection-a", field: "token" }))
      .rejects.toThrow(CONNECTION_SECRET_RESOLUTION_ERROR);

    const wrongEnvironment = createConnectionSecretResolver({
      ownerId: "owner-a",
      environment: "preview" as never,
      repository,
    });
    await expect(wrongEnvironment({ connectionId: "connection-a", field: "headers" }))
      .rejects.toThrow(CONNECTION_SECRET_RESOLUTION_ERROR);
    expect(resolveHeaders).not.toHaveBeenCalled();
  });

  it("captures owner, environment, repository method, and method receiver exactly once", async () => {
    const attacker = vi.fn(async () => ({ Authorization: "Bearer attacker" }));
    const repository = {
      marker: "stable-receiver",
      resolveHeaders: vi.fn(function (
        this: { marker: string },
        ownerId: string,
        connectionId: string,
        environment: "test" | "live",
        field: "headers",
      ) {
        expect(this.marker).toBe("stable-receiver");
        return Promise.resolve({ Authorization: `Bearer ${ownerId}:${connectionId}:${environment}:${field}` });
      }),
    } as unknown as ConnectionRepository & { marker: string };
    const options = {
      ownerId: "owner-original",
      environment: "live" as const,
      repository,
    };
    const resolver = createConnectionSecretResolver(options);

    (options as { ownerId: string }).ownerId = "owner-attacker";
    (options as { environment: string }).environment = "test";
    (options as { repository: ConnectionRepository }).repository = repositoryWith(attacker);
    repository.resolveHeaders = attacker;

    await expect(resolver({ connectionId: "connection-a", field: "headers" })).resolves.toEqual({
      Authorization: "Bearer owner-original:connection-a:live:headers",
    });
    expect(attacker).not.toHaveBeenCalled();
  });

  it("never invokes constructor accessors and does not reread a validated options proxy", async () => {
    const resolveHeaders = vi.fn(async () => ({ Authorization: "Bearer stable" }));
    const repository = repositoryWith(resolveHeaders);
    const optionGetter = vi.fn(() => "owner-accessor");
    const accessorOptions = {
      get ownerId() { return optionGetter(); },
      environment: "live",
      repository,
    } as unknown as Parameters<typeof createConnectionSecretResolver>[0];
    const refused = createConnectionSecretResolver(accessorOptions);
    await expect(refused({ connectionId: "connection-a", field: "headers" }))
      .rejects.toThrow(CONNECTION_SECRET_RESOLUTION_ERROR);
    expect(optionGetter).not.toHaveBeenCalled();
    expect(resolveHeaders).not.toHaveBeenCalled();

    let constructionComplete = false;
    const target = { ownerId: "owner-proxy", environment: "test" as const, repository };
    const proxied = new Proxy(target, {
      get(targetValue, property, receiver) {
        if (constructionComplete) throw new Error("options reread after construction");
        return Reflect.get(targetValue, property, receiver);
      },
      getOwnPropertyDescriptor(targetValue, property) {
        return Reflect.getOwnPropertyDescriptor(targetValue, property);
      },
      getPrototypeOf(targetValue) {
        return Reflect.getPrototypeOf(targetValue);
      },
      ownKeys(targetValue) {
        return Reflect.ownKeys(targetValue);
      },
    });
    const stable = createConnectionSecretResolver(proxied);
    constructionComplete = true;
    await expect(stable({ connectionId: "connection-a", field: "headers" })).resolves.toEqual({
      Authorization: "Bearer stable",
    });
    expect(resolveHeaders).toHaveBeenCalledWith("owner-proxy", "connection-a", "test", "headers");
  });

  it("rejects repository method accessors without invoking or rereading them", async () => {
    const methodGetter = vi.fn(() => vi.fn(async () => ({ Authorization: "Bearer accessor" })));
    const repository = Object.create(null) as ConnectionRepository;
    Object.defineProperty(repository, "resolveHeaders", {
      enumerable: true,
      get: () => methodGetter(),
    });
    const resolver = createConnectionSecretResolver({
      ownerId: "owner-a",
      environment: "live",
      repository,
    });

    await expect(resolver({ connectionId: "connection-a", field: "headers" }))
      .rejects.toThrow(CONNECTION_SECRET_RESOLUTION_ERROR);
    expect(methodGetter).not.toHaveBeenCalled();
  });

  it("uses one fixed label-only failure for missing, thrown, and malformed repository results", async () => {
    const owner = "owner-canary";
    const environment = "live";
    const connection = "connection-canary";
    const secret = "secret-canary";
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "Authorization", {
      enumerable: true,
      get: () => `Bearer ${secret}`,
    });
    const symbol = { Authorization: `Bearer ${secret}` } as Record<PropertyKey, unknown>;
    symbol[Symbol("secret")] = secret;
    const outcomes: readonly unknown[] = [
      null,
      [],
      { Authorization: 7 },
      accessor,
      symbol,
      Object.assign(Object.create({ inherited: secret }), { Authorization: `Bearer ${secret}` }),
    ];

    for (const outcome of outcomes) {
      const resolver = createConnectionSecretResolver({
        ownerId: owner,
        environment,
        repository: repositoryWith(async () => outcome as never),
      });
      try {
        await resolver({ connectionId: connection, field: "headers" });
        throw new Error("expected resolver failure");
      } catch (error) {
        fixedFailure(error, [owner, environment, connection, secret]);
      }
    }

    const resolver = createConnectionSecretResolver({
      ownerId: owner,
      environment,
      repository: repositoryWith(async () => { throw new Error(secret); }),
    });
    await expect(resolver({ connectionId: connection, field: "headers" }))
      .rejects.toThrow(CONNECTION_SECRET_RESOLUTION_ERROR);
  });

  it("enters execution only through trusted provenance and cannot be forged or serialized", async () => {
    const secret = "Bearer provenance-secret-canary";
    const resolver = createConnectionSecretResolver({
      ownerId: "owner-a",
      environment: "test",
      repository: repositoryWith(async () => ({ Authorization: secret })),
    });
    const graph: FlowGraphV2 = {
      schemaVersion: 2,
      id: "connection-runtime",
      name: "Connection runtime",
      nodes: [{
        id: "request",
        type: "http",
        params: { headers: { "X-Static": "static" } },
        bindings: {
          headers: { kind: "secret", connectionId: "connection-a", field: "headers" },
        },
        position: { x: 0, y: 0 },
      }],
      edges: [],
      variables: [],
      groups: [],
      annotations: [],
    };
    const resolved = await resolveNodeBindings(graph.nodes[0]!, {
      graph,
      outputs: new Map(),
      runVariables: {},
      resolveSecretReference: resolver,
    });

    expect(resolved.values).toEqual({});
    expect(resolved.secretBindingValues).toEqual({
      headers: { Authorization: secret },
    });
    expect(Object.hasOwn(graph.nodes[0]!.params, "Authorization")).toBe(false);

    const provenance = createNodeExecutionProvenance(resolved.secretBindingValues);
    const inspect = vi.fn(async (_ctx, params, _inputs, authority) => ({
      ok: true as const,
      outputs: {
        result: {
          params,
          keys: listProvenanceSecretKeys(authority),
          headers: readProvenanceSecret(authority, "headers"),
        },
      },
      costUsdc: 0,
    }));
    const definition: NodeDef = {
      type: "http",
      label: "HTTP",
      group: "Logic",
      costBearing: false,
      paramsSchema: { parse: (value: unknown) => value } as never,
      inputs: [],
      outputs: ["result"],
      executor: inspect,
    };
    const context = makeCtx({ dryRun: false });
    const result = await executeSelectedNode(
      selectNodeDispatch(definition, context),
      context,
      { params: graph.nodes[0]!.params, provenance },
      {},
    );

    expect(result).toMatchObject({
      outputs: {
        result: {
          params: { headers: { "X-Static": "static" } },
          keys: ["headers"],
          headers: { Authorization: secret },
        },
      },
    });
    expect(JSON.stringify(provenance)).toBe("{}");
    expect(JSON.stringify({ provenance })).not.toContain(secret);
    const forged = { headers: { Authorization: secret } } as NodeExecutionProvenance;
    expect(listProvenanceSecretKeys(forged)).toEqual([]);
    expect(readProvenanceSecret(forged, "headers")).toBeUndefined();
  });

  it("does not log repository failures or expose protected labels", async () => {
    const canary = "never-log-runtime-secret";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const resolver = createConnectionSecretResolver({
        ownerId: `owner-${canary}`,
        environment: "live",
        repository: repositoryWith(async () => { throw new Error(canary); }),
      });
      try {
        await resolver({ connectionId: `connection-${canary}`, field: "headers" });
        throw new Error("expected resolver failure");
      } catch (error) {
        fixedFailure(error, [canary]);
      }
      expect(errorSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
