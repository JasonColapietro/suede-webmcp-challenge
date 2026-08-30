import { NextResponse } from "next/server";
import { getRepo } from "@/lib/db/repo";
import { getProjectRepo } from "@/lib/projects/provider";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  invalidRequestResponse,
  privateJson,
  readBoundedJsonRequest,
} from "@/lib/projects/api-response";
import { resolveOperatingSystemAccess } from "@/lib/company/operating-system/authorization";
import { OperatingRefreshRequestSchema } from "@/lib/company/operating-system/schema";
import { buildOperatingSystemSnapshot } from "@/lib/company/operating-system/snapshot";

export const runtime = "nodejs";

async function projectRepoOrNull(): Promise<Awaited<ReturnType<typeof getProjectRepo>> | null> {
  try {
    return await getProjectRepo();
  } catch {
    return null;
  }
}

export async function GET(): Promise<NextResponse> {
  try {
    const access = await resolveOperatingSystemAccess();
    if (access.kind === "signed-out") {
      return privateJson({ error: "Authentication required" }, 401);
    }
    if (access.kind === "forbidden") {
      return privateJson({ error: "not found" }, 404);
    }
    const snapshot = await buildOperatingSystemSnapshot({
      ownerId: access.ownerId,
      companyRepo: await getRepo(),
      projectRepo: await projectRepoOrNull(),
    });
    return privateJson(snapshot);
  } catch {
    return privateJson({ error: "internal server error" }, 500);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const access = await resolveOperatingSystemAccess();
    if (access.kind === "signed-out") {
      return privateJson({ error: "Authentication required" }, 401);
    }
    if (access.kind === "forbidden") {
      return privateJson({ error: "not found" }, 404);
    }
    const limited = checkRateLimit(`operating-system-refresh:${access.ownerId}`, {
      capacity: 10,
      refillPerSec: 1 / 6,
    });
    if (!limited.allowed) {
      return privateJson(
        { error: "rate limited", retryAfterSec: limited.retryAfterSec },
        429,
        { "Retry-After": String(limited.retryAfterSec) },
      );
    }
    const body = await readBoundedJsonRequest(request);
    if (!body.ok) return invalidRequestResponse();
    const parsed = OperatingRefreshRequestSchema.safeParse(body.data);
    if (!parsed.success) return invalidRequestResponse();
    const snapshot = await buildOperatingSystemSnapshot({
      ownerId: access.ownerId,
      companyRepo: await getRepo(),
      projectRepo: await projectRepoOrNull(),
      ...(parsed.data.baseline ? { baseline: parsed.data.baseline } : {}),
    });
    return privateJson(snapshot);
  } catch {
    return privateJson({ error: "internal server error" }, 500);
  }
}
