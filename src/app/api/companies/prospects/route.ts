import { NextResponse } from "next/server";
import { getRepo } from "@/lib/db/repo";
import { resolveOperatingSystemAccess } from "@/lib/company/operating-system/authorization";
import { createProspectRecord } from "@/lib/company/prospect-engine/engine";
import { ImportProspectRequestSchema } from "@/lib/company/prospect-engine/contracts";
import { privateJson, readBoundedJsonRequest } from "@/lib/projects/api-response";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROSPECT_STORE_WRITE_TIMEOUT_MS = 8_000;

async function withProspectStoreWriteDeadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Prospect store write timed out")),
          PROSPECT_STORE_WRITE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function accessResponse(): Promise<
  | { readonly ownerId: string }
  | { readonly response: NextResponse }
> {
  const access = await resolveOperatingSystemAccess();
  if (access.kind === "signed-out") return { response: privateJson({ error: "Authentication required" }, 401) };
  if (access.kind === "forbidden") return { response: privateJson({ error: "not found" }, 404) };
  return { ownerId: access.ownerId };
}

export async function GET(): Promise<NextResponse> {
  try {
    const access = await accessResponse();
    if ("response" in access) return access.response;
    return privateJson({ prospects: await (await getRepo()).listProspects(access.ownerId) });
  } catch {
    return privateJson({ error: "prospect store unavailable" }, 503);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const access = await accessResponse();
    if ("response" in access) return access.response;
    const limited = checkRateLimit(`prospect-import:${access.ownerId}`, { capacity: 20, refillPerSec: 1 / 3 });
    if (!limited.allowed) return privateJson({ error: "rate limited" }, 429, { "Retry-After": String(limited.retryAfterSec) });
    const body = await readBoundedJsonRequest(request);
    if (!body.ok) return privateJson({ error: "invalid request" }, 400);
    const parsed = ImportProspectRequestSchema.safeParse(body.data);
    if (!parsed.success) return privateJson({ error: "invalid request" }, 400);
    const prospect = createProspectRecord({
      ownerId: access.ownerId,
      websiteUrl: parsed.data.websiteUrl,
      source: parsed.data.source,
    });
    await withProspectStoreWriteDeadline(
      getRepo().then((repo) => repo.createProspect(prospect)),
    );
    return privateJson({ prospect }, 201);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (message.includes("unique") || message.includes("duplicate")) {
      return privateJson({ error: "A prospect for this domain already exists." }, 409);
    }
    return privateJson({ error: "prospect store unavailable" }, 503);
  }
}
