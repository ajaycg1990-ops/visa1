import { config } from "./config.mjs";

/**
 * The interview brain.
 *
 * Two engines behind one API:
 *
 *   built-in  - a deterministic question/scoring/coaching engine. Always
 *               present, needs no API key, and is what keeps the product
 *               fully usable out of the box.
 *   provider  - any OpenAI-compatible /chat/completions endpoint. When
 *               AI_API_KEY is set it helps choose each next question
 *               (interviewer.mjs) and writes the coaching text.
 *
 * Numeric scoring stays deterministic in both modes on purpose: scores are
 * compared across sessions in analytics, so they must not drift with model
 * temperature. The provider changes the words, never the maths.
 */

/* --------------------------------- officers -------------------------------- */

export const MODES = {
  strict: {
    id: "strict",
    name: "Strict officer",
    blurb: "Short, cold and unimpressed. Challenges every vague sentence.",
    greeting: "Next. Documents, please. Let us begin.",
    persona:
      "You are a cold, clipped, skeptical U.S. consular officer at a high-scrutiny post. Ask short questions, never encourage, and challenge anything vague or rehearsed.",
    scoreMultiplier: 0.9,
    followUpBias: 0.85,
    pressureQuestions: 3,
  },
  neutral: {
    id: "neutral",
    name: "Neutral officer",
    blurb: "Professional and even-paced. The closest match to a real window.",
    greeting: "Good morning. I have a few questions about your study plans.",
    persona:
      "You are a professional, brisk, neutral U.S. consular officer. Ask standard questions at an even pace and follow up when an answer leaves an obvious gap.",
    scoreMultiplier: 1,
    followUpBias: 0.55,
    pressureQuestions: 2,
  },
  casual: {
    id: "casual",
    name: "Casual officer",
    blurb: "Friendly and conversational, with small talk. A gentle first run.",
    greeting: "Hi there, relax - this only takes a few minutes. Tell me about your plans.",
    persona:
      "You are a relaxed, conversational U.S. consular officer who makes light small talk but still asks real consular questions.",
    scoreMultiplier: 1.06,
    followUpBias: 0.3,
    pressureQuestions: 1,
  },
};

export const CATEGORIES = [
  "Academic & Program",
  "Financial Readiness",
  "Intent to Return",
  "Personal & History",
  "Composure Under Pressure",
];

export const DEFAULT_QUESTION_COUNT = 10;

export function engineName() {
  return config.ai.enabled ? "provider" : "built-in";
}

/* ------------------------------ question bank ------------------------------ */

/**
 * Each entry carries what the officer is testing, the words that signal a
 * specific answer, and the drills to use when the answer is thin.
 */
export const BANK = [
  {
    id: "uni_choice",
    category: "Academic & Program",
    text: "Why did you choose {university}?",
    keywords: ["program", "course", "curriculum", "faculty", "research", "lab", "track", "specializ", "professor", "capstone"],
    followUps: [
      "What specifically in that curriculum attracted you?",
      "Name one professor, lab or course you want to work with.",
      "Every applicant says that. What makes it true in your case?",
    ],
    tests: "Whether the choice is researched and academic, or was made by an agent.",
    say: "Name the programme, one concrete feature of it, and how that feature connects to the work you will do at home.",
  },
  {
    id: "program_content",
    category: "Academic & Program",
    text: "What will you study, and what does that programme actually cover?",
    keywords: ["credit", "semester", "course", "module", "thesis", "capstone", "core", "elective", "specializ"],
    followUps: ["Name two core courses.", "How many credits, over how many semesters?"],
    tests: "Whether you have read your own curriculum.",
    say: "State the degree, its length, two named courses, and the specialisation you intend to take.",
  },
  {
    id: "why_not_home",
    category: "Academic & Program",
    text: "Why not study this course in {homeCountry}?",
    keywords: ["not offered", "specializ", "research", "lab", "industry", "curriculum", "flexible", "equipment"],
    followUps: ["Universities at home teach this too. Why not there?"],
    tests: "Whether the choice is academic or economic.",
    say: "Compare programmes, not countries: name what your programme has that no programme at home offers.",
  },
  {
    id: "shortlist",
    category: "Academic & Program",
    text: "How many universities did you apply to, and which ones admitted you?",
    keywords: ["applied", "admitted", "offer", "compared", "shortlist", "accept"],
    followUps: ["Why did you reject the others?"],
    tests: "Whether you researched a shortlist or applied wherever admission was easy.",
    say: "Give the real number, name two or three, and the deciding factor between them.",
  },
  {
    id: "academics",
    category: "Academic & Program",
    text: "What was your GPA, and how did you perform in your last degree?",
    keywords: ["gpa", "cgpa", "percentage", "division", "score", "grade", "result"],
    followUps: ["How will you cope with graduate-level coursework?"],
    tests: "Honesty and academic readiness.",
    say: "Give the real number, one sentence of context if it is low, and evidence you can handle the coursework.",
  },
  {
    id: "english",
    category: "Academic & Program",
    text: "What are your English test scores?",
    keywords: ["ielts", "toefl", "pte", "duolingo", "band", "overall", "score"],
    followUps: ["Your speaking band is modest. How will you follow lectures?"],
    tests: "Whether you can study in English, and whether your speech matches the score.",
    say: "State the test, the overall score and the date, then let the rest of the interview prove it.",
  },
  {
    id: "gap",
    category: "Academic & Program",
    text: "You have a gap of {gap} since graduating. What were you doing?",
    keywords: ["work", "job", "certification", "training", "experience", "prepare", "family", "business"],
    followUps: ["Nothing academic in all that time?", "Why apply now and not then?"],
    tests: "Whether the gap was purposeful or drift.",
    say: "Account for the time concretely, then say what changed to make this the right moment.",
    requires: (p) => hasText(p.gapYears) && !/^(no|none|nil|0)$/i.test(p.gapYears.trim()),
  },
  {
    id: "sponsor",
    category: "Financial Readiness",
    text: "Who is sponsoring your education?",
    keywords: ["father", "mother", "parents", "sponsor", "income", "business", "salary", "savings"],
    followUps: ["What exactly does your sponsor do?", "What is their annual income?", "Can you document that?"],
    tests: "Whether a real, documented person is paying, and whether you know their finances.",
    say: "Name the sponsor, the relationship, their income source, and confirm the funds are documented.",
  },
  {
    id: "first_year_cost",
    category: "Financial Readiness",
    text: "What does your first year cost, and how is it covered?",
    keywords: ["tuition", "living", "i-20", "total", "cost", "savings", "loan", "scholarship", "covered"],
    followUps: ["That does not match your I-20. Explain.", "What happens in year two?"],
    tests: "Whether you know your own numbers.",
    say: "Quote the I-20 cost of attendance, then break the funding into named sources that add up to it.",
  },
  {
    id: "shortfall",
    category: "Financial Readiness",
    text: "Your sponsor earns about ${income} a year, but your first year costs ${coa}. How does that work?",
    keywords: ["savings", "accumulated", "property", "loan", "scholarship", "assistantship", "liquid", "rental"],
    followUps: ["So you will depend on working in the U.S.?", "Which of those funds is liquid today?"],
    tests: "Financial arithmetic. If the numbers do not close, the officer stops listening.",
    say: "Separate income from accumulated assets, and show the total closes the gap.",
    requires: (p) => moneyGap(p) > 0,
  },
  {
    id: "loan",
    category: "Financial Readiness",
    text: "You have an education loan of ${loan}. Who sanctioned it, and against what security?",
    keywords: ["bank", "sanction", "collateral", "property", "approved", "letter", "disburse"],
    followUps: ["Is the sanction letter in your file today?"],
    tests: "Whether the loan is real and documented rather than planned.",
    say: "Name the bank, the sanctioned amount, the security, and confirm the letter is in your documents.",
    requires: (p) => money(p.loanUsd) > 0,
  },
  {
    id: "work",
    category: "Financial Readiness",
    text: "Do you plan to work while studying?",
    keywords: ["on-campus", "not depend", "funded", "covered", "assistantship", "permitted", "no"],
    followUps: ["So you need that job to survive?", "What if you do not get one?"],
    tests: "Whether your funding depends on U.S. earnings. It must not.",
    say: "Say your costs are already funded without work; mention on-campus work only as permitted experience.",
  },
  {
    id: "after_graduation",
    category: "Intent to Return",
    text: "What are your plans after completing your studies?",
    keywords: ["return", "back", "home", "nepal", "job", "role", "industry", "company", "family business"],
    followUps: ["Be specific: which employer, which role?", "Why would you not stay in the United States?"],
    tests: "Non-immigrant intent, the single most important thing in an F-1 interview.",
    say: "State plainly that you return home, then name the industry, the role, and why the degree is worth more there.",
  },
  {
    id: "salary",
    category: "Intent to Return",
    text: "What salary do you expect back home, and is it worth this investment?",
    keywords: ["salary", "growth", "sector", "career", "position", "senior", "market", "return"],
    followUps: ["That is far less than a U.S. salary. Convince me you will still return."],
    tests: "The economic logic of returning.",
    say: "Give a realistic local figure, then argue on trajectory - seniority, ownership, sector growth.",
  },
  {
    id: "opt",
    category: "Intent to Return",
    text: "Do you intend to apply for OPT after graduation?",
    keywords: ["opt", "practical training", "temporary", "return", "experience", "then"],
    followUps: ["So you do want to stay?", "What is your hard limit for coming home?"],
    tests: "Whether you can be honest about OPT without signalling immigrant intent.",
    say: "Acknowledge OPT as permitted, time-bounded training tied to the degree, then close firmly on returning.",
  },
  {
    id: "ties",
    category: "Intent to Return",
    text: "What ties do you have that will bring you back to {homeCountry}?",
    keywords: ["family", "property", "business", "parents", "responsibility", "land", "job offer", "dependents"],
    followUps: ["Property is not a person. What actually pulls you back?"],
    tests: "The strength and specificity of your ties.",
    say: "Name concrete ties: dependents, property, a family business, a role waiting for you.",
  },
  {
    id: "relatives",
    category: "Personal & History",
    text: "Do you have any relatives in the United States?",
    keywords: ["yes", "no", "uncle", "aunt", "cousin", "brother", "sister", "citizen", "student", "resident"],
    followUps: ["What is their status?", "Will you live with them?", "Are they helping with your fees?"],
    tests: "Honesty. A concealed relative is verifiable and fatal.",
    say: "Answer directly, state their status, and separate them from your funding and your plans.",
  },
  {
    id: "refusal",
    category: "Personal & History",
    text: "You have been refused a U.S. visa before. What has changed since then?",
    keywords: ["refused", "changed", "documented", "improved", "funding", "admission", "clear", "prepared"],
    followUps: ["Why should the outcome be different today?"],
    tests: "Honesty plus growth. Hiding a refusal is worse than having one.",
    say: "State the refusal plainly, name the weakness the officer saw, and list what concretely changed.",
    requires: (p) => hasRefusal(p),
  },
  {
    id: "travel",
    category: "Personal & History",
    text: "Have you travelled abroad before?",
    keywords: ["yes", "no", "india", "travel", "visa", "returned", "trip", "conference"],
    followUps: ["Did you return on time each time?"],
    tests: "Travel history and compliance record.",
    say: "List trips briefly and stress that you returned within your permitted stay every time.",
  },
  {
    id: "who_chose",
    category: "Personal & History",
    text: "Who helped you with this application?",
    keywords: ["myself", "research", "compared", "consultancy", "senior", "verified", "website"],
    followUps: ["So a consultancy chose it, not you?", "What did you personally verify?"],
    tests: "Ownership of your own application.",
    say: "Acknowledge any help honestly, then show the decision and the research were yours.",
  },
  {
    id: "why_visa",
    category: "Composure Under Pressure",
    text: "Why should I give you a visa?",
    keywords: ["admitted", "funded", "documented", "plan", "return", "qualified", "prepared"],
    followUps: ["That is what everyone says. Give me one fact I can verify."],
    tests: "Whether you can summarise your own case in three sentences under pressure.",
    say: "Three sentences: genuine admission, funding documented today, a specific plan back home.",
  },
  {
    id: "think_stay",
    category: "Composure Under Pressure",
    text: "I think you are going to stay in the United States. Change my mind.",
    keywords: ["property", "family", "business", "return", "ties", "responsibility", "role"],
    followUps: ["Property is not a person. What actually pulls you back?"],
    tests: "Composure and the strength of your ties.",
    say: "Stay calm, do not over-promise, and answer with concrete ties and career logic.",
  },
  {
    id: "no_job",
    category: "Composure Under Pressure",
    text: "What if you do not find a job after graduation?",
    keywords: ["plan", "family business", "sector", "backup", "return", "role", "network"],
    followUps: ["So you would stay and look for work in the U.S.?"],
    tests: "Whether your plan survives its own failure case.",
    say: "Give a real fallback located at home: the family business, a sector that hires your skill, further study.",
  },
  {
    id: "rehearsed",
    category: "Composure Under Pressure",
    text: "Your answers sound rehearsed. Say that again in your own words.",
    keywords: ["actually", "specifically", "example", "because", "in my case", "personally"],
    followUps: ["Now give me one detail that is not in your application."],
    tests: "Whether the story is yours or memorised.",
    say: "Drop the polish and give one concrete personal detail no script would contain.",
  },
];

