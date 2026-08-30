/**
 * POST /api/agents/[agent]/discovery/submit  { venue }
 *
 * Push an agent to one discovery venue and record the real result. What each
 * mechanism does:
 *  - push-github: open a real PR/issue via the GitHub REST API — but ONLY when
 *    GITHUB_DISTRIBUTION_TOKEN is configured. Absent → an honest 501, never a
 *    fake success.
 *  - auto / manual / paid: not push-able from here — 409 with a machine reason.
 *    Bazaar and Agentic.Market are settlement-driven, Satring costs money
 *    (human approval), and pay.sh has no public API; the console shows the
 *    relevant draft or settlement guidance instead.
 *
 * Auth mirrors the settlement route: a same-origin session cookie (with the
 * fetch-metadata + JSON contract) or an anonymous workspace Bearer key. Only
 * the agent's owner may submit.
 */
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { z } from "zod";
import { resolveOwnerId, SUEDE_OWNER_PREFIX, UnauthenticatedOwnerError } from "@/lib/auth";
import { getRepo } from "@/lib/db/repo";
import { resolveAgent } from "@/lib/agents";
import { buildCatalog, type CatalogEntry } from "@/lib/catalog";
import { readBoundedJsonRequest } from "@/lib/projects/api-response";
import { getVenue, type DiscoveryVenue } from "@/lib/distribution/venues";
import {
  buildAwesomeListLine,
  buildDiscoveryIssueBody,
  buildServiceDescriptor,
} from "@/lib/distribution/payloads";

export const runtime = "nodejs";

const SubmitBodySchema = z.object({ venue: z.string().min(1) });

interface RouteContext {
  params: Promise<{ agent: string }>;
}

const SUBMIT_TIMEOUT_MS = 15_000;
const GITHUB_API = "https://api.github.com";

function extractBearer(authHeader: string | null): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const key = authHeader.slice(7).trim();
  return key.length > 0 ? key : null;
}

/** Same-origin fetch-metadata + JSON contract for the cookie-session lane. */
function validateSessionMutation(req: Request): 403 | 415 | null {
  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(req.url).origin;
  } catch {
    return 403;
  }
  if (req.headers.get("origin") !== expectedOrigin) return 403;
  if (req.headers.get("sec-fetch-site") !== "same-origin") return 403;
  if (req.headers.has("content-encoding")) return 415;
  const contentType = req.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return contentType === "application/json" ? null : 415;
}

/** Not-push-able reason for auto/manual/paid venues. */
function nonPushReason(venue: DiscoveryVenue): { error: string; reason: string } {
  if (venue.mechanism === "paid") {
    return { error: "venue_requires_payment", reason: `${venue.id}_requires_payment` };
  }
  if (venue.mechanism === "manual") {
    return { error: "venue_is_manual", reason: "venue_is_manual" };
  }
  // auto (Bazaar and Agentic.Market)
  return { error: "venue_is_automatic", reason: `${venue.id}_is_automatic` };
}

interface GithubPushResult {
  ok: boolean;
  htmlUrl: string | null;
  reason?: string;
}

async function githubJson(
  path: string,
  token: string,
  init?: { method?: string; body?: unknown },
): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "suede-agent-studio-distribution",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
  });
  let data: Record<string, unknown> = {};
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    data = {};
  }
  return { status: res.status, data };
}

/**
 * Open a PR (append the generated line to a README section) or an issue. Only
 * called with a configured token. Direct-branch flow works when the token can
 * push to the target repo (e.g. a bot collaborator); a fork-first flow is a
 * later enhancement and is noted in the caller.
 */
