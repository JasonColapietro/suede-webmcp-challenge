import { parseGraphCommand } from "@/lib/flow/graph-command-schema";
import type { GraphCommand } from "@/lib/flow/graph-command-types";
import { isFlowGraphV1, isFlowGraphV2, parseSupportedFlowGraph } from "@/lib/flow/graph-schema";
import { flowSaveFingerprint } from "@/lib/flow/save-queue";
import type { SupportedFlowGraph } from "@/lib/flow/types";
import type { FlowVersionRecord } from "@/lib/projects/types";

export interface VersionRestoreCommandInput {
  readonly currentGraph: SupportedFlowGraph;
  readonly version: FlowVersionRecord;
  readonly expectedDraftFingerprint: string;
  readonly commandId: string;
}

export type VersionRestoreCommand = Extract<GraphCommand, { kind: "graph.replace" }>;

function validatedGraph(
  value: unknown,
  message: "The current draft is invalid." | "The saved version is invalid.",
): SupportedFlowGraph {
  try {
    parseSupportedFlowGraph(value);
    if (isFlowGraphV1(value) || isFlowGraphV2(value)) return value;
  } catch {
    // Replace parser details with a fixed client-safe failure below.
  }
  throw new TypeError(message);
}

export function buildVersionRestoreCommand(
  input: VersionRestoreCommandInput,
): VersionRestoreCommand {
  const currentGraph = validatedGraph(input.currentGraph, "The current draft is invalid.");
  const versionGraph = validatedGraph(input.version.graph, "The saved version is invalid.");
  if (flowSaveFingerprint(currentGraph) !== input.expectedDraftFingerprint) {
    throw new Error("The draft changed before restore.");
  }
  try {
    const command = parseGraphCommand({
      v: 1,
      id: input.commandId,
      kind: "graph.replace",
      graph: structuredClone(versionGraph),
    });
    if (command.kind !== "graph.replace") throw new Error("Unexpected restore command");
    return command;
  } catch {
    throw new TypeError("The restore command is invalid.");
  }
}
