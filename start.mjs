import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./backend/src/config.mjs";

/**
 * Start the API and the website together.
 *
 *   node start.mjs
 *
 * Both run as child processes so one crash does not silently leave the other
 * running: if either exits, this script shuts the other down too.
 */

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// Compatible with Node.js 20+; SQLite is provided by better-sqlite3.

const children = new Map();
let shuttingDown = false;

/** Restart backoff: 1s, 2s, 4s, 8s, capped at 30s. */
const RESTART_BASE_MS = 1000;
const RESTART_MAX_MS = 30_000;
/** More than this many crashes inside the window means it is broken, not flaky. */
const CRASH_LIMIT = 5;
const CRASH_WINDOW_MS = 60_000;

/**
 * Start one server and keep it alive.
 *
 * A crashed process is restarted automatically with a growing delay, so a
 * transient fault costs seconds of downtime instead of hours. A process that
 * keeps crashing immediately is a real bug, not a blip, so after CRASH_LIMIT
 * failures in a minute we stop and say so rather than restart-looping in
 * silence.
 */
function run(name, file, env) {
  const state = children.get(name) ?? { crashes: [], child: null };
  children.set(name, state);

  const child = spawn(process.execPath, [file], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  state.child = child;

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;

    const now = Date.now();
    state.crashes = state.crashes.filter((t) => now - t < CRASH_WINDOW_MS);
    state.crashes.push(now);

    if (state.crashes.length > CRASH_LIMIT) {
      console.error(
        `\n[${name}] crashed ${state.crashes.length} times in a minute - not restarting again.\n` +
          `[${name}] this is a real fault. Check logs/app-${new Date().toISOString().slice(0, 10)}.log,\n` +
          `[${name}] or run:  node scripts/logs.mjs --errors\n`
      );
      shutdown(1);
      return;
    }

    const delay = Math.min(RESTART_BASE_MS * 2 ** (state.crashes.length - 1), RESTART_MAX_MS);
    console.error(
      `\n[${name}] exited (${signal ?? `code ${code}`}). Restarting in ${delay / 1000}s ` +
        `(attempt ${state.crashes.length} of ${CRASH_LIMIT}).\n`
    );
    setTimeout(() => {
      if (!shuttingDown) run(name, file, env);
    }, delay);
  });

  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children.values()) {
    if (child && !child.killed) child.kill();
  }
  setTimeout(() => process.exit(code), 150);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log("");
console.log("  NIEC Visa AI");
console.log("  ---------------------------------------------");
const PUBLIC_PORT = Number.parseInt(process.env.PORT || process.env.FRONTEND_PORT || "3000", 10);
const INTERNAL_API_PORT = Number.parseInt(process.env.INTERNAL_API_PORT || "4000", 10);
console.log(`  Website   http://localhost:${PUBLIC_PORT}`);
console.log(`  API       proxied at http://localhost:${PUBLIC_PORT}/api`);
console.log(`  Health    http://localhost:${PUBLIC_PORT}/health`);
console.log(`  Engine    ${config.ai.enabled ? `provider (${config.ai.model})` : "built-in (no AI key set)"}`);
console.log("");
console.log("  Demo account: student@example.com / Demo123!");
console.log("  Press Ctrl+C to stop.");
console.log("");

run("api", path.join(ROOT, "backend", "src", "server.mjs"), {
  PORT: String(INTERNAL_API_PORT),
  HOST: "127.0.0.1",
  CORS_ORIGINS: process.env.PUBLIC_APP_URL || `http://localhost:${PUBLIC_PORT}`,
});

run("web", path.join(ROOT, "frontend", "server.mjs"), {
  FRONTEND_PORT: String(PUBLIC_PORT),
  HOST: "0.0.0.0",
  INTERNAL_API_URL: `http://127.0.0.1:${INTERNAL_API_PORT}`,
  PUBLIC_API_URL: process.env.PUBLIC_API_URL || "SAME_ORIGIN",
});
