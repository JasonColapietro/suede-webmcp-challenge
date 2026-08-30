import { NextResponse } from "next/server";
import { getRepo } from "@/lib/db/repo";
import { resolveOperatingSystemAccess } from "@/lib/company/operating-system/authorization";
import { runOptimizeOperatorAudit, ProspectAdapterUnavailableError } from "@/lib/company/prospect-engine/adapters";
import { ProspectActionSchema, type ProspectRecord } from "@/lib/company/prospect-engine/contracts";
import {
  applyProspectAction,
  attachTrustedAudit,
  buildHandoffPresentation,
  createHandoffLease,
  recipientEmailDigest,
  ProspectTransitionError,
  validateProspectIntegrity,
} from "@/lib/company/prospect-engine/engine";
import { privateJson, readBoundedJsonRequest } from "@/lib/projects/api-response";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext { readonly params: Promise<{ id: string }> }

async function authorizedRecord(id: string): Promise<
  | { readonly ownerId: string; readonly record: ProspectRecord }
  | { readonly response: NextResponse }
> {
  const access = await resolveOperatingSystemAccess();
  if (access.kind === "signed-out") return { response: privateJson({ error: "Authentication required" }, 401) };
  if (access.kind === "forbidden") return { response: privateJson({ error: "not found" }, 404) };
  const record = await (await getRepo()).getProspect(id, access.ownerId);
  if (!record) return { response: privateJson({ error: "not found" }, 404) };
  return { ownerId: access.ownerId, record };
}

export async function GET(_request: Request, { params }: RouteContext): Promise<NextResponse> {
  try {
    const { id } = await params;
    const found = await authorizedRecord(id);
    if ("response" in found) return found.response;
    return privateJson({ prospect: validateProspectIntegrity(found.record) });
  } catch {
    return privateJson({ error: "prospect store unavailable" }, 503);
  }
}

export async function POST(request: Request, { params }: RouteContext): Promise<NextResponse> {
  try {
    const { id } = await params;
    const found = await authorizedRecord(id);
    if ("response" in found) return found.response;
    if (!found.record) return privateJson({ error: "not found" }, 404);
    const limited = checkRateLimit(`prospect-action:${found.ownerId}`, { capacity: 30, refillPerSec: 1 / 2 });
    if (!limited.allowed) return privateJson({ error: "rate limited" }, 429, { "Retry-After": String(limited.retryAfterSec) });
    const body = await readBoundedJsonRequest(request);
    if (!body.ok) return privateJson({ error: "invalid request" }, 400);
    const parsed = ProspectActionSchema.safeParse(body.data);
    if (!parsed.success) return privateJson({ error: "invalid request" }, 400);
    const repo = await getRepo();
    validateProspectIntegrity(found.record);

    const recipientEmail = parsed.data.action === "build-draft"
      ? parsed.data.recipientEmail
      : found.record.draft?.recipientEmail;
    if (
      recipientEmail
      && ["build-draft", "approve", "email-handoff", "confirm-delivery"].includes(parsed.data.action)
      && await repo.isProspectRecipientSuppressed(found.ownerId, recipientEmailDigest(recipientEmail))
    ) {
      return privateJson({ error: "recipient is suppressed for this workspace" }, 409);
    }

    if (parsed.data.action === "email-handoff") {
      const leased = createHandoffLease(found.record, parsed.data.idempotencyKey);
      const saved = leased === found.record
        ? found.record
        : await repo.updateProspectUnlessSuppressed(leased, found.record.revision, recipientEmailDigest(leased.draft!.recipientEmail));
      if (!saved) return privateJson({ error: "prospect changed; refresh and retry" }, 409);
      return privateJson(buildHandoffPresentation(saved));
    }

    let updated;
    if (parsed.data.action === "audit") {
      const requestedAt = new Date();
      const handoff = await runOptimizeOperatorAudit(found.record.websiteUrl);
      updated = attachTrustedAudit(found.record, handoff, requestedAt);
    } else {
      updated = applyProspectAction(found.record, parsed.data);
    }
    const digest = found.record.draft ? recipientEmailDigest(found.record.draft.recipientEmail) : null;
    const saved = digest && (parsed.data.action === "opt-out" || parsed.data.action === "suppress")
      ? await repo.suppressProspect(updated, found.record.revision, digest, parsed.data.action === "opt-out" ? "opt-out" : "operator")
      : digest && (parsed.data.action === "approve" || parsed.data.action === "confirm-delivery")
        ? await repo.updateProspectUnlessSuppressed(updated, found.record.revision, digest)
        : await repo.updateProspect(updated, found.record.revision);
    if (!saved) return privateJson({ error: "prospect changed; refresh and retry" }, 409);
    return privateJson({ prospect: saved });
  } catch (error: unknown) {
    if (error instanceof ProspectTransitionError) return privateJson({ error: error.message }, 409);
    if (error instanceof ProspectAdapterUnavailableError) return privateJson({ error: error.message }, 503);
    return privateJson({ error: "prospect action failed" }, 502);
  }
}

export async function DELETE(_request: Request, { params }: RouteContext): Promise<NextResponse> {
  try {
    const { id } = await params;
    const found = await authorizedRecord(id);
    if ("response" in found) return found.response;
    validateProspectIntegrity(found.record);
    const limited = checkRateLimit(`prospect-redact:${found.ownerId}`, { capacity: 10, refillPerSec: 1 / 10 });
    if (!limited.allowed) return privateJson({ error: "rate limited" }, 429, { "Retry-After": String(limited.retryAfterSec) });
    const redacted = await (await getRepo()).redactProspect(id, found.ownerId);
    if (!redacted) return privateJson({ error: "not found" }, 404);
    return privateJson({ redacted: true, suppressionRetained: true });
  } catch (error: unknown) {
    if (error instanceof ProspectTransitionError) return privateJson({ error: error.message }, 409);
    return privateJson({ error: "prospect redaction failed" }, 502);
  }
}
