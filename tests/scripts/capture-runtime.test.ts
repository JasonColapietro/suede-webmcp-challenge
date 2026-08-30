import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isSafeCaptureRuntime } from "@/lib/verification/capture-runtime";

const SAFE_SESSION = "12345678-1234-1234-1234-123456789012";

describe("capture runtime proof", () => {
  it("accepts only a non-production dry-run SQLite database under the temp root", () => {
    expect(
      isSafeCaptureRuntime({
        NODE_ENV: "development",
        DB_DRIVER: "sqlite",
        SQLITE_PATH: join(tmpdir(), "suede-phase0-test", "capture.db"),
        X402_SKIP_SETTLEMENT: "true",
        PHASE0_CAPTURE_SESSION: SAFE_SESSION,
      }),
    ).toBe(true);
  });

  it.each([
    { NODE_ENV: "production" },
    { DB_DRIVER: "supabase" },
    { SQLITE_PATH: "studio.db" },
    { SQLITE_PATH: "/Users/example/studio.db" },
    { X402_SKIP_SETTLEMENT: "false" },
    { PHASE0_CAPTURE_SESSION: "short" },
  ])("rejects unsafe override $NODE_ENV$DB_DRIVER$SQLITE_PATH", (override) => {
    expect(
      isSafeCaptureRuntime({
        NODE_ENV: "development",
        DB_DRIVER: "sqlite",
        SQLITE_PATH: join(tmpdir(), "suede-phase0-test", "capture.db"),
        X402_SKIP_SETTLEMENT: "true",
        PHASE0_CAPTURE_SESSION: SAFE_SESSION,
        ...override,
      }),
    ).toBe(false);
  });
});
