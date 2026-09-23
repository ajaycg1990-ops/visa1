import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { config } from "../backend/src/config.mjs";

/**
 * Read the log files.
 *
 *   node scripts/logs.mjs                  last 50 entries from today
 *   node scripts/logs.mjs --errors         only errors, last 7 days
 *   node scripts/logs.mjs --errors --all   every error ever recorded
 *   node scripts/logs.mjs --grep interview lines mentioning "interview"
 *   node scripts/logs.mjs --lines 200      more history
 *   node scripts/logs.mjs --full           print full stack traces
 *
 * This is the first thing to run when something breaks in production.
 */

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const value = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const onlyErrors = has("--errors");
const full = has("--full");
const limit = Number.parseInt(value("--lines", "50"), 10);
const grep = value("--grep", "");
const days = has("--all") ? 3650 : Number.parseInt(value("--days", onlyErrors ? "7" : "1"), 10);

if (!existsSync(config.logDir)) {
  console.log(`No log directory yet at ${config.logDir}`);
  console.log("Start the server and make a request, then run this again.");
  process.exit(0);
}

const cutoff = Date.now() - days * 86_400_000;

const files = readdirSync(config.logDir)
  .filter((name) => name.startsWith("app-") && name.endsWith(".log"))
  .sort()
  .filter((name) => {
    const day = name.slice(4, 14);
    return new Date(`${day}T23:59:59Z`).getTime() >= cutoff;
  });

if (!files.length) {
  console.log(`No log files in the last ${days} day(s).`);
  process.exit(0);
}

const entries = [];
for (const name of files) {
  for (const line of readFileSync(path.join(config.logDir, name), "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A partially written final line is normal while the server is running.
    }
  }
}

let shown = entries;
if (onlyErrors) shown = shown.filter((e) => e.level === "error");
if (grep) {
  const needle = grep.toLowerCase();
  shown = shown.filter((e) => JSON.stringify(e).toLowerCase().includes(needle));
}
shown = shown.slice(-limit);

if (!shown.length) {
  console.log(onlyErrors ? `No errors in the last ${days} day(s). ` : "Nothing matched.");
  process.exit(0);
}

const colour = { error: "\x1b[31m", warn: "\x1b[33m", info: "\x1b[90m", debug: "\x1b[90m" };
const reset = "\x1b[0m";

for (const entry of shown) {
  const time = entry.time.slice(0, 19).replace("T", " ");
  console.log(`${colour[entry.level] ?? ""}${time}  ${entry.level.toUpperCase().padEnd(5)}${reset}  ${entry.message}`);

  const details = entry.details;
  if (!details) continue;

  if (details.reference) console.log(`        reference : ${details.reference}   <- the code shown to the student`);
  if (details.userId) console.log(`        user      : ${details.userId}`);
  if (details.path) console.log(`        request   : ${details.method} ${details.path} (${details.ms}ms)`);
  if (details.page) console.log(`        page      : ${details.page}`);

  if (details.error) {
    console.log(`        error     : ${details.error.name}: ${details.error.message}`);
    const stack = details.error.stack ?? "";
    const lines = stack.split("\n").slice(1);
    for (const frame of full ? lines : lines.slice(0, 3)) console.log(`        ${frame.trim()}`);
    if (!full && lines.length > 3) console.log(`        ... ${lines.length - 3} more frames (--full to see them)`);
  }
  if (details.stack && !details.error) {
    const lines = details.stack.split("\n");
    for (const frame of full ? lines : lines.slice(0, 3)) console.log(`        ${frame.trim()}`);
  }
}

const errorCount = entries.filter((e) => e.level === "error").length;
console.log("");
console.log(`${shown.length} shown, ${entries.length} entries scanned, ${errorCount} error(s) in the last ${days} day(s).`);
