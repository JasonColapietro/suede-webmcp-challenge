import type { NodeRegistry } from "./executor";
import type { NodeGroup } from "./node-definition-types";
import { NODE_DEFS } from "./nodes";

export function getRegistry(): NodeRegistry {
  const registry: NodeRegistry = {};
  for (const def of NODE_DEFS) {
    if (Object.prototype.hasOwnProperty.call(registry, def.type)) {
      throw new Error(`Duplicate built-in node type: ${def.type}`);
    }
    registry[def.type] = def;
  }
  return registry;
}

export { NODE_GROUP_ORDER } from "./node-definitions";
export type { NodeGroup };

export { NODE_DEFS };
