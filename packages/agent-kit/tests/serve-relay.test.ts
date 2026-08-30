/**
 * Tests for serve() relay signature verification.
 * When SUEDE_RELAY_SECRET is set, POST /run must reject invalid signatures.
 */
import { describe, it, expect, afterEach } from "vitest";
import { serve } from "../src/serve.js";
import { defineAgent } from "../src/define.js";
import { manual } from "../src/triggers.js";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";

function makeAgent() {
  return defineAgent({
    name: "relay-test-agent",
    description: "test",
    triggers: [manual()],
    async run() {
      return { ok: true };
    },
  });
}

function signBody(body: string, secret: string): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(body);
  return `sha256=${hmac.digest("hex")}`;
}

/** Find a free port, then start serve() on it. Returns url + handle. */
async function startOnFreePort(
  agent: ReturnType<typeof defineAgent>,
): Promise<{ url: string; handle: ReturnType<typeof serve> }> {
  return new Promise((resolve) => {
    const finder = http.createServer();
    finder.listen(0, "127.0.0.1", () => {
      const { port } = finder.address() as AddressInfo;
      finder.close(() => {
        const handle = serve(agent, { port });
        // Give the server a tick to start
        setTimeout(() => {
          resolve({ url: `http://127.0.0.1:${port}`, handle });
        }, 50);
      });
    });
  });
}

async function postRun(
  url: string,
  body: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${url}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body,
  });
  return { status: res.status, json: await res.json() };
}

let activeHandle: ReturnType<typeof serve> | null = null;

afterEach(() => {
  delete process.env.SUEDE_RELAY_SECRET;
  if (activeHandle) {
    activeHandle.close();
    activeHandle = null;
  }
});

describe("serve() — no SUEDE_RELAY_SECRET (open)", () => {
  it("accepts POST /run without any signature header", async () => {
    const agent = makeAgent();
    const { url, handle } = await startOnFreePort(agent);
    activeHandle = handle;

    const body = JSON.stringify({ input: {} });
    const result = await postRun(url, body);
    expect(result.status).toBe(200);
  });
});

describe("serve() — SUEDE_RELAY_SECRET set", () => {
  it("accepts POST /run with a valid x-suede-signature", async () => {
    const secret = "test-secret-32bytes-padding-12345";
    process.env.SUEDE_RELAY_SECRET = secret;

    const agent = makeAgent();
    const { url, handle } = await startOnFreePort(agent);
    activeHandle = handle;

    const body = JSON.stringify({ input: {} });
    const sig = signBody(body, secret);
    const result = await postRun(url, body, { "x-suede-signature": sig });
    expect(result.status).toBe(200);
  });

  it("rejects POST /run with a missing signature (401)", async () => {
    const secret = "test-secret-32bytes-padding-12345";
    process.env.SUEDE_RELAY_SECRET = secret;

    const agent = makeAgent();
    const { url, handle } = await startOnFreePort(agent);
    activeHandle = handle;

    const body = JSON.stringify({ input: {} });
    const result = await postRun(url, body);
    expect(result.status).toBe(401);
  });

  it("rejects POST /run with an invalid signature (401)", async () => {
    const secret = "test-secret-32bytes-padding-12345";
    process.env.SUEDE_RELAY_SECRET = secret;

    const agent = makeAgent();
    const { url, handle } = await startOnFreePort(agent);
    activeHandle = handle;

    const body = JSON.stringify({ input: {} });
    const result = await postRun(url, body, { "x-suede-signature": "sha256=badhex00badhex00" });
    expect(result.status).toBe(401);
  });
});
