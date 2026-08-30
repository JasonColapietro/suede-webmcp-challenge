import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireStudioAccount: vi.fn(),
  getRepo: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("@/lib/studio-auth", () => ({
  requireStudioAccount: mocks.requireStudioAccount,
}));
vi.mock("@/lib/db/repo", () => ({ getRepo: mocks.getRepo }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import EnterPage, {
  dynamic,
  metadata,
  runtime,
} from "@/app/enter/page";

class RedirectSignal extends Error {
  constructor(readonly target: string) {
    super(`redirect:${target}`);
  }
}

describe("/enter account resolver", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.redirect.mockImplementation((target: string) => {
      throw new RedirectSignal(target);
    });
  });

  it("is a dynamic Node route that search engines do not index", () => {
    expect(runtime).toBe("nodejs");
    expect(dynamic).toBe("force-dynamic");
    expect(metadata.robots).toMatchObject({ index: false, follow: true });
  });

  it("leaves signed-out handling to the shared account guard", async () => {
    const signInRedirect = new RedirectSignal("shared-sign-in");
    mocks.requireStudioAccount.mockRejectedValue(signInRedirect);

    await expect(EnterPage()).rejects.toBe(signInRedirect);

    expect(mocks.requireStudioAccount).toHaveBeenCalledWith("/enter");
    expect(mocks.getRepo).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("waits for strict workspace adoption before listing verified-owner flows", async () => {
    let finishAdoption: ((account: { readonly ownerId: string }) => void) | undefined;
    mocks.requireStudioAccount.mockImplementation(
      () => new Promise((resolve) => {
        finishAdoption = resolve;
      }),
    );
    const listFlows = vi.fn().mockResolvedValue([{ id: "flow-1" }]);
    mocks.getRepo.mockResolvedValue({ listFlows });

    const result = EnterPage();
    await Promise.resolve();
    expect(mocks.getRepo).not.toHaveBeenCalled();

    if (!finishAdoption) throw new Error("guard was not awaited");
    finishAdoption({ ownerId: "sb:user-1" });
    await expect(result).rejects.toMatchObject({ target: "/flows" });

    expect(listFlows).toHaveBeenCalledWith("sb:user-1");
    expect(mocks.redirect).toHaveBeenCalledWith("/flows");
  });

  it("sends a verified owner with no flows to Guided", async () => {
    mocks.requireStudioAccount.mockResolvedValue({ ownerId: "sb:new-user" });
    const listFlows = vi.fn().mockResolvedValue([]);
    mocks.getRepo.mockResolvedValue({ listFlows });

    await expect(EnterPage()).rejects.toMatchObject({ target: "/start" });

    expect(listFlows).toHaveBeenCalledWith("sb:new-user");
    expect(mocks.redirect).toHaveBeenCalledWith("/start");
  });

  it("keeps the Android access-only host inside its existing flows surface", async () => {
    mocks.requireStudioAccount.mockResolvedValue(null);

    await expect(EnterPage()).rejects.toMatchObject({ target: "/flows" });

    expect(mocks.getRepo).not.toHaveBeenCalled();
    expect(mocks.redirect).toHaveBeenCalledWith("/flows");
  });

  it("propagates repository failure without misclassifying the owner as new", async () => {
    const unavailable = new Error("database unavailable");
    mocks.requireStudioAccount.mockResolvedValue({ ownerId: "sb:user-1" });
    const listFlows = vi.fn().mockRejectedValue(unavailable);
    mocks.getRepo.mockResolvedValue({ listFlows });

    await expect(EnterPage()).rejects.toBe(unavailable);

    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
