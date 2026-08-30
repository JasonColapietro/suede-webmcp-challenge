import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createElement,
  type ComponentProps,
  type KeyboardEvent,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider } from "@xyflow/react";
import { describe, expect, it, vi } from "vitest";
import Inspector from "@/components/canvas/Inspector";
import SuedeNode, {
  activateHandleFromKeyboard,
  suedeNodeStatusLabel,
} from "@/components/canvas/SuedeNode";
import {
  matchesNodeDefinition,
  nodeCapabilitySummary,
  nodeCostLabel,
  nodePermissionSummary,
  nodeTestModeLabel,
} from "@/lib/flow/node-display";
import { getNodeDefinition } from "@/lib/flow/node-definitions";
import { NODE_DEFINITIONS } from "@/lib/flow/node-definitions";
import { hashCallableInterface } from "@/lib/flow/subflow-reference";

describe("canonical node definition UI model", () => {
  it("searches label, type, description, and searchable terms", () => {
    const definition = getNodeDefinition("suede.generateSong");

    expect(matchesNodeDefinition(definition, "Generate Song")).toBe(true);
    expect(matchesNodeDefinition(definition, "suede.generate")).toBe(true);
    expect(matchesNodeDefinition(definition, "text description")).toBe(true);
    expect(matchesNodeDefinition(definition, "audio")).toBe(true);
    expect(matchesNodeDefinition(definition, "spreadsheet")).toBe(false);
    expect(matchesNodeDefinition(definition, "   ")).toBe(true);
  });

  it("formats free, estimated USDC, and variable costs", () => {
    expect(nodeCostLabel(getNodeDefinition("input"))).toBe("Free");
    expect(nodeCostLabel(getNodeDefinition("suede.styleCoach"))).toBe(
      "Est. $0.050 USDC",
    );
    expect(nodeCostLabel(getNodeDefinition("http"))).toBe("Variable cost");
  });

  it("describes every test behavior without inspecting an executor", () => {
    expect(nodeTestModeLabel(getNodeDefinition("transform"))).toBe(
      "Runs safely in test",
    );
    expect(nodeTestModeLabel(getNodeDefinition("http"))).toBe(
      "Uses a zero-cost stub in test",
    );

    const refusing = {
      ...getNodeDefinition("http"),
      testMode: "refuse" as const,
    };
    expect(nodeTestModeLabel(refusing)).toBe("Refuses test execution");
  });

  it("keeps configuration-dependent effects conservative", () => {
    const summary = nodeCapabilitySummary(getNodeDefinition("http"));

    expect(summary).toContain(
      "Possible effects depend on this node's configuration.",
    );
    expect(summary).toEqual(
      expect.arrayContaining([
        "May read data",
        "May write data",
        "May delete data",
        "May send data",
      ]),
    );
  });

  it.each(["subflow", "loop"] as const)(
    "%s discloses inherited capabilities",
    (type) => {
      expect(nodeCapabilitySummary(getNodeDefinition(type))).toContain(
        "Capabilities inherit from the referenced flow.",
      );
    },
  );

  it("describes nodes without connected-account permissions", () => {
    expect(nodePermissionSummary(getNodeDefinition("http"))).toEqual([
      "No connected account required",
    ]);
  });

  it("leaves descriptor fields unchanged and keeps palette chips at two rows", () => {
    const fields = getNodeDefinition("http").ui.fields;

    expect(fields.map((field) => field.key)).toEqual([
      "method",
      "url",
      "headers",
      "body",
      "timeoutMs",
    ]);
    expect(fields[0]?.options).toEqual([
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
    ]);

    const palette = readFileSync(
      join(process.cwd(), "src/components/canvas/NodePalette.tsx"),
      "utf8",
    );
    const inspector = readFileSync(
      join(process.cwd(), "src/components/canvas/Inspector.tsx"),
      "utf8",
    );
    const styles = readFileSync(join(process.cwd(), "src/app/site.css"), "utf8");
    expect(palette).toContain('className="node-palette-chip__label"');
    expect(palette).toContain('className="node-palette-chip__meta"');
    expect(palette).toContain('className="node-palette-chip__summary"');
    expect(palette).toContain('className="node-palette-chip__datum mono tabular"');
    expect(palette).toContain("compactCostLabel(def)");
    expect(palette).toContain("compactTestLabel(def)");
    expect(palette).toContain("aria-label={nodeChipAccessibleLabel(def)}");
    expect(palette).toContain(
      "`${definition.label}. Type ${definition.type}. ${definition.description} Cost ",
    );
    expect(palette).toContain("Test mode ${compactTestLabel(definition)}.`");
    expect(palette).not.toMatch(/<span[^>]*aria-label=/s);
    expect(palette).not.toContain('outline: "none"');
    expect(inspector).not.toContain('outline: "none"');
    // The useful description is visible; implementation type and Test mode
    // stay available in the compact datum tooltip and accessible label.
    expect(palette).toContain("title={def.description}");
    expect(palette).toContain("title={`Type ${def.type} · Test ${compactTestLabel(def)}`}");
    expect(palette).not.toContain('className="node-palette-chip__description"');
    expect(styles).toMatch(/\.node-palette-chip__summary\s*\{[^}]*min-width:\s*0/s);
    expect(styles).toMatch(/\.node-palette-chip__datum\s*\{[^}]*flex:\s*0 0 auto/s);
  });

  it("does not pretend palette groups can collapse while search controls visibility", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/canvas/NodePalette.tsx"),
      "utf8",
    );

    expect(source).toContain("disabled={searching}");
    expect(source).toContain("if (!searching) toggleGroup(group)");
  });

  it("does not mix border shorthand with a per-side node accent", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/canvas/SuedeNode.tsx"),
      "utf8",
    );

    expect(source).not.toContain(
      'border: `1px solid ${selected ? "var(--primary)" : "var(--hairline)"}`',
    );
    expect(source).toContain("borderTop:");
    expect(source).toContain("borderRight:");
    expect(source).toContain("borderBottom:");
    expect(source).toContain("borderLeft:");
  });

  it("shows a text-and-shape execution status for every node state", () => {
    expect(suedeNodeStatusLabel(undefined)).toBe("not run");
    expect(suedeNodeStatusLabel("running")).toBe("running");
    expect(suedeNodeStatusLabel("done")).toBe("completed");
    expect(suedeNodeStatusLabel("error")).toBe("failed");

    const markup = renderToStaticMarkup(
      createElement(
        ReactFlowProvider,
        null,
        createElement(SuedeNode, {
          data: {
            nodeType: "transform",
            label: "Transform",
            graphVersion: 2,
            status: "error",
          },
          selected: false,
        } as ComponentProps<typeof SuedeNode>),
      ),
    );

    expect(markup).toContain('class="suede-node-status mono"');
    expect(markup).toContain('data-status="error"');
    expect(markup).toContain('<span aria-hidden="true">!</span><span>failed</span>');
    expect(markup).not.toContain('role="group"');
  });

  it("renders every canonical input and output as a generic typed data receipt", () => {
    for (const definition of NODE_DEFINITIONS) {
      const markup = renderToStaticMarkup(
        createElement(
          ReactFlowProvider,
          null,
          createElement(SuedeNode, {
            data: {
              nodeType: definition.type,
              label: definition.label,
              graphVersion: 2,
            },
            selected: false,
          } as ComponentProps<typeof SuedeNode>),
        ),
      );
      const ports = [...definition.inputPorts.map((port) => ["input", port] as const), ...definition.outputPorts.map((port) => ["output", port] as const)];
      expect(markup.match(/role="button"/g) ?? [], definition.type).toHaveLength(ports.length);
      for (const [direction, port] of ports) {
        const status = Object.keys(port.schema).length === 0 ? "unknown schema" : "typed";
        expect(markup).toContain(`${definition.label} ${direction} ${port.label} (${port.id}), ${status}`);
        // On-card captions flag only the exception: typed ports show the bare
        // label, untyped ports carry the marker. Full receipts live in the
        // accessible name asserted above.
        const caption = status === "typed" ? port.label : `${port.label} · untyped`;
        expect(markup).toContain(`>${caption}</span>`);
      }
    }
  });

  it("preserves loop's handleless legacy result while naming v2 result and errors handles", () => {
    const markup = renderToStaticMarkup(
      createElement(
        ReactFlowProvider,
        null,
        createElement(SuedeNode, {
          data: {
            nodeType: "loop",
            label: "Loop",
            graphVersion: 1,
          },
          selected: false,
        } as ComponentProps<typeof SuedeNode>),
      ),
    );

    expect(markup.match(/role="button"/g)).toHaveLength(3);
    expect(markup.match(/tabindex="0"/g)).toHaveLength(3);
    expect(markup).toContain('aria-label="Loop output Result (result), typed"');
    expect(markup).toContain('aria-label="Loop output Errors (errors), typed"');
    expect(markup).toContain('data-legacy-default="true"');
    expect(markup).toMatch(/>Result<\/span>/);
    expect(markup).toMatch(/>Errors<\/span>/);
  });

  it("activates a focused handle with Enter or Space only", () => {
    const click = vi.fn();
    const preventDefault = vi.fn();
    const event = (key: string) =>
      ({
        key,
        preventDefault,
        currentTarget: { click },
      }) as unknown as KeyboardEvent<HTMLDivElement>;

    activateHandleFromKeyboard(event("ArrowRight"));
    expect(click).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();

    activateHandleFromKeyboard(event("Enter"));
    activateHandleFromKeyboard(event(" "));
    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(click).toHaveBeenCalledTimes(2);
  });

  it("renders every generic inspector field with a programmatic label", () => {
    for (const definition of NODE_DEFINITIONS.filter(({ type }) => type !== "api.operation")) {
      const nodeId = `node:${definition.type}`;
      const markup = renderToStaticMarkup(
        createElement(Inspector, {
          node: {
            id: nodeId,
            type: definition.type,
            params: {},
            position: { x: 0, y: 0 },
          },
          onChange: () => undefined,
        }),
      );

      for (const field of definition.ui.fields) {
        const id = `inspector-${encodeURIComponent(nodeId)}-${encodeURIComponent(field.key)}`;
        expect(markup, `${definition.type}.${field.key} label`).toContain(
          `for="${id}"`,
        );
        expect(markup, `${definition.type}.${field.key} control`).toContain(
          `id="${id}"`,
        );
      }
    }
  });

  it("renders named cost/speed tier options for the LLM node's model select", () => {
    const markup = renderToStaticMarkup(
      createElement(Inspector, {
        node: {
          id: "node:llm",
          type: "llm",
          params: {},
          position: { x: 0, y: 0 },
        },
        onChange: () => undefined,
      }),
    );

    expect(markup).toContain("Use platform default");
    expect(markup).toContain("Fast &amp; cheap — ~$3/1M tokens");
    expect(markup).toContain("Balanced (recommended) — ~$9/1M tokens");
    expect(markup).toContain("Best quality — ~$45/1M tokens");
    expect(markup).toContain('value="claude-haiku-4-5-20251001"');
    expect(markup).toContain('value="claude-sonnet-4-6"');
    expect(markup).toContain('value="claude-opus-4-6"');
  });

  it("keeps legacy reusable-flow fields and hides legacy-only fields for typed loops", () => {
    const callableInterface = { inputs: [], outputs: [] } as const;
    const markup = renderToStaticMarkup(createElement(Inspector, {
      node: {
        id: "typed-loop",
        type: "loop",
        params: { reference: {
          kind: "draft",
          flowId: "child-flow",
          interface: callableInterface,
          interfaceHash: hashCallableInterface(callableInterface),
        } },
        bindings: {},
        position: { x: 0, y: 0 },
      },
      onChange: () => undefined,
    }));

    expect(markup).not.toContain('for="inspector-typed-loop-flowId"');
    expect(markup).not.toContain('for="inspector-typed-loop-itemsPath"');
    expect(markup).toContain('for="inspector-typed-loop-concurrency"');
    expect(markup).toContain('for="inspector-typed-loop-maxIterations"');
  });
});
