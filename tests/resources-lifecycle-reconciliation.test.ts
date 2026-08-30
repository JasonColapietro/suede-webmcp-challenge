import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RESOURCE_OUTCOME_UNKNOWN,
  ResourceClientError,
  resourceJsonRequest,
  resourceLifecycleNeedsReconciliation,
} from "@/components/resources/client";
import {
  ResourceAmbiguousFinalCommitError,
  ResourcePersistenceError,
} from "@/lib/resources/repository";
import { resourceApiErrorResponse } from "@/lib/resources/service";

afterEach(() => vi.unstubAllGlobals());

describe("Resource lifecycle outcome reconciliation", () => {
  it("preserves an explicit outcome-unknown signal across the private API boundary", async () => {
    const response = resourceApiErrorResponse(new ResourceAmbiguousFinalCommitError());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "resource outcome unknown",
      code: RESOURCE_OUTCOME_UNKNOWN,
    });
    await expect(resourceApiErrorResponse(new ResourcePersistenceError()).json())
      .resolves.toEqual({ error: "resource store unavailable" });
  });

  it("marks conflicts, ambiguous commits, and ambiguous 5xx responses for a server-current reload", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "resource outcome unknown",
      code: RESOURCE_OUTCOME_UNKNOWN,
    }), { status: 503, headers: { "content-type": "application/json" } })));

    const error = await resourceJsonRequest("/api/v2/resources/resource-1/lifecycle", {
      method: "POST",
      body: "{}",
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ResourceClientError);
    expect(error).toMatchObject({
      status: 503,
      code: RESOURCE_OUTCOME_UNKNOWN,
      message: expect.stringContaining("may have committed"),
    });
    expect(resourceLifecycleNeedsReconciliation(error)).toBe(true);
    expect(resourceLifecycleNeedsReconciliation(new ResourceClientError(409, "conflict"))).toBe(true);
    expect(resourceLifecycleNeedsReconciliation(new ResourceClientError(503, "unavailable"))).toBe(true);
    expect(resourceLifecycleNeedsReconciliation(new ResourceClientError(400, "invalid"))).toBe(false);
  });

  it("reconciles transport loss, abort, unreadable success, and response parse failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("connection lost")));
    const transport = await resourceJsonRequest("/api/v2/resources/resource-1/lifecycle", {
      method: "POST",
      body: "{}",
    }).catch((caught: unknown) => caught);
    expect(resourceLifecycleNeedsReconciliation(transport)).toBe(true);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 200 })));
    const unreadable = await resourceJsonRequest("/api/v2/resources/resource-1/lifecycle", {
      method: "POST",
      body: "{}",
    }).catch((caught: unknown) => caught);
    expect(unreadable).toMatchObject({ status: 502 });
    expect(resourceLifecycleNeedsReconciliation(unreadable)).toBe(true);

    expect(resourceLifecycleNeedsReconciliation(new DOMException("aborted", "AbortError"))).toBe(true);
    expect(resourceLifecycleNeedsReconciliation(new Error("invalid lifecycle response"))).toBe(true);
    expect(resourceLifecycleNeedsReconciliation(null)).toBe(false);
  });

  it("reloads the current receipt before another lifecycle action is possible", () => {
    const workspace = readFileSync("src/components/resources/ResourceWorkspace.tsx", "utf8");
    expect(workspace).toContain("if (resourceLifecycleNeedsReconciliation(error)) await load(false);");
  });
});
