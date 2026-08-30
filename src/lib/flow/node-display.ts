import type {
  NodeDefinitionV2,
  NodeEffect,
} from "./node-definition-types";

const EFFECT_LABELS: Readonly<Record<NodeEffect, string>> = {
  read: "May read data",
  write: "May write data",
  delete: "May delete data",
  send: "May send data",
  spend: "May spend funds",
  publish: "May publish content",
  settle: "May settle payments",
};

export function matchesNodeDefinition(
  definition: NodeDefinitionV2,
  query: string,
): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized === "") return true;

  return [
    definition.label,
    definition.type,
    definition.description,
    ...definition.ui.searchableTerms,
  ].some((value) => value.toLocaleLowerCase().includes(normalized));
}

export function nodeCostLabel(definition: NodeDefinitionV2): string {
  if (definition.cost.kind === "free") return "Free";
  if (definition.cost.kind === "variable") return "Variable cost";

  const amount = definition.cost.amount;
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    return "Variable cost";
  }
  const currency = definition.cost.currency ?? "USDC";
  return `Est. $${amount.toFixed(3)} ${currency}`;
}

export function nodeTestModeLabel(definition: NodeDefinitionV2): string {
  if (definition.testMode === "native") return "Runs safely in test";
  if (definition.testMode === "stub") return "Uses a zero-cost stub in test";
  return "Refuses test execution";
}

export function nodeCapabilitySummary(
  definition: NodeDefinitionV2,
): readonly string[] {
  const qualifier =
    definition.capabilityMode === "config-dependent"
      ? ["Possible effects depend on this node's configuration."]
      : definition.capabilityMode === "inherits-graph"
        ? ["Capabilities inherit from the referenced flow."]
        : [];
  const effects = definition.effects.map((effect) => EFFECT_LABELS[effect]);

  return effects.length === 0
    ? [...qualifier, "No external side effects declared"]
    : [...qualifier, ...effects];
}

export function nodePermissionSummary(
  definition: NodeDefinitionV2,
): readonly string[] {
  if (definition.permissions.length === 0) {
    return ["No connected account required"];
  }

  return definition.permissions.map((permission) => {
    const requirement = permission.required ? "Required" : "Optional";
    const scope = permission.scope ? ` · ${permission.scope}` : "";
    return `${permission.label} · ${requirement}${scope}`;
  });
}
