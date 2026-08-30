import type { FlowProjectContext, ProjectRepo } from "./repo";

export class ProjectStoreUnavailableError extends Error {
  constructor() {
    super("Project store unavailable");
    this.name = "ProjectStoreUnavailableError";
  }
}

interface ProjectRepoCache {
  readonly driver: "sqlite" | "supabase";
  readonly configuration: string;
  readonly promise: Promise<ProjectRepo>;
}

let cachedRepo: ProjectRepoCache | null = null;

async function initializeSqliteProjectRepo(sqlitePath: string): Promise<ProjectRepo> {
  const { SqliteProjectRepo } = await import("./sqlite-project-repo");
  return new SqliteProjectRepo(sqlitePath);
}

async function initializeSupabaseProjectRepo(): Promise<ProjectRepo> {
  const { SupabaseProjectRepo } = await import("./supabase-project-repo");
  return new SupabaseProjectRepo();
}

export function getProjectRepo(): Promise<ProjectRepo> {
  const driver = process.env.DB_DRIVER ?? "sqlite";
  if (driver !== "sqlite" && driver !== "supabase") {
    return Promise.reject(new ProjectStoreUnavailableError());
  }

  const sqlitePath = process.env.SQLITE_PATH ?? "studio.db";
  const supabaseUrl = process.env.SUPABASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    process.env.SUPABASE_ANON_KEY?.trim() ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() || "";
  const configuration = driver === "sqlite"
    ? sqlitePath
    : JSON.stringify([
        supabaseUrl,
        supabaseKey,
        process.env.AGENT_STUDIO_DB_SECRET ?? "",
      ]);
  if (cachedRepo) {
    if (cachedRepo.driver !== driver || cachedRepo.configuration !== configuration) {
      return Promise.reject(new ProjectStoreUnavailableError());
    }
    return cachedRepo.promise;
  }

  const initialization = driver === "sqlite"
    ? initializeSqliteProjectRepo(sqlitePath)
    : initializeSupabaseProjectRepo();
  const guarded = initialization.catch((error: unknown) => {
    if (
      cachedRepo?.promise === guarded &&
      cachedRepo.driver === driver &&
      cachedRepo.configuration === configuration
    ) {
      cachedRepo = null;
    }
    throw error;
  });
  cachedRepo = { driver, configuration, promise: guarded };
  return guarded;
}

export async function ensureOwnedFlowContext(input: {
  readonly repo: ProjectRepo;
  readonly flowId: string;
  readonly ownerId: string;
}): Promise<FlowProjectContext | null> {
  const existing = await input.repo.getFlowContext(input.flowId, input.ownerId);
  if (existing) return existing;

  if (!(await input.repo.ownsFlow(input.flowId, input.ownerId))) return null;

  const personal = await input.repo.ensurePersonalContext(input.ownerId);
  const binding = await input.repo.bindFlow(input.flowId, personal);
  if (!binding) return null;
  return input.repo.getFlowContext(input.flowId, input.ownerId);
}