/* ------------------------------- small helpers ----------------------------- */

const hasText = (value) => typeof value === "string" && value.trim().length > 0;
const words = (text) => String(text || "").trim().split(/\s+/).filter(Boolean);
const clamp = (n, min = 5, max = 98) => Math.max(min, Math.min(max, Math.round(n)));
const countHits = (text, list) => list.filter((needle) => text.includes(needle)).length;
const money = (value) => Number(String(value ?? "").replace(/[^\d.]/g, "")) || 0;

function moneyGap(profile) {
  const coa = money(profile.totalCoaUsd);
  const funds = money(profile.annualIncomeUsd) + money(profile.savingsUsd) + money(profile.loanUsd) + money(profile.scholarshipUsd);
  return coa > 0 && funds > 0 ? coa - funds : 0;
}

function hasRefusal(profile) {
  const value = String(profile.refusals ?? "").trim().toLowerCase();
  return value !== "" && !["no", "none", "nil", "0", "never"].includes(value);
}

export function hasRelatives(profile) {
  const value = String(profile.relativesInUs ?? "").trim().toLowerCase();
  return value !== "" && !["no", "none", "nil", "0"].includes(value);
}

/** Fill {placeholders} in a bank question from the applicant's own file. */
export function fill(text, profile) {
  return text
    .replace(/\{university\}/g, hasText(profile.usUniversity) ? profile.usUniversity : "this university")
    .replace(/\{program\}/g, hasText(profile.program) ? profile.program : "this programme")
    .replace(/\{homeCountry\}/g, hasText(profile.homeCountry) ? profile.homeCountry : "your own country")
    .replace(/\{gap\}/g, hasText(profile.gapYears) ? profile.gapYears : "some time")
    .replace(/\$\{income\}/g, money(profile.annualIncomeUsd).toLocaleString())
    .replace(/\$\{coa\}/g, money(profile.totalCoaUsd).toLocaleString())
    .replace(/\$\{loan\}/g, money(profile.loanUsd).toLocaleString());
}

export function findBankEntry(id) {
  return BANK.find((entry) => entry.id === id);
}

/**
 * The bank entry behind a live question: its topic when known (built-in and
 * uploaded questions carry one), otherwise a best-effort match on the text.
 */
function matchBank(questionText, category, topic = null) {
  const known = topic ? findBankEntry(topic) : null;
  if (known) return known;
  const text = String(questionText || "").toLowerCase();
  const sameCategory = BANK.filter((entry) => entry.category === category);
  const pool = sameCategory.length ? sameCategory : BANK;
  let best = pool[0];
  let bestHits = -1;
  for (const entry of pool) {
    const terms = words(entry.text.toLowerCase()).filter((w) => w.length > 4);
    const hits = terms.filter((t) => text.includes(t.replace(/[^a-z]/g, ""))).length;
    if (hits > bestHits) {
      best = entry;
      bestHits = hits;
    }
  }
  return best;
}

/* ------------------------------ required topics ----------------------------- */

/**
 * The three things every consular officer must be satisfied on before
 * approving: is this a genuine student, is the money real, will they go home.
 * They are required in every interview; the order and wording of everything
 * else is decided live, answer by answer, in interviewer.mjs.
 */
export const PILLAR_IDS = ["uni_choice", "sponsor", "after_graduation"];

/**
 * Decide whether the officer drills into the answer just given.
 * Returns null when the interview should move on to the next planned question.
 */
export function followUpFor({ mode, question, category, topic = null, answer, alreadyAsked = [], force = false }) {
  const officer = MODES[mode] ?? MODES.neutral;
  const entry = matchBank(question, category, topic);
  if (!entry) return null;

  const text = String(answer || "").toLowerCase();
  const count = words(answer).length;
  const weak =
    count < 14 ||
    (entry.keywords && countHits(text, entry.keywords) === 0) ||
    /\b(i think|maybe|i guess|not sure|good|nice|best)\b/.test(text);

  // `force` is used when an essential answer fell below the floor: the officer
  // always follows up, which is also the student's chance to recover.
  if (!weak && !force) return null;
  const drill = (entry.followUps || []).find((f) => !alreadyAsked.includes(f));
  if (!drill) return null;
  // Strict officers nearly always drill; casual officers rarely do.
  if (!force && Math.random() > officer.followUpBias) return null;
  return { question: drill, category: entry.category, isFollowUp: true };
}

/* ------------------------------ answer length ------------------------------ */

/** Average speaking rate at a consular window, in words per second. */
const SPEAKING_RATE = 2.5;

/**
 * How long an answer takes to say out loud, estimated from its length.
 *
 * Deliberately independent of how the student entered it: a typed answer
 * takes minutes to type but seconds to say, and the officer only ever hears
 * the saying. Real answers land best at 20-40 seconds; past about 45 the
 * officer has stopped listening.
 */
export function spokenLength(answer) {
  const seconds = Math.round(words(answer).length / SPEAKING_RATE);
  if (seconds < 8) {
    return { seconds, verdict: "short", note: `About ${seconds}s spoken - too short to convince anyone. Aim for 20-40 seconds.` };
  }
  if (seconds > 45) {
    return {
      seconds,
      verdict: "long",
      note: `About ${seconds}s spoken - too long. Officers stop listening after about 40 seconds, so cut it to the essentials.`,
    };
  }
  return { seconds, verdict: "good", note: `About ${seconds}s spoken - a good length for the window.` };
}

/* ------------------------- adaptive interview length ------------------------ */

/**
 * The simulated officer's running confidence in the applicant.
 *
 * Real F-1 interviews are not a fixed length. A convincing applicant is often
 * approved after three or four questions; a doubtful one gets probed. The old
 * fixed-ten format taught students the wrong lesson - that there is always
 * time to recover - so the interview now ends as soon as the officer is
 * satisfied, and runs to the maximum only when they are not.
 *
 * Calibration (neutral officer): consistently good answers reach approval in
 * about 4 questions; a strict officer takes about 6 for the same answers;
 * weak answers never reach it and run the full 10.
 */
export const ADAPTIVE = {
  startConfidence: 50,
  minQuestions: 4,
  maxQuestions: DEFAULT_QUESTION_COUNT,
  /** Confidence the officer needs before approving early. */
  thresholds: { casual: 70, neutral: 75, strict: 78 },
  /** Below this at the end, the officer was never convinced. */
  notReadyBelow: 40,
  /**
   * Answer quality at which confidence neither rises nor falls. Generic but
   * on-topic answers sit just above it, so an honest but vague student drifts
   * up slowly rather than being approved in four questions.
   */
  pivot: 62,
  /** How far one answer moves confidence per point of quality. */
  step: 0.5,
  /**
   * Every required answer must reach this quality before early approval. A
   * student who cannot explain their funding is never waved through, however
   * well they describe their university.
   */
  requiredFloor: 60,
  /** Average quality needed for an early approval to rank Strong, not Good. */
  strongQuality: 72,
};

