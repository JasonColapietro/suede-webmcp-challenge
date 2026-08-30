import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

// We test the gateway client against a local stub server
// so no real network calls happen in tests.

let stubServer: http.Server;
let stubUrl: string;
let lastRequest: { headers: Record<string, string>; body: unknown } | null = null;
let stubResponse: { status: number; body: unknown } = { status: 200, body: { text: "hello from stub" } };

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      stubServer = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (chunk: Buffer) => {
          raw += chunk.toString();
        });
        req.on("end", () => {
          lastRequest = {
            headers: req.headers as Record<string, string>,
            body: raw ? (JSON.parse(raw) as unknown) : null,
          };
          res.writeHead(stubResponse.status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(stubResponse.body));
        });
      });
      stubServer.listen(0, "127.0.0.1", () => {
        const { port } = stubServer.address() as AddressInfo;
        stubUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    }),
);

afterAll(
  () =>
    new Promise<void>((resolve) => {
      stubServer.close(() => resolve());
    }),
);

describe("suede.llm — SUEDE_GATEWAY_STUB mode", () => {
  it("echoes system + prompt without network when SUEDE_GATEWAY_STUB=1", async () => {
    process.env["SUEDE_GATEWAY_STUB"] = "1";
    delete process.env["SUEDE_API_URL"];
    delete process.env["SUEDE_WORKSPACE_KEY"];

    const { suede } = await import("../src/gateway.js");
    const result = await suede.llm({ system: "You are helpful.", prompt: "Say hi." });
    expect(result.text).toContain("You are helpful.");
    expect(result.text).toContain("Say hi.");

    delete process.env["SUEDE_GATEWAY_STUB"];
  });
});

describe("suede.run — SUEDE_GATEWAY_STUB mode", () => {
  it("returns config as output in stub mode", async () => {
    process.env["SUEDE_GATEWAY_STUB"] = "1";

    const { suede } = await import("../src/gateway.js");
    const result = await suede.run("llm", { prompt: "hello" });
    expect(result.output).toEqual({ prompt: "hello" });

    delete process.env["SUEDE_GATEWAY_STUB"];
  });

  it("works with no config argument (defaults to empty object)", async () => {
    process.env["SUEDE_GATEWAY_STUB"] = "1";

    const { suede } = await import("../src/gateway.js");
    const result = await suede.run("input");
    expect(result.output).toEqual({});

    delete process.env["SUEDE_GATEWAY_STUB"];
  });
});

describe("suede.llm — real HTTP client against stub server", () => {
  it("POSTs to /api/gateway/llm with Authorization header", async () => {
    delete process.env["SUEDE_GATEWAY_STUB"];
    process.env["SUEDE_API_URL"] = stubUrl;
    process.env["SUEDE_WORKSPACE_KEY"] = "test-key-123";
    stubResponse = { status: 200, body: { text: "price is 42" } };

    // Re-import to pick up new env (gateway reads env at call time)
    const { suede } = await import("../src/gateway.js");
    const result = await suede.llm({ system: "Extract price.", prompt: "The price is $42." });

    expect(result.text).toBe("price is 42");
    expect(lastRequest?.headers["authorization"]).toBe("Bearer test-key-123");
    const body = lastRequest?.body as { system: string; prompt: string };
    expect(body.system).toBe("Extract price.");
    expect(body.prompt).toBe("The price is $42.");
  });

  it("throws GatewayError with status 401 on missing/invalid key", async () => {
    delete process.env["SUEDE_GATEWAY_STUB"];
    process.env["SUEDE_API_URL"] = stubUrl;
    process.env["SUEDE_WORKSPACE_KEY"] = "bad-key";
    stubResponse = { status: 401, body: { error: "unauthorized" } };

    const { suede, GatewayError } = await import("../src/gateway.js");
    await expect(suede.llm({ system: "s", prompt: "p" })).rejects.toThrow(GatewayError);
    await expect(suede.llm({ system: "s", prompt: "p" })).rejects.toMatchObject({ status: 401 });
  });

  it("throws GatewayError with status 429 on rate limit", async () => {
    delete process.env["SUEDE_GATEWAY_STUB"];
    process.env["SUEDE_API_URL"] = stubUrl;
    process.env["SUEDE_WORKSPACE_KEY"] = "test-key";
    stubResponse = { status: 429, body: { error: "rate limit exceeded" } };

    const { suede, GatewayError } = await import("../src/gateway.js");
    await expect(suede.llm({ system: "s", prompt: "p" })).rejects.toThrow(GatewayError);
    await expect(suede.llm({ system: "s", prompt: "p" })).rejects.toMatchObject({ status: 429 });
  });

  it("throws GatewayError with status 402 on insufficient credit", async () => {
    delete process.env["SUEDE_GATEWAY_STUB"];
    process.env["SUEDE_API_URL"] = stubUrl;
    process.env["SUEDE_WORKSPACE_KEY"] = "test-key";
    stubResponse = { status: 402, body: { error: "insufficient credit" } };

    const { suede, GatewayError } = await import("../src/gateway.js");
    await expect(suede.llm({ system: "s", prompt: "p" })).rejects.toThrow(GatewayError);
    await expect(suede.llm({ system: "s", prompt: "p" })).rejects.toMatchObject({ status: 402 });
  });
});