async function pushGithub(
  venue: DiscoveryVenue,
  entries: readonly CatalogEntry[],
  token: string,
): Promise<GithubPushResult> {
  const gh = venue.github;
  if (!gh) return { ok: false, htmlUrl: null, reason: "venue_has_no_github_target" };
  const service = buildServiceDescriptor();

  try {
    if (gh.kind === "issue") {
      const created = await githubJson(`/repos/${gh.repo}/issues`, token, {
        method: "POST",
        body: {
          title: `Add ${service.name}: pay-per-call x402 agent flows (USDC on Base)`,
          body: buildDiscoveryIssueBody(service, entries),
        },
      });
      const htmlUrl = typeof created.data.html_url === "string" ? created.data.html_url : null;
      return created.status >= 200 && created.status < 300 && htmlUrl
        ? { ok: true, htmlUrl }
        : { ok: false, htmlUrl: null, reason: `github_http_${created.status}` };
    }

    // kind === "pr": read the target file, append the list line to the section,
    // commit on a new branch, open the PR.
    const file = gh.file ?? "README.md";
    const repoInfo = await githubJson(`/repos/${gh.repo}`, token);
    const baseBranch =
      typeof repoInfo.data.default_branch === "string" ? repoInfo.data.default_branch : "main";

    const current = await githubJson(
      `/repos/${gh.repo}/contents/${encodeURIComponent(file)}?ref=${encodeURIComponent(baseBranch)}`,
      token,
    );
    const sha = typeof current.data.sha === "string" ? current.data.sha : null;
    const encoded = typeof current.data.content === "string" ? current.data.content : null;
    if (!sha || encoded === null) {
      return { ok: false, htmlUrl: null, reason: `github_file_unreadable_${current.status}` };
    }
    const original = Buffer.from(encoded, "base64").toString("utf-8");
    const line = buildAwesomeListLine(service);
    if (original.includes(service.url)) {
      return { ok: false, htmlUrl: null, reason: "already_listed" };
    }
    const updated = insertLineIntoSection(original, gh.section, line);

    const headRef = await githubJson(
      `/repos/${gh.repo}/git/ref/heads/${encodeURIComponent(baseBranch)}`,
      token,
    );
    const headObject = headRef.data.object;
    const headSha =
      typeof headObject === "object" && headObject !== null && typeof (headObject as Record<string, unknown>).sha === "string"
        ? String((headObject as Record<string, unknown>).sha)
        : null;
    if (!headSha) return { ok: false, htmlUrl: null, reason: `github_ref_unreadable_${headRef.status}` };

    const branch = `suede-agent-studio-listing-${Date.now().toString(36)}`;
    const branchRes = await githubJson(`/repos/${gh.repo}/git/refs`, token, {
      method: "POST",
      body: { ref: `refs/heads/${branch}`, sha: headSha },
    });
    if (branchRes.status < 200 || branchRes.status >= 300) {
      return { ok: false, htmlUrl: null, reason: `github_branch_http_${branchRes.status}` };
    }

    const commitRes = await githubJson(`/repos/${gh.repo}/contents/${encodeURIComponent(file)}`, token, {
      method: "PUT",
      body: {
        message: `Add ${service.name} to ${gh.section ?? file}`,
        content: Buffer.from(updated, "utf-8").toString("base64"),
        sha,
        branch,
      },
    });
    if (commitRes.status < 200 || commitRes.status >= 300) {
      return { ok: false, htmlUrl: null, reason: `github_commit_http_${commitRes.status}` };
    }

    const pr = await githubJson(`/repos/${gh.repo}/pulls`, token, {
      method: "POST",
      body: {
        title: `Add ${service.name}: pay-per-call x402 agent flows (USDC on Base)`,
        head: branch,
        base: baseBranch,
        body: `Adds ${service.name} (${service.url}) to ${gh.section ?? file}.\n\n${line}`,
      },
    });
    const prUrl = typeof pr.data.html_url === "string" ? pr.data.html_url : null;
    return pr.status >= 200 && pr.status < 300 && prUrl
      ? { ok: true, htmlUrl: prUrl }
      : { ok: false, htmlUrl: null, reason: `github_pr_http_${pr.status}` };
  } catch (error) {
    return { ok: false, htmlUrl: null, reason: `github_error_${String(error).slice(0, 60)}` };
  }
}

