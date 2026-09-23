import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Configuration and .env loading.
 *
 * Deliberately dependency-free: a tiny .env parser instead of dotenv, so the
 * product runs straight from a clone with no npm install.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..", "..");

/** Parse a .env file. Supports KEY=value, quotes, blank lines and # comments. */
function loadEnvFile(file) {
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Real environment variables always win over the file.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(path.join(ROOT, ".env"));

const bool = (value, fallback = false) => {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
};

const int = (value, fallback) => {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
};

/** Development defaults are obvious placeholders, never silent secrets. */
const DEV_SESSION_SECRET = "dev-only-session-secret-change-me";
const DEV_ENCRYPTION_KEY = "dev-only-encryption-key-change-me";

export const config = {
  env: process.env.NODE_ENV || "development",
  get isProduction() {
    return this.env === "production";
  },

  backendPort: int(process.env.PORT || process.env.BACKEND_PORT, 4000),
  frontendPort: int(process.env.FRONTEND_PORT, 3000),
  /**
   * Interface to bind. Defaults to loopback so that on a public server the
   * app is reachable only through the reverse proxy that terminates HTTPS -
   * binding 0.0.0.0 would expose plain HTTP on port 4000 to the internet.
   * Set HOST=0.0.0.0 only inside a container with its own network boundary.
   */
  host: process.env.HOST || "127.0.0.1",
  publicApiUrl: process.env.PUBLIC_API_URL || `http://localhost:${int(process.env.PORT || process.env.BACKEND_PORT, 4000)}`,
  publicAppUrl: process.env.PUBLIC_APP_URL || `http://localhost:${int(process.env.FRONTEND_PORT, 3000)}`,

  databaseFile: process.env.DATABASE_FILE || path.join(ROOT, "database", "niec.sqlite"),
  schemaFile: path.join(ROOT, "database", "schema.sql"),

  // Logging. Files are JSON Lines, one per day, pruned after the retention
  // window. Turn LOG_TO_FILE off only if the host captures stdout itself.
  logDir: process.env.LOG_DIR || path.join(ROOT, "logs"),
  logToFile: !["0", "false", "no"].includes(String(process.env.LOG_TO_FILE ?? "1").toLowerCase()),
  logLevel: ["debug", "info", "warn", "error"].includes(process.env.LOG_LEVEL ?? "")
    ? process.env.LOG_LEVEL
    : "info",
  logRetentionDays: int(process.env.LOG_RETENTION_DAYS, 30),
  /** Backups written by scripts/backup.mjs. */
  backupDir: process.env.BACKUP_DIR || path.join(ROOT, "backups"),
  backupKeep: int(process.env.BACKUP_KEEP, 14),
  /** Skip the demo student on a fresh database (the e2e test sets this). */
  seedDemo: bool(process.env.SEED_DEMO, true),

  sessionSecret: process.env.SESSION_SECRET || DEV_SESSION_SECRET,
  encryptionKey: process.env.DATA_ENCRYPTION_KEY || DEV_ENCRYPTION_KEY,
  sessionDays: int(process.env.SESSION_DAYS, 14),
  resetTokenMinutes: int(process.env.RESET_TOKEN_MINUTES, 60),

  /** Browser origins allowed to call the API. */
  corsOrigins: (process.env.CORS_ORIGINS || `http://localhost:${int(process.env.FRONTEND_PORT, 3000)},http://127.0.0.1:${int(process.env.FRONTEND_PORT, 3000)}`)
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),

  // Optional OpenAI-compatible provider. Absent = built-in deterministic engine.
  ai: {
    apiKey: process.env.AI_API_KEY || "",
    baseUrl: (process.env.AI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, ""),
    model: process.env.AI_MODEL || "gpt-4o-mini",
    timeoutMs: int(process.env.AI_TIMEOUT_MS, 25000),
    get enabled() {
      return Boolean(this.apiKey);
    },
  },

  googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  resendApiKey: process.env.RESEND_API_KEY || "",
  fromEmail: process.env.FROM_EMAIL || "",

  rateLimits: {
    // windowMs / max requests per IP, per bucket.
    auth: { windowMs: 15 * 60_000, max: int(process.env.RATE_LIMIT_AUTH, 30) },
    ai: { windowMs: 60_000, max: int(process.env.RATE_LIMIT_AI, 20) },
    general: { windowMs: 60_000, max: int(process.env.RATE_LIMIT_GENERAL, 300) },
    // Browser error reports: enough for a genuinely broken page, not enough
    // to flood the log file.
    clientError: { windowMs: 60_000, max: int(process.env.RATE_LIMIT_CLIENT_ERROR, 20) },
  },
};

/** Warn loudly when production is still running on development placeholders. */
export function assertProductionSecrets() {
  if (!config.isProduction) return;
  const problems = [];
  if (config.sessionSecret === DEV_SESSION_SECRET) problems.push("SESSION_SECRET");
  if (config.encryptionKey === DEV_ENCRYPTION_KEY) problems.push("DATA_ENCRYPTION_KEY");
  if (problems.length) {
    throw new Error(
      `Refusing to start in production with development defaults for: ${problems.join(", ")}. Set them in .env.`
    );
  }
}

export const usingDevSecrets =
  config.sessionSecret === DEV_SESSION_SECRET || config.encryptionKey === DEV_ENCRYPTION_KEY;
