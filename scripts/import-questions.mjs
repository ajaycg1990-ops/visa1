import { readFileSync } from "node:fs";
import path from "node:path";
import * as db from "../backend/src/db.mjs";
import { normalizeQuestion, parseQuestionUpload } from "../backend/src/interviewer.mjs";
import { readQuestionFile } from "../frontend/file-text.mjs";

/**
 * Load a question list into the bank from the command line.
 *
 *   node scripts/import-questions.mjs questions.docx
 *   node scripts/import-questions.mjs questions.xlsx --dry-run
 *
 * The same thing the admin portal's "Question bank" section does, for a file
 * already on the server: Word (.docx), Excel (.xlsx), CSV or plain text, read
 * by the same code the browser uses. Headings, numbering, column titles and
 * sample answers are recognised; questions already in the bank are skipped, so
 * running it twice is safe. --dry-run shows how each question would be sorted
 * without saving anything.
 */

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const dryRun = args.includes("--dry-run");

if (!file) {
  console.error("\nUsage: node scripts/import-questions.mjs <file.docx|.xlsx|.csv|.txt> [--dry-run]\n");
  process.exit(1);
}

let text;
try {
  ({ text } = await readQuestionFile(new File([readFileSync(file)], path.basename(file))));
} catch (error) {
  console.error(`\n${error.code === "ENOENT" ? `Cannot find ${file}.` : error.message}\n`);
  process.exit(1);
}

const { items, skipped } = parseQuestionUpload(text);

console.log("");
for (const item of items) {
  console.log(`  ${(item.topic ?? "general").padEnd(17)} ${item.category.padEnd(26)} ${item.question}`);
}
if (skipped.length) {
  console.log(`\nLeft out ${skipped.length} line(s):`);
  for (const s of skipped) console.log(`  - ${s.reason}: ${s.line}`);
}
if (!items.length) {
  console.log("\nNo questions found. Put one question per line.\n");
  process.exit(1);
}

if (dryRun) {
  console.log(`\nDry run: ${items.length} question(s) read, nothing saved.\n`);
  process.exit(0);
}

db.init();
const { added, duplicates } = db.addBankQuestions(items, { normalize: normalizeQuestion });
console.log(`\nAdded ${added.length} question(s)${duplicates ? `, ${duplicates} already in the bank` : ""}.`);
console.log("New interviews use them straight away - no restart needed.\n");