/** One number per answer, weighted the way the report weights it. */
export function answerQuality(scores) {
  return Math.round(scores.answer * 0.55 + scores.tone * 0.2 + scores.clarity * 0.25);
}

/**
 * Answer quality with the officer's marking leniency taken back out.
 *
 * Displayed scores are softened by a casual officer and hardened by a strict
 * one. That is right for the per-answer feedback, but wrong for judging the
 * student: the same answer must not rank Strong with one officer and Not ready
 * with another. So confidence, the essential-answer floor and the final rank
 * all use this - the officer's style changes the bar and how often they drill,
 * never how good the student's answer actually was.
 */
export function trueQuality(scores, mode) {
  const leniency = (MODES[mode] ?? MODES.neutral).scoreMultiplier;
  return Math.min(100, Math.round(answerQuality(scores) / leniency));
}

/**
 * Move confidence after an answer. A strong answer lifts it, a weak one lowers
 * it, and a high-risk red flag drops it sharply - one sentence about staying in
 * the U.S. undoes several good answers, exactly as it does at a real window.
 */
export function nextConfidence(previous, { scores, redFlags = [], mode = "neutral" }) {
  let delta = (trueQuality(scores, mode) - ADAPTIVE.pivot) * ADAPTIVE.step;
  for (const flag of redFlags) {
    delta -= flag.severity === "high" ? 18 : flag.severity === "medium" ? 4 : 2;
  }
  return Math.max(0, Math.min(100, Math.round(previous + delta)));
}

/**
 * The officer's immediate challenge to a red flag. A real officer does not
 * note a contradiction and move on - they ask about it at once.
 */
const CHALLENGES = {
  "Sponsor mismatch": {
    category: "Financial Readiness",
    question: "You just named a different sponsor from the one in your file. Who is actually paying for your studies?",
  },
  "Immigration-intent language": {
    category: "Intent to Return",
    question: "That sounds like you plan to stay in the United States. Why should I believe you will go home?",
  },
  "Funding depends on U.S. work": {
    category: "Financial Readiness",
    question: "So you are depending on a job in the U.S. to pay for this. How would you manage without one?",
  },
  "Refusal concealed": {
    category: "Personal & History",
    question: "Our records show a previous refusal. Why did you say otherwise?",
  },
  "Undocumented loan": {
    category: "Financial Readiness",
    question: "You mentioned an education loan. Which bank sanctioned it, and do you have the letter with you?",
  },
};

export function challengeFor(redFlags = [], alreadyAsked = []) {
  for (const flag of redFlags) {
    const challenge = CHALLENGES[flag.label];
    if (challenge && !alreadyAsked.includes(challenge.question)) {
      return { ...challenge, isFollowUp: true };
    }
  }
  return null;
}

/**
 * How many essential answers are still unconvincing.
 *
 * An essential answer below the floor counts - unless the student recovered
 * with a good answer to a later follow-up on the same topic, exactly as they
 * could at a real window. Used both for the live decision and the final rank,
 * so the two always agree.
 */
export function weakEssentials(answeredRows, mode) {
  const floor = ADAPTIVE.requiredFloor;
  return answeredRows.filter((q) => {
    if (!q.isRequired || trueQuality(q.scores, mode) >= floor) return false;
    const recovered = answeredRows.some(
      (f) => f.isFollowUp && f.category === q.category && f.position > q.position && trueQuality(f.scores, mode) >= floor
    );
    return !recovered;
  }).length;
}

/** Did the student say, anywhere in the interview, that they will go home? */
export function statedReturn(answers) {
  const joined = answers.map((a) => String(a ?? "").toLowerCase()).join(" ");
  return countHits(joined, ["return", "come back", "go back", "back home", "back to"]) > 0;
}

/**
 * Whether the interview is over, and why.
 *
 * Early approval needs every one of these, because each is something a real
 * officer would not overlook:
 *   - at least the minimum number of questions,
 *   - every required topic answered (the pillars and the student's own risks),
 *   - every one of those answers at least acceptable, not just attempted,
 *   - confidence at or above this officer's bar,
 *   - no high-risk red flag at any point,
 *   - the student has said plainly that they will return home,
 *   - their own file shows enough money for the first year.
 *
 * The last two mirror whole-interview checks in buildReport, so the officer can
 * never approve someone the report then calls refused.
 */
export function officerDecision({
  mode,
  answered,
  confidence,
  requiredRemaining,
  weakRequired = 0,
  highFlagsSoFar,
  saidReturn,
  fileShortfall,
  challengeQueued,
  questionsLeft,
}) {
  if (answered >= ADAPTIVE.maxQuestions) return { done: true, reason: "max_questions" };
  // An open challenge is always asked; the officer never approves mid-doubt.
  if (challengeQueued) return { done: false, reason: null };

  const threshold = ADAPTIVE.thresholds[mode] ?? ADAPTIVE.thresholds.neutral;
  const convinced =
    answered >= ADAPTIVE.minQuestions &&
    requiredRemaining === 0 &&
    weakRequired === 0 &&
    highFlagsSoFar === 0 &&
    saidReturn &&
    !fileShortfall &&
    confidence >= threshold;

  if (convinced) return { done: true, reason: "approved_early" };
  if (questionsLeft === 0) return { done: true, reason: "no_more_questions" };
  return { done: false, reason: null };
}

/** Whether the student's own file shows less money than the first year costs. */
export function hasFileShortfall(profile) {
  return moneyGap(profile ?? {}) > 0;
}

export const RANKS = {
  strong: { label: "Strong", tone: "good" },
  good: { label: "Good", tone: "good" },
  borderline: { label: "Borderline", tone: "warn" },
  incomplete: { label: "Incomplete", tone: "warn" },
  not_ready: { label: "Not ready yet", tone: "bad" },
};

/**
 * Rank the interview from what the officer actually did, and derive the
 * verdict from the same facts so the two can never disagree.
 */
export function rankInterview({
  endedReason,
  answered,
  confidence,
  highFlags,
  requiredRemaining,
  weakRequired = 0,
  mode,
  averageQuality = 0,
}) {
  const threshold = ADAPTIVE.thresholds[mode] ?? ADAPTIVE.thresholds.neutral;
  const make = (rank, verdict, headline) => ({ rank, label: RANKS[rank].label, verdict, headline });

  if (endedReason === "approved_early") {
    // Strong means the answers were genuinely strong, not merely good enough
    // to get through quickly.
    return answered <= 5 && averageQuality >= ADAPTIVE.strongQuality
      ? make("strong", VERDICTS.approved, `Approved after only ${answered} questions. The officer was convinced early.`)
      : make(
          "good",
          VERDICTS.approved,
          `Approved, but it took ${answered} questions. Tighten your weakest area so the officer is convinced sooner.`
        );
  }
  if (highFlags >= 2 || confidence < ADAPTIVE.notReadyBelow) {
    return make("not_ready", VERDICTS.refused, "The officer was not convinced. Fix the red flags below before your real interview.");
  }
  if (requiredRemaining > 0) {
    return make(
      "incomplete",
      VERDICTS.borderline,
      "You ended before the officer covered the essentials - study, funding and your plan to return."
    );
  }
  if (highFlags === 1) {
    return make("borderline", VERDICTS.borderline, "One serious concern kept the officer questioning you. Fix it and you are close.");
  }
  // An essential answer that stayed weak - most often funding - means the
  // officer never had what they needed, however well the rest went.
  if (weakRequired > 0) {
    return make(
      "borderline",
      VERDICTS.borderline,
      "You never gave the officer a convincing answer on one essential question. Fix that and the rest of your interview carries you."
    );
  }
  if (confidence >= threshold) {
    return make("good", VERDICTS.approved, `Approved at the end of ${answered} questions - the officer needed the full interview to be sure.`);
  }
  return make("borderline", VERDICTS.borderline, "The officer had doubts and questioned you the full distance.");
}

/* --------------------------------- scoring --------------------------------- */

const HEDGES = ["i think", "i guess", "maybe", "probably", "somehow", "kind of", "sort of", "not sure", "i hope"];
const FILLERS = ["um", "uh", "like ", "basically", "actually", "you know", "i mean"];
const VAGUE = ["good", "nice", "best", "great", "world class", "very famous", "many things", "everything", "etc"];
const SCRIPTED = ["first of all", "as we all know", "since my childhood", "it is my dream since childhood", "i would like to say that"];
const INTENT_RISK = [
  "settle",
  "stay there",
  "stay in the us",
  "stay in america",
  "green card",
  "permanent resident",
  "immigrate",
  "citizenship",
  "better life there",
  "opportunities there are better",
];
const WORK_DEPENDENCE = ["work and pay", "earn and pay", "part time job to pay", "job to cover", "work to cover", "manage by working", "work to pay"];
const SPONSOR_TERMS = ["father", "mother", "uncle", "aunt", "brother", "sister", "cousin", "myself", "employer"];

/**
 * Score one answer on the three dimensions the student sees after every
 * question: Answer (content), Tone (delivery), Clarity (how followable it is).
 */
