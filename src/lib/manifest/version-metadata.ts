import type { FlowGraph } from "@/lib/flow/types";
import type { AgentManifest, ManifestVersionMetadata } from "./schema";
import { normalizeDependencyPins } from "@/lib/projects/version-input";

const manifestVersionMetadataSymbol = Symbol("suede.manifestVersionMetadata");

type VersionedFlowGraph = FlowGraph & {
  readonly [manifestVersionMetadataSymbol]?: ManifestVersionMetadata;
};

export function versionMetadataFromManifest(
  manifest: AgentManifest,
): ManifestVersionMetadata | undefined {
  if (
    manifest.schemaVersion === undefined &&
    manifest.resourceVersion === undefined &&
    manifest.dependencies === undefined
  ) {
    return undefined;
  }
  return {
    ...(manifest.schemaVersion === undefined ? {} : { schemaVersion: manifest.schemaVersion }),
    ...(manifest.resourceVersion === undefined
      ? {}
      : { resourceVersion: { ...manifest.resourceVersion } }),
    ...(manifest.dependencies === undefined
      ? {}
      : { dependencies: normalizeDependencyPins(manifest.dependencies) }),
  };
}

export function attachManifestVersionMetadata(
  graph: FlowGraph,
  metadata: ManifestVersionMetadata | undefined,
): FlowGraph {
  if (metadata === undefined) return graph;
  Object.defineProperty(graph, manifestVersionMetadataSymbol, {
    value: metadata,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return graph;
}

export function getAttachedManifestVersionMetadata(
  graph: FlowGraph,
): ManifestVersionMetadata | undefined {
  return (graph as VersionedFlowGraph)[manifestVersionMetadataSymbol];
}
