import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProspectRecord } from "@/lib/company/prospect-engine/contracts";
import {
  applyProspectAction,
  attachTrustedAudit,
  createProspectRecord,
  recipientEmailDigest,
} from "@/lib/company/prospect-engine/engine";
import type { ScanDiagnosticHandoff } from "@/lib/company/operating-system/outbound-diagnostic";
import { SqliteRepo } from "@/lib/db/sqlite-repo";

vi.mock("server-only", () => ({}));
process.env.PROSPECT_SUPPRESSION_HMAC_SECRET = "x".repeat(32);

const state = vi.hoisted(() => ({
  ownerId: "sb:prospect-route-owner",
  resolveOperatingSystemAccess: vi.fn(),
  getRepo: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/company/operating-system/authorization", () => ({
  resolveOperatingSystemAccess: () => state.resolveOperatingSystemAccess(),
}));
vi.mock("@/lib/db/repo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/repo")>()),
  getRepo: () => state.getRepo(),
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  checkRateLimit: (...args: unknown[]) => state.checkRateLimit(...args),
}));

const originalPlacesKey = process.env.GOOGLE_PLACES_API_KEY;
const T0 = new Date("2026-08-04T12:00:00.000Z");
const handoff: ScanDiagnosticHandoff = {
  kind: "suede.audit.prospect",
  version: 1,
  source: "suede-audit",
  domain: "fixture.example.com",
  auditedUrl: "https://fixture.example.com/",
  observedAt: "2026-08-04T12:00:00.500Z",
  totalFindings: 1,
  omittedCount: 0,
  findings: [{
    id: "broken-link-about",
    kind: "site-integrity",
    lane: "Links",
    title: "Broken About link",
    priority: "high",
    observed: "The About link returns HTTP 404.",
    action: "Replace the broken destination.",
  }],
};

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`https://agents.suedeai.ai${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function context(id: string): { readonly params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function fixtureRecord(ownerId = state.ownerId, websiteUrl = "https://fixture.example.com/"): ProspectRecord {
  return createProspectRecord({
    ownerId,
    websiteUrl,
    source: { kind: "manual" },
    now: T0,
  });
}

function approvedRecord(websiteUrl = "https://fixture.example.com/"): ProspectRecord {
  const domain = new URL(websiteUrl).hostname;
  const scopedHandoff = { ...handoff, domain, auditedUrl: websiteUrl };
  const audited = attachTrustedAudit(fixtureRecord(state.ownerId, websiteUrl), scopedHandoff, T0, new Date(T0.getTime() + 1_000));
  const reproduced = applyProspectAction(audited, {
    action: "reproduce",
    sourceUrl: websiteUrl,
    operatorNote: "Confirmed the About link returns HTTP 404 from the public homepage.",
  }, new Date(T0.getTime() + 2_000));
  const repaired = applyProspectAction(reproduced, {
    action: "prepare-repair",
    primaryFindingId: "broken-link-about",
    preparedRepair: "Replace the broken About link target with the verified public About page.",
    verificationStep: "Open About from the homepage and confirm a successful response.",
  }, new Date(T0.getTime() + 3_000));
  const drafted = applyProspectAction(repaired, {
    action: "build-draft",
    recipientEmail: "owner@fixture.example.com",
    recipientName: "Morgan",
    postalAddress: "123 Example Street, Tampa, FL 33602",
    contactSource: "Public business contact page",
    jurisdiction: "united-states",
    recipientType: "corporate-business",
    suppressionChecked: true,
    optOutMonitored: true,
    outreachRulesReviewed: true,
  }, new Date(T0.getTime() + 4_000));
  return applyProspectAction(
    drafted,
    { action: "approve", suppressionChecked: true },
    new Date(T0.getTime() + 5_000),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(T0.getTime() + 10_000));
  delete process.env.GOOGLE_PLACES_API_KEY;
  state.resolveOperatingSystemAccess.mockResolvedValue({
    kind: "authorized",
    ownerId: state.ownerId,
  });
  state.getRepo.mockResolvedValue(new SqliteRepo(":memory:"));
  state.checkRateLimit.mockReturnValue({ allowed: true, retryAfterSec: 0 });
});

afterEach(() => vi.useRealTimers());

afterAll(() => {
  if (originalPlacesKey === undefined) delete process.env.GOOGLE_PLACES_API_KEY;
  else process.env.GOOGLE_PLACES_API_KEY = originalPlacesKey;
});

describe("Prospect Engine API routes", () => {
  it("returns private 401 for signed-out users and concealed 404 for non-operators", async () => {
    const { GET } = await import("@/app/api/companies/prospects/route");
    state.resolveOperatingSystemAccess.mockResolvedValueOnce({ kind: "signed-out" });
    const signedOut = await GET();
    expect(signedOut.status).toBe(401);
    expect(signedOut.headers.get("cache-control")).toContain("no-store");

    state.resolveOperatingSystemAccess.mockResolvedValueOnce({ kind: "forbidden" });
    const forbidden = await GET();
    expect(forbidden.status).toBe(404);
    expect(state.getRepo).not.toHaveBeenCalled();
  });

  it("strictly imports public websites and deduplicates the owner-domain pair", async () => {
    const { POST } = await import("@/app/api/companies/prospects/route");
    const invalid = await POST(jsonRequest("/api/companies/prospects", {
      websiteUrl: "http://127.0.0.1/?secret=yes",
      source: { kind: "manual" },
    }));
    expect(invalid.status).toBe(400);

    const created = await POST(jsonRequest("/api/companies/prospects", {
      websiteUrl: "https://fixture.example.com/",
      source: { kind: "manual" },
    }));
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toContain("private");
    expect(created.headers.get("cache-control")).toContain("no-store");

    const duplicate = await POST(jsonRequest("/api/companies/prospects", {
      websiteUrl: "https://fixture.example.com/about",
      source: { kind: "manual" },
    }));
    expect(duplicate.status).toBe(409);
  });

  it("returns a private application error when the prospect store stops responding", async () => {
    const repo = new SqliteRepo(":memory:");
    vi.spyOn(repo, "createProspect").mockImplementation(() => new Promise(() => {}));
    state.getRepo.mockResolvedValue(repo);
    const { POST } = await import("@/app/api/companies/prospects/route");

    let response: Response | undefined;
    void POST(jsonRequest("/api/companies/prospects", {
      websiteUrl: "https://stalled.example.com/",
      source: { kind: "manual" },
    })).then((value) => { response = value; });

    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.resolve();

    expect(response?.status).toBe(503);
    expect(response?.headers.get("cache-control")).toContain("no-store");
  });

  it("conceals cross-owner records from reads and actions", async () => {
    const repo = new SqliteRepo(":memory:");
    const record = fixtureRecord("sb:other-owner");
    await repo.createProspect(record);
    state.getRepo.mockResolvedValue(repo);
    const route = await import("@/app/api/companies/prospects/[id]/route");

    const read = await route.GET(
      new Request(`https://agents.suedeai.ai/api/companies/prospects/${record.id}`),
      context(record.id),
    );
    expect(read.status).toBe(404);

    const action = await route.POST(
      jsonRequest(`/api/companies/prospects/${record.id}`, { action: "email-handoff", idempotencyKey: "cross-owner-key" }),
      context(record.id),
    );
    expect(action.status).toBe(404);
  });

  it("requires an approval for email handoff and reports optimistic conflicts", async () => {
    const repo = new SqliteRepo(":memory:");
    const discovered = fixtureRecord();
    await repo.createProspect(discovered);
    state.getRepo.mockResolvedValue(repo);
    const route = await import("@/app/api/companies/prospects/[id]/route");
    const handoffResponse = await route.POST(
      jsonRequest(`/api/companies/prospects/${discovered.id}`, { action: "email-handoff", idempotencyKey: "approval-required-key" }),
      context(discovered.id),
    );
    expect(handoffResponse.status).toBe(409);

    const audited = attachTrustedAudit(discovered, handoff, T0, new Date(T0.getTime() + 1_000));
    await repo.updateProspect(audited, discovered.revision);
    vi.spyOn(repo, "updateProspect").mockResolvedValueOnce(null);
    const conflict = await route.POST(
      jsonRequest(`/api/companies/prospects/${discovered.id}`, {
        action: "reproduce",
        sourceUrl: "https://fixture.example.com/",
        operatorNote: "Confirmed the public About link returns HTTP 404.",
      }),
      context(discovered.id),
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "prospect changed; refresh and retry" });
  });

  it("confirms the same approved delivery idempotently without a provider claim", async () => {
    const repo = new SqliteRepo(":memory:");
    const approved = approvedRecord();
    await repo.createProspect(approved);
    state.getRepo.mockResolvedValue(repo);
    const { POST } = await import("@/app/api/companies/prospects/[id]/route");
    const lease = await POST(
      jsonRequest(`/api/companies/prospects/${approved.id}`, { action: "email-handoff", idempotencyKey: "route-confirm-0001" }),
      context(approved.id),
    );
    const leaseBody = await lease.json() as { approvalDigest: string; handoffDigest: string };
    expect(lease.status).toBe(200);
    const action = {
      action: "confirm-delivery",
      approvalDigest: leaseBody.approvalDigest,
      handoffDigest: leaseBody.handoffDigest,
      recipientEmail: approved.draft?.recipientEmail,
      idempotencyKey: "route-confirm-0001",
    };

    const first = await POST(
      jsonRequest(`/api/companies/prospects/${approved.id}`, action),
      context(approved.id),
    );
    const firstBody = await first.json() as { prospect: ProspectRecord };
    expect(first.status).toBe(200);
    expect(firstBody.prospect.delivery?.providerDeliveryClaimed).toBe(false);

    const retry = await POST(
      jsonRequest(`/api/companies/prospects/${approved.id}`, action),
      context(approved.id),
    );
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(firstBody);
  });

  it("suppresses the same normalized recipient across domains and retains it after redaction", async () => {
    const repo = new SqliteRepo(":memory:");
    const first = approvedRecord();
    const second = approvedRecord("https://alternate.example.net/");
    await repo.createProspect(first); await repo.createProspect(second);
    state.getRepo.mockResolvedValue(repo);
    const route = await import("@/app/api/companies/prospects/[id]/route");
    const lease = await route.POST(jsonRequest(`/api/companies/prospects/${first.id}`, {
      action: "email-handoff", idempotencyKey: "suppression-route-0001",
    }), context(first.id));
    const leaseBody = await lease.json() as { approvalDigest: string; handoffDigest: string };
    expect((await route.POST(jsonRequest(`/api/companies/prospects/${first.id}`, {
      action: "confirm-delivery", approvalDigest: leaseBody.approvalDigest,
      handoffDigest: leaseBody.handoffDigest, recipientEmail: "OWNER@fixture.example.com ",
      idempotencyKey: "suppression-route-0001",
    }), context(first.id))).status).toBe(200);
    expect((await route.POST(jsonRequest(`/api/companies/prospects/${first.id}`, {
      action: "opt-out", note: "Recipient opted out.",
    }), context(first.id))).status).toBe(200);
    expect(await repo.isProspectRecipientSuppressed(state.ownerId, recipientEmailDigest(" owner@fixture.example.com"))).toBe(true);
    expect((await route.POST(jsonRequest(`/api/companies/prospects/${second.id}`, {
      action: "email-handoff", idempotencyKey: "suppression-route-0002",
    }), context(second.id))).status).toBe(409);
    expect((await route.DELETE(new Request(`https://agents.suedeai.ai/api/companies/prospects/${first.id}`, { method: "DELETE" }), context(first.id))).status).toBe(200);
    expect(await repo.getProspect(first.id, state.ownerId)).toBeNull();
    expect(await repo.isProspectRecipientSuppressed(state.ownerId, recipientEmailDigest("owner@fixture.example.com"))).toBe(true);
  });

  it("fails optional discovery closed while preserving manual import", async () => {
    const { POST } = await import("@/app/api/companies/prospects/discover/route");
    const response = await POST(jsonRequest("/api/companies/prospects/discover", {
      query: "roofers in Tampa",
    }));
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toMatchObject({ manualImportAvailable: true });
  });
});
