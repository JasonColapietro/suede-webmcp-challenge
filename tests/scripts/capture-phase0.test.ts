import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  validateCaptureOutput,
  validateLocalBaseUrl,
  verifyIsolatedCaptureServer,
  writeNewCaptureManifest,
} from "../../scripts/capture-phase-0-lib.mjs";

describe("Phase 0 capture safety", () => {
  it.each([
    "http://127.0.0.1:3210",
    "http://localhost:3210",
    "http://[::1]:3210",
  ])("accepts the loopback origin %s", (value) => {
    expect(validateLocalBaseUrl(value).origin).toBe(value);
  });

  it.each([
    "https://agents.suedeai.ai",
    "https://example.com",
    "file:///tmp/app",
    "https://user:password@localhost:3210",
  ])("rejects the unsafe origin %s", (value) => {
    expect(() => validateLocalBaseUrl(value)).toThrow();
  });

  it("allows external output and refuses an existing manifest", () => {
    const output = join(tmpdir(), `suede-capture-${randomUUID()}`);
    mkdirSync(output, { recursive: true });
    try {
      const manifest = validateCaptureOutput(output);
      writeNewCaptureManifest(manifest, { first: true });
      expect(() => validateCaptureOutput(output)).toThrow("refusing to overwrite");
      expect(() => writeNewCaptureManifest(manifest, { second: true })).toThrow();
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  it("allows only the ignored artifact tree inside a repository", () => {
    const repository = join(tmpdir(), `suede-repo-${randomUUID()}`);
    mkdirSync(repository, { recursive: true });
    try {
      expect(() => validateCaptureOutput(join(repository, "screenshots"), repository)).toThrow(
        "must be under .artifacts",
      );
      expect(
        validateCaptureOutput(join(repository, ".artifacts", "phase0"), repository),
      ).toContain(".artifacts");
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it("resolves symlinked output parents before enforcing the repository boundary", () => {
    const root = join(tmpdir(), `suede-link-${randomUUID()}`);
    const repository = join(root, "repo");
    const inRepo = join(repository, "screenshots");
    const external = join(root, "external");
    mkdirSync(inRepo, { recursive: true });
    mkdirSync(external, { recursive: true });
    symlinkSync(inRepo, join(external, "linked-output"));
    try {
      expect(() =>
        validateCaptureOutput(join(external, "linked-output"), repository),
      ).toThrow("must be under .artifacts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires a positive disposable-runtime handshake", async () => {
    const baseUrl = validateLocalBaseUrl("http://127.0.0.1:3210");
    const fetchOk = vi.fn(async () =>
      new Response(JSON.stringify({ safe: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      verifyIsolatedCaptureServer(baseUrl, "12345678-1234-1234-1234-123456789012", fetchOk),
    ).resolves.toBeUndefined();
    expect(fetchOk).toHaveBeenCalledWith(
      "http://127.0.0.1:3210/api/verification/capture-session",
      expect.objectContaining({
        headers: { "x-suede-capture-session": "12345678-1234-1234-1234-123456789012" },
      }),
    );

    const fetchUnsafe = vi.fn(async () => new Response(null, { status: 404 }));
    await expect(
      verifyIsolatedCaptureServer(
        baseUrl,
        "12345678-1234-1234-1234-123456789012",
        fetchUnsafe,
        { attempts: 1, delayMs: 0 },
      ),
    ).rejects.toThrow("disposable SQLite runtime");
  });

  it("retries connection errors during local server cold start", async () => {
    const baseUrl = validateLocalBaseUrl("http://127.0.0.1:3210");
    const fetchCold = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ safe: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    await expect(
      verifyIsolatedCaptureServer(
        baseUrl,
        "12345678-1234-1234-1234-123456789012",
        fetchCold,
        { attempts: 3, delayMs: 0 },
      ),
    ).resolves.toBeUndefined();
    expect(fetchCold).toHaveBeenCalledTimes(3);
  });
});