export function scoreAnswer({ question, category, topic = null, answer, seconds = 0, profile: rawProfile, mode = "neutral", inputMode = "typed" }) {
  const profile = rawProfile ?? {};
  const officer = MODES[mode] ?? MODES.neutral;
  const entry = matchBank(question, category, topic);
  const text = String(answer || "").toLowerCase();
  const count = words(answer).length;

  // --- Answer: does it engage the question, with facts an officer can check?
  const questionTerms = words(String(question).toLowerCase())
    .filter((w) => w.length > 4)
    .map((w) => w.replace(/[^a-z]/g, ""));
  const overlap = questionTerms.filter((t) => t && text.includes(t)).length;
  const keywordHits = entry ? countHits(text, entry.keywords) : 0;
  const numbers = (String(answer).match(/\d[\d,.]*/g) ?? []).length;
  const properNouns = (String(answer).match(/\b[A-Z][a-z]{2,}/g) ?? []).length;

  let answerScore = 40;
  answerScore += Math.min(overlap, 4) * 5;
  answerScore += Math.min(keywordHits, 4) * 7;
  answerScore += Math.min(numbers, 3) * 4;
  answerScore += Math.min(properNouns, 4) * 3;
  answerScore += Math.min(count, 45) * 0.25;
  answerScore -= countHits(text, VAGUE) * 5;
  if (count < 8) answerScore = Math.min(answerScore, 42);

  // --- Tone: hedging, filler, rehearsed phrasing and pace.
  let toneScore = 78;
  toneScore -= countHits(text, HEDGES) * 8;
  toneScore -= countHits(text, FILLERS) * 4;
  toneScore -= countHits(text, SCRIPTED) * 5;
  // Pace only means something for a spoken answer. For a typed one, the time
  // between question and submit is typing speed - about 35-40 words a minute
  // while composing - and used to cost every typist 10 points for "stalling".
  if (inputMode === "voice") {
    const pace = seconds > 0 && count > 0 ? count / (seconds / 60) : 120;
    if (pace < 55) toneScore -= 10; // stalling
    if (pace > 190) toneScore -= 6; // rushing
  }
  if (count >= 12 && countHits(text, HEDGES) === 0) toneScore += 4;

  // --- Clarity: developed but not rambling, reasonable sentence length.
  const sentences = String(answer).split(/[.!?]+/).filter((s) => s.trim().length > 0);
  const averageSentence = sentences.length ? count / sentences.length : count;
  let clarityScore = count < 10 ? 45 : count <= 90 ? 80 : 64;
  clarityScore -= countHits(text, FILLERS) * 4;
  if (averageSentence > 34) clarityScore -= 10;
  if (sentences.length >= 2 && averageSentence <= 24) clarityScore += 5;

  return {
    answer: clamp(answerScore * officer.scoreMultiplier),
    tone: clamp(toneScore * officer.scoreMultiplier),
    clarity: clamp(clarityScore * officer.scoreMultiplier),
  };
}

