import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { config } from "./config.mjs";

/**
 * Logging.
 *
 * Two destinations, always:
 *   - the console, so `node start.mjs` still reads normally,
 *   - a dated file in logs/, so an error at 2am is still there at 9am.
 *
 * Every line is one JSON object (JSON Lines), which means `scripts/logs.mjs`
 * can filter them and any hosted log viewer can parse them.
 *
 * Nothing sensitive is ever written: no passwords, no tokens, no answer text,
 * no applicant details. Only ids, paths, status codes and error stacks.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function logDir() {
  return config.logDir;
}

let currentDir = null;

function ensureDir() {
  const dir = logDir();
  if (currentDir === dir) return dir;
  mkdirSync(dir, { recursive: true });
  currentDir = dir;
  return dir;
}

/** One file per day: logs/app-2026-09-23.log */
function logFile() {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(ensureDir(), `app-${day}.log`);
}

/** Delete log files older than the retention window. */
function pruneOldLogs() {
  try {
    const dir = ensureDir();
    const cutoff = Date.now() - config.logRetentionDays * 86_400_000;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith("app-") || !name.endsWith(".log")) continue;
      const file = path.join(dir, name);
      if (statSync(file).mtimeMs < cutoff) unlinkSync(file);
    }
  } catch {
    // Pruning must never take the server down.
  }
}

/**
 * Redact anything that should not reach a log file, however it was passed in.
 * Belt and braces: callers are not supposed to send these, but one careless
 * `logger.error("failed", { body })` should not leak a password.
 */
const SECRET_KEYS = /^(password|token|authorization|apiKey|api_key|secret|credential|answer|email)$/i;

function safe(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 4) return "[deep]";
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => safe(v, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SECRET_KEYS.test(key) ? "[redacted]" : safe(item, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 2000) return `${value.slice(0, 2000)}...[truncated]`;
  return value;
}

let lastPrune = 0;

function write(level, message, details) {
  if (LEVELS[level] < LEVELS[config.logLevel]) return;

  const entry = {
    time: new Date().toISOString(),
    level,
    message,
    ...(details ? { details: safe(details) } : {}),
  };

  // Console first - if the file write fails, the operator still sees it.
  const line = `[${level}] ${message}`;
  if (level === "error") console.error(line, details?.error?.stack ?? details ?? "");
  else if (level === "warn") console.warn(line, details ?? "");
  else console.log(line, details ?? "");

  if (!config.logToFile) return;
  try {
    appendFileSync(logFile(), `${JSON.stringify(entry)}\n`, "utf8");
    // Prune at most once an hour, on a write we are already doing.
    if (Date.now() - lastPrune > 3_600_000) {
      lastPrune = Date.now();
      pruneOldLogs();
    }
  } catch (error) {
    console.error("[logger] could not write to the log file:", error.message);
  }
}

export const logger = {
  debug: (message, details) => write("debug", message, details),
  info: (message, details) => write("info", message, details),
  warn: (message, details) => write("warn", message, details),
  error: (message, details) => write("error", message, details),

  /**
   * One line per API request. Slow or failed requests are raised to warn/error
   * so `scripts/logs.mjs --errors` surfaces them without noise.
   */
  request({ method, path: urlPath, status, ms, userId, ip }) {
    const details = { method, path: urlPath, status, ms, userId: userId ?? null, ip };
    if (status >= 500) write("error", `${method} ${urlPath} -> ${status}`, details);
    else if (status >= 400 || ms > 10_000) write("warn", `${method} ${urlPath} -> ${status}`, details);
    else write("info", `${method} ${urlPath} -> ${status}`, details);
  },

  /** Where the log files are, for the startup banner. */
  location: () => (config.logToFile ? logFile() : "console only"),
};
