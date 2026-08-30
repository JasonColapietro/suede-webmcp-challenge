import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("private scoped test route source contract", () => {
  it("uses only owner-scoped reads and the ephemeral test boundary", () => {
    const source = readFileSync("src/app/api/v2/flows/[flowId]/test/route.ts", "utf8");
    expect(source).toContain("resolveReadOnlyOwnerId");
    expect(source).toContain("getOwnedFlow(flowId, ownerId)");
    expect(source).toContain("getFlowContext(flowId, ownerId)");
    expect(source).toContain("readCappedJsonRequest(request, { signal })");
    expect(source).toContain("parsedJsonWithinBudget(read.data)");
    expect(source).toContain("validateAndCompileTestRunRequest(read.data)");
    expect(source).toContain("runEphemeralScopedTest(read.data, { signal })");
    expect(source).toContain("privateJson({ result })");
    expect(source).not.toMatch(/\b(?:resolveOwnerId|ensureOwnedFlowContext|adoptAnonymousWorkspace|ensurePersonalContext|bindFlow|saveFlow|deleteFlow|createRun|appendStep|finishRun|runAndStream|collectRun)\b/u);
    expect(source).not.toMatch(/from\s+["'][^"']*(?:run-service|run-context)[^"']*["']/u);
    expect(source).not.toContain("rejectAuthorizationMutation");
    expect(source.indexOf("validateTestRouteHeaders(request)")).toBeLessThan(source.indexOf("resolveReadOnlyOwnerId()"));
    expect(source.indexOf("const deadline = new AbortController()")).toBeLessThan(source.indexOf("resolveReadOnlyOwnerId()"));
    expect(source).toContain("withinDeadline(resolveReadOnlyOwnerId())");
    expect(source.indexOf("validateTestRouteHeaders(request)")).toBeLessThan(source.indexOf("getRepo()"));
    expect(source.indexOf("validateTestRouteHeaders(request)")).toBeLessThan(source.indexOf("readCappedJsonRequest(request"));
  });

  it("keeps the streaming body cap aligned with the test request contract", () => {
    const responseSource = readFileSync("src/lib/projects/api-response.ts", "utf8");
    const contractSource = readFileSync("src/lib/flow/test-run-contract.ts", "utf8");
    expect(responseSource).toContain("const MAX_PRIVATE_JSON_BYTES = 2 * 1024 * 1024");
    expect(contractSource).toContain("requestBytes: 2 * 1024 * 1024");
  });
});
