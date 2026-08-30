import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { defineAgent } from "../src/define.js";
import { manual, paidCall } from "../src/triggers.js";
import { serve } from "../src/serve.js";

let activeServer: { close(): void } | null = null;

afterEach(() => {
  if (activeServer) {
    activeServer.close();
    activeServer = null;
  }
});

async function startOnFreePort(
  agent: ReturnType<typeof defineAgent>,
): Promise<{ url: string; server: { close(): void } }> {
  return new Promise<{ url: string; server: { close(): void } }>((resolve) => {
    const finder = http.createServer();
    finder.listen(0, "127.0.0.1", () => {
      const { port } = finder.address() as AddressInfo;
      finder.close(() => {
        const server = serve(agent, { port });
        setTimeout(() => {
          resolve({ url: `http://127.0.0.1:${port}`, server });
        }, 50);
      });
    });
  });
}

describe("serve() — GET /manifest", () => {
  it("returns the agent definition minus run()", async () => {
    const agent = defineAgent({
      name: "test-agent",
      description: "A test agent.",
      triggers: [manual(), paidCall(0.5)],
      async run() {
        return { ok: true };
      },
    });

    const { url, server } = await startOnFreePort(agent);
    activeServer = server;

    const res = await fetch(`${url}/manifest`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["name"]).toBe("test-agent");
    expect(body["description"]).toBe("A test agent.");
    expect(body["triggers"]).toHaveLength(2);
    // run() must not be in the manifest
    expect(body["run"]).toBeUndefined();
  });
});

describe("serve() — POST /run", () => {
  it("executes the agent run() and returns output", async () => {
    const agent = defineAgent({
      name: "echo-agent",
      triggers: [manual()],
      async run({ input }) {
        return { echoed: input };
      },
    });

    const { url, server } = await startOnFreePort(agent);
    activeServer = server;

    const res = await fetch(`${url}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "hello", trigger: "manual" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["output"]).toEqual({ echoed: "hello" });
  });

  it("returns 400 for non-JSON body", async () => {
    const agent = defineAgent({
      name: "err-agent",
      triggers: [manual()],
      async run() {
        return null;
      },
    });

    const { url, server } = await startOnFreePort(agent);
    activeServer = server;

    const res = await fetch(`${url}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 500 when run() throws", async () => {
    const agent = defineAgent({
      name: "throw-agent",
      triggers: [manual()],
      async run() {
        throw new Error("boom");
      },
    });

    const { url, server } = await startOnFreePort(agent);
    activeServer = server;

    const res = await fetch(`${url}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: null }),
    });
    expect(res.status).toBe(500);
  });

  it("returns 404 for unknown routes", async () => {
    const agent = defineAgent({
      name: "404-agent",
      triggers: [manual()],
      async run() {
        return null;
      },
    });

    const { url, server } = await startOnFreePort(agent);
    activeServer = server;

    const res = await fetch(`${url}/unknown`);
    expect(res.status).toBe(404);
  });
});
