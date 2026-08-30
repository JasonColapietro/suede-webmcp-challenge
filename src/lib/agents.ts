/** Resolve an agent by id or slug (routes accept either). Server-only. */
import { getRepo } from "./db/repo";
import type { AgentRecord } from "./db/repo";

export async function resolveAgent(idOrSlug: string): Promise<AgentRecord | null> {
  const repo = await getRepo();
  return (await repo.getAgent(idOrSlug)) ?? (await repo.getAgentBySlug(idOrSlug));
}
