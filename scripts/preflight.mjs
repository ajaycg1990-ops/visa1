import { runChecks } from "../backend/src/checks.mjs";

/**
 * Pre-launch check.
 *
 *   node scripts/preflight.mjs
 *
 * Run this on the server before you point students at it. The checks live in
 * backend/src/checks.mjs, shared with the admin portal's System page.
 *
 * Exits non-zero if anything is FAIL, so a deploy script can gate on it.
 */

const COLOUR = { pass: "\x1b[32mPASS\x1b[0m", warn: "\x1b[33mWARN\x1b[0m", fail: "\x1b[31mFAIL\x1b[0m" };

console.log("\nNIEC Visa AI - pre-launch check");
let group = null;
const results = runChecks();
for (const check of results) {
  if (check.group !== group) {
    group = check.group;
    console.log(`\n${group}`);
  }
  console.log(`  ${COLOUR[check.status]}  ${check.label}${check.detail ? `  - ${check.detail}` : ""}`);
}

const fails = results.filter((c) => c.status === "fail").length;
const warns = results.filter((c) => c.status === "warn").length;
console.log("");
if (fails) {
  console.log(`\x1b[31m${fails} blocking problem(s)\x1b[0m and ${warns} warning(s). Do not launch until the FAILs are fixed.\n`);
  process.exitCode = 1;
} else if (warns) {
  console.log(`\x1b[33mNo blocking problems, ${warns} warning(s).\x1b[0m Read them before you launch.\n`);
} else {
  console.log("\x1b[32mAll checks passed. Ready to launch.\x1b[0m\n");
}