/** Red flags raised by one answer, including checks against the stored file. */
export function redFlagsFor({ question, category, answer, profile: rawProfile, scores, position }) {
  const profile = rawProfile ?? {};
  const text = String(answer || "").toLowerCase();
  const count = words(answer).length;
  const flags = [];

  if (countHits(text, INTENT_RISK) > 0) {
    flags.push({
      severity: "high",
      label: "Immigration-intent language",
      detail: "This answer contains wording that suggests staying in the United States. F-1 requires you to show you intend to return home.",
      position,
    });
  }
  if (countHits(text, WORK_DEPENDENCE) > 0) {
    flags.push({
      severity: "high",
      label: "Funding depends on U.S. work",
      detail: "You implied you will pay costs by working in the U.S. Your funding must already be in place without any U.S. earnings.",
      position,
    });
  }

  // Sponsor contradiction.
  //
  // Checked sentence by sentence, and only where the student actually claims
  // someone funds them. Two things must not trigger it: naming a cousin while
  // answering a question about relatives, and explicitly ruling someone out
  // ("my cousin is not funding me") - a denial is the opposite of a mismatch.
  const relation = String(profile.sponsorRelation ?? "").toLowerCase();
  if (relation) {
    const questionIsAboutMoney =
      category === "Financial Readiness" || /sponsor|fund|pay|cost|money|financ|expense|tuition/i.test(String(question));
    const fundingClaim =
      /\b(pay|pays|paying|paid|sponsor|sponsors|sponsoring|fund|funds|funding|support|supports|supporting|bearing the cost|covers? (?:my|the) (?:cost|costs|fees|expenses))\b/i;
    const negation = /\b(not|never|n't|nobody|no one)\b/i;

    const mentioned = new Set();
    for (const sentence of String(answer || "").split(/[.!?;]+/)) {
      const claim = sentence.match(fundingClaim);
      if (!questionIsAboutMoney && !claim) continue;

      // A negation only cancels the claim when it comes before the funding
      // verb: "is not funding me" is a denial, "will pay ... was not an issue"
      // is still a claim.
      const negated = sentence.match(negation);
      if (negated && (!claim || negated.index < claim.index)) continue;

      for (const term of SPONSOR_TERMS) {
        if (new RegExp(`\\b${term}\\b`, "i").test(sentence)) mentioned.add(term);
      }
    }

    const named = [...mentioned];
    if (named.length && !named.some((term) => relation.includes(term))) {
      flags.push({
        severity: "high",
        label: "Sponsor mismatch",
        detail: `Your profile lists your sponsor as "${profile.sponsorRelation}", but this answer names ${named.slice(0, 2).join(" / ")}. At the window that reads as a changed story.`,
        position,
      });
    }
  }

  if (hasRefusal(profile) && /refus/i.test(String(question)) && /\b(no|never)\b/.test(text)) {
    flags.push({
      severity: "high",
      label: "Refusal concealed",
      detail: "Your file records a previous refusal but this answer denies one. Concealment is verifiable and far more damaging than the refusal itself.",
      position,
    });
  }
  if (money(profile.loanUsd) === 0 && /\bloan\b/.test(text)) {
    flags.push({
      severity: "medium",
      label: "Undocumented loan",
      detail: "You mentioned an education loan, but your profile records no loan amount. Any loan you cite must be sanctioned and documented.",
      position,
    });
  }
  if (count < 8) {
    flags.push({
      severity: "medium",
      label: "Answer too thin",
      detail: "A one-line answer gives the officer nothing to approve. Add one concrete fact and one reason.",
      position,
    });
  } else if (scores.answer < 55) {
    flags.push({
      severity: "medium",
      label: "Vague, unverifiable answer",
      detail: "No names, numbers or specifics. Officers treat general praise as an answer they cannot check.",
      position,
    });
  }
  if (countHits(text, SCRIPTED) >= 2) {
    flags.push({
      severity: "low",
      label: "Sounds memorised",
      detail: "The phrasing reads like a template. Keep the structure, but say it in your own words.",
      position,
    });
  }
  return flags;
}

/* --------------------------------- coaching -------------------------------- */

function feedbackFor(scores, count) {
  if (count < 8) return "Too short. The officer heard a fragment, not a case - there is nothing here to approve.";
  if (scores.answer < 55) return "No names, numbers or specifics - this is a general claim the officer cannot verify.";
  if (scores.clarity < 60) return "Hard to follow. Shorter sentences, one fact each, and the point lands.";
  if (scores.tone < 60) return "Hedging weakens it - you sound unsure about your own plan.";
  if (scores.answer < 72) return "On topic, but it stops one concrete detail short of convincing.";
  return "Solid: direct, specific, and the officer can check it.";
}

/** The built-in improved answer, written from the applicant's own facts. */
function builtInCoaching({ question, category, topic = null, answer, profile }) {
  const entry = matchBank(question, category, topic);
  const p = profile ?? {};
  const uni = hasText(p.usUniversity) ? p.usUniversity : "my university";
  const program = hasText(p.program) ? p.program : "my programme";
  const home = hasText(p.homeCountry) ? p.homeCountry : "my home country";
  const goal = hasText(p.careerGoal) ? p.careerGoal : "the role I am building towards";
  const sponsor = hasText(p.sponsorRelation) ? p.sponsorRelation.toLowerCase() : "sponsor";

  let improved;
  switch (category) {
    case "Academic & Program":
      improved = hasText(p.usUniversity)
        ? `I chose ${uni} for its ${program} - ${hasText(p.whyProgram) ? lowerFirst(p.whyProgram) : "specifically the specialisation that matches my career plan"}. That is what I could not get at home, and it leads directly to ${goal}.`
        : entry?.say ?? "Name the programme, one concrete feature, and the career it leads to.";
      break;
    case "Financial Readiness":
      improved = hasText(p.sponsorRelation)
        ? `My first year costs ${money(p.totalCoaUsd) ? `$${money(p.totalCoaUsd).toLocaleString()}` : "the amount on my I-20"} and it is already covered. My ${sponsor}${hasText(p.sponsorName) ? `, ${p.sponsorName}` : ""}${hasText(p.sponsorOccupation) ? ` (${p.sponsorOccupation})` : ""} funds me${money(p.annualIncomeUsd) ? `, earning about $${money(p.annualIncomeUsd).toLocaleString()} a year` : ""}${money(p.savingsUsd) ? `, alongside $${money(p.savingsUsd).toLocaleString()} already in the bank` : ""}. I do not need to work to pay for my studies.`
        : entry?.say ?? "Name the sponsor, the income source, and confirm the funds are documented.";
      break;
    case "Intent to Return":
      improved = `I return to ${home} after I finish. ${hasText(p.planAfter) ? p.planAfter : "I move into the role I have been building towards"}, aiming at ${goal}. ${hasText(p.tiesHome) ? p.tiesHome : "My family and responsibilities are all there."}`;
      break;
    case "Personal & History":
      improved = hasRefusal(p) && /refus/i.test(String(question))
        ? `Yes, I was refused before${hasText(p.refusalReason) ? ` - the officer was not satisfied about ${lowerFirst(p.refusalReason)}` : ""}. Since then my funding is documented in full, my admission and programme are settled, and I can explain my plan after graduation clearly.`
        : hasRelatives(p) && /relative/i.test(String(question))
          ? `Yes - ${p.relativesInUs}. They are not funding my studies and I am not depending on them; my sponsor is my ${sponsor}. My plan is to return to ${home}.`
          : entry?.say ?? "Answer directly and completely, then close on returning home.";
      break;
    case "Composure Under Pressure":
      improved = `I have a genuine admission to ${uni} for ${program}, my first year is documented and funded through my ${sponsor}, and I return to ${home} for ${goal}. All three are verifiable in my file.`;
      break;
    default:
      improved = entry?.say ?? "One concrete fact, one reason, one sentence about returning home.";
  }

  return {
    improvedAnswer: improved,
    whatToSay: entry?.say ?? "Answer the question directly, then add one fact the officer can verify.",
    howToSayIt:
      "Three or four sentences, then stop. Steady pace, no hedging words, and do not fill the silence afterwards - let the officer ask the next question.",
    whyItWorks: `It answers what was actually asked, gives ${entry ? "the detail this question is testing" : "a verifiable detail"}, and leaves the officer nothing vague to challenge. ${entry?.tests ?? ""}`.trim(),
  };
}

function lowerFirst(text) {
  const value = String(text).trim();
  return value ? value.charAt(0).toLowerCase() + value.slice(1) : value;
}

/**
 * Grade one answer and coach it. Scores are always deterministic; the coaching
 * text comes from the provider when one is configured.
 */
export async function reviewAnswer({ question, category, topic = null, answer, seconds, profile: rawProfile, mode, position, inputMode = "typed" }) {
  const profile = rawProfile ?? {};
  const scores = scoreAnswer({ question, category, topic, answer, seconds, profile, mode, inputMode });
  const flags = redFlagsFor({ question, category, answer, profile, scores, position });
  const feedback = feedbackFor(scores, words(answer).length);
  let coaching = builtInCoaching({ question, category, topic, answer, profile });
  let engine = "built-in";

  if (config.ai.enabled) {
    const system = [
      "You are a U.S. student visa preparation coach reviewing one interview answer.",
      "Explain why the answer is weak before rewriting it, and rewrite it using only facts from the applicant file.",
      "Never invent facts. Never guarantee a visa outcome. Never advise misrepresenting anything to an officer.",
      "The rewrite is a framework to adapt in the student's own words, not a script to memorise. Keep it under 70 words.",
      "",
      ...FILE_IS_TRUTH,
      "",
      'Reply with JSON: {"improvedAnswer":string,"whatToSay":string,"howToSayIt":string,"whyItWorks":string}',
    ].join("\n");
    const user = [
      "APPLICANT FILE",
      profileBrief(profile),
      "",
      `QUESTION (${category}): ${question}`,
      `THE STUDENT ANSWERED: ${answer}`,
      "",
      `Scored: answer ${scores.answer}, tone ${scores.tone}, clarity ${scores.clarity}.`,
    ].join("\n");

    const data = await callProvider(system, user, 0.5);
    // A rewrite that contradicts the student's file would rehearse a refusal,
    // so it is discarded in favour of the built-in coaching.
    if (
      data &&
      typeof data.improvedAnswer === "string" &&
      data.improvedAnswer.trim() &&
      !contradictsFile(data.improvedAnswer, profile)
    ) {
      coaching = {
        improvedAnswer: data.improvedAnswer.trim(),
        whatToSay: text(data.whatToSay, coaching.whatToSay),
        howToSayIt: text(data.howToSayIt, coaching.howToSayIt),
        whyItWorks: text(data.whyItWorks, coaching.whyItWorks),
      };
      engine = "provider";
    }
  }

  return { scores, feedback, coaching, redFlags: flags, engine, spoken: spokenLength(answer) };
}

/**
 * Score a practice retry of an answered question. Same scoring and red flags
 * as the live answer, so before/after is a fair comparison, but no provider
 * call: the student already has the coaching from the report, and a retry is
 * about hearing whether the new version lands.
 */
export function reviewRetry({ question, category, topic = null, answer, profile: rawProfile, mode, position }) {
  const profile = rawProfile ?? {};
  const scores = scoreAnswer({ question, category, topic, answer, profile, mode, inputMode: "typed" });
  const redFlags = redFlagsFor({ question, category, answer, profile, scores, position });
  return { scores, feedback: feedbackFor(scores, words(answer).length), redFlags, spoken: spokenLength(answer) };
}

/* ------------------------------- final report ------------------------------ */

const VERDICTS = { approved: "Likely approved", borderline: "Borderline", refused: "Likely refused" };

/**
 * Roll the answered questions up into category scores, strengths, weaknesses,
 * recommendations and an officer-voice summary.
 */
export function buildReport({ questions, mode, profile: rawProfile, outcome = {} }) {
  const profile = rawProfile ?? {};
  const answered = questions.filter((q) => hasText(q.answer));
  const officer = MODES[mode] ?? MODES.neutral;

  const perQuestion = answered.map((q) => ({
    ...q,
    overall: Math.round((q.scores.answer * 0.55 + q.scores.tone * 0.2 + q.scores.clarity * 0.25) || 0),
  }));

  const byCategory = new Map();
  for (const q of perQuestion) {
    const bucket = byCategory.get(q.category) ?? [];
    bucket.push(q.overall);
    byCategory.set(q.category, bucket);
  }
  const categoryScores = [...byCategory.entries()]
    .map(([category, scores]) => ({
      category,
      score: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length),
    }))
    .sort((a, b) => a.score - b.score);

  const overallScore = perQuestion.length
    ? Math.round(perQuestion.reduce((sum, q) => sum + q.overall, 0) / perQuestion.length)
    : 0;

  // Red flags collected during the interview, capped per label so one repeated
  // habit does not bury everything else.
  const rawFlags = questions.flatMap((q) => q.redFlags ?? []);
  const seen = new Map();
  const redFlags = [];
  for (const flag of [...rawFlags].sort((a, b) => rank(a.severity) - rank(b.severity))) {
    const n = seen.get(flag.label) ?? 0;
    if (n >= 2) continue;
    seen.set(flag.label, n + 1);
    redFlags.push(flag);
  }

  // Whole-interview checks.
  const joined = answered.map((q) => String(q.answer).toLowerCase()).join(" ");
  if (answered.length >= 4 && countHits(joined, ["return", "come back", "back home", "back to"]) === 0) {
    redFlags.unshift({
      severity: "high",
      label: "No stated intent to return",
      detail: "Across the whole interview you never said plainly that you will return home after your studies. Say it, and attach it to something concrete.",
      position: null,
    });
  }
  const gap = moneyGap(profile ?? {});
  if (gap > 0) {
    redFlags.push({
      severity: "high",
      label: "Funding shortfall in your own file",
      detail: `Your profile is about $${gap.toLocaleString()} short of your first-year cost of attendance. Close that gap in your documents before the real interview.`,
      position: null,
    });
  }

  const highFlags = redFlags.filter((f) => f.severity === "high").length;

  // The verdict follows what the officer actually did in the interview, so a
  // student the officer approved at question 4 is never told "refused".
  const ranking = rankInterview({
    endedReason: outcome.endedReason ?? "student_ended",
    answered: perQuestion.length,
    confidence: outcome.confidence ?? ADAPTIVE.startConfidence,
    highFlags,
    requiredRemaining: outcome.requiredRemaining ?? 0,
    weakRequired: outcome.weakRequired ?? 0,
    mode,
    // Ranked on the student's real answer quality, not this officer's marking.
    averageQuality: Math.min(100, Math.round(overallScore / officer.scoreMultiplier)),
  });
  const verdict = ranking.verdict;

  const strengths = perQuestion
    .filter((q) => q.overall >= 75)
    .slice(0, 4)
    .map((q) => ({ kind: "strength", label: q.category, detail: `"${truncate(q.question, 70)}" - ${q.feedback}`, position: q.position }));

  const weaknesses = perQuestion
    .filter((q) => q.overall < 65)
    .slice(0, 4)
    .map((q) => ({ kind: "weakness", label: q.category, detail: `"${truncate(q.question, 70)}" - ${q.feedback}`, position: q.position }));

  const recommendations = categoryScores
    .filter((c) => c.score < 75)
    .slice(0, 3)
    .map((c) => ({
      kind: "recommendation",
      label: `Practise ${c.category}`,
      detail: recommendationFor(c.category),
    }));

  if (!recommendations.length) {
    recommendations.push({
      kind: "recommendation",
      label: "Run it again with the strict officer",
      detail: "Every category is above 75. The next useful test is whether that holds when the officer interrupts you.",
    });
  }

  const worst = redFlags[0];
  const summary = [
    ranking.headline,
    `You scored ${overallScore}/100 across ${perQuestion.length} answers with the ${officer.name.toLowerCase()}.`,
    worst
      ? `The thing that decides it: ${worst.label.toLowerCase()} - ${worst.detail}`
      : "Nothing in your answers actively worked against you.",
    categoryScores[0]
      ? `Weakest area: ${categoryScores[0].category} at ${categoryScores[0].score}. Practise that, then run the interview again at a harder setting.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  const insights = [
    ...strengths,
    ...weaknesses,
    ...recommendations,
    ...redFlags.map((f) => ({ kind: "red_flag", severity: f.severity, label: f.label, detail: f.detail, position: f.position })),
  ];

  if (!strengths.length && perQuestion.length) {
    insights.unshift({
      kind: "strength",
      label: "Completed the interview",
      detail: "You answered every question without abandoning one. That is the baseline - now raise the weakest category below.",
    });
  }

  return {
    overallScore,
    verdict,
    summary,
    categoryScores,
    insights,
    rank: ranking.rank,
    rankLabel: ranking.label,
    rankHeadline: ranking.headline,
  };
}

function rank(severity) {
  return { high: 0, medium: 1, low: 2 }[severity] ?? 3;
}

function truncate(text, max) {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max - 1)}...` : value;
}

function recommendationFor(category) {
  switch (category) {
    case "Financial Readiness":
      return "Rehearse the numbers until they are automatic: cost of attendance, sponsor income, savings, and what is already in the bank.";
    case "Intent to Return":
      return "Write one sentence naming the employer type, the role and the city you return to - then use it in every answer that touches your future.";
    case "Academic & Program":
      return "Learn two named courses and one faculty member or lab in your programme, and connect them to the job you want at home.";
    case "Personal & History":
      return "Practise disclosing relatives, refusals and travel plainly and completely, then closing on your plan to return.";
    case "Composure Under Pressure":
      return "Practise being interrupted. Answer in three sentences, stop, and let the silence sit.";
    default:
      return "Practise this category again with the strict officer.";
  }
}

/* ----------------------------- custom question ----------------------------- */

const TOPIC_RULES = [
  { topic: "funding", test: /(fund|pay|money|cost|sponsor|financ|bank|loan|afford|expens|tuition)/ },
  { topic: "return", test: /(return|after grad|come back|go back|stay|settle|immigrat|opt|h-?1)/ },
  { topic: "university", test: /(universit|college|school|campus)/ },
  { topic: "program", test: /(program|course|major|subject|curriculum|degree)/ },
  { topic: "gap", test: /(gap|break|since graduat)/ },
  { topic: "refusal", test: /(refus|reject|denied|214|reappl)/ },
  { topic: "relatives", test: /(relative|uncle|aunt|cousin|brother|sister|family in)/ },
  { topic: "work", test: /(job|work|part.?time|earn)/ },
];

function builtInCustomAnswer(profile, question) {
  const q = String(question).toLowerCase();
  const topic = TOPIC_RULES.find((rule) => rule.test.test(q))?.topic ?? "general";
  const p = profile ?? {};
  const home = hasText(p.homeCountry) ? p.homeCountry : "my home country";
  const sponsor = hasText(p.sponsorRelation) ? p.sponsorRelation.toLowerCase() : "sponsor";
  const goal = hasText(p.careerGoal) ? p.careerGoal : "the role I am building towards";

  const shared = {
    howToSayIt:
      "Three or four sentences, steady pace, no hedging. Say it once and stop - do not add extra detail to fill the pause.",
  };

  switch (topic) {
    case "funding":
      return {
        ...shared,
        answer: `My first year${money(p.totalCoaUsd) ? ` costs $${money(p.totalCoaUsd).toLocaleString()} and` : ""} is already covered. My ${sponsor}${hasText(p.sponsorName) ? `, ${p.sponsorName}` : ""}${hasText(p.sponsorOccupation) ? ` (${p.sponsorOccupation})` : ""} sponsors me${money(p.annualIncomeUsd) ? `, earning about $${money(p.annualIncomeUsd).toLocaleString()} a year` : ""}${money(p.savingsUsd) ? `, and we hold $${money(p.savingsUsd).toLocaleString()} in documented savings` : ""}. Those funds are in the bank now, with statements to show, and I do not need to work in the United States to pay for my studies.`,
        whatToSay: "The exact first-year figure, the sponsor and their income source, and confirmation the money is already deposited.",
        whyItWorks: "It answers with numbers the officer can verify against your I-20 and bank papers, and removes any dependence on U.S. earnings.",
        warning: "Never say you will work in the U.S. to cover fees or living costs - that alone can end the interview.",
      };
    case "return":
      return {
        ...shared,
        answer: `I return to ${home} after I finish. ${hasText(p.planAfter) ? p.planAfter : "I move straight into the work I have been preparing for"}, aiming at ${goal}. My degree is worth more there than in the United States because that experience is still scarce at home, and ${hasText(p.tiesHome) ? lowerFirst(p.tiesHome) : "my family and responsibilities are all there"}.`,
        whatToSay: "The return itself in the first sentence, then the sector, the role, and the tie that holds you there.",
        whyItWorks: "Officers refuse for unproven non-immigrant intent. Naming a sector, a role and a tie turns an intention into something checkable.",
        warning: "Do not mention settling, a green card, or that opportunities are better in the U.S. - all three read as immigrant intent.",
      };
    case "university":
      return {
        ...shared,
        answer: `I chose ${hasText(p.usUniversity) ? p.usUniversity : "my university"} for its ${hasText(p.program) ? p.program : "programme"}. ${hasText(p.whyProgram) ? p.whyProgram : "It has the specialisation that matches the work I want to do"}. I compared it with the other offers I received, and it was the closest fit to ${goal}.`,
        whatToSay: "The programme first, one concrete academic detail, and evidence that you compared options yourself.",
        whyItWorks: "It shows a researched, personal decision instead of a school someone else picked for you.",
        warning: "Never say a consultancy, agent or friend chose the university for you.",
      };
    case "program":
      return {
        ...shared,
        answer: `I am studying ${hasText(p.program) ? p.program : "my programme"} at ${hasText(p.usUniversity) ? p.usUniversity : "my university"}${hasText(p.programMonths) ? ` over ${p.programMonths} months` : ""}. ${hasText(p.whyProgram) ? p.whyProgram : "It closes the gap between what I can do today and what my target role requires"}.`,
        whatToSay: "The degree, its length, two courses or a specialisation, and the skill gap it closes.",
        whyItWorks: "Knowing your own curriculum is the simplest proof that you are a genuine student.",
        warning: "Avoid 'it is a good field with a lot of scope' - that is a phrase, not an answer.",
      };
    case "gap":
      return {
        ...shared,
        answer: `${hasText(p.gapYears) ? `I had ${p.gapYears} between graduating and applying.` : "I had a gap before applying."} I used it deliberately - work and preparation in my field rather than waiting. That period is exactly why I am applying now with a clear plan.`,
        whatToSay: "Concrete activity for the time: work, certifications, family duty - and what changed to make now the moment.",
        whyItWorks: "An accounted-for gap stops looking like drift and starts looking like preparation.",
        warning: "Never leave the years unexplained or say you were 'just at home'.",
      };
    case "refusal":
      return {
        ...shared,
        answer: `Yes, I was refused before${hasText(p.refusalReason) ? ` - the officer was not satisfied about ${lowerFirst(p.refusalReason)}` : ""}. Since then I have fixed exactly that: my funding is documented in full, my admission and programme are settled, and I can explain my plan after graduation clearly. That is what is different today.`,
        whatToSay: "The refusal admitted immediately, the weakness the officer saw, and the concrete things that changed since.",
        whyItWorks: "The refusal is already on the officer's screen. Owning it and showing change is the only route through it.",
        warning: "Never say the previous officer was wrong or unfair, and never hide a refusal.",
      };
    case "relatives":
      return {
        ...shared,
        answer: hasRelatives(p)
          ? `Yes - ${p.relativesInUs}. They are not funding my studies and I am not depending on them; my sponsor is my ${sponsor}. My plan after graduation is to return to ${home}.`
          : `No, I have no relatives in the United States. My family is in ${home}, and that is where I return after my studies.`,
        whatToSay: "A direct yes or no, their status if yes, and a clear separation from your funding and your plans.",
        whyItWorks: "Relatives are verifiable. Disclosing plainly removes the suspicion that the relative is the real reason for the trip.",
        warning: "Never conceal a relative. Being caught hiding one is far worse than having one.",
      };
    case "work":
      return {
        ...shared,
        answer: `My studies are funded without any work in the United States. If an on-campus opportunity or assistantship comes up within what my status permits, I would take it for the experience - but nothing in my funding plan depends on it.`,
        whatToSay: "Funding independence first; on-campus work only as permitted experience.",
        whyItWorks: "It answers honestly without giving the officer a reason to doubt your finances.",
        warning: "Never raise off-campus work, and never imply you need a job to survive.",
      };
    default:
      return {
        ...shared,
        answer: `I would answer from my own case: I am doing ${hasText(p.program) ? p.program : "my programme"} at ${hasText(p.usUniversity) ? p.usUniversity : "my university"}, funded by my ${sponsor}, and I return to ${home} for ${goal}. Keeping every answer anchored to those three facts - admission, funding, return - is what keeps the story consistent.`,
        whatToSay: "Anchor the answer to three facts: genuine admission, documented funding, a specific plan at home.",
        whyItWorks: "Consistency across answers is what officers are testing for; three fixed anchors make contradictions almost impossible.",
        warning: "Do not memorise wording word for word - officers recognise rehearsed answers instantly.",
      };
  }
}

/* ---------------------- coaching must match the file ---------------------- */

/**
 * Coaching that contradicts the student's own paperwork is worse than no
 * coaching: it rehearses exactly the inconsistency that gets people refused.
 *
 * This was a real bug. Asked "my sponsor is my uncle, not my father - how do
 * I answer?", the AI coach took the father's name from the file and wrote
 * "My sponsor is my uncle, Ram Bahadur Budhathoki". The guards below stop that
 * two ways: a question that contradicts the file gets a warning instead of a
 * blended answer, and every AI-written answer is checked against the file by
 * the same red-flag detector the interview uses, then rejected if it fails.
 */

const RELATION_TERMS = ["father", "mother", "uncle", "aunt", "brother", "sister", "cousin", "grandfather", "grandmother", "husband", "wife", "spouse"];
const COACH_BLOCKING_FLAGS = new Set([
  "Sponsor mismatch",
  "Immigration-intent language",
  "Funding depends on U.S. work",
  "Undocumented loan",
]);

/** The student asks about a sponsor that is not the one in their file. */
export function sponsorPremiseConflict(question, profile) {
  const recorded = String(profile?.sponsorRelation ?? "").toLowerCase().trim();
  if (!recorded) return null;
  const q = String(question ?? "").toLowerCase();
  if (!/sponsor|fund|pay|paying|support|financ|money/.test(q)) return null;
  const asked = RELATION_TERMS.find((term) => new RegExp(`\\b${term}\\b`).test(q) && !recorded.includes(term));
  return asked ? { recorded: profile.sponsorRelation, asked } : null;
}

/** A person named in the file is given a different relationship in the text. */
function relabelsPerson(text, profile) {
  const name = String(profile?.sponsorName ?? "").trim();
  const recorded = String(profile?.sponsorRelation ?? "").toLowerCase();
  if (!name || !recorded) return false;
  const first = name.split(/\s+/)[0].toLowerCase();
  if (first.length < 3) return false;
  return String(text)
    .split(/[.!?;]+/)
    .some((sentence) => {
      const s = sentence.toLowerCase();
      if (!s.includes(first)) return false;
      const relations = RELATION_TERMS.filter((term) => new RegExp(`\\b${term}\\b`).test(s));
      return relations.length > 0 && !relations.some((term) => recorded.includes(term));
    });
}

/**
 * A dollar amount that is not in the file. Allows each recorded amount and any
 * total of the funding sources, within 2% - anything else is invented.
 */
function inventsAmount(text, profile) {
  const recorded = ["tuitionUsd", "totalCoaUsd", "annualIncomeUsd", "savingsUsd", "loanUsd", "scholarshipUsd"]
    .map((key) => money(profile?.[key]))
    .filter((n) => n > 0);
  if (!recorded.length) return false;

  const sources = ["annualIncomeUsd", "savingsUsd", "loanUsd", "scholarshipUsd"].map((key) => money(profile?.[key]));
  const allowed = new Set(recorded);
  for (let mask = 1; mask < 16; mask++) {
    let sum = 0;
    for (let i = 0; i < 4; i++) if (mask & (1 << i)) sum += sources[i];
    if (sum > 0) allowed.add(sum);
  }

  const found = [...String(text).matchAll(/\$?\s?(\d{1,3}(?:,\d{3})+|\d{4,7})/g)]
    .map((m) => Number(m[1].replace(/,/g, "")))
    .filter((n) => n >= 1000 && !(n >= 1900 && n <= 2100)); // years are not money
  return found.some((n) => ![...allowed].some((a) => Math.abs(a - n) <= a * 0.02));
}

/**
 * Why a suggested answer contradicts the student's own file, or null if it is
 * safe to show them.
 */
export function contradictsFile(text, profile) {
  if (!profile || !String(text ?? "").trim()) return null;
  const flags = redFlagsFor({
    question: "",
    category: "",
    answer: text,
    profile,
    scores: { answer: 100, tone: 100, clarity: 100 },
    position: null,
  });
  const blocking = flags.find((f) => COACH_BLOCKING_FLAGS.has(f.label));
  if (blocking) return blocking.label;
  if (relabelsPerson(text, profile)) return "Relabels a person from the file";
  if (inventsAmount(text, profile)) return "Uses an amount not in the file";
  return null;
}

/* --------------------------- story across interviews ----------------------- */

/**
 * Officers compare what you say with your DS-160 and I-20, and a student who
 * practises the same case five times can drift - $34,000 one week, $30,000 the
 * next. These helpers pull the checkable facts out of every answer and report
 * where the story changes, or leaves the file.
 */

const FACT_KINDS = [
  { kind: "cost", label: "total first-year cost", key: "totalCoaUsd", pattern: /cost of attendance|total cost|\bcost|first[- ]year|\bcoa\b|expenses|attendance/g },
  { kind: "tuition", label: "tuition", key: "tuitionUsd", pattern: /tuition/g },
  { kind: "income", label: "sponsor's annual income", key: "annualIncomeUsd", pattern: /income|earns?\b|earning|salary|profit/g },
  { kind: "savings", label: "savings", key: "savingsUsd", pattern: /saving|bank|deposit|balance/g },
  { kind: "loan", label: "education loan", key: "loanUsd", pattern: /\bloan|borrow/g },
  { kind: "scholarship", label: "scholarship", key: "scholarshipUsd", pattern: /scholarship|assistantship|waiver|\bgrant\b/g },
];
const SPONSOR_CONTEXT = /sponsor|paying for|pays? for|fund(?:s|ing)? my|financ(?:e|es|ing) my|support(?:s|ing)? (?:me|my (?:studies|education|degree))|cover(?:s|ing)? my/;
const RETURN_PLACE = /\b(?:return|come back|go back|move back|going back|coming back)\s+(?:home\s+)?(?:to|in)\s+([A-Z][a-zA-Z]{2,})/;
// Country-level "Nepal" is not a claim that can drift - the city is.
const NOT_A_PLACE = new Set(["Nepal", "The", "My", "Our", "Work", "Join", "Start", "Help", "Take", "Lead"]);

/** Dollar amounts in a sentence, skipping years and rupee figures. */
function amountsIn(sentence) {
  const found = [];
  const pattern = /\$?\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?(k\b|thousand\b)?(?:\s?(?:us\s)?(?:dollars?|usd)\b)?(\s?(?:rupees|npr|rs\.?|lakh|lakhs|crore))?/gi;
  for (const m of sentence.matchAll(pattern)) {
    if (m[3]) continue; // Nepali rupees - the file is in dollars
    let value = Number(m[1].replace(/,/g, ""));
    if (m[2]) value *= 1000;
    if (!m[2] && (value < 1000 || (value >= 1900 && value <= 2100 && !m[0].includes("$")))) continue;
    found.push({ value: Math.round(value), index: m.index, end: m.index + m[0].length });
  }
  return found;
}

/**
 * The fact kind an amount belongs to: the closest keyword, preferring one in
 * the same clause ("my tuition is $18,500 | and the total cost is 34k") and one
 * that comes before the number, the way people usually say it.
 */
function kindForAmount(sentence, amount) {
  const boundaries = [...sentence.matchAll(/,|;|\band\b|\bbut\b|\bwhile\b/g)].map((m) => m.index);
  const clauseOf = (i) => boundaries.filter((b) => b < i).length;
  const clause = clauseOf(amount.index);

  let best = null;
  for (const fact of FACT_KINDS) {
    for (const m of sentence.matchAll(fact.pattern)) {
      const before = m.index < amount.index;
      let distance = before ? amount.index - m.index : (m.index - amount.end) * 1.5;
      if (clauseOf(m.index) !== clause) distance += 60;
      if (distance < 100 && (!best || distance < best.distance)) best = { fact, distance };
    }
  }
  return best?.fact ?? null;
}

/** Checkable facts in one answer. */
export function extractFacts(answer) {
  const facts = [];
  for (const raw of String(answer ?? "").split(/(?<=[.!?;])\s+/)) {
    const sentence = raw.trim();
    if (!sentence) continue;
    const lower = sentence.toLowerCase();

    for (const amount of amountsIn(lower)) {
      const fact = kindForAmount(lower, amount);
      if (fact) facts.push({ kind: fact.kind, value: amount.value, quote: sentence });
    }

    if (SPONSOR_CONTEXT.test(lower)) {
      const relations = RELATION_TERMS.filter((term) => new RegExp(`\\b${term}\\b`).test(lower));
      if (relations.length) facts.push({ kind: "sponsor", value: relations.sort().join(" and "), quote: sentence });
    }

    const place = sentence.match(RETURN_PLACE)?.[1];
    if (place && !NOT_A_PLACE.has(place)) facts.push({ kind: "returnPlace", value: place, quote: sentence });
  }
  return facts;
}

const usd = (n) => `$${Math.round(n).toLocaleString("en-US")}`;

/** Every amount the file supports: each recorded figure and any total of the funding sources. */
function fileAmounts(profile) {
  const recorded = FACT_KINDS.map((f) => money(profile?.[f.key])).filter((n) => n > 0);
  const sources = ["annualIncomeUsd", "savingsUsd", "loanUsd", "scholarshipUsd"].map((key) => money(profile?.[key]));
  const allowed = [...recorded];
  for (let mask = 1; mask < 16; mask++) {
    let sum = 0;
    for (let i = 0; i < 4; i++) if (mask & (1 << i)) sum += sources[i];
    if (sum > 0) allowed.push(sum);
  }
  return { recorded, allowed };
}

/**
 * The first dollar figure in an answer that the file does not support, with
 * what the file says for the same kind of amount - or null. An officer who
 * hears "$50,000" when the I-20 papers say $40,000 asks about it at once.
 */
export function unfamiliarAmount(answer, rawProfile) {
  const profile = rawProfile ?? {};
  const { recorded, allowed } = fileAmounts(profile);
  if (!recorded.length) return null;
  for (const raw of String(answer ?? "").split(/(?<=[.!?;])\s+/)) {
    const sentence = raw.toLowerCase();
    for (const amount of amountsIn(sentence)) {
      if (allowed.some((a) => Math.abs(a - amount.value) <= a * 0.02)) continue;
      const fact = kindForAmount(sentence, amount);
      const fileValue = fact ? money(profile[fact.key]) : 0;
      return { said: usd(amount.value), label: fact?.label ?? null, file: fileValue ? usd(fileValue) : null };
    }
  }
  return null;
}
const near = (a, b) => Math.abs(a - b) <= Math.max(a, b) * 0.02;
const shortDate = (iso) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/**
 * Compare every fact the student has stated, across interviews, with each
 * other and with their file.
 *
 * interviews: [{ id, createdAt, questions: [{ position, answer }] }]
 */
export function storyConsistency(interviews, rawProfile) {
  const profile = rawProfile ?? {};
  const mentions = [];
  for (const interview of interviews) {
    for (const q of interview.questions ?? []) {
      if (!hasText(q.answer)) continue;
      for (const fact of extractFacts(q.answer)) {
        mentions.push({ ...fact, interviewId: interview.id, createdAt: interview.createdAt, position: q.position });
      }
    }
  }

  // Any recorded amount or total of funding sources is a legitimate figure to
  // say - a mention that matches one of those is never a conflict, even if the
  // keyword next to it was misread.
  const recorded = FACT_KINDS.map((f) => money(profile[f.key])).filter((n) => n > 0);
  const sources = ["annualIncomeUsd", "savingsUsd", "loanUsd", "scholarshipUsd"].map((key) => money(profile[key]));
  const allowed = [...recorded];
  for (let mask = 1; mask < 16; mask++) {
    let sum = 0;
    for (let i = 0; i < 4; i++) if (mask & (1 << i)) sum += sources[i];
    if (sum > 0) allowed.push(sum);
  }
  const recordedRelation = String(profile.sponsorRelation ?? "").toLowerCase().trim();

  const kinds = [
    ...FACT_KINDS,
    { kind: "sponsor", label: "sponsor", key: "sponsorRelation" },
    { kind: "returnPlace", label: "return city", key: null },
  ];

  const facts = [];
  const issues = [];
  for (const def of kinds) {
    const said = mentions.filter((m) => m.kind === def.kind);
    if (!said.length) continue;

    const isAmount = def.kind !== "sponsor" && def.kind !== "returnPlace";
    const fileValue = isAmount ? money(profile[def.key]) || null : def.key ? profile[def.key] || null : null;
    const display = (v) => (isAmount ? usd(v) : v);
    const same = (a, b) => (isAmount ? near(a, b) : String(a).toLowerCase() === String(b).toLowerCase());

    // Distinct values said, each with where it was last said.
    const values = [];
    for (const m of said) {
      const existing = values.find((v) => same(v.value, m.value));
      if (existing) {
        existing.count += 1;
        existing.interviews.add(m.interviewId);
        if (m.createdAt > existing.lastAt) Object.assign(existing, { lastAt: m.createdAt, quote: m.quote });
      } else {
        values.push({ value: m.value, count: 1, interviews: new Set([m.interviewId]), lastAt: m.createdAt, quote: m.quote });
      }
    }

    const conflicts = said.filter((m) =>
      isAmount
        ? recorded.length > 0 && !allowed.some((a) => near(a, m.value))
        : def.kind === "sponsor" && recordedRelation && !m.value.split(" and ").some((term) => recordedRelation.includes(term))
    );
    const spansInterviews = new Set(said.map((m) => m.interviewId)).size > 1;
    const changed = values.length > 1 && spansInterviews;

    let status = "consistent";
    if (conflicts.length) status = "conflicts_file";
    else if (changed && !(isAmount && fileValue)) status = "changed";

    facts.push({
      kind: def.kind,
      label: def.label,
      file: fileValue ? display(fileValue) : null,
      status,
      said: values
        .sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1))
        .map((v) => ({ value: display(v.value), times: v.count, interviews: v.interviews.size, lastAt: v.lastAt })),
    });

    if (status === "conflicts_file") {
      // One issue per wrong value, pointing at the latest time it was said.
      const byValue = new Map();
      for (const m of conflicts) {
        const key = isAmount ? Math.round(m.value / 100) : m.value;
        if (!byValue.has(key) || m.createdAt > byValue.get(key).createdAt) byValue.set(key, m);
      }
      for (const m of byValue.values()) {
        issues.push({
          severity: ["sponsor", "cost", "income", "savings"].includes(def.kind) ? "high" : "medium",
          kind: def.kind,
          interviewId: m.interviewId,
          position: m.position,
          quote: m.quote,
          message:
            def.kind === "sponsor"
              ? `On ${shortDate(m.createdAt)} you named your ${m.value} as your sponsor, but your file names your ${String(fileValue).toLowerCase()}. A sponsor who changes at the window is one of the fastest routes to a refusal.`
              : fileValue
                ? `On ${shortDate(m.createdAt)} you gave your ${def.label} as ${display(m.value)}, but your file says ${display(fileValue)}. The officer has your DS-160 and I-20 - use the figure on them.`
                : `On ${shortDate(m.createdAt)} you said ${display(m.value)} for your ${def.label}, which does not match any amount in your file.`,
        });
      }
    } else if (status === "changed") {
      const latest = said.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
      issues.push({
        severity: def.kind === "returnPlace" ? "low" : "medium",
        kind: def.kind,
        interviewId: latest.interviewId,
        position: latest.position,
        quote: latest.quote,
        message: `Your ${def.label} has changed between interviews: ${values
          .map((v) => `${display(v.value)} (${shortDate(v.lastAt)})`)
          .join(", ")}. Settle on the true answer and give it every time.`,
      });
    }
  }

  const order = { high: 0, medium: 1, low: 2 };
  issues.sort((a, b) => order[a.severity] - order[b.severity]);
  return {
    interviewsChecked: interviews.length,
    consistent: issues.length === 0,
    facts,
    issues,
  };
}

