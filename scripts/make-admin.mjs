import * as db from "../backend/src/db.mjs";

/**
 * Promote an account to admin, or demote it back.
 *
 *   node scripts/make-admin.mjs someone@niec.edu.np
 *   node scripts/make-admin.mjs someone@niec.edu.np --remove
 *   node scripts/make-admin.mjs --list
 *
 * Deliberately a command line tool with no web equivalent: the first admin has
 * to come from someone with access to the server, and there is no screen
 * anywhere in the app that can grant this. That closes the obvious hole where
 * a stolen student session escalates itself to admin.
 */

const args = process.argv.slice(2);
const email = args.find((a) => !a.startsWith("--"));
const remove = args.includes("--remove");

db.init();

if (args.includes("--list") || !email) {
  const admins = db.listAdmins();
  if (!admins.length) {
    console.log("\nNo admins yet.\n");
    console.log("Promote one with:  node scripts/make-admin.mjs you@niec.edu.np");
    console.log("(The account must already exist - sign up in the app first.)\n");
  } else {
    console.log(`\n${admins.length} admin(s):`);
    for (const a of admins) console.log(`  ${a.email}  (${a.full_name})`);
    console.log("");
  }
  process.exit(0);
}

const user = db.setUserRole(email, remove ? "student" : "admin");

if (!user) {
  console.error(`\nNo account found for ${email}.`);
  console.error("Sign up in the app first, then run this again.\n");
  process.exit(1);
}

console.log("");
console.log(remove ? `${user.email} is no longer an admin.` : `${user.email} is now an admin.`);
console.log("");

if (!remove) {
  console.log("Sign out and back in, then the Admin link appears in the navigation.");
  console.log("");
  console.log("Admins see aggregate reporting only: student list, interview counts,");
  console.log("average scores and data requests. No screen or endpoint exposes another");
  console.log("student's answers, profile or coaching text.");
  console.log("");
}
