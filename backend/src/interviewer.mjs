import * as ai from "./ai.mjs";

/**
 * The live interviewer.
 *
 * Nothing is planned in advance. After every answer the officer decides what
 * to ask next, the way a real one does:
 *
 *   1. a red flag is challenged at once            (server, via ai.challengeFor)
 *   2. something in the answer worth probing is followed up - a number that is
 *      not in the file, a cousin in Texas, a consultancy, a named employer
 *   3. otherwise the next question comes from the bank - the essentials first
 *      (study, money, return, and this student's own risks), then whatever the
 *      last answer points towards, keeping the categories balanced
 *
 * The bank is the built-in topics plus every question NIEC staff upload from
 * the admin portal. Uploaded questions are sorted into the same topics, so a
 * staff-written "What does your father do for a living?" counts as covering
 * the sponsor topic and is asked in its place.
 */

/**
 * Follow-ups per interview, and in a row, before the officer moves on. A
 * critical point (money that is not in the file, working in the U.S., a
 * partner or relative there) gets one more turn than ordinary curiosity.
 */
const MAX_FOLLOW_UPS = 4;
const MAX_FOLLOW_UP_STREAK = 2;
const MAX_CRITICAL_STREAK = 3;

/* ------------------------------- topic matching ----------------------------- */

/**
 * Which built-in topic an uploaded question belongs to. Checked in this order,
 * so the more specific topics win ("What if you do not find a job after
 * graduation?" is no_job, not after_graduation).
 */
