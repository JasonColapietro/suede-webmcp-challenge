/**
 * Regression guard for the structural dry-run gate.
 *
 * Context: an earlier fix introduced `withDryRunGuard` / `isCostBearingNode`
 * (executor.ts) as the mechanism to stop a dry run from ever making a real
 * paid or external call, but it was applied per-module, at NodeDef
 * construction time, inside each node's own file. That made gating an
 * opt-in convention every node author had to remember — and one node
 * (http.ts, a generic "fetch any URL" node) shipped without it, so a caller
 * could force `ctx.dryRun: true` (?dryRun=1, x-suede-dry-run, or a body
 * flag) and still trigger a real outbound HTTP request, including a
 * POST/PUT/DELETE against a third party.
 *
 * The fix (see engine.ts's `executeNode` and the `dryRunStub` /
 * `sideEffecting` fields on NodeDef in executor.ts) moves enforcement to
 * the single place that actually turns a NodeDef into a NodeResult. This
 * test enumerates every registered NodeDef and asserts each one is either:
 *   (a) genuinely free/pure — `requiresDryRunStub` is false, and its real
 *       executor runs even in a dry run (a dry run must still traverse the
 *       graph to be useful), or
 *   (b) provably stubbed — `requiresDryRunStub` is true AND it declares a
 *       `dryRunStub`, AND `executeNode` never invokes its real executor
 *       while ctx.dryRun is true.
 *
 * A newly added node type that is cost-bearing or side-effecting (the
 * deny-by-default classification in `isCostBearingNode` treats anything
 * not explicitly marked free as unsafe) but forgets to declare a
 * `dryRunStub` fails case (b) here — this is the exact shape of bug this
 * file exists to catch before it reaches a published agent.
 */
import { describe, it, expect, vi } from "vitest";
import { NODE_DEFS } from "@/lib/flow/nodes";
import {
  createNodeExecutionProvenance,
  executeSelectedNode,
  listProvenanceSecretKeys,
  readProvenanceSecret,
  requiresDryRunStub,
  selectNodeDispatch,
  type NodeDef,
  type NodeExecutionProvenance,
  type NodeResult,
  type ResolvedNodeExecutionParams,
} from "@/lib/flow/executor";
import { makeCtx } from "../_helpers";

const OK_RESULT: NodeResult = { ok: true, outputs: {}, costUsdc: 0 };

describe("dry-run enumeration — every registered node is provably safe in a dry run", () => {
  for (const def of NODE_DEFS) {
    const guarded = requiresDryRunStub(def);

    it(`"${def.type}" — ${guarded ? "cost-bearing/side-effecting: must declare a dryRunStub and never run its real executor in dry-run" : "free/pure: must still run its real executor in dry-run"}`, async () => {
      const execSpy = vi.fn(async (): Promise<NodeResult> => OK_RESULT);
      // Also spy the stub (if any) so we never exercise a node's real
      // internal logic/schema requirements here — this test only checks
      // the DISPATCH decision, not what a stub or executor computes.
      const stubSpy = def.dryRunStub
        ? vi.fn(async (): Promise<NodeResult> => OK_RESULT)
        : undefined;
      const testDef: NodeDef = {
        ...def,
        executor: execSpy,
        ...(stubSpy ? { dryRunStub: stubSpy } : {}),
      };

      const ctx = makeCtx({ dryRun: true });
      const selection = selectNodeDispatch(testDef, ctx);
      const result = await executeSelectedNode(
        selection,
        ctx,
        { params: {}, provenance: createNodeExecutionProvenance({}) },
        {},
      );

      expect(def.definition.testMode === "native", def.type).toBe(!guarded);
      if (def.definition.testMode === "stub") {
        expect(def.dryRunStub, def.type).toBeTypeOf("function");
      }
      if (def.definition.testMode === "refuse") {
        expect(selection.kind).toBe("dry-run-stub");
        expect(def.dryRunStub, def.type).toBeUndefined();
      }

      if (def.definition.testMode === "refuse") {
        expect(
          execSpy,
          `"${def.type}" must refuse without running its real executor`,
        ).not.toHaveBeenCalled();
        expect(result.ok).toBe(false);
      } else if (guarded) {
        expect(selection.kind).toBe("dry-run-stub");
        expect(
          def.dryRunStub,
          `"${def.type}" is cost-bearing and/or sideEffecting (requiresDryRunStub === true) but declares ` +
            `no dryRunStub. A newly added cost-bearing or side-effecting node MUST declare one, or the ` +
            `engine refuses to run it at all (fail-closed) rather than risk a real charge or a real ` +
            `external call during a dry run.`,
        ).toBeTypeOf("function");
        expect(
          execSpy,
          `"${def.type}" must never invoke its real executor while ctx.dryRun is true.`,
        ).not.toHaveBeenCalled();
        expect(
          stubSpy,
          `"${def.type}" dryRunStub was not invoked`,
        ).toHaveBeenCalledTimes(1);
        expect(result.ok).toBe(true);
      } else {
        expect(selection.kind).toBe("real");
        expect(
          execSpy,
          `"${def.type}" is classified as free/pure but its real executor did not run during a dry run — ` +
            `a dry run must still traverse the graph for a free/pure node, not silently no-op it.`,
        ).toHaveBeenCalledTimes(1);
      }
    });
  }

  it("live mode (ctx.dryRun: false) always runs the real executor, regardless of classification", async () => {
    for (const def of NODE_DEFS) {
      const execSpy = vi.fn(async (): Promise<NodeResult> => OK_RESULT);
      const testDef: NodeDef = { ...def, executor: execSpy };
      const ctx = makeCtx({ dryRun: false });
      const selection = selectNodeDispatch(testDef, ctx);
      expect(selection.kind).toBe("real");
      await executeSelectedNode(
        selection,
        ctx,
        { params: {}, provenance: createNodeExecutionProvenance({}) },
        {},
      );
      expect(
        execSpy,
        `"${def.type}" did not run for real with ctx.dryRun: false`,
      ).toHaveBeenCalledTimes(1);
    }
  });
});

