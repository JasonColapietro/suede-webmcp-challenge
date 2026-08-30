import { defineExecutableNode, type NodeExecutor } from "../executor";
import { getNodeDefinition } from "../node-definitions";
import {
  API_OPERATION_LIVE_UNAVAILABLE,
  ApiOperationNodeParamsSchema,
} from "../../connectors/operation-closure";

export const API_OPERATION_PREVIEW_RESULT = Object.freeze({
  result: Object.freeze({ status: 0, body: null }),
});

const preview: NodeExecutor = async () => ({
  ok: true,
  outputs: API_OPERATION_PREVIEW_RESULT,
  costUsdc: 0,
});

export const apiOperationNode = defineExecutableNode(getNodeDefinition("api.operation"), {
  paramsSchema: ApiOperationNodeParamsSchema,
  executor: async () => ({ ok: false, error: API_OPERATION_LIVE_UNAVAILABLE, costUsdc: 0 }),
  dryRunStub: preview,
});
