import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/verification/capture-session/route";

const SESSION = "12345678-1234-1234-1234-123456789012";

afterEach(() => vi.unstubAllEnvs());

function configureSafeRuntime(): void {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("DB_DRIVER", "sqlite");
  vi.stubEnv("SQLITE_PATH", join(tmpdir(), "suede-phase0-route", "capture.db"));
  vi.stubEnv("X402_SKIP_SETTLEMENT", "true");
  vi.stubEnv("PHASE0_CAPTURE_SESSION", SESSION);
}

describe("capture-session proof endpoint", () => {
  it("confirms the matching isolated local runtime", async () => {
    configureSafeRuntime();
    const response = await GET(
      new Request("http://127.0.0.1/api/verification/capture-session", {
        headers: { "x-suede-capture-session": SESSION },
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ safe: true });
  });

  it("fails closed for a wrong token or unsafe database", async () => {
    configureSafeRuntime();
    const wrongToken = await GET(
      new Request("http://127.0.0.1/api/verification/capture-session", {
        headers: { "x-suede-capture-session": "wrong-but-long-enough-token" },
      }),
    );
    expect(wrongToken.status).toBe(404);

    vi.stubEnv("SQLITE_PATH", "/Users/example/studio.db");
    const unsafePath = await GET(
      new Request("http://127.0.0.1/api/verification/capture-session", {
        headers: { "x-suede-capture-session": SESSION },
      }),
    );
    expect(unsafePath.status).toBe(404);
  });
});
