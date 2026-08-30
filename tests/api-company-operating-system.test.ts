import { beforeEach, describe, expect, it, vi } from "vitest";
import { OperatingSystemSnapshotSchema } from "@/lib/company/operating-system/schema";
import { SqliteRepo } from "@/lib/db/sqlite-repo";

const state = vi.hoisted(() => ({
  ownerId: "sb:route-owner",
  resolveOperatingSystemAccess: vi.fn(),
  getRepo: vi.fn(),
  getProjectRepo: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/company/operating-system/authorization", () => ({
  resolveOperatingSystemAccess: () => state.resolveOperatingSystemAccess(),
}));
vi.mock("@/lib/db/repo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/repo")>()),
  getRepo: () => state.getRepo(),
}));
vi.mock("@/lib/projects/provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/projects/provider")>()),
  getProjectRepo: () => state.getProjectRepo(),
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  checkRateLimit: () => state.checkRateLimit(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  state.resolveOperatingSystemAccess.mockResolvedValue({
    kind: "authorized",
    ownerId: state.ownerId,
  });
  state.getRepo.mockResolvedValue(new SqliteRepo(":memory:"));
  state.getProjectRepo.mockRejectedValue(new Error("project store unavailable"));
  state.checkRateLimit.mockReturnValue({ allowed: true, retryAfterSec: 0 });
});

describe("/api/companies/operating-system", () => {
  it("requires a verified Suede account owner", async () => {
    state.resolveOperatingSystemAccess.mockResolvedValueOnce({ kind: "signed-out" });
    const { GET } = await import("@/app/api/companies/operating-system/route");

    const response = await GET();

    expect(response.status).toBe(401);
    expect(state.getRepo).not.toHaveBeenCalled();
  });

  it("conceals the internal portfolio from authenticated non-operators", async () => {
    state.resolveOperatingSystemAccess.mockResolvedValueOnce({ kind: "forbidden" });
    const { GET } = await import("@/app/api/companies/operating-system/route");

    const response = await GET();

    expect(response.status).toBe(404);
    expect(state.getRepo).not.toHaveBeenCalled();
  });

  it("returns a bounded Zod-valid owner-scoped snapshot", async () => {
    const { GET } = await import("@/app/api/companies/operating-system/route");

    const response = await GET();
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(OperatingSystemSnapshotSchema.safeParse(body).success).toBe(true);
    expect(JSON.stringify(body)).not.toContain(state.ownerId);
  });

  it("rejects malformed refresh baselines and rate-limits repeated reviews", async () => {
    const { POST } = await import("@/app/api/companies/operating-system/route");
    const invalid = await POST(new Request(
      "https://agents.suedeai.ai/api/companies/operating-system",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseline: { snapshotId: "not-a-hash" } }),
      },
    ));
    expect(invalid.status).toBe(400);

    state.checkRateLimit.mockReturnValueOnce({ allowed: false, retryAfterSec: 6 });
    const limited = await POST(new Request(
      "https://agents.suedeai.ai/api/companies/operating-system",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    ));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("6");
  });
});