/**
 * The coach's reply when the question itself contradicts the file. It never
 * invents the other sponsor's details - it cannot know them - and it leads
 * with the thing that actually matters: fix the paperwork first.
 */
function premiseCoach(conflict) {
  const recorded = conflict.recorded.toLowerCase();
  const asked = conflict.asked;
  return {
    answer: `My ${asked} sponsors my education. [Their name] works as [their occupation] and earns about [yearly income], and [the amount] is already in the bank for my studies, which covers the first-year cost on my I-20. I do not need to work in the United States to pay for my studies.`,
    whatToSay: `Who your ${asked} is, what they do, what they earn, and that the money is already deposited and documented.`,
    howToSayIt:
      "Three or four sentences, steady pace, no hedging. Fill in the brackets with your real details - never guess a figure you cannot back up.",
    whyItWorks:
      "The officer checks your spoken answer against your DS-160, your I-20 and your bank documents. An answer that matches all three is believed; one that differs from any of them is a contradiction.",
    warning: `Your case file says your sponsor is your ${recorded}, not your ${asked}. If your ${asked} really is paying, update your DS-160 and financial documents to show that before the interview, then update your case file here. Never tell the officer something your paperwork does not show. If your ${recorded} is still the sponsor, answer about your ${recorded}.`,
    premiseConflict: true,
  };
}

