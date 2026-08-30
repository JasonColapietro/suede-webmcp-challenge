import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveSharedSupabaseServerConfiguration,
  resolveSupabaseServerConfiguration,
} from "@/lib/db/supabase-server-client";

afterEach(() => vi.unstubAllEnvs());

const STRONG_SECRET = "agent-studio-0123456789-ABCDEFGHIJK";

describe("resolveSupabaseServerConfiguration", () => {
  it("prefers the service role when one is configured", () => {
    vi.stubEnv("SUPABASE_URL", "https://service.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "public-key");
    vi.stubEnv("AGENT_STUDIO_DB_SECRET", STRONG_SECRET);

    expect(resolveSupabaseServerConfiguration()).toEqual({
      url: "https://service.supabase.co",
      key: "service-role",
    });
  });

  it("keeps the shared-runtime resolver on the public key when a service role also exists", () => {
    vi.stubEnv("SUPABASE_URL", "https://shared.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "must-not-use-for-connections");
    vi.stubEnv("SUPABASE_ANON_KEY", "public-key");
    vi.stubEnv("AGENT_STUDIO_DB_SECRET", STRONG_SECRET);

    expect(resolveSharedSupabaseServerConfiguration()).toEqual({
      url: "https://shared.supabase.co",
      key: "public-key",
      requestSecret: STRONG_SECRET,
    });
  });

  it("uses the public key only when the server request secret is present", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://shared.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "public-key");
    vi.stubEnv("AGENT_STUDIO_DB_SECRET", STRONG_SECRET);

    expect(resolveSupabaseServerConfiguration()).toEqual({
      url: "https://shared.supabase.co",
      key: "public-key",
      requestSecret: STRONG_SECRET,
    });
  });

  it("fails closed when a public key has no server request secret", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://shared.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "public-key");
    vi.stubEnv("AGENT_STUDIO_DB_SECRET", "");

    expect(() => resolveSupabaseServerConfiguration()).toThrow(/AGENT_STUDIO_DB_SECRET/u);
  });

  it("ignores quoted-empty sentinels and falls through to usable values", () => {
    vi.stubEnv("SUPABASE_URL", "\"\"");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://shared.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "''");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "public-key");
    vi.stubEnv("AGENT_STUDIO_DB_SECRET", STRONG_SECRET);

    expect(resolveSupabaseServerConfiguration()).toEqual({
      url: "https://shared.supabase.co",
      key: "public-key",
      requestSecret: STRONG_SECRET,
    });
  });

  it("rejects weak public-key request secrets", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://shared.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "public-key");
    vi.stubEnv("AGENT_STUDIO_DB_SECRET", "x".repeat(64));

    expect(() => resolveSupabaseServerConfiguration()).toThrow(/strong random material/u);
  });
});
