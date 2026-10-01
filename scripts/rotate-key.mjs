import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config, ROOT } from "../backend/src/config.mjs";
import { ENCRYPTED_PREFIX, fieldCipher } from "../backend/src/security.mjs";

/**
 * Change DATA_ENCRYPTION_KEY without losing any data.
 *
 *   node scripts/rotate-key.mjs            generate a new key, re-encrypt, save it to .env
 *   node scripts/rotate-key.mjs --check    only count encrypted fields and test the current key
 *
 * Every encrypted value in the database (profiles, answers, coaching, ...) is
 * decrypted with the current key and encrypted again with the new one, in one
 * transaction: either all of it moves to the new key or none of it does. A
 * backup is taken first. The new key is written to .env and never printed.
 *
 * Stop the server first - anything it writes during the change would use the
 * old key.
 *
 * Backups taken before the change stay readable only with the OLD key.
 */

const checkOnly = process.argv.includes("--check");
// ENV_FILE lets the tests rotate a throwaway database without touching .env.
const envFile = process.env.ENV_FILE || path.join(ROOT, ".env");

if (!existsSync(config.databaseFile)) {
  console.error(`\nNo database at ${config.databaseFile} - nothing to re-encrypt.\n`);
  process.exit(1);
}

// Refuse to run under a live server: is anything listening on its port?
const serverRunning = await new Promise((resolve) => {
  const socket = net.connect({ host: "127.0.0.1", port: config.backendPort });
  socket.setTimeout(1000);
  socket.once("connect", () => (socket.destroy(), resolve(true)));
  socket.once("timeout", () => (socket.destroy(), resolve(false)));
  socket.once("error", () => resolve(false));
});
if (serverRunning && !checkOnly) {
  console.error(`\nThe server is running on port ${config.backendPort}. Stop it first, then run this again.\n`);
  process.exit(1);
}

const current = fieldCipher(config.encryptionKey);
const db = new DatabaseSync(config.databaseFile);

/** Every column value in the database that is encrypted. */
function encryptedCells() {
  const cells = [];
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  for (const { name: table } of tables) {
    for (const { name: column } of db.prepare(`PRAGMA table_info("${table}")`).all()) {
      const rows = db
        .prepare(`SELECT rowid AS id, "${column}" AS value FROM "${table}" WHERE "${column}" LIKE ?`)
        .all(`${ENCRYPTED_PREFIX}%`);
      for (const row of rows) cells.push({ table, column, id: row.id, value: row.value });
    }
  }
  return cells;
}

const cells = encryptedCells();
const unreadable = cells.filter((cell) => current.decrypt(cell.value) === null);
console.log(`\n${cells.length} encrypted field(s) found.`);
if (unreadable.length) {
  console.error(
    `${unreadable.length} of them cannot be read with the current key. DATA_ENCRYPTION_KEY does not match this ` +
      "database - nothing was changed.\n"
  );
  process.exit(1);
}
console.log("All of them decrypt with the current key.");
if (checkOnly) {
  console.log("Check only - nothing changed.\n");
  process.exit(0);
}

// 1. Backup, while everything is still readable with the old key.
mkdirSync(config.backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const backup = path.join(config.backupDir, `niec-${stamp}-before-key-change.sqlite`);
db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
console.log(`Backup taken: ${path.relative(ROOT, backup)} (readable with the old key)`);

// 2. Re-encrypt everything in one transaction.
const newKey = randomBytes(32).toString("base64url");
const next = fieldCipher(newKey);
db.exec("BEGIN");
try {
  for (const cell of cells) {
    db.prepare(`UPDATE "${cell.table}" SET "${cell.column}" = ? WHERE rowid = ?`).run(
      next.encrypt(current.decrypt(cell.value)),
      cell.id
    );
  }
  // Verify before committing: every field must read back with the new key.
  const after = encryptedCells();
  const bad = after.filter((cell) => next.decrypt(cell.value) === null);
  if (after.length !== cells.length || bad.length) throw new Error("verification failed after re-encrypting");
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  console.error(`\nRe-encryption failed and was rolled back - nothing changed: ${error.message}\n`);
  process.exit(1);
}
db.close();
console.log(`Re-encrypted ${cells.length} field(s) with the new key.`);

// 3. Save the new key to .env, replacing the old line if there is one.
const env = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
const line = `DATA_ENCRYPTION_KEY=${newKey}`;
const updated = /^DATA_ENCRYPTION_KEY=.*$/m.test(env)
  ? env.replace(/^DATA_ENCRYPTION_KEY=.*$/m, line)
  : `${env.replace(/\n*$/, "\n")}\n# Encrypts student data at rest. Change it only with scripts/rotate-key.mjs.\n${line}\n`;
writeFileSync(envFile, updated);
console.log("New key saved to .env as DATA_ENCRYPTION_KEY (not shown here).");
console.log("\nKeep a copy of .env somewhere safe: without that key the data cannot be read.\n");