/** Rules both AI coaching prompts share. */
const FILE_IS_TRUTH = [
  "THE APPLICANT FILE IS THE SOURCE OF TRUTH:",
  "- Never change a person's relationship, name, amount, date or plan from what the file says.",
  "- Never attach a name from the file to a different relationship.",
  "- Never introduce an amount that is not in the file.",
  "- If the student's question assumes something that contradicts the file, say so first and tell them their answer must match their DS-160 and documents.",
];

/** Answer a student's own question, personalised from their file. */
export async function customAnswer(rawProfile, question) {
  const profile = rawProfile ?? {};

  // A question that contradicts the file is answered deterministically, with
  // the contradiction up front - never passed to the model to blend.
  const conflict = sponsorPremiseConflict(question, profile);
  if (conflict) return { ...premiseCoach(conflict), engine: "built-in" };

  const built = builtInCustomAnswer(profile, question);
  if (!config.ai.enabled) return { ...built, engine: "built-in" };

  const system = [
    "You are an experienced U.S. student visa preparation coach for international students.",
    "Answer using the applicant's own file so the wording sounds like them, not a template.",
    "Be direct and practical. If their plan has a weakness, say so.",
    "Never guarantee a visa outcome, never give legal or immigration advice, and never suggest misrepresenting anything to an officer.",
    "",
    ...FILE_IS_TRUTH,
    "",
    'Reply with JSON: {"answer":string,"whatToSay":string,"howToSayIt":string,"whyItWorks":string,"warning":string}',
    "- answer: 60-110 words, first person, as the student would say it at the window.",
  ].join("\n");
  const user = ["APPLICANT FILE", profileBrief(profile), "", "STUDENT QUESTION", String(question)].join("\n");

  const data = await callProvider(system, user, 0.6);
  if (!data || typeof data.answer !== "string" || !data.answer.trim()) {
    return { ...built, engine: "built-in" };
  }

  // The model is told the rules; this checks it followed them.
  const problem = contradictsFile(data.answer, profile);
  if (problem) return { ...built, engine: "built-in", guarded: problem };

  return {
    answer: data.answer.trim(),
    whatToSay: text(data.whatToSay, built.whatToSay),
    howToSayIt: text(data.howToSayIt, built.howToSayIt),
    whyItWorks: text(data.whyItWorks, built.whyItWorks),
    warning: text(data.warning, built.warning),
    engine: "provider",
  };
}

