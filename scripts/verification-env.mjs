import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REMOTE_OR_PAID_PREFIXES = [
  "ANTHROPIC_",
  "AWS_",
  "AZURE_",
  "CDP_",
  "CLOUDFLARE_",
  "COINBASE_",
  "CONNECTION_",
  "GCP_",
  "GOOGLE_",
  "GROQ_",
  "HUGGINGFACE_",
  "FACILITATOR_",
  "LLM_PROVIDER_",
  "MISTRAL_",
  "OPENAI_",
  "OPENROUTER_",
  "PAYPAL_",
  "PG",
  "PINECONE_",
  "POSTHOG_",
  "PROVIDER_",
  "REDIS_",
  "REPLICATE_",
  "RELAY_",
  "RESEND_",
  "STRIPE_",
  "SUPABASE_",
  "SUEDE_ID_",
  "SUEDE_RELAY_",
  "TOGETHER_",
  "TWILIO_",
  "UPSTASH_",
  "VERCEL_",
  "WEBHOOK_",
  "X402_",
];

const REMOTE_OR_PAID_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "BASE_RPC_URL",
  "BASH_ENV",
  "CDP_API_KEY_ID",
  "CDP_API_KEY_SECRET",
  "DATABASE_URL",
  "DIRECT_URL",
  "NEXT_PUBLIC_POSTHOG_HOST",
  "NEXT_PUBLIC_POSTHOG_KEY",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NODE_OPTIONS",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "PHASE0_CAPTURE_SESSION",
  "PROMO_AGENT_KEY",
  "PGPASSFILE",
  "PGSERVICEFILE",
  "SUEDE_API_URL",
  "SUEDE_BASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_URL",
  "WALLET_PRIVATE_KEY",
  "X402_FACILITATOR_URL",
  "X402_FACILITATOR_URL_SECONDARY",
  "X402_PRIVATE_KEY",
  "X402_SELLER_WALLET_ADDRESS",
]);

function mustRemove(key) {
  return (
    REMOTE_OR_PAID_KEYS.has(key) ||
    REMOTE_OR_PAID_PREFIXES.some((prefix) => key.startsWith(prefix)) ||
    /(?:_KEY|API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PRIVATE_KEY|PASSWORD|SECRET)$/.test(key)
  );
}

function sensitiveKeysFromEnvFiles(projectRoot) {
  const keys = new Set();
  let names = [];
  try {
    names = readdirSync(projectRoot).filter(
      (name) => name === ".env" || name.startsWith(".env."),
    );
  } catch {
    return keys;
  }
  for (const name of names) {
    const contents = readFileSync(join(projectRoot, name), "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (match && mustRemove(match[1])) keys.add(match[1]);
    }
  }
  return keys;
}

export function createIsolatedSqliteEnvironment(
  baseEnvironment = process.env,
  projectRoot = process.cwd(),
) {
  const environment = { ...baseEnvironment };

  const sensitiveKeys = new Set(REMOTE_OR_PAID_KEYS);
  for (const key of Object.keys(environment)) {
    if (mustRemove(key)) sensitiveKeys.add(key);
  }
  for (const key of sensitiveKeysFromEnvFiles(projectRoot)) sensitiveKeys.add(key);
  for (const key of sensitiveKeys) environment[key] = "";

  const directory = mkdtempSync(join(tmpdir(), "suede-phase0-"));
  try {
    environment.DB_DRIVER = "sqlite";
    environment.SQLITE_PATH = join(directory, "studio.db");
    environment.X402_SKIP_SETTLEMENT = "true";
    environment.X402_SELLER_WALLET_ADDRESS =
      "0x0000000000000000000000000000000000000000";

    const home = join(directory, "home");
    const configHome = join(home, ".config");
    const cacheHome = join(home, ".cache");
    const dataHome = join(home, ".local", "share");
    const tempDirectory = join(directory, "tmp");
    for (const target of [home, configHome, cacheHome, dataHome, tempDirectory]) {
      mkdirSync(target, { recursive: true, mode: 0o700 });
    }
    environment.HOME = home;
    environment.XDG_CONFIG_HOME = configHome;
    environment.XDG_CACHE_HOME = cacheHome;
    environment.XDG_DATA_HOME = dataHome;
    environment.TMPDIR = tempDirectory;
    environment.TMP = tempDirectory;
    environment.TEMP = tempDirectory;
    environment.NPM_CONFIG_USERCONFIG = join(home, ".npmrc-disabled");
    environment.HTTP_PROXY = "";
    environment.HTTPS_PROXY = "";
    environment.ALL_PROXY = "";
    environment.NO_PROXY = "127.0.0.1,localhost,::1";
    environment.NEXT_TELEMETRY_DISABLED = "1";
    environment.DO_NOT_TRACK = "1";

    return {
      directory,
      environment,
      cleanup() {
        rmSync(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