describe("dry-run enumeration — fail-closed default for an unclassified/forgotten node", () => {
  it("refuses to run a hypothetical cost-bearing node's real executor when it declares no dryRunStub", async () => {
    const realExecutor = vi.fn(async (): Promise<NodeResult> => ({
      ok: true,
      outputs: { result: "charged-the-platform-card" },
      costUsdc: 5,
    }));
    // A brand-new node type: not in FREE_NODE_TYPES, no costBearing/
    // sideEffecting override (so isCostBearingNode's deny-by-default makes
    // it cost-bearing), and — the bug this whole file exists to prevent —
    // no dryRunStub declared.
    const forgottenNode: NodeDef = {
      type: "some.brand.new.node" as never,
      label: "Brand New Node",
      group: "Rails",
      paramsSchema: { parse: (v: unknown) => v } as never,
      inputs: ["in"],
      outputs: ["result"],
      executor: realExecutor,
    };

    const ctx = makeCtx({ dryRun: true });
    const selection = selectNodeDispatch(forgottenNode, ctx);
    const result = await executeSelectedNode(
      selection,
      ctx,
      { params: {}, provenance: createNodeExecutionProvenance({}) },
      {},
    );

    expect(selection.kind).toBe("dry-run-stub");
    expect(realExecutor).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/dryRunStub/i);
    }
  });

  it("the same hypothetical node runs for real once it is explicitly marked free (costBearing: false)", async () => {
    const realExecutor = vi.fn(async (): Promise<NodeResult> => ({
      ok: true,
      outputs: { result: "local-only" },
      costUsdc: 0,
    }));
    const explicitlyFreeNode: NodeDef = {
      type: "some.brand.new.free.node" as never,
      label: "Brand New Free Node",
      group: "Logic",
      costBearing: false,
      paramsSchema: { parse: (v: unknown) => v } as never,
      inputs: ["in"],
      outputs: ["result"],
      executor: realExecutor,
    };

    const ctx = makeCtx({ dryRun: true });
    const selection = selectNodeDispatch(explicitlyFreeNode, ctx);
    const result = await executeSelectedNode(
      selection,
      ctx,
      { params: {}, provenance: createNodeExecutionProvenance({}) },
      {},
    );

    expect(selection.kind).toBe("real");
    expect(realExecutor).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });
});