const TOPIC_MATCH = [
  // "Have you ever been refused?" is fair to ask anyone, so it stays a general
  // history question - unlike the refusal topic, which assumes there was one.
  [null, /have you ever been (refused|denied|rejected)|have you (ever )?(applied|been refused|been denied)\b.{0,30}before\??$/],
  ["refusal",/refus|\bdenied\b|rejected (visa|before)|applied for (a |an )?(u\.?s\.? )?visa before|214\s?\(?b/],
  ["loan", /\bloans?\b|borrow/],
  ["opt", /\bopt\b|practical training|stem extension|h-?1b|work visa|work permit/],
  ["no_job", /(don'?t|do not|can'?t|cannot|fail to|unable to) (get|find) a job|no job|without a job|unemployed/],
  ["think_stay", /(going|want|plan|planning) to stay|won'?t (come|go) back|won'?t you stay|(will|would) you stay (in|on)|stay (in|on) (in )?(the )?(us|usa|u\.s\.|america|united states)|not (going to )?return|immigrat|settle (in|there|down in)|green card|change my mind/],
  ["why_visa", /why should (i|we) (give|grant|approve|issue)|convince me|why do you deserve/],
  ["rehearsed", /rehears|memori[sz]|own words|scripted|coached/],
  ["who_chose", /who (helped|prepared|filled)|consultan|agency|\bagents?\b|(yourself|by yourself|on your own)\?/],
  ["relatives", /relatives?\b|family members? (in|living in) (the )?(us|usa|u\.s\.|america|united states|states)|anyone (you know )?in (the )?(us|usa|u\.s\.|america|united states)|(brother|sister|cousin|uncle|aunt)s? (in|living in) (the )?(us|usa|america|states)/],
  ["gap", /\bgap\b|since (you )?(graduat|finish|complet)|what (have|were) you (been )?doing (since|after)|break in (your )?stud/],
  ["shortfall", /(income|earn\w*).{0,50}(cost|tuition|fees?)|not enough (money|funds)|how (does|will) that (work|add up)|shortfall/],
  ["sponsor", /sponsor|who (is |will be )?(pay|paying|fund|funding|financ|support)\w*|what does your (father|mother|parents?|dad|mom|uncle|aunt|brother|sister) do|(father|mother|parents?|dad|mom)'?s? (job|occupation|income|business|work|profession)|annual income|how much does your (father|mother|sponsor|family) (earn|make)/],
  ["first_year_cost", /(how much|what) (is|does|will) (the |your |it )?(total )?(cost|tuition|fees?|expenses?)|cost of attendance|\bi-?20\b|living (costs?|expenses)|how (will|do) you (pay|cover|afford|manage)/],
  ["work", /(work|job) (while|during) (you )?(study|studying|studies|your studies)|part[- ]time|on[- ]campus (job|work)|plan to work/],
  ["salary", /salary|how much (will|would|can) you (earn|make)|worth (the|this) (investment|money)|return on (your )?investment/],
  ["ties", /\bties\b|what (will |would )?(bring|brings) you back|why (would|will) you (come|go) back|reason to (come back|return)|what (do you have|keeps you) (in|at) (nepal|home)/],
  ["after_graduation", /after (you )?(graduat|finish|complet)|after (your )?(studies|degree|course|graduation|masters|bachelors)|future plans?|plans? after|where do you see yourself|what will you do (after|when|once)/],
  ["english", /ielts|toefl|\bpte\b|duolingo|\bgre\b|\bsat\b|english (test|score|proficiency)|test scores?/],
  ["academics", /\bgpa\b|cgpa|\bgrades?\b|percentage|\bmarks\b|academic (record|performance|background)|transcripts?|backlogs?/],
  ["why_not_home", /why not (study )?(in )?(nepal|your (home )?country|home)|why (study )?(in )?(the )?(us|usa|u\.s\.|america|united states)\b|(choose|chose|pick|picked|select|selected) (the )?(us|usa|u\.s\.|america|united states)\b|over (canada|the uk|uk|australia|germany|other countries)|same (course|program|programme) in nepal/],
  ["uni_choice", /why (did you |have you )?(choose|chose|pick|picked|select|selected|apply to|applied to)|why (this|that|your) (university|college|school)|what made you (choose|pick|select)|why .{0,30}\b(university|college)\b/],
  ["shortlist", /how many (universities|colleges|schools)|which (other )?(universities|colleges|schools)|other (universities|offers|admits)|where else did you apply|\badmits?\b|\badmitted\b|rejected by/],
  ["program_content", /what (will|are) you (going to )?study|what (is|are) (your|the) (course|courses|program|programme|major|subjects?)|which courses|curriculum|what will you learn|tell me about (your|the) (program|programme|course)/],
  ["travel", /travel{1,2}ed|been abroad|visited|other countries|outside (nepal|your country)|\btrips?\b/],
];

/** Category for an uploaded question that fits no topic. */
const CATEGORY_RULES = [
  ["Composure Under Pressure", /why should i|convince|change my mind|really\b|honestly|prove|i don'?t believe/],
  ["Financial Readiness", /money|fund|pay|cost|fee|tuition|bank|income|salary|afford|sponsor|scholar|expens|dollar|rupee|savings/],
  ["Intent to Return", /return|come back|go back|after (you )?(graduat|finish|complet)|future|stay|settle|career|nepal after|plans?/],
  ["Academic & Program", /stud(y|ies)|course|program|university|college|major|degree|gpa|professor|research|class|semester|thesis|subject|ielts|toefl|school/],
];

/** Words staff might write for each category in an upload. */
const CATEGORY_ALIASES = [
  ["Academic & Program", /^(academic|academics|academic & program|academic and program|study|studies|program|programme|university|education)$/],
  ["Financial Readiness", /^(financial|finance|finances|financial readiness|money|funding|funds|sponsor|sponsorship)$/],
  ["Intent to Return", /^(intent|intent to return|return|ties|future|career|plans?)$/],
  ["Personal & History", /^(personal|history|personal & history|personal and history|background|family|travel)$/],
  ["Composure Under Pressure", /^(composure|pressure|composure under pressure|tough|stress|hard|challenge)$/],
];

export function categoryFromAlias(value) {
  const key = String(value ?? "").trim().toLowerCase();
  return CATEGORY_ALIASES.find(([, pattern]) => pattern.test(key))?.[0] ?? null;
}

/** Lower-case, collapse spacing and punctuation: the key for spotting duplicates. */
export function normalizeQuestion(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/\{[a-z]+\}|\$\{[a-z]+\}/g, "x")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** The topic and category of one question. A category the uploader gave wins. */
export function classifyQuestion(question, givenCategory = null) {
  const text = String(question ?? "").toLowerCase();
  const topic = TOPIC_MATCH.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
  const topicCategory = topic ? ai.findBankEntry(topic)?.category : null;
  const ruled = CATEGORY_RULES.find(([, pattern]) => pattern.test(text))?.[0];
  return { topic, category: givenCategory ?? topicCategory ?? ruled ?? "Personal & History" };
}

/* ---------------------------------- uploads --------------------------------- */

/**
 * Loose category words, for headings and category columns people actually
 * write: "Section 2: Financial Questions", "Study plans", "Tough ones".
 */
const CATEGORY_HINTS = [
  ["Composure Under Pressure", /pressure|tough|tricky|difficult|stress|challeng|composure|rapid|trap/],
  ["Financial Readiness", /financ|fund|money|sponsor|bank (balance|statement|loan)|cost|fee|tuition|expens/],
  ["Intent to Return", /intent|return|ties|future|career|post[- ]?study|after (study|studies|graduat)|plans?\b/],
  ["Academic & Program", /academ|stud(y|ies)|program|course|university|college|education|major|degree/],
  ["Personal & History", /personal|family|background|history|travel|previous/],
];

/** A category from a short label a person wrote: an exact alias, or a phrase that names one. */
export function categoryFromLabel(label) {
  const exact = categoryFromAlias(label);
  if (exact) return exact;
  const text = String(label ?? "")
    .toLowerCase()
    .replace(/\b(questions?|question bank|related|section|part|round|based|set|category|type|q&a|qna|visa|interview|mock|practice|common|frequently asked|faqs?|top|list|niec|f|us|usa|u\.s)\b|[\d:.\-–()#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || text.split(" ").length > 5) return null;
  return categoryFromAlias(text) ?? CATEGORY_HINTS.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
}

/** Word and Excel punctuation that would otherwise defeat the matching. */
function cleanText(text) {
  return String(text ?? "")
    .replace(/^﻿/, "")
    .replace(/[‘’‚ʼ′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/[   ]/g, " ")
    .replace(/[​‌‍]/g, "")
    .replace(/…/g, "...");
}

/** Column titles in a spreadsheet or table header row. */
const HEADER_CELL =
  /^(s\.?\s?n\.?|sl\.?\s?no\.?|no\.?|#|serial( no\.?)?|q\.?\s?no\.?|questions?|question text|category|categories|topic|type|section|answers?|sample answers?|model answers?|remarks?|notes?)$/i;

/** One CSV row, with quoted fields and "" escapes. */
function parseCsvLine(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && !cell.trim()) quoted = true;
    else if (ch === ",") {
      cells.push(cell);
      cell = "";
    } else cell += ch;
  }
  cells.push(cell);
  return cells;
}

/**
 * The columns of one line: tab-separated (Excel, Word tables), pipe-separated,
 * or CSV - but only when it clearly is CSV, because questions contain commas.
 */
function cellsOf(line) {
  if (line.includes("\t")) return line.split("\t");
  if (line.includes("|")) return line.split("|");
  if (line.includes(",")) {
    const cells = parseCsvLine(line);
    if (cells.length >= 2) {
      const first = cells[0].trim();
      const last = cells[cells.length - 1].trim();
      const csv =
        /^"/.test(line.trim()) ||
        /^\d{1,4}$/.test(first) ||
        Boolean(categoryFromAlias(first)) ||
        Boolean(categoryFromAlias(last)) ||
        HEADER_CELL.test(first);
      if (csv) return cells;
    }
  }
  return [line];
}

const unquote = (cell) => cell.trim().replace(/^"([\s\S]*)"$/, "$1").replace(/""/g, '"').trim();

/** The question and category in a row of cells, ignoring serial numbers and an answer column. */
function pickCells(cells, answerColumn) {
  let category = null;
  const texts = [];
  cells.map(unquote).forEach((cell, index) => {
    if (!cell || index === answerColumn || /^[\d.)]+$/.test(cell)) return;
    const label = !cell.includes("?") && cell.split(/\s+/).length <= 4 ? categoryFromLabel(cell) : null;
    if (label && !category) category = label;
    else texts.push(cell);
  });
  // A cell ending in "?" is the question; otherwise the first real text.
  const question = texts.find((t) => /\?\s*$/.test(t)) ?? texts[0] ?? "";
  return { question, category, labelOnly: !question && Boolean(category) };
}

function stripNumbering(text) {
  return text
    .replace(/^[-*•·▪◦●○■➢➤✓✔]\s*/, "")
    .replace(/^q(?:uestion)?\s*(?:no\.?)?\s*[.:#-]?\s*\d{1,3}\s*[.):\-]?\s*/i, "") // Q1. Q.1 Question 1: Q No. 3
    .replace(/^[(\[]?#?\d{1,3}\s*[)\].:\-]\s*/, "") // 1. 1) (1) [1] 1: 1- #1.
    .replace(/^#\d{1,3}\s+/, "")
    .replace(/^[a-h]\)\s+/, "") // a) b) sub-items
    .replace(/^q(?:uestion)?\s*[.:\-)]\s*/i, "") // "Q:" with no number
    .trim();
}

const ANSWER_LINE = /^(ans(wer)?|a|sample answer|model answer|reply|response|tip|hint)\s*[.:\-)]\s*/i;

/** "Why this university? Ans: Because..." - keep the question, drop the answer. */
function cutInlineAnswer(text) {
  const at = text.indexOf("?");
  if (at < 0) return text;
  const rest = text.slice(at + 1).trim();
  if (!rest) return text;
  if (ANSWER_LINE.test(rest) || /^[-–:=>]/.test(rest) || (rest.length > 60 && !rest.includes("?"))) {
    return text.slice(0, at + 1);
  }
  return text;
}

/** "FINANCIAL QUESTIONS", "Section 2: Academic", "Personal:" - a heading, not a question. */
function isHeading(text) {
  if (text.includes("?")) return false;
  const words = text.split(/\s+/).length;
  if (/:\s*$/.test(text) && words <= 8) return true;
  const letters = text.replace(/[^A-Za-z]/g, "");
  if (letters.length >= 4 && letters === letters.toUpperCase() && words <= 8) return true;
  if (/\bquestions?\b/i.test(text) && words <= 6) return true;
  if (/^(section|part|round|chapter)\s+\w+/i.test(text) && words <= 8) return true;
  return words <= 4 && !/[.!]$/.test(text) && Boolean(categoryFromLabel(text));
}

/**
 * Read a pasted or uploaded list of questions. Forgiving on purpose, because
 * staff will paste from Word, Excel, PDFs and chat messages:
 *
 *   Why did you choose this university?          one per line
 *   12. What does your father do?                numbering and bullets removed
 *   Financial | How much is your tuition?        category | question
 *   [Intent] What will you do after graduating?  [category] question
 *   3,"How much is your tuition?",Financial      CSV / Excel columns, any order
 *   FINANCIAL QUESTIONS                          a heading: files what follows
 *   Ans: Because my father...                    sample answers are left out
 *
 * Returns the questions, and every skipped line with the reason.
 */
export function parseQuestionUpload(raw) {
  const items = [];
  const skipped = [];
  const skip = (line, reason) => skipped.push({ line: line.trim().slice(0, 160), reason });
  let sectionCategory = null;
  let answerColumn = -1;

  for (const original of cleanText(raw).split(/\r?\n/)) {
    const line = original.trim();
    if (!line) continue;
    if (/^(#|\/\/)/.test(line) && !/^#\s*\d/.test(line)) continue; // a comment

    const cells = cellsOf(line);
    if (cells.length > 1 && cells.every((c) => !unquote(c) || HEADER_CELL.test(unquote(c)))) {
      answerColumn = cells.findIndex((c) => /answer/i.test(c));
      skip(line, "column headings");
      continue;
    }

    let { question, category, labelOnly } = cells.length > 1 ? pickCells(cells, answerColumn) : { question: line, category: null };
    if (labelOnly) {
      // A row holding only a category is a section heading in a spreadsheet.
      sectionCategory = category;
      skip(line, `heading - questions below it are filed under ${category}`);
      continue;
    }

    const bracket = question.match(/^\[([^\]]{2,40})\]\s*(.+)$/);
    if (bracket && categoryFromLabel(bracket[1])) {
      category ??= categoryFromLabel(bracket[1]);
      question = bracket[2];
    }
    const prefixed = question.match(/^([A-Za-z &]{3,30}):\s+(.+)$/);
    if (prefixed && categoryFromAlias(prefixed[1])) {
      category ??= categoryFromAlias(prefixed[1]);
      question = prefixed[2];
    }

    question = stripNumbering(question);
    if (ANSWER_LINE.test(question)) {
      skip(line, "an answer, not a question");
      continue;
    }
    question = cutInlineAnswer(question);

    if (isHeading(question)) {
      sectionCategory = categoryFromLabel(question);
      skip(line, sectionCategory ? `heading - questions below it are filed under ${sectionCategory}` : "heading");
      continue;
    }

    question = question.replace(/^"([\s\S]*)"$/, "$1").replace(/\s+/g, " ").trim();
    if (!/[a-z]/i.test(question)) skip(line, "no English text");
    else if (question.length < 8) skip(line, "too short to be a question");
    else if (question.length > 300) skip(line, "too long - is this an answer?");
    else items.push({ question, ...classifyQuestion(question, category ?? sectionCategory) });
  }
  return { items, skipped };
}

/* ----------------------------------- pool ----------------------------------- */

/** Topics the officer must cover before approving: the pillars and this student's own risks. */
export function requiredTopicsFor(rawProfile) {
  const profile = rawProfile ?? {};
  const topics = [...ai.PILLAR_IDS];
  for (const entry of ai.BANK) {
    if (entry.requires && entry.requires(profile) && !topics.includes(entry.id)) topics.push(entry.id);
  }
  if (ai.hasRelatives(profile) && !topics.includes("relatives")) topics.push("relatives");
  return topics;
}

/**
 * Every question this student may be asked: the built-in topics plus the
 * active uploaded questions, with placeholders filled from their file. A
 * question about a loan, a refusal or a gap is only in the pool if the file
 * has one - uploaded variants inherit that rule from their topic.
 */
export function buildPool(uploaded, rawProfile) {
  const profile = rawProfile ?? {};
  const eligible = (topic) => {
    const entry = topic ? ai.findBankEntry(topic) : null;
    return !entry?.requires || entry.requires(profile);
  };
  const pool = [];
  for (const entry of ai.BANK) {
    if (!eligible(entry.id)) continue;
    const text = ai.fill(entry.text, profile);
    pool.push({ id: `bank:${entry.id}`, text, norm: normalizeQuestion(text), category: entry.category, topic: entry.id, origin: "bank" });
  }
  for (const row of uploaded ?? []) {
    if (!eligible(row.topic)) continue;
    const text = ai.fill(row.question, profile);
    pool.push({ id: row.id, text, norm: normalizeQuestion(text), category: row.category, topic: row.topic ?? null, origin: "upload" });
  }
  return pool;
}

/* --------------------------------- relevance -------------------------------- */

const STOP = new Set(
  "about above after again also another because been before being below between both could does doing down during each from further have having here into itself just more most much must once only other over same should some such than that their them then there these they this those through under until very were what when where which while will with would your yours you'll i'm it's".split(" ")
);

function stems(text) {
  return new Set(
    String(text ?? "")
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((w) => w.length >= 4 && !STOP.has(w))
      .map((w) => w.slice(0, 6))
  );
}

/** How strongly a candidate question connects to what the student just said. */
function relevance(answerStems, entry) {
  if (!answerStems.size) return 0;
  const topicEntry = entry.topic ? ai.findBankEntry(entry.topic) : null;
  const terms = stems(`${entry.text} ${(topicEntry?.keywords ?? []).join(" ")}`);
  let hits = 0;
  for (const term of terms) if (answerStems.has(term)) hits += 1;
  return Math.min(hits, 4);
}

function similar(a, b) {
  const x = stems(a);
  const y = stems(b);
  if (!x.size || !y.size) return false;
  let shared = 0;
  for (const term of x) if (y.has(term)) shared += 1;
  return shared / Math.min(x.size, y.size) >= 0.75;
}

/* --------------------------------- follow-ups ------------------------------- */

const NOT_A_NAME = new Set(["Nepal", "Kathmandu", "The", "My", "Our", "America", "USA", "US", "United", "Texas", "University", "Nepali"]);

/**
 * Things in an answer a real officer picks up on. Each returns the follow-up
 * question, or null. `critical` ones are always asked; the rest depend on how
 * inquisitive this officer is. Each is asked at most once per interview.
 */
const HOOKS = [
  {
    id: "amount",
    critical: true,
    category: "Financial Readiness",
    ask: (answer, profile) => {
      const found = ai.unfamiliarAmount(answer, profile);
      if (!found) return null;
      return found.file
        ? `You said ${found.said}${found.label ? ` for your ${found.label}` : ""}, but your documents show ${found.file}. Which is correct?`
        : `You said ${found.said}. Where exactly does that figure come from, and is it in your documents?`;
    },
  },
  {
    id: "extra_sponsor",
    critical: true,
    category: "Financial Readiness",
    ask: (answer, profile) => {
      const recorded = String(profile.sponsorRelation ?? "").toLowerCase();
      if (!recorded) return null;
      // "My father pays, and my uncle might help" - the file's sponsor comes
      // first, so look at every person named, not just the first.
      const pattern = /\b(uncle|aunt|brother|sister|cousin|grandfather|grandmother|mother|father)\b[^.]{0,30}?\b(help|helps|helping|pay|pays|paying|support|supports|contribute|contributes|fund|funds|give|gives)\b/gi;
      const other = [...answer.matchAll(pattern)].find((m) => !recorded.includes(m[1].toLowerCase()));
      return other ? `You mentioned your ${other[1].toLowerCase()} helping with money. How much, and is that support in your documents?` : null;
    },
  },
  {
    id: "partner",
    critical: true,
    category: "Personal & History",
    ask: (answer) => {
      const m = answer.match(/\b(girlfriend|boyfriend|fianc[eé]e?|wife|husband|spouse)\b/i);
      return m ? `Where is your ${m[1].toLowerCase()} now, and what are their plans while you study?` : null;
    },
  },
  {
    id: "us_work",
    critical: true,
    category: "Intent to Return",
    ask: (answer, _profile, last) => {
      if (last.topic === "opt" || last.topic === "work") return null;
      const m = /\b(opt|stem opt|h-?1b|green card|work (in|for a company in) (the )?(us|usa|u\.s\.|america|united states)|(gain|get) (some )?(work )?experience (in the us|in america|there)|work there)\b/i.test(answer);
      return m ? "You mentioned working in the United States. For how long, exactly - and what brings you home after that?" : null;
    },
  },
  {
    id: "relative",
    critical: true,
    category: "Personal & History",
    ask: (answer, _profile, last) => {
      if (last.topic === "relatives") return null;
      for (const sentence of answer.split(/(?<=[.!?;])\s+/)) {
        const who = sentence.match(/\b(cousin|uncle|aunt|brother|sister|relatives?|friends?)\b/i);
        const inUs = /\b(us|u\.s\.|usa|america|united states|texas|california|new york|florida|dallas|houston|boston|chicago|seattle|virginia)\b/i.test(sentence);
        if (who && inUs) {
          const person = who[1].toLowerCase();
          return `You mentioned your ${person} in the United States. What is their status there, and will you live with them?`;
        }
      }
      return null;
    },
  },
  {
    id: "consultancy",
    category: "Personal & History",
    ask: (answer, _profile, last) =>
      last.topic !== "who_chose" && /\b(consultanc(y|ies)|consultant|agency|education counsell?or)\b/i.test(answer)
        ? "Did the consultancy choose this university for you, or did you? What did you compare it against?"
        : null,
  },
  {
    id: "business",
    category: "Financial Readiness",
    ask: (answer) =>
      /\b(family|father'?s|mother'?s|our|his|her|parents'?)\s+(\w+\s+){0,2}(business|company|shop|firm|factory|hotel|restaurant)\b/i.test(answer)
        ? "Tell me about that business. What exactly does it do, and roughly how much does it earn in a year?"
        : null,
  },
  {
    id: "property",
    category: "Financial Readiness",
    ask: (answer) =>
      /\b(property|properties|land|lalpurja|apartment)\b/i.test(answer)
        ? "Whose name is that property in, and roughly what is it worth?"
        : null,
  },
  {
    id: "scholarship",
    category: "Financial Readiness",
    ask: (answer) =>
      /\b(scholarship|assistantship|fellowship|tuition waiver)\b/i.test(answer)
        ? "Is that scholarship guaranteed for every year of the programme, or only the first?"
        : null,
  },
  {
    id: "company",
    category: "Intent to Return",
    ask: (answer, profile) => {
      const m = answer.match(/\b(?:join|joining|work (?:at|for|with)|working (?:at|for|with)|job (?:at|with)|apply (?:to|at))\s+((?:[A-Z][\w&.-]*)(?:\s+[A-Z][\w&.-]*){0,3})/);
      if (!m) return null;
      const name = m[1].trim();
      const first = name.split(/\s+/)[0];
      const uni = String(profile.usUniversity ?? "").split(/\s+/)[0];
      if (NOT_A_NAME.has(first) || (uni && first === uni)) return null;
      return `You mentioned ${name}. What role would you have there, and have you been in contact with them?`;
    },
  },
  {
    id: "professor",
    category: "Academic & Program",
    ask: (answer) => {
      const m = answer.match(/\b(Professor|Prof\.?|Dr\.?)\s+([A-Z][a-z]+)/);
      return m ? `What do you know about ${m[1]} ${m[2]}'s work, and why does it matter to you?` : null;
    },
  },
  {
    id: "vague",
    category: "Academic & Program",
    ask: (answer) => {
      const m = answer.match(/\b(good|best|famous|reputed|top|world[- ]class|prestigious|high[- ]ranking|well[- ]known)\s+(university|college|school|program|programme|ranking|faculty|education)\b/i);
      return m ? `You called it a "${m[0].toLowerCase()}". What does that mean for your programme, specifically?` : null;
    },
  },
  {
    id: "unsure",
    category: "Composure Under Pressure",
    ask: (answer, _profile, last) =>
      !last.isFollowUp && String(last.question).length < 160 && /\b(i think|i guess|maybe|not sure|probably|i hope)\b/i.test(answer)
        ? `You don't sound sure. Let me ask again: ${last.question}`
        : null,
  },
];

/** The follow-up to the answer just given, or null to move on. */
function followUpOn({ last, rows, profile, mode, random, streak = 0 }) {
  const officer = ai.MODES[mode] ?? ai.MODES.neutral;
  const used = new Set(rows.map((r) => r.origin).filter((o) => String(o ?? "").startsWith("hook:")));
  const asked = rows.map((r) => r.question);
  const answer = String(last.answer ?? "");

  for (const hook of HOOKS) {
    if (used.has(`hook:${hook.id}`)) continue;
    const question = hook.ask(answer, profile, last);
    if (!question) continue;
    if (streak >= (hook.critical ? MAX_CRITICAL_STREAK : MAX_FOLLOW_UP_STREAK)) continue;
    if (!hook.critical && random() > officer.followUpBias) continue;
    return { question, category: hook.category ?? last.category, topic: last.topic ?? null, origin: `hook:${hook.id}`, isFollowUp: true, critical: Boolean(hook.critical) };
  }

  // A weak answer to an essential question is always drilled - that is also
  // the student's chance to recover it. A thin answer elsewhere, sometimes.
  const weakEssential = last.isRequired && ai.trueQuality(last.scores, mode) < ai.ADAPTIVE.requiredFloor;
  if ((!last.isFollowUp || weakEssential) && streak < MAX_FOLLOW_UP_STREAK) {
    const drill = ai.followUpFor({
      mode,
      question: last.question,
      category: last.category,
      topic: last.topic,
      answer,
      alreadyAsked: asked,
      force: weakEssential,
    });
    if (drill) return { ...drill, topic: last.topic ?? null, origin: "drill", isFollowUp: true, critical: weakEssential };
  }
  return null;
}

/* ------------------------------- next question ------------------------------ */

/** One question from a topic: a staff-uploaded wording if there is one, else the built-in. */
/**
 * Essential topics a student often answers before being asked - "my father
 * pays, he runs a shop" in reply to a question about a cousin. Asking "Who is
 * sponsoring your education?" next would show the officer was not listening,
 * so a topic already touched gets a deeper question on the same point instead.
 */
const TOUCHED = {
  sponsor: /\b(father|mother|parents?|uncle|aunt|brother|sister|sponsor|myself)\b[^.]{0,40}\b(pay|pays|paying|sponsor|sponsors|sponsoring|fund|funds|funding|support|supports|supporting)\b|\b(paid|sponsored|funded|supported) by (my )?(father|mother|parents?|uncle|aunt|brother|sister)/i,
  after_graduation: /\b(return|come back|go back|back home|back to nepal|move back)\b[^.]{0,80}\b(job|work|career|role|company|business|engineer|join|start)|\b(job|work|career|role|join)\b[^.]{0,80}\b(return|come back|go back|back home|back to nepal)\b/i,
  gap: /\b(since (i )?graduat\w*|after (i )?graduat\w*|during (my|the) gap|for the (last|past) (year|two years))\b/i,
};

/**
 * The deeper question for each touched topic, in order; one is skipped when
 * the student has already given what it asks for (no asking for an income
 * they just stated).
 */
const DEEPER = {
  sponsor: [
    { q: "What is their annual income, and can you show it in your documents?", skip: /\b(earn|earns|earning|income|salary|makes)\b/i },
    { q: "How much of your first-year cost do they have in the bank today?", skip: /\b(savings|in the bank|deposit|balance)\b/i },
    { q: "Can you show all of that in your documents today - the income and the savings?" },
  ],
  after_graduation: [
    { q: "Be specific: which employer, which role, and in which city?", skip: /\b(at|join|with|for) [A-Z][a-z]+/ },
    { q: "Why would you not stay in the United States after that?" },
  ],
  gap: [{ q: "Why apply now, and not a year earlier?" }],
};

function touchedTopics(rows) {
  const said = rows.filter((r) => r.answer).map((r) => String(r.answer));
  return new Set(Object.keys(TOUCHED).filter((topic) => said.some((answer) => TOUCHED[topic].test(answer))));
}

/** A deeper question on a topic the student has already covered in passing. */
function deeperOn(topic, pool, askedNorm, said) {
  const option = (DEEPER[topic] ?? []).find((d) => !askedNorm.has(normalizeQuestion(d.q)) && !(d.skip && d.skip.test(said)));
  if (!option) return null;
  const text = option.q;
  const base = pool.find((e) => e.topic === topic);
  return { id: `deeper:${topic}`, text, norm: normalizeQuestion(text), category: base?.category ?? "Financial Readiness", topic, origin: "deeper" };
}

function variantFor(topic, pool, askedNorm, random) {
  const options = pool.filter((e) => e.topic === topic && !askedNorm.has(e.norm));
  const uploaded = options.filter((e) => e.origin === "upload");
  const choices = uploaded.length ? uploaded : options;
  return choices.length ? choices[Math.floor(random() * choices.length)] : null;
}

function asQuestion(entry, required) {
  return {
    question: entry.text,
    category: entry.category,
    topic: entry.topic,
    origin: entry.origin === "upload" ? `upload:${entry.id}` : entry.origin === "deeper" ? "deeper" : "bank",
    isFollowUp: false,
    required,
  };
}

/** The opening question: always why this university, in one of its wordings. */
export function firstQuestion(pool, random = Math.random) {
  const entry = variantFor("uni_choice", pool, new Set(), random) ?? pool[0];
  return asQuestion(entry, true);
}

/**
 * Where the interview stands: what has been covered, what must still be, and
 * whether there is room for a follow-up without squeezing out an essential.
 */
function standing({ rows, requiredTopics, maxQuestions }) {
  const answered = rows.filter((r) => r.answer);
  const covered = new Set(answered.filter((r) => !r.isFollowUp && r.topic).map((r) => r.topic));
  const requiredLeft = (requiredTopics ?? []).filter((t) => !covered.has(t));
  const slotsLeft = maxQuestions - answered.length;
  let streak = 0;
  for (let i = answered.length - 1; i >= 0 && answered[i].isFollowUp; i--) streak += 1;
  const followUps = rows.filter((r) => r.isFollowUp).length;
  // Never at the cost of an essential topic: a follow-up needs a spare slot.
  const allowFollowUp = slotsLeft - 1 >= requiredLeft.length && streak < MAX_CRITICAL_STREAK && followUps < MAX_FOLLOW_UPS;
  return { answered, requiredLeft, slotsLeft, streak, allowFollowUp, askedNorm: new Set(rows.map((r) => normalizeQuestion(r.question))) };
}

/** Required topics still to cover - for the officer's decision and the rank. */
export function requiredRemaining(rows, requiredTopics) {
  return standing({ rows, requiredTopics, maxQuestions: ai.ADAPTIVE.maxQuestions }).requiredLeft.length;
}

/**
 * Bank questions ranked for this moment: related to the last answer, from a
 * category not yet heard much, staff-written before built-in, pressure
 * questions kept for later - with some chance so no two interviews match.
 */
function rankCandidates({ rows, pool, mode, askedNorm, random, maxQuestions }) {
  const officer = ai.MODES[mode] ?? ai.MODES.neutral;
  const answered = rows.filter((r) => r.answer);
  const last = answered.at(-1);
  const answerStems = stems(last?.answer);
  const askedTopics = new Set(rows.filter((r) => r.topic && !r.isFollowUp).map((r) => r.topic));
  const perCategory = {};
  for (const r of rows) if (!r.isFollowUp) perCategory[r.category] = (perCategory[r.category] ?? 0) + 1;
  const pressureTime = answered.length >= maxQuestions - officer.pressureQuestions - 2;

  return pool
    .filter((e) => !askedNorm.has(e.norm) && !(e.topic && askedTopics.has(e.topic)) && !rows.some((r) => similar(r.question, e.text)))
    .map((e) => ({
      entry: e,
      score:
        relevance(answerStems, e) * 2.5 +
        1.5 / (1 + (perCategory[e.category] ?? 0)) +
        (e.origin === "upload" ? 1 : 0) +
        random() * 2.2 -
        (e.category === "Composure Under Pressure" && !pressureTime ? 4 : 0),
    }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Decide the next question with the built-in rules. Returns the pick, plus
 * what an AI provider needs to make the same decision in its own words.
 */
export function planNext({ rows, profile: rawProfile, mode, requiredTopics, pool, random = Math.random, maxQuestions = ai.ADAPTIVE.maxQuestions }) {
  const profile = rawProfile ?? {};
  const state = standing({ rows, requiredTopics, maxQuestions });
  const last = state.answered.at(-1);

  // 1. Follow the answer, if there is room.
  let followUp = null;
  if (last && state.allowFollowUp) {
    followUp = followUpOn({ last, rows, profile, mode, random, streak: state.streak });
    if (followUp && state.askedNorm.has(normalizeQuestion(followUp.question))) followUp = null;
  }

  // 2. The essentials: one question per topic still owed, the one the last
  // answer leads into first. A topic already answered in passing is offered
  // only as its deeper question - never the plain one the student just answered.
  const answerStems = stems(last?.answer);
  const touched = touchedTopics(rows);
  const said = rows.filter((r) => r.answer).map((r) => r.answer).join(" ");
  const requiredOptions = state.requiredLeft
    .map((topic, index) => {
      const entry =
        (touched.has(topic) ? deeperOn(topic, pool, state.askedNorm, said) : null) ??
        variantFor(topic, pool, state.askedNorm, random);
      return entry ? { question: asQuestion(entry, true), score: relevance(answerStems, entry) * 2 - index * 0.75 } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .map((o) => o.question);
  const requiredPick = requiredOptions[0] ?? null;

  // 3. Everything else, ranked. Owed topics are already represented above.
  const owed = new Set(state.requiredLeft);
  const ranked = rankCandidates({ rows, pool, mode, askedNorm: state.askedNorm, random, maxQuestions }).filter(
    (r) => !(r.entry.topic && owed.has(r.entry.topic))
  );
  const candidates = [...requiredOptions, ...ranked.slice(0, 6).map((r) => asQuestion(r.entry, false))];

  const pick = followUp ?? requiredPick ?? candidates[0] ?? null;
  return {
    pick,
    followUp,
    candidates,
    requiredLeft: state.requiredLeft,
    allowFollowUp: state.allowFollowUp && state.streak < MAX_FOLLOW_UP_STREAK,
  };
}

/**
 * The next question with an AI provider: it sees the whole conversation and
 * either probes the last answer in its own words or picks from the ranked
 * candidates. The built-in pick is the fallback for anything unusable, and a
 * critical built-in follow-up (a figure that contradicts the file) is never
 * overridden.
 */
export async function nextQuestion(ctx) {
  const plan = planNext(ctx);
  if (!plan.pick) return null;
  if (ai.engineName() !== "provider" || plan.followUp?.critical) return plan.pick;

  const { rows, profile, mode } = ctx;
  const officer = ai.MODES[mode] ?? ai.MODES.neutral;
  const answered = rows.filter((r) => r.answer);
  const last = answered.at(-1);
  if (!last) return plan.pick;

  const ids = plan.candidates.map((_, i) => `C${i + 1}`);
  const system = [
    officer.persona,
    "",
    "You are in the middle of a live F-1 student visa interview. Decide your NEXT question.",
    plan.allowFollowUp
      ? "If the student's LAST answer contains something specific a real officer would probe - a person, a number, a company, a claim, a vague phrase, anything that does not fit their file - ask a short follow-up about exactly that, naming or quoting it."
      : "Do NOT ask a follow-up this turn: you must pick one of the CANDIDATES.",
    "Otherwise pick the most natural next question from CANDIDATES by its id. You may reword it slightly so it flows from the last answer, but keep its meaning.",
    plan.requiredLeft.length ? "Candidates marked REQUIRED must be covered before the interview can end - prefer them unless the follow-up really matters." : "",
    'Say "you mentioned" only about something the student actually said in this conversation - facts from the file are not things they mentioned.',
    "Never ask something the student has already answered, even in passing. If they already covered a candidate's point, pick it anyway but reword it into a deeper question on the same point (their income, their documents, a specific employer), keeping its id.",
    "One or two short sentences, spoken the way an officer talks at a window. Never coach, praise or reassure. Never mention AI. Never predict the outcome. Never repeat a question already asked.",
    'Reply with JSON: {"type":"follow_up" or "candidate","id":string or null,"question":string}',
  ]
    .filter(Boolean)
    .join("\n");

  const transcript = answered
    .slice(-6)
    .map((r) => `OFFICER: ${r.question}\nSTUDENT: ${String(r.answer).slice(0, 500)}`)
    .join("\n");
  const user = [
    "APPLICANT FILE",
    ai.profileBrief(profile ?? {}),
    "",
    "CONVERSATION SO FAR (latest last)",
    transcript,
    "",
    plan.followUp ? `A rule-based check on the last answer suggests this follow-up: ${plan.followUp.question}` : "",
    "CANDIDATES",
    plan.candidates.map((c, i) => `${ids[i]}${c.required ? " [REQUIRED]" : ""} (${c.category}): ${c.question}`).join("\n"),
  ]
    .filter((line) => line !== "")
    .join("\n");

  const data = await ai.callProvider(system, user, 0.7, 9000);
  const text = String(data?.question ?? "").replace(/\s+/g, " ").trim();
  const usable =
    text.length >= 10 &&
    text.length <= 240 &&
    !/\b(as an ai|language model|agent)\b/i.test(text) &&
    !rows.some((r) => normalizeQuestion(r.question) === normalizeQuestion(text));

  if (data?.type === "candidate") {
    const index = ids.indexOf(String(data.id ?? "").trim());
    if (index === -1) return plan.pick;
    const chosen = plan.candidates[index];
    if (chosen.origin === "deeper") return chosen;
    // A bank question is about the file, not about something the student said.
    // If the rewording claims "you mentioned...", it is putting words in their
    // mouth - keep the original wording instead.
    const claimsTheySaidIt = /\byou (mentioned|said|told me|stated)\b/i;
    if (claimsTheySaidIt.test(text) && !claimsTheySaidIt.test(chosen.question)) return chosen;
    return usable ? { ...chosen, question: text, origin: `${chosen.origin}+ai` } : chosen;
  }
  if (data?.type === "follow_up" && plan.allowFollowUp && usable) {
    return { question: text, category: last.category, topic: last.topic ?? null, origin: "ai", isFollowUp: true, required: false };
  }
  return plan.pick;
}

/**
 * Questions for the report's "worth practising anyway" list: the essentials
 * the officer never reached, then the best of the rest.
 */
export function practiceSuggestions({ rows, requiredTopics, pool, mode, limit = 4 }) {
  const state = standing({ rows, requiredTopics, maxQuestions: ai.ADAPTIVE.maxQuestions });
  const noChance = () => 0.5;
  const list = [];
  for (const topic of state.requiredLeft) {
    const entry = variantFor(topic, pool, state.askedNorm, noChance);
    if (entry) list.push(asQuestion(entry, true));
  }
  for (const { entry } of rankCandidates({ rows, pool, mode, askedNorm: state.askedNorm, random: noChance, maxQuestions: ai.ADAPTIVE.maxQuestions })) {
    if (list.length >= limit) break;
    if (!list.some((q) => q.topic && q.topic === entry.topic)) list.push(asQuestion(entry, false));
  }
  return list.slice(0, Math.max(limit, state.requiredLeft.length));
}
