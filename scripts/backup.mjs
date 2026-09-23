import Database from "better-sqlite3";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { config } from "../backend/src/config.mjs";

/**
 * Back up the database.
 *
 *   node scripts/backup.mjs
 *
 * Uses SQLite's VACUUM INTO, which writes a consistent copy even while the
 * server is running and mid-write - a plain file copy can catch the database
 * half-written and produce a backup that will not open.
 *
 * Old backups beyond BACKUP_KEEP are deleted, newest kept.
 */

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const target = path.join(config.backupDir, `niec-${stamp}.sqlite`);

if (!existsSync(config.databaseFile)) {
  console.error(`No database at ${config.databaseFile} - nothing to back up.`);
  process.exit(1);
}

mkdirSync(config.backupDir, { recursive: true });

const db = new Database(config.databaseFile, { readOnly: true });
try {
  // The path is interpolated into SQL, so quote it the SQLite way ('' escapes ').
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
} finally {
  db.close();
}

const size = (statSync(target).size / 1024).toFixed(0);
console.log(`Backed up to ${target} (${size} KB)`);

/* ------------------------- prune old backups ------------------------- */

const backups = readdirSync(config.backupDir)
  .filter((name) => name.startsWith("niec-") && name.endsWith(".sqlite"))
  .map((name) => ({ name, file: path.join(config.backupDir, name) }))
  .sort((a, b) => statSync(b.file).mtimeMs - statSync(a.file).mtimeMs);

let removed = 0;
for (const old of backups.slice(config.backupKeep)) {
  unlinkSync(old.file);
  removed += 1;
}

console.log(`Kept ${Math.min(backups.length, config.backupKeep)} backup(s)${removed ? `, removed ${removed} older one(s)` : ""}.`);

if (!process.env.DATA_ENCRYPTION_KEY) {
  console.log("");
  console.log("NOTE: this backup is encrypted with the key in your .env file.");
  console.log("      Back that key up separately and somewhere safe - without it,");
  console.log("      the student data inside this file cannot be recovered by anyone.");
}
