import { describe, expect, it } from "vitest";
import {
  graphHasSafeHttpPublicationCredentials,
  projectPublicHttpCredentials,
} from "@/lib/flow/http-publication-policy";
import { graphHasRequiredConnectionBindings } from "@/lib/flow/connection-requirements";
import type { FlowGraphV2, ValueBinding } from "@/lib/flow/types";

function graph(input: {
  headers?: Record<string, string>;
  url?: string;
  body?: string;
  binding?: ValueBinding;
  variables?: FlowGraphV2["variables"];
} = {}): FlowGraphV2 {
  return {
    schemaVersion: 2,
    id: "http-publication",
    name: "HTTP publication",
    nodes: [{
      id: "request",
      type: "http",
      params: {
        method: "GET",
        url: input.url ?? "https://example.com/data?page=1",
        headers: input.headers ?? { Accept: "application/json" },
        ...(input.body === undefined ? {} : { body: input.body }),
      },
      bindings: input.binding ? { headers: input.binding } : {},
      position: { x: 0, y: 0 },
    }],
    edges: [],
    variables: input.variables ?? [],
    groups: [],
    annotations: [],
  };
}

describe("HTTP publication binding policy", () => {
  it.each([
    ["literal", { kind: "literal", value: { Authorization: "Bearer literal-canary" } }],
    ["variable", { kind: "variable", variableId: "credential-headers" }],
    ["port", { kind: "port", nodeId: "input", portId: "result" }],
  ] as const)("refuses and removes a %s headers binding", (_name, binding) => {
    const variables = binding.kind === "variable"
      ? [{
          id: "credential-headers",
          name: "Credential headers",
          scope: "workflow" as const,
          schema: { type: "object" },
          default: { Authorization: "Bearer variable-canary" },
        }]
      : [];
    const value = graph({ binding, variables });

    expect(graphHasSafeHttpPublicationCredentials(value)).toBe(false);
    const projected = projectPublicHttpCredentials(value) as FlowGraphV2;
    expect(projected.nodes[0]?.bindings).not.toHaveProperty("headers");
    if (binding.kind === "literal") expect(JSON.stringify(projected)).not.toContain("literal-canary");
    if (binding.kind === "variable") {
      expect(JSON.stringify(projected)).not.toContain("variable-canary");
      expect(projected.variables[0]).toMatchObject({ sensitive: true });
      expect(projected.variables[0]).not.toHaveProperty("default");
    }
  });

  it("permits only the exact opaque Connection headers binding", () => {
    expect(graphHasSafeHttpPublicationCredentials(graph({
      binding: { kind: "secret", connectionId: "opaque-connection", field: "headers" },
    }))).toBe(true);
    expect(graphHasSafeHttpPublicationCredentials(graph({
      binding: { kind: "secret", connectionId: "opaque-connection", field: "token" },
    }))).toBe(false);
  });
});

describe("business-action publication binding policy", () => {
  function slackGraph(binding?: ValueBinding): FlowGraphV2 {
    return {
      ...graph(),
      id: "slack-publication",
      name: "Slack publication",
      nodes: [{
        id: "notify",
        type: "comms.slackMessage",
        params: { text: "Deployment finished" },
        bindings: binding ? { connection: binding } : {},
        position: { x: 0, y: 0 },
      }],
    };
  }

  it("permits and retains the exact declared opaque webhook binding", () => {
    const value = slackGraph({
      kind: "secret",
      connectionId: "opaque-slack-connection",
      field: "webhook",
    });

    expect(graphHasSafeHttpPublicationCredentials(value)).toBe(true);
    expect(graphHasRequiredConnectionBindings(value)).toBe(true);
    expect(projectPublicHttpCredentials(value)).toBe(value);
  });

  it("refuses missing, forged-key, and wrong-field action connections", () => {
    expect(graphHasRequiredConnectionBindings(slackGraph())).toBe(false);
    expect(graphHasSafeHttpPublicationCredentials(slackGraph({
      kind: "secret",
      connectionId: "opaque-slack-connection",
      field: "headers",
    }))).toBe(false);
    const base = slackGraph();
    const forged: FlowGraphV2 = {
      ...base,
      nodes: [{
        ...base.nodes[0]!,
        bindings: { authorization: {
          kind: "secret",
          connectionId: "opaque-slack-connection",
          field: "webhook",
        } },
      }],
    };
    expect(graphHasSafeHttpPublicationCredentials(forged)).toBe(false);
    expect(graphHasRequiredConnectionBindings(forged)).toBe(false);
  });
});

