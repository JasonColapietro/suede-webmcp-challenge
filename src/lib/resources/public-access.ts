import type { SupportedFlowGraph } from "@/lib/flow/types";
import type { ResourceDiscoveryAccess, ResourceExecutionAccess } from "./types";

export interface PublishedResourceAccess {
  readonly executionAccess: ResourceExecutionAccess;
  readonly discoveryAccess: ResourceDiscoveryAccess;
}

/**
 * Read access only from the immutable published graph. A graph without a
 * Resource Product marker is an ordinary agent; a malformed marker fails
 * closed as private and unlisted.
 */
export function publishedResourceAccess(
  graph: Pick<SupportedFlowGraph, "meta">,
): PublishedResourceAccess | null {
  const meta = graph.meta;
  if (!meta || !("resourceProduct" in meta)) return null;
  const value = meta.resourceProduct;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { executionAccess: "private", discoveryAccess: "unlisted" };
  }
  const record = value as Readonly<Record<string, unknown>>;
  const executionAccess = record.executionAccess;
  const discoveryAccess = record.discoveryAccess;
  if ((executionAccess !== "free" && executionAccess !== "paid" && executionAccess !== "private") ||
      (discoveryAccess !== "public" && discoveryAccess !== "unlisted")) {
    return { executionAccess: "private", discoveryAccess: "unlisted" };
  }
  return { executionAccess, discoveryAccess };
}
