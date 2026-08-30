import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface SupabaseServerConfiguration {
  readonly url: string;
  readonly key: string;
  readonly requestSecret?: string;
}

export interface SharedSupabaseServerConfiguration {
  readonly url: string;
  readonly key: string;
  readonly requestSecret: string;
}

function firstConfigured(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalized = value.trim();
    if (
      normalized.length === 0 ||
      normalized === "\"\"" ||
      normalized === "''" ||
      normalized === "null" ||
      normalized === "undefined"
    ) continue;
    return normalized;
  }
  return undefined;
}

function requireStrongRequestSecret(secret: string): string {
  const bytes = new TextEncoder().encode(secret);
  if (bytes.byteLength < 32 || new Set(bytes).size < 8) {
    throw new Error("AGENT_STUDIO_DB_SECRET must contain at least 32 bytes of strong random material");
  }
  return secret;
}

export function resolveSupabaseServerConfiguration(): SupabaseServerConfiguration {
  const url = firstConfigured(
    process.env.SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_URL,
  );
  if (!url) throw new Error("A Supabase project URL is required for the supabase driver");

  const serviceRoleKey = firstConfigured(process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (serviceRoleKey) return { url, key: serviceRoleKey };

  return resolveSharedSupabaseServerConfiguration();
}

export function resolveSharedSupabaseServerConfiguration(): SharedSupabaseServerConfiguration {
  const url = firstConfigured(
    process.env.SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_URL,
  );
  if (!url) throw new Error("A Supabase project URL is required for the supabase driver");

  const publicKey = firstConfigured(
    process.env.SUPABASE_ANON_KEY,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
  const configuredRequestSecret = firstConfigured(process.env.AGENT_STUDIO_DB_SECRET);
  if (!publicKey || !configuredRequestSecret) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY or a public Supabase key plus AGENT_STUDIO_DB_SECRET is required",
    );
  }
  const requestSecret = requireStrongRequestSecret(configuredRequestSecret);
  return { url, key: publicKey, requestSecret };
}

export function createServerSupabaseClient(): SupabaseClient {
  const configuration = resolveSupabaseServerConfiguration();
  return createClient(configuration.url, configuration.key, {
    auth: { persistSession: false, autoRefreshToken: false },
    ...(configuration.requestSecret
      ? { global: { headers: { "x-agent-studio-secret": configuration.requestSecret } } }
      : {}),
  });
}

export function createSharedSupabaseServerClient(): SupabaseClient {
  const configuration = resolveSharedSupabaseServerConfiguration();
  return createClient(configuration.url, configuration.key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "x-agent-studio-secret": configuration.requestSecret } },
  });
}
