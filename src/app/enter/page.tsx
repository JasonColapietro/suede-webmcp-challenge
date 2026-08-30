import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getRepo } from "@/lib/db/repo";
import { noIndexFollowMetadata } from "@/lib/seo-metadata";
import { requireStudioAccount } from "@/lib/studio-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const metadata: Metadata = noIndexFollowMetadata("/enter");

export default async function EnterPage(): Promise<never> {
  const account = await requireStudioAccount("/enter");
  if (account === null) return redirect("/flows");

  const flows = await (await getRepo()).listFlows(account.ownerId);
  return redirect(flows.length > 0 ? "/flows" : "/start");
}
