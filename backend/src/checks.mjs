import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config, ROOT } from "./config.mjs";
import { decryptField } from "./security.mjs";

/**
 * Launch-readiness checks, shared by the command line (scripts/preflight.mjs)
 * and the admin portal's System page.
 *
 * They look for the mistakes that are silent but serious: a database still
 * encrypted with the development key, a domain left on localhost, an app bound
 * to the public internet without a proxy, secrets committed to git.
 *
 * Returns [{ group, label, status: "pass" | "warn" | "fail", detail }].
 */

const DEV_SESSION = "dev-only-session-secret-change-me";
const DEV_ENCRYPTION = "dev-only-encryption-key-change-me";

/** The newest backup file and how many are kept, or null if there are none. */
export function backupStatus() {
  if (!existsSync(config.backupDir)) return null;
  const files = readdirSync(config.backupDir)
    .filter((f) => f.endsWith(".sqlite"))
    .map((f) => ({ file: f, time: statSync(path.join(config.backupDir, f)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  if (!files.length) return null;
  return { count: files.length, newest: files[0].file, ageHours: (Date.now() - files[0].time) / 3_600_000 };
}

export function runChecks() {
  const results = [];
  const add = (group, status, label, detail = "") => results.push({ group, label, status, detail });

  /* runtime */
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major > 22 || (major === 22 && minor >= 5)) add("Runtime", "pass", "Node version", process.versions.node);
  else add("Runtime", "fail", "Node version", `${process.versions.node} - needs 22.5+ for node:sqlite`);

  if (config.isProduction) add("Runtime", "pass", "NODE_ENV", "production");
  else add("Runtime", "warn", "NODE_ENV", `${config.env} - set NODE_ENV=production on the server (enables HSTS, rejects weak secrets)`);

  /* secrets */
  if (config.sessionSecret === DEV_SESSION) add("Secrets", "fail", "SESSION_SECRET", "still the development default");
  else if (config.sessionSecret.length < 24) add("Secrets", "warn", "SESSION_SECRET", "shorter than 24 characters");
  else add("Secrets", "pass", "SESSION_SECRET", "set");

  if (config.encryptionKey === DEV_ENCRYPTION) {
    add("Secrets", "fail", "DATA_ENCRYPTION_KEY", "still the development default - student data is encrypted with a key published in this repo. Fix it with: node scripts/rotate-key.mjs");
  } else if (config.encryptionKey.length < 24) {
    add("Secrets", "warn", "DATA_ENCRYPTION_KEY", "shorter than 24 characters");
  } else {
    add("Secrets", "pass", "DATA_ENCRYPTION_KEY", "set");
  }

  /* addresses */
  const appUrl = config.publicAppUrl;
  if (appUrl.includes("localhost") || appUrl.includes("127.0.0.1")) {
    add("Addresses", "fail", "PUBLIC_APP_URL", `${appUrl} - fine on this computer, but students cannot reach it. Set your https domain on the server.`);
  } else if (!appUrl.startsWith("https://")) {
    add("Addresses", "fail", "PUBLIC_APP_URL", `${appUrl} - must be https, or microphones will not work and passwords travel in clear text`);
  } else {
    add("Addresses", "pass", "PUBLIC_APP_URL", appUrl);
  }

  const apiUrl = config.publicApiUrl;
  if (apiUrl.includes("localhost") && config.isProduction) add("Addresses", "fail", "PUBLIC_API_URL", `${apiUrl} - the browser cannot reach this`);
  else add("Addresses", "pass", "PUBLIC_API_URL", apiUrl);

  const localOrigins = config.corsOrigins.filter((o) => o.includes("localhost") || o.includes("127.0.0.1"));
  if (config.isProduction && localOrigins.length) add("Addresses", "warn", "CORS_ORIGINS", `still allows ${localOrigins.join(", ")}`);
  else add("Addresses", "pass", "CORS_ORIGINS", config.corsOrigins.join(", ") || "(none)");

  if (config.host === "0.0.0.0" && config.isProduction) {
    add("Addresses", "warn", "HOST", "0.0.0.0 exposes plain HTTP directly - only do this if a firewall or container blocks the ports");
  } else {
    add("Addresses", "pass", "HOST", config.host);
  }

  /* database */
  if (!existsSync(config.databaseFile)) {
    add("Database", "pass", "database", "none yet - will be created on first start");
  } else {
    const size = (statSync(config.databaseFile).size / 1024).toFixed(0);
    add("Database", "pass", "database", `${path.basename(config.databaseFile)} (${size} KB)`);
    // A database written with one key cannot be read with another.
    try {
      const db = new DatabaseSync(config.databaseFile, { readOnly: true });
      const row = db.prepare("SELECT full_name FROM profiles WHERE full_name IS NOT NULL LIMIT 1").get();
      db.close();
      if (row && decryptField(row.full_name) === null) {
        add("Database", "fail", "encryption key matches the data", "existing rows cannot be decrypted - DATA_ENCRYPTION_KEY has changed since this database was written");
      } else {
        add("Database", "pass", "encryption key matches the data");
      }
    } catch (error) {
      add("Database", "warn", "encryption key check", `could not run: ${error.message}`);
    }
  }

  if (config.seedDemo && config.isProduction) {
    add("Database", "warn", "SEED_DEMO", "a demo student is created on a fresh database - set SEED_DEMO=0 for a public launch");
  } else {
    add("Database", "pass", "SEED_DEMO", config.seedDemo ? "on (fine for testing)" : "off");
  }

  /* backups */
  const backups = backupStatus();
  if (!backups) add("Backups", "warn", "backups", "none taken yet - run: node scripts/backup.mjs, and schedule it daily");
  else if (backups.ageHours > 48) add("Backups", "warn", "backups", `newest is ${Math.round(backups.ageHours / 24)} days old - is the daily schedule running?`);
  else {
    const age = backups.ageHours < 1 ? "under an hour" : `${Math.round(backups.ageHours)} hours`;
    add("Backups", "pass", "backups", `${backups.count} kept, newest ${age} old`);
  }

  /* source control */
  const gitignore = path.join(ROOT, ".gitignore");
  if (!existsSync(path.join(ROOT, ".git"))) add("Source control", "warn", "git", "not a repository - you have no way to undo a bad change");
  else if (!existsSync(gitignore) || !readFileSync(gitignore, "utf8").includes(".env")) add("Source control", "fail", ".gitignore", ".env is not ignored - your API key would be committed");
  else add("Source control", "pass", "git", ".env and data are ignored");

  /* AI */
  if (config.ai.enabled) add("AI", "pass", "AI provider", `${config.ai.model} via ${config.ai.baseUrl}`);
  else add("AI", "pass", "AI provider", "none - the built-in engine runs the interviews");

  return results;
}

/**
 * Warnings and errors in the application log over the last `days` days,
 * newest first. Reads the JSON-lines files the logger writes.
 */
export function recentProblems({ days = 7, limit = 20 } = {}) {
  if (!existsSync(config.logDir)) return { errors: 0, warnings: 0, latest: [] };
  const since = Date.now() - days * 86_400_000;
  let errors = 0;
  let warnings = 0;
  const latest = [];
  const files = readdirSync(config.logDir)
    .filter((f) => /^app-\d{4}-\d{2}-\d{2}\.log$/.test(f))
    .sort()
    .reverse();
  for (const file of files) {
    if (Date.parse(file.slice(4, 14)) < since - 86_400_000) break;
    const lines = readFileSync(path.join(config.logDir, file), "utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"level":"error"') && !lines[i].includes('"level":"warn"')) continue;
      let entry;
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (Date.parse(entry.time) < since) continue;
      // Every 4xx a student causes (a wrong password, a 404) is logged as a
      // warning; only unhandled server errors are worth showing here.
      if (entry.level === "warn") {
        warnings += 1;
        continue;
      }
      if (/ -> 5\d\d$/.test(entry.message)) continue; // the request line that repeats an error
      errors += 1;
      if (latest.length < limit) {
        latest.push({
          time: entry.time,
          message: entry.message,
          reference: entry.details?.reference ?? null,
          error: String(entry.details?.error?.message ?? entry.details?.error ?? "").split("\n")[0].slice(0, 240),
        });
      }
    }
  }
  return { errors, warnings, latest };
}