/* --------------------------------- provider -------------------------------- */

function text(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/** Compact applicant file - the context every provider call receives. */
export function profileBrief(profile) {
  if (!profile) return "No profile on file. Ask general F-1 questions and do not invent details.";
  const p = profile;
  return [
    `Name: ${p.fullName || "unknown"}`,
    `Home: ${[p.homeCity, p.homeCountry].filter(Boolean).join(", ") || "unknown"}. Age ${p.age || "unknown"}.`,
    `Previous study: ${p.highestDegree || "?"} in ${p.previousMajor || "?"} at ${p.previousInstitution || "?"} (${p.graduationYear || "?"}), GPA ${p.gpa || "?"}. English: ${p.englishTest || "?"}. Gap: ${p.gapYears || "none"}.`,
    `U.S. plan: ${p.degreeLevel || ""} ${p.program || "?"} at ${p.usUniversity || "?"}, ${p.usCity || "?"}, starting ${p.startTerm || "?"} for ${p.programMonths || "?"} months.`,
    `Costs: tuition $${p.tuitionUsd || "?"}, first-year cost of attendance $${p.totalCoaUsd || "?"}.`,
    `Funding: sponsor ${p.sponsorName || "?"} (${p.sponsorRelation || "?"}, ${p.sponsorOccupation || "?"}), income $${p.annualIncomeUsd || "0"}, savings $${p.savingsUsd || "0"}, loan $${p.loanUsd || "0"}, scholarship $${p.scholarshipUsd || "0"}.`,
    `Why U.S.: ${p.whyUsa || "not stated"}`,
    `Why this programme: ${p.whyProgram || "not stated"}`,
    `Career goal: ${p.careerGoal || "not stated"}. After graduation: ${p.planAfter || "not stated"}. Ties at home: ${p.tiesHome || "not stated"}.`,
    `History: previous applications ${p.previousApplications || "none"}, refusals ${p.refusals || "none"} (${p.refusalReason || "n/a"}). Relatives in U.S.: ${p.relativesInUs || "none"}. Travel: ${p.travelHistory || "none"}.`,
  ].join("\n");
}

/**
 * One call to an OpenAI-compatible /chat/completions endpoint.
 * Returns parsed JSON, or null on any failure - callers always have a
 * built-in fallback, so a provider outage degrades quality, never uptime.
 */
export async function callProvider(system, user, temperature = 0.7, timeoutMs = config.ai.timeoutMs) {
  if (!config.ai.enabled) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${config.ai.baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.ai.apiKey}`,
      },
      body: JSON.stringify({
        model: config.ai.model,
        temperature,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    return typeof content === "string" ? JSON.parse(content) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
