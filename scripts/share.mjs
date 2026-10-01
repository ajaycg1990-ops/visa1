import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { config, ROOT } from "../backend/src/config.mjs";

/**
 * A temporary public https link to this computer's NIEC Visa AI.
 *
 *   node scripts/share.mjs        (or double-click share.bat)
 *
 * Starts the site, then a Cloudflare quick tunnel to it, and prints the link.
 * Anyone with the link can use the site - on a phone too, microphone included,
 * because the link is https. It works only while this window stays open and
 * the computer is on, and the link changes every time. For a permanent
 * address, host it on a server (DEPLOY.md).
 *
 * Needs tools/cloudflared.exe (Windows) or cloudflared on the PATH.
 */

const bundled = path.join(ROOT, "tools", process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
const cloudflared = existsSync(bundled) ? bundled : "cloudflared";

const children = [];
const stopAll = () => {
  for (const child of children) child.kill();
  process.exit(0);
};
process.on("SIGINT", stopAll);
process.on("SIGTERM", stopAll);

// 1. The site itself.
const site = spawn(process.execPath, [path.join(ROOT, "start.mjs")], { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] });
children.push(site);

// 2. Wait until it answers, then open the tunnel.
const localUrl = `http://localhost:${config.frontendPort}`;
for (let i = 0; i < 60; i++) {
  try {
    const response = await fetch(`${localUrl}/api/config`);
    if (response.ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

const tunnel = spawn(cloudflared, ["tunnel", "--no-autoupdate", "--url", localUrl], { cwd: ROOT });
children.push(tunnel);
tunnel.on("error", () => {
  console.error("\nCould not start cloudflared. Download it from https://github.com/cloudflare/cloudflared/releases");
  console.error(`and save it as ${bundled}\n`);
  stopAll();
});

let announced = false;
const watch = (chunk) => {
  const match = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (match && !announced) {
    announced = true;
    const line = "=".repeat(64);
    console.log(`\n${line}`);
    console.log("  NIEC Visa AI is online at:\n");
    console.log(`    Students:  ${match[0]}`);
    console.log(`    Staff:     ${match[0]}/admin/`);
    console.log("\n  Works on any phone. Keep this window open - closing it takes");
    console.log("  the site offline. The link changes each time you run this.");
    console.log(`${line}\n`);
  }
};
tunnel.stdout.on("data", watch);
tunnel.stderr.on("data", watch);
tunnel.on("exit", (code) => {
  console.error(`\nThe tunnel stopped (code ${code}). The site is no longer public.`);
  stopAll();
});
