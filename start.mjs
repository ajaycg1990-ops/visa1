import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./backend/src/config.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  console.error(`NIEC Visa AI needs Node 22.5 or newer (found ${process.versions.node}).`);
  process.exit(1);
}

// Render exposes one public PORT. The web server owns that port and proxies
// /api/* to the API on an internal loopback-only port.
const isRender = Boolean(process.env.RENDER || process.env.RENDER_SERVICE_ID);
const publicPort = Number.parseInt(process.env.PORT || process.env.FRONTEND_PORT || "3000", 10);
const apiPort = Number.parseInt(process.env.BACKEND_PORT || "4000", 10);
const publicHost = isRender ? "0.0.0.0" : (process.env.HOST || "127.0.0.1");

const children = new Map();
let shuttingDown = false;
const RESTART_BASE_MS = 1000;
const RESTART_MAX_MS = 30_000;
const CRASH_LIMIT = 5;
const CRASH_WINDOW_MS = 60_000;

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
      console.error(`\n[${name}] crashed ${state.crashes.length} times in a minute - not restarting again.`);
      shutdown(1);
      return;
    }
    const delay = Math.min(RESTART_BASE_MS * 2 ** (state.crashes.length - 1), RESTART_MAX_MS);
    console.error(`\n[${name}] exited (${signal ?? `code ${code}`}). Restarting in ${delay / 1000}s.`);
    setTimeout(() => { if (!shuttingDown) run(name, file, env); }, delay);
  });
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children.values()) if (child && !child.killed) child.kill();
  setTimeout(() => process.exit(code), 150);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log("\n  NIEC Visa AI");
console.log("  ---------------------------------------------");
console.log(`  Website   http://${publicHost}:${publicPort}`);
console.log(`  API       proxied at http://${publicHost}:${publicPort}/api`);
console.log(`  API local http://127.0.0.1:${apiPort}`);
console.log(`  Engine    ${config.ai.enabled ? `provider (${config.ai.model})` : "built-in (no AI key set)"}`);
console.log("  Admin     /admin/\n");

run("api", path.join(ROOT, "backend", "src", "server.mjs"), {
  PORT: String(apiPort),
  BACKEND_PORT: String(apiPort),
  HOST: "127.0.0.1",
});

run("web", path.join(ROOT, "frontend", "server.mjs"), {
  FRONTEND_PORT: String(publicPort),
  BACKEND_PORT: String(apiPort),
  HOST: publicHost,
  BROWSER_API_URL: "",
});
