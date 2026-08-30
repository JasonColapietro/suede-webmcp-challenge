import { beforeEach, describe, expect, it, vi } from "vitest";

const { initBotId } = vi.hoisted(() => ({
  initBotId: vi.fn(),
}));

vi.mock("botid/client/core", () => ({ initBotId }));

describe("BotID client configuration", () => {
  beforeEach(() => {
    vi.resetModules();
    initBotId.mockReset();
  });

  it("protects every POST route that performs server-side BotID verification", async () => {
    await import("@/instrumentation-client");

    expect(initBotId).toHaveBeenCalledOnce();
    expect(initBotId).toHaveBeenCalledWith({
      protect: [
        { path: "/api/guided", method: "POST" },
        { path: "/api/site-agent", method: "POST" },
        { path: "/api/site-agent/verify", method: "POST" },
        { path: "/api/companies/found", method: "POST" },
        { path: "/api/moderation/reports", method: "POST" },
      ],
    });
  });
});
