/**
 * Factory for Suede x402 tool nodes. Every paid Suede node is built from:
 *   - an endpoint (path + method + price)
 *   - a zod params schema
 *   - a toBody mapper (params + upstream inputs -> request body)
 *
 * The executor parses params, calls the x402 client (dry-run by default),
 * and charges the ledger only when the call actually settles.
 *
 * `suedeNode()` also attaches a `dryRunStub` (see `suedeDryRunStub` below)
 * to every node it builds, so the engine's central dry-run gate
 * (engine.ts's executeNode) never even reaches `ctx.x402.call()` while
 * ctx.dryRun is true. Before this, these nodes were only safe because
 * `ctx.x402`'s own `dryRun` flag happens to be derived from the same
 * source as `ctx.dryRun` (see run-context.ts's `buildRunContext`) — real,
 * but an indirect, easy-to-break coincidence rather than something the
 * engine itself enforces. Attaching an explicit stub here makes every node
 * built through this factory structurally safe the same way `http` now is,
 * independent of how `ctx.x402` happens to be constructed.
 */
import type { ZodType } from "zod";
import {
  defineExecutableNode,
  type CanonicalNodeDef,
  type NodeExecutor,
} from "../../executor";
import type { NodeDefinitionV2 } from "../../node-definition-types";
import type { SuedeEndpoint } from "../../../rails/suede-endpoints";
import { errMessage } from "../_util";

export function suedeExecutor<T>(
  endpoint: SuedeEndpoint,
  schema: ZodType<T>,
  toBody: (params: T, inputs: Record<string, unknown>) => unknown,
): NodeExecutor {
  return async (ctx, rawParams, inputs) => {
    let params: T;
    try {
      params = schema.parse(rawParams ?? {});
    } catch (e) {
      return { ok: false, error: errMessage(e), costUsdc: 0 };
    }
    try {
      const body = toBody(params, inputs);
      const res = await ctx.x402.call(endpoint.path, body, {
        method: endpoint.method,
        priceUsdc: endpoint.priceUsdc,
      });
      return {
        ok: true,
        outputs: { result: res.data, settled: res.settled, dryRun: res.dryRun },
        costUsdc: res.costUsdc,
      };
    } catch (e) {
      return { ok: false, error: errMessage(e), costUsdc: 0 };
    }
  };
}

/**
 * Synthetic dry-run stub shared by every x402-routed Suede tool node. It
 * cannot know what the real Suede endpoint would return (that's real
 * provider/model output), so it only ever echoes the outgoing request back
 * in the same shape X402Client.call()'s own dry-run branch already returns
 * (see ../../../rails/x402-client.ts) — { result: { dryRun, path, method,
 * echo }, settled: false, dryRun: true } — so downstream nodes reading
 * result/settled/dryRun still typecheck and run the same as a real call.
 */
export function suedeDryRunStub<T>(
  endpoint: SuedeEndpoint,
  schema: ZodType<T>,
  toBody: (params: T, inputs: Record<string, unknown>) => unknown,
): NodeExecutor {
  return async (_ctx, rawParams, inputs) => {
    let params: T;
    try {
      params = schema.parse(rawParams ?? {});
    } catch (e) {
      return { ok: false, error: errMessage(e), costUsdc: 0 };
    }
    let body: unknown;
    try {
      body = toBody(params, inputs);
    } catch (e) {
      return { ok: false, error: errMessage(e), costUsdc: 0 };
    }
    return {
      ok: true,
      outputs: {
        result: {
          dryRun: true,
          path: endpoint.path,
          method: endpoint.method,
          echo: body ?? null,
        },
        settled: false,
        dryRun: true,
      },
      costUsdc: 0,
    };
  };
}

export function suedeEndpointPrice(
  definition: NodeDefinitionV2,
  endpoint: SuedeEndpoint,
): number {
  if (
    definition.cost.kind !== "estimated" ||
    definition.cost.amount === undefined ||
    !Number.isFinite(definition.cost.amount)
  ) {
    throw new Error(
      `${definition.type} must declare a finite estimated price for ${endpoint.path}`,
    );
  }
  if (definition.cost.amount !== endpoint.priceUsdc) {
    throw new Error(
      `${definition.type} descriptor price ${definition.cost.amount} does not match endpoint price ${endpoint.priceUsdc}`,
    );
  }
  return definition.cost.amount;
}

export function suedeNode<T>(
  definition: NodeDefinitionV2,
  endpoint: SuedeEndpoint,
  schema: ZodType<T>,
  toBody: (params: T, inputs: Record<string, unknown>) => unknown,
): CanonicalNodeDef {
  const priceUsdc = suedeEndpointPrice(definition, endpoint);
  const canonicalEndpoint = { ...endpoint, priceUsdc };
  return defineExecutableNode(definition, {
    paramsSchema: schema,
    executor: suedeExecutor(canonicalEndpoint, schema, toBody),
    dryRunStub: suedeDryRunStub(canonicalEndpoint, schema, toBody),
  });
}
