/**
 * The personal document checklist.
 *
 * Built from the student's own case file: everyone needs the core set, and
 * each risk or funding source in the file adds the papers that back it up -
 * a loan adds the sanction letter, an uncle as sponsor adds the relationship
 * proof, a gap year adds experience letters. Each conditional item says why
 * it is on the list, so the student understands the file, not just the pile.
 *
 * This is preparation guidance, not an official list. The page tells the
 * student to confirm against the U.S. Embassy's current instructions.
 */

const hasText = (value) => typeof value === "string" && value.trim().length > 0;
const money = (value) => Number(String(value ?? "").replace(/[^\d.]/g, "")) || 0;
const isNo = (value) => !hasText(value) || /^(no|none|nil|0|never|n\/a)$/i.test(String(value).trim());

export const GROUPS = [
  { id: "core", title: "Visa application" },
  { id: "academic", title: "Academic" },
  { id: "financial", title: "Financial" },
  { id: "case", title: "Your case" },
];

/** The checklist for one student's file. */
export function documentChecklist(rawProfile) {
  const p = rawProfile ?? {};
  const items = [];
  const add = (group, id, title, detail, because = null, essential = true) =>
    items.push({ id, group, title, detail, because, essential });

  /* -- visa application: everyone -- */
  add("core", "passport", "Passport", "Valid for at least six months beyond your intended stay, plus any old passports.");
  add("core", "i20", "Form I-20", `From ${hasText(p.usUniversity) ? p.usUniversity : "your university"}, signed by you and the school official. Check every figure matches your funding documents.`);
  add("core", "ds160", "DS-160 confirmation page", "The page with the barcode. Re-read your answers the night before - what you say must match it.");
  add("core", "appointment", "Appointment confirmation letter", "From the visa appointment booking system.");
  add("core", "sevis", "SEVIS I-901 fee receipt", "Paid online before the interview; print the receipt.");
  add("core", "mrv", "Visa application (MRV) fee receipt", "Proof of the visa fee payment.");
  add("core", "photo", "Passport photo", "One recent photo in the U.S. visa format (5 x 5 cm, white background).");

  /* -- academic -- */
  add("academic", "admission", "Admission letter", `Your offer from ${hasText(p.usUniversity) ? p.usUniversity : "the university"}${hasText(p.program) ? ` for ${p.program}` : ""}.`);
  add("academic", "transcripts", "Transcripts and certificates", `SEE, +2 and ${hasText(p.highestDegree) ? p.highestDegree : "degree"} transcripts, certificates and character certificates.`);
  add("academic", "tests", "Test score reports", hasText(p.englishTest) ? `${p.englishTest} - bring the official score report.` : "IELTS, TOEFL, Duolingo, GRE or SAT - whichever the university used to admit you.");

  /* -- financial -- */
  const selfFunded = /\bself\b|myself/i.test(p.sponsorRelation ?? "");
  const sponsor = hasText(p.sponsorRelation) && !selfFunded ? p.sponsorRelation.toLowerCase() : "sponsor";
  add(
    "financial",
    "bank",
    "Bank balance certificate and statements",
    `${selfFunded ? "Your" : `Your ${sponsor}'s`} bank balance certificate and at least six months of statements. The balance should cover the cost on your I-20${money(p.totalCoaUsd) ? ` ($${money(p.totalCoaUsd).toLocaleString("en-US")})` : ""}.`,
    money(p.savingsUsd) ? `Your file shows $${money(p.savingsUsd).toLocaleString("en-US")} in savings` : null
  );

  const occupation = String(p.sponsorOccupation ?? "").toLowerCase();
  if (/business|owner|shop|company|trader|contractor|supply|industry|enterprise/.test(occupation)) {
    add("financial", "business", "Business documents", "Business registration, PAN/VAT certificate, tax clearance certificates and audited accounts for the last three years.", `Your ${sponsor} runs a business`);
  } else if (/farm|agri|cultivat|livestock/.test(occupation)) {
    add("financial", "agri-income", "Agricultural income proof", "Land ownership papers and an income certificate from the ward or municipality office.", `Your ${sponsor}'s income is from farming`);
  } else if (/retired|pension/.test(occupation)) {
    add("financial", "pension", "Pension documents", "Pension book or statements and any other income records.", `Your ${sponsor} is retired`);
  } else if (hasText(occupation)) {
    add("financial", "salary", "Employment and salary proof", "Employment letter, recent salary slips and tax clearance.", `Your ${sponsor} is employed`);
  }
  add("financial", "income-source", "Income source verification", "An income source certificate from the ward or municipality office, with the documents behind each source.", null);
  add("financial", "valuation", "Property valuation report", "Optional, but commonly used to show family assets beyond cash.", null, false);

  if (!selfFunded && hasText(p.sponsorRelation)) {
    const parent = /father|mother|parent/i.test(p.sponsorRelation);
    add(
      "financial",
      "relationship",
      "Relationship verification certificate",
      parent
        ? "From the ward office, showing your relationship to your sponsor. Your birth certificate supports it."
        : "From the ward office, plus a signed sponsorship letter explaining why they are paying for your education. Expect to be asked why.",
      `Your sponsor is your ${sponsor}`
    );
  }
  if (money(p.loanUsd) > 0) {
    add("financial", "loan", "Education loan sanction letter", "From the bank, with the amount, terms and collateral documents. Know your repayment plan.", `Your file includes a $${money(p.loanUsd).toLocaleString("en-US")} loan`);
  }
  if (money(p.scholarshipUsd) > 0) {
    add("financial", "scholarship", "Scholarship or assistantship letter", "The award letter. The amount must match what your I-20 shows.", `Your file includes a $${money(p.scholarshipUsd).toLocaleString("en-US")} scholarship`);
  }

  /* -- your case -- */
  const gap = hasText(p.gapYears) && !isNo(p.gapYears);
  if (gap) {
    add("case", "gap", "Proof of what you did in your gap", "Experience letters, salary slips, training or course certificates covering the whole period.", `Your file shows a gap of ${p.gapYears}`);
  }
  if (!isNo(p.refusals)) {
    add("case", "refusal", "Previous refusal letter", "The refusal slip (usually 214(b)) and a short note to yourself of what has changed since. Never hide a refusal - it is on record.", "Your file shows a previous refusal");
  }
  if (/property|land|house|home|lalpurja/i.test(p.tiesHome ?? "")) {
    add("case", "property", "Family property documents", "Land ownership certificates (lalpurja) for the property you mention as a tie to home.", "You list property as a tie to Nepal", false);
  }
  if (/offer|employer|company|join|job/i.test(`${p.planAfter ?? ""} ${p.careerGoal ?? ""}`)) {
    add("case", "career", "Evidence of your career plan", "A letter from a prospective employer, or research on the companies and roles you mean - only if you have it.", "Your plan after graduating names a job", false);
  }
  if (!isNo(p.travelHistory)) {
    add("case", "travel", "Old passports with visas and stamps", "Earlier travel you returned from is evidence you come home.", `Your file lists travel: ${p.travelHistory}`, false);
  }
  add("case", "ds160-review", "A printed copy of your own answers", "Your DS-160 answers and the figures on your I-20, read the morning of the interview.", null, false);

  return { groups: GROUPS, items };
}

/** Keep only ticks for items that are on this student's list. */
export function cleanDone(done, items) {
  const known = new Set(items.map((i) => i.id));
  return [...new Set(Array.isArray(done) ? done.filter((id) => typeof id === "string" && known.has(id)) : [])];
}
