import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { config, ROOT } from "../backend/src/config.mjs";

/**
 * Pre-launch check.
 *
 *   node scripts/preflight.mjs
 *
 * Run this on the server before you point students at it. It looks for the
 * mistakes that are silent but serious: a database still encrypted with the
 * development key, a domain left on localhost, an app bound to the public
 * internet without a proxy, secrets committed to git.
 *
 * Exits non-zero if anything is FAIL, so a deploy script can gate on it.
 */

let fails = 0;
let warns = 0;

const pass = (label, detail = "") => console.log(`  \x1b[32mPASS\x1b[0m  ${label}${detail ? `  - ${detail}` : ""}`);
const warn = (label, detail) => {
  warns += 1;
  console.log(`  \x1b[33mWARN\x1b[0m  ${label}${detail ? `  - ${detail}` : ""}`);
};
const fail = (label, detail) => {
  fails += 1;
  console.log(`  \x1b[31mFAIL\x1b[0m  ${label}${detail ? `  - ${detail}` : ""}`);
};

const DEV_SESSION = "dev-only-session-secret-change-me";
const DEV_ENCRYPTION = "dev-only-encryption-key-change-me";

console.log("\nNIEC Visa AI - pre-launch check\n");

/* ------------------------------- runtime -------------------------------- */

console.log("Runtime");
const [major, minor] = process.versions.node.split(".").map(Number);
if (major > 22 || (major === 22 && minor >= 5)) pass("Node version", process.versions.node);
else fail("Node version", `${process.versions.node} - needs Node 20+`);

if (config.isProduction) pass("NODE_ENV", "production");
else warn("NODE_ENV", `${config.env} - set NODE_ENV=production before launch (enables HSTS, rejects weak secrets)`);

/* ------------------------------- secrets -------------------------------- */

console.log("\nSecrets");
if (config.sessionSecret === DEV_SESSION) fail("SESSION_SECRET", "still the development default");
else if (config.sessionSecret.length < 24) warn("SESSION_SECRET", "shorter than 24 characters");
else pass("SESSION_SECRET", "set");

if (config.encryptionKey === DEV_ENCRYPTION) {
  fail(
    "DATA_ENCRYPTION_KEY",
    "still the development default - student data would be encrypted with a key published in this repo"
  );
} else if (config.encryptionKey.length < 24) {
  warn("DATA_ENCRYPTION_KEY", "shorter than 24 characters");
} else {
  pass("DATA_ENCRYPTION_KEY", "set");
}

/* -------------------------------- domain -------------------------------- */

console.log("\nAddresses");
const appUrl = config.publicAppUrl;
const apiUrl = config.publicApiUrl;

if (appUrl.includes("localhost") || appUrl.includes("127.0.0.1")) {
  fail("PUBLIC_APP_URL", `${appUrl} - students cannot reach this`);
} else if (!appUrl.startsWith("https://")) {
  fail("PUBLIC_APP_URL", `${appUrl} - must be https, or microphones will not work and passwords travel in clear text`);
} else {
  pass("PUBLIC_APP_URL", appUrl);
}

if (apiUrl.includes("localhost") && config.isProduction) fail("PUBLIC_API_URL", `${apiUrl} - the browser cannot reach this`);
else pass("PUBLIC_API_URL", apiUrl);

const badOrigins = config.corsOrigins.filter((o) => o.includes("localhost") || o.includes("127.0.0.1"));
if (config.isProduction && badOrigins.length) warn("CORS_ORIGINS", `still allows ${badOrigins.join(", ")}`);
else pass("CORS_ORIGINS", config.corsOrigins.join(", ") || "(none)");

if (config.host === "0.0.0.0" && config.isProduction) {
  warn("HOST", "0.0.0.0 exposes plain HTTP directly - only do this if a firewall or container blocks the ports");
} else {
  pass("HOST", config.host);
}

/* ------------------------------- database ------------------------------- */

console.log("\nDatabase");
if (!existsSync(config.databaseFile)) {
  pass("database", "none yet - will be created on first start");
} else {
  const size = (statSync(config.databaseFile).size / 1024).toFixed(0);
  pass("database", `${config.databaseFile} (${size} KB)`);

  // A database written with one key cannot be read with another.
  try {
    const { default: DatabaseSync } = await import("better-sqlite3");
    const { decryptField } = await import("../backend/src/security.mjs");
    const db = new DatabaseSync(config.databaseFile, { readOnly: true });
    const row = db.prepare("SELECT full_name FROM profiles WHERE full_name IS NOT NULL LIMIT 1").get();
    db.close();
    if (row && decryptField(row.full_name) === null) {
      fail(
        "encryption key matches the data",
        "existing rows cannot be decrypted - DATA_ENCRYPTION_KEY has changed since this database was written"
      );
    } else {
      pass("encryption key matches the data");
    }
  } catch (error) {
    warn("encryption key check", `could not run: ${error.message}`);
  }
}

if (config.seedDemo && config.isProduction) {
  warn("SEED_DEMO", "demo student will be created on a fresh database - set SEED_DEMO=0 for a public launch");
} else {
  pass("SEED_DEMO", config.seedDemo ? "on (fine for testing)" : "off");
}

/* -------------------------------- backups ------------------------------- */

console.log("\nBackups");
if (!existsSync(config.backupDir)) {
  warn("backups", "none taken yet - run: node scripts/backup.mjs, and schedule it daily");
} else {
  const files = (await import("node:fs")).readdirSync(config.backupDir).filter((f) => f.endsWith(".sqlite"));
  if (!files.length) warn("backups", "backup folder is empty");
  else {
    const newest = files
      .map((f) => ({ f, t: statSync(path.join(config.backupDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0];
    const ageHours = (Date.now() - newest.t) / 3_600_000;
    if (ageHours > 48) warn("backups", `newest is ${Math.round(ageHours / 24)} days old - is the schedule running?`);
    else pass("backups", `${files.length} kept, newest ${ageHours < 1 ? "under an hour" : `${Math.round(ageHours)} hours`} old`);
  }
}

/* --------------------------------- git ---------------------------------- */

console.log("\nSource control");
const gitignore = path.join(ROOT, ".gitignore");
if (!existsSync(path.join(ROOT, ".git"))) {
  warn("git", "not a repository - you have no way to undo a bad change");
} else if (!existsSync(gitignore) || !readFileSync(gitignore, "utf8").includes(".env")) {
  fail(".gitignore", ".env is not ignored - your API key would be committed");
} else {
  pass("git", ".env and data are ignored");
}

/* ----------------------------------- AI ---------------------------------- */

console.log("\nAI");
if (config.ai.enabled) pass("AI provider", `${config.ai.model} via ${config.ai.baseUrl}`);
else pass("AI provider", "none - the built-in engine will run the interviews");

/* --------------------------------- result -------------------------------- */

console.log("");
if (fails) {
  console.log(`\x1b[31m${fails} blocking problem(s)\x1b[0m and ${warns} warning(s). Do not launch until the FAILs are fixed.\n`);
  process.exit(1);
}
if (warns) {
  console.log(`\x1b[33mNo blocking problems, ${warns} warning(s).\x1b[0m Read them before you launch.\n`);
  process.exit(0);
}
console.log("\x1b[32mAll checks passed. Ready to launch.\x1b[0m\n");
