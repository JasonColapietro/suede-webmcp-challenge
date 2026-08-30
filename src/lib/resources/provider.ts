import type { ResourceRepository } from "./repository";

export class ResourceStoreUnavailableError extends Error {
  constructor() { super("Resource store unavailable"); this.name = "ResourceStoreUnavailableError"; }
}

interface Cache {
  readonly driver: "sqlite" | "supabase";
  readonly configuration: string;
  readonly promise: Promise<ResourceRepository>;
}

let cached: Cache | null = null;

async function sqlite(path: string): Promise<ResourceRepository> {
  const { SqliteResourceRepository } = await import("./sqlite-repository");
  return new SqliteResourceRepository(path);
}

async function supabase(): Promise<ResourceRepository> {
  const { SupabaseResourceRepository } = await import("./supabase-repository");
  return new SupabaseResourceRepository();
}

export function getResourceRepository(): Promise<ResourceRepository> {
  const driver = process.env.DB_DRIVER ?? "sqlite";
  if (driver !== "sqlite" && driver !== "supabase") return Promise.reject(new ResourceStoreUnavailableError());
  const path = process.env.SQLITE_PATH ?? "studio.db";
  const configuration = driver === "sqlite" ? path : JSON.stringify([
    process.env.SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "",
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_ANON_KEY?.trim() || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() || "",
    process.env.AGENT_STUDIO_DB_SECRET ?? "",
  ]);
  if (cached) {
    if (cached.driver !== driver || cached.configuration !== configuration) return Promise.reject(new ResourceStoreUnavailableError());
    return cached.promise;
  }
  const initialization = driver === "sqlite" ? sqlite(path) : supabase();
  const guarded = initialization.catch((error: unknown) => {
    if (cached?.promise === guarded) cached = null;
    throw error;
  });
  cached = { driver, configuration, promise: guarded };
  return guarded;
}