/** Insert `line` after the last list item of the named section, else append. */
function insertLineIntoSection(content: string, section: string | undefined, line: string): string {
  if (!section) return content.trimEnd() + "\n" + line + "\n";
  const lines = content.split("\n");
  const headerIdx = lines.findIndex(
    (l) => /^#{1,6}\s/.test(l) && l.toLowerCase().includes(section.toLowerCase()),
  );
  if (headerIdx === -1) return content.trimEnd() + "\n" + line + "\n";
  let insertAt = headerIdx + 1;
  for (let i = headerIdx + 1; i < lines.length; i += 1) {
    if (/^#{1,6}\s/.test(lines[i])) break; // next heading ends the section
    if (lines[i].trim().startsWith("-")) insertAt = i + 1;
  }
  return [...lines.slice(0, insertAt), line, ...lines.slice(insertAt)].join("\n");
}

export async function POST(req: Request, { params }: RouteContext): Promise<NextResponse> {
  try {
    const h = await headers();
    const authorization = h.get("Authorization");
    const bearerOwner = extractBearer(authorization);
    if (authorization !== null && bearerOwner === null) {
      return NextResponse.json({ error: "Authorization required" }, { status: 401 });
    }
    if (bearerOwner?.startsWith(SUEDE_OWNER_PREFIX)) {
      return NextResponse.json({ error: "Authorization required" }, { status: 401 });
    }
    if (bearerOwner === null) {
      const failure = validateSessionMutation(req);
      if (failure === 403) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      if (failure === 415) return NextResponse.json({ error: "Unsupported media type" }, { status: 415 });
    }
    const ownerId = bearerOwner ?? (await resolveOwnerId());

    const raw = await readBoundedJsonRequest(req);
    if (!raw.ok) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    const parsed = SubmitBodySchema.safeParse(raw.data);
    if (!parsed.success) {
      return NextResponse.json({ error: "Body must be { venue: string }" }, { status: 400 });
    }

    const venue = getVenue(parsed.data.venue);
    if (!venue) return NextResponse.json({ error: "unknown_venue" }, { status: 400 });

    const { agent: agentParam } = await params;
    const agent = await resolveAgent(agentParam);
    if (!agent) return NextResponse.json({ error: "agent not found" }, { status: 404 });
    const repo = await getRepo();
    const flow = await repo.getFlow(agent.flowId);
    if (!flow || flow.ownerId !== ownerId) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    // Non-push mechanisms: honest 409, the console shows the draft/toggle.
    if (venue.mechanism !== "push-github") {
      return NextResponse.json(nonPushReason(venue), { status: 409 });
    }

    const catalog = await buildCatalog();
    const entry = catalog.find((e) => e.id === agent.id || e.slug === agent.slug);
    if (!entry) {
      return NextResponse.json(
        { error: "agent_not_public", reason: "agent_not_in_live_catalog" },
        { status: 409 },
      );
    }

    // ── push-github: real PR/issue, gated on a configured token ──────────
    const token = process.env.GITHUB_DISTRIBUTION_TOKEN?.trim();
    if (!token) {
      return NextResponse.json({ error: "github_automation_not_configured" }, { status: 501 });
    }
    const result = await pushGithub(venue, catalog, token);
    if (result.ok && result.htmlUrl) {
      const listing = await repo.upsertAgentListing({
        agentId: agent.id,
        venueId: venue.id,
        status: "submitted",
        externalUrl: result.htmlUrl,
      });
      return NextResponse.json({ venue: venue.id, status: listing.status, externalUrl: listing.externalUrl });
    }
    await repo.upsertAgentListing({ agentId: agent.id, venueId: venue.id, status: "failed", externalUrl: null });
    return NextResponse.json(
      { error: "github_submission_failed", reason: result.reason ?? "unknown" },
      { status: 502 },
    );
  } catch (error: unknown) {
    if (error instanceof UnauthenticatedOwnerError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    // Opaque 500: raw error.message can leak DB/provider internals (same
    // rationale as /api/agents/[agent]/run). Log server-side instead.
    console.error("agents discovery submit route failed", error);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