describe("HTTP publication static-header policy", () => {
  it("allows the conservative public header set case-insensitively", () => {
    expect(graphHasSafeHttpPublicationCredentials(graph({ headers: {
      Accept: "application/json",
      "content-type": "application/json",
      "User-Agent": "Suede Agent Studio",
      "x-request-id": "safe-request-id",
    } }))).toBe(true);
  });

  it.each([
    "Ocp-Apim-Subscription-Key",
    "X-Auth-Key",
    "X-Custom-Header",
  ])("refuses and redacts non-allowlisted header %s", (name) => {
    const canary = `plain-${name}-canary`;
    const value = graph({ headers: { Accept: "application/json", [name]: canary } });

    expect(graphHasSafeHttpPublicationCredentials(value)).toBe(false);
    const projected = projectPublicHttpCredentials(value);
    expect(projected.nodes[0]?.params.headers).toEqual({ Accept: "application/json" });
    expect(JSON.stringify(projected)).not.toContain(canary);
  });
});

describe("HTTP publication query credential policy", () => {
  it.each([
    "subscription-key",
    "api_key",
    "token",
    "auth",
    "key",
    "secret",
    "signature",
    "password",
    "credential",
  ])("refuses and redacts the %s query parameter", (name) => {
    const canary = `query-${name}-canary`;
    const value = graph({
      url: `https://example.com/data?page=1&${encodeURIComponent(name)}=${encodeURIComponent(canary)}#result`,
    });

    expect(graphHasSafeHttpPublicationCredentials(value)).toBe(false);
    const projected = projectPublicHttpCredentials(value);
    expect(projected.nodes[0]?.params.url).toBe("https://example.com/data?page=1#result");
    expect(JSON.stringify(projected)).not.toContain(canary);
  });

  it("decodes credential names before checking them", () => {
    const value = graph({ url: "https://example.com/data?api%5Fkey=encoded-canary&safe=value" });
    expect(graphHasSafeHttpPublicationCredentials(value)).toBe(false);
    expect(projectPublicHttpCredentials(value).nodes[0]?.params.url).toBe(
      "https://example.com/data?safe=value",
    );
  });

  it.each(["ocp-apim-subscription-key", "x-api-key", "access_token"])(
    "recognizes credential segments inside %s",
    (name) => {
      const value = graph({ url: `https://example.com/data?${name}=segmented-canary&safe=value` });
      expect(graphHasSafeHttpPublicationCredentials(value)).toBe(false);
      expect(projectPublicHttpCredentials(value).nodes[0]?.params.url).toBe(
        "https://example.com/data?safe=value",
      );
    },
  );
});

describe("HTTP publication body credential policy", () => {
  it.each([
    ['{"password":"plain-json-canary"}', "plain-json-canary"],
    ["client_secret=plain-form-canary&safe=value", "plain-form-canary"],
    ["api_key=plain-api-canary", "plain-api-canary"],
  ])("refuses and redacts credentials embedded in a static body", (body, canary) => {
    const value = graph({ body });

    expect(graphHasSafeHttpPublicationCredentials(value)).toBe(false);
    const projected = projectPublicHttpCredentials(value);
    expect(projected.nodes[0]?.params).not.toHaveProperty("body");
    expect(JSON.stringify(projected)).not.toContain(canary);
  });
});
