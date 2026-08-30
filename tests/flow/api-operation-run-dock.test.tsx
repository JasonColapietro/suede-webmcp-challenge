import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import RunDock, { ApiOperationSimulationReceiptView } from "@/components/canvas/RunDock";
import type { ApiOperationSimulationReceiptV1 } from "@/lib/connectors/simulation-contract";

const receipt: ApiOperationSimulationReceiptV1 = Object.freeze({
  schemaVersion: 1,
  correlationId: "11111111-1111-4111-8111-111111111111",
  simulationId: "22222222-2222-4222-8222-222222222222",
  message: "Simulated locally. No request sent.",
  operation: Object.freeze({
    operationVersionId: "33333333-3333-4333-8333-333333333333",
    operationId: "listOrders",
    connectorProjectionHash: "a".repeat(64),
    operationProjectionHash: "b".repeat(64),
    schemaHash: "c".repeat(64),
    method: "GET",
    origin: "https://api.example.test",
    pathTemplate: "/orders/{orderId}",
    pathParameterNames: Object.freeze(["orderId"]),
    queryParameterNames: Object.freeze(["limit"]),
    requestHeaderNames: Object.freeze(["accept"]),
    hasBody: false,
    selectedStatus: 200,
    credentialPlaceholder: Object.freeze({ kind: "api_key_header", headerName: "x-api-key", value: "[redacted]" }),
  }),
  systemPolicy: Object.freeze({ effects: Object.freeze(["write"] as const), retry: "unsafe", cost: "unknown", idempotency: "none" }),
  authorAnnotation: Object.freeze({ label: "Unverified", effectNote: "Possible retry side effect." }),
  execution: Object.freeze({ plannedNodeCount: 2, completedNodeCount: 2 }),
  egressCount: 0,
  costUsdc: 0,
  durationMs: 12,
});

describe("API operation Run Dock receipt", () => {
  it("renders only the dedicated redacted structural receipt", () => {
    const markup = renderToStaticMarkup(createElement(ApiOperationSimulationReceiptView, { receipt }));

    expect(markup).toContain("Simulated locally. No request sent.");
    expect(markup).toContain("/orders/{orderId}");
    expect(markup).toContain("[redacted]");
    expect(markup).toContain("0 egress");
    expect(markup).toContain("0 USDC");
    expect(markup).toContain("write / unsafe / unknown / none");
    expect(markup).toContain("Connector projection hash");
    expect(markup).toContain("Operation projection hash");
    expect(markup).toContain("Schema hash");
    expect(markup).not.toMatch(/>Projection hash</u);
    expect(markup).not.toMatch(/>Operation hash</u);
    expect(markup).not.toContain("Test outputs");
    expect(markup).not.toContain(receipt.operation.operationVersionId);
    expect(markup).not.toContain(receipt.simulationId);
  });

  it("wins over durable mode when an immutable version exists and no scope is selected", () => {
    const markup = renderToStaticMarkup(createElement(RunDock, {
      flowId: "flow",
      immutableVersionStatus: "ready",
      immutableVersion: { id: "version", versionNumber: 1 },
      testScope: null,
      apiOperationSimulation: { status: "success", receipt },
    }));
    expect(markup).toContain("Simulated locally. No request sent.");
    expect(markup).not.toContain("Start durable run");
    expect(markup).not.toContain("Trigger input JSON");
    expect(markup).not.toContain("Run log");
    expect(markup).not.toContain("Test outputs");
  });
});