describe("central node dispatch authority", () => {
  it("selects before evaluating only the chosen parameter factory", async () => {
    const realFactory = vi.fn((): ResolvedNodeExecutionParams => ({
      params: { source: "resolved" },
      provenance: createNodeExecutionProvenance({ token: "live-secret" }),
    }));
    const staticFactory = vi.fn((): ResolvedNodeExecutionParams => ({
      params: { source: "static" },
      provenance: createNodeExecutionProvenance({ token: "must-not-reach-stub" }),
    }));
    const realExecutor = vi.fn(async (): Promise<NodeResult> => OK_RESULT);
    const dryRunStub = vi.fn(async (
      _ctx,
      params,
      _inputs,
      provenance,
    ): Promise<NodeResult> => ({
      ok: true,
      outputs: {
        params,
        secretKeys: listProvenanceSecretKeys(provenance),
      },
      costUsdc: 0,
    }));
    const definition: NodeDef = {
      type: "lazy.dispatch" as never,
      label: "Lazy dispatch",
      group: "Logic",
      sideEffecting: true,
      paramsSchema: { parse: (value: unknown) => value } as never,
      inputs: [],
      outputs: ["result"],
      executor: realExecutor,
      dryRunStub,
    };
    const ctx = makeCtx({ dryRun: true });

    const selection = selectNodeDispatch(definition, ctx);
    expect(realFactory).not.toHaveBeenCalled();
    expect(staticFactory).not.toHaveBeenCalled();

    const selectedParams = selection.kind === "real" ? realFactory() : staticFactory();
    const result = await executeSelectedNode(selection, ctx, selectedParams, {});

    expect(selection.kind).toBe("dry-run-stub");
    expect(realFactory).not.toHaveBeenCalled();
    expect(staticFactory).toHaveBeenCalledTimes(1);
    expect(dryRunStub).toHaveBeenCalledTimes(1);
    expect(realExecutor).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      outputs: { params: { source: "static" }, secretKeys: [] },
      costUsdc: 0,
    });
  });

  it("passes trusted provenance to real executors and canonical empty provenance to stubs", async () => {
    const inspect = vi.fn(async (
      _ctx,
      _params,
      _inputs,
      provenance,
    ): Promise<NodeResult> => ({
      ok: true,
      outputs: {
        keys: listProvenanceSecretKeys(provenance),
        token: readProvenanceSecret(provenance, "token"),
      },
      costUsdc: 0,
    }));
    const base: NodeDef = {
      type: "provenance.dispatch" as never,
      label: "Provenance dispatch",
      group: "Logic",
      sideEffecting: true,
      paramsSchema: { parse: (value: unknown) => value } as never,
      inputs: [],
      outputs: ["result"],
      executor: inspect,
      dryRunStub: inspect,
    };
    const trusted = createNodeExecutionProvenance({ token: "secret" });

    const live = makeCtx({ dryRun: false });
    const liveResult = await executeSelectedNode(
      selectNodeDispatch(base, live),
      live,
      { params: {}, provenance: trusted },
      {},
    );
    const dry = makeCtx({ dryRun: true });
    const dryResult = await executeSelectedNode(
      selectNodeDispatch(base, dry),
      dry,
      { params: {}, provenance: trusted },
      {},
    );

    expect(liveResult).toMatchObject({ outputs: { keys: ["token"], token: "secret" } });
    expect(dryResult).toMatchObject({ outputs: { keys: [], token: undefined } });
  });
});

describe("node execution provenance authority", () => {
  it("keeps a deep-cloned frozen secret record behind an opaque nonserializing handle", () => {
    const source = Object.assign(Object.create(null), {
      headers: { Authorization: "Bearer original" },
      token: "original",
    }) as Record<string, unknown>;
    const provenance = createNodeExecutionProvenance(source);
    (source.headers as { Authorization: string }).Authorization = "Bearer changed";
    source.token = "changed";

    const headers = readProvenanceSecret(provenance, "headers") as { Authorization: string };
    expect(headers).toEqual({ Authorization: "Bearer original" });
    expect(Object.isFrozen(headers)).toBe(true);
    expect(listProvenanceSecretKeys(provenance)).toEqual(["headers", "token"]);
    expect(Object.keys(provenance)).toEqual([]);
    expect(JSON.stringify(provenance)).toBe("{}");
    expect(JSON.stringify({ params: { provenance }, result: provenance })).not.toContain("original");
  });

  it("treats structural objects and mutable Map instances as empty forgeries", () => {
    const structural = Object.freeze({ token: "forged" }) as NodeExecutionProvenance;
    const mutableMap = new Map([["token", "forged"]]) as NodeExecutionProvenance;

    for (const forgery of [structural, mutableMap]) {
      expect(readProvenanceSecret(forgery, "token")).toBeUndefined();
      expect(listProvenanceSecretKeys(forgery)).toEqual([]);
    }
    expect(readProvenanceSecret(undefined, "token")).toBeUndefined();
    expect(listProvenanceSecretKeys(undefined)).toEqual([]);
  });

  it("ignores provenance-shaped graph params instead of granting private storage access", async () => {
    const forgedHandle = createNodeExecutionProvenance({ token: "graph-secret" });
    const executor = vi.fn(async (
      _ctx,
      params,
      _inputs,
      provenance,
    ): Promise<NodeResult> => ({
      ok: true,
      outputs: {
        params,
        provenanceKeys: listProvenanceSecretKeys(provenance),
      },
      costUsdc: 0,
    }));
    const definition: NodeDef = {
      type: "graph.forgery" as never,
      label: "Graph forgery",
      group: "Logic",
      costBearing: false,
      paramsSchema: { parse: (value: unknown) => value } as never,
      inputs: [],
      outputs: ["result"],
      executor,
    };
    const ctx = makeCtx({ dryRun: false });

    const result = await executeSelectedNode(
      selectNodeDispatch(definition, ctx),
      ctx,
      {
        params: { provenance: forgedHandle, secretValues: new Map([["token", "map-secret"]]) },
        provenance: {} as NodeExecutionProvenance,
      },
      {},
    );

    expect(result).toMatchObject({ outputs: { provenanceKeys: [] } });
    expect(JSON.stringify(result)).not.toMatch(/graph-secret|map-secret/u);
  });
});
